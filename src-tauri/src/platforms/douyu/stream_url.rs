use deno_core::{JsRuntime, RuntimeOptions};
use base64::Engine;
use std::collections::BTreeMap;
use super::app_signature;
use html_escape::decode_html_entities;
use reqwest::{
    header::{HeaderMap, HeaderValue},
    redirect::Policy,
    Client,
};
use serde::{Deserialize, Serialize};
use super::quality_policy::{self, RateVariant as DouyuRateVariant};
use serde_json::Value;
#[cfg(target_os = "linux")]
use std::sync::Once;
use std::time::{SystemTime, UNIX_EPOCH};

#[derive(Deserialize, Debug)]
struct BetardRoomInfo {
    room_id: Option<Value>,
    show_status: Option<Value>,
}

#[derive(Deserialize, Debug)]
struct BetardResponse {
    room: Option<BetardRoomInfo>,
}

#[derive(Clone, Debug)]
struct DouyuPlayInfo {
    variants: Vec<DouyuRateVariant>,
    cdns: Vec<String>,
}

#[derive(Clone, Debug, Serialize)]
pub struct DouyuPlayback {
    pub url: String,
    pub actual_quality: String,
    pub quality_limited: bool,
    pub line: String,
    pub requested_hevc: bool,
    pub requested_rate: i32,
    pub actual_rate: Option<i32>,
    pub available_qualities: Vec<DouyuRateVariant>,
    pub api: String,
}

fn value_to_i32(value: &Value) -> Option<i32> {
    match value {
        Value::Number(num) => num.as_i64().map(|n| n as i32),
        Value::String(s) => s.parse::<i32>().ok(),
        _ => None,
    }
}

fn value_to_string(value: &Value) -> Option<String> {
    match value {
        Value::Number(num) => Some(num.to_string()),
        Value::String(s) => Some(s.to_string()),
        _ => None,
    }
}

struct DouYu {
    did: String,
    rid: String,
    client: Client,
    cookie: Option<String>,
}

const DEFAULT_DOUYU_CDN: &str = "ws-h5";
const DEFAULT_DOUYU_UA: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/114.0.0.0 Safari/537.36";
const DEFAULT_DOUYU_DID: &str = "10000000000000000000000000001501";
const CRYPTO_JS: &str = include_str!("cryptojs.min.js");

#[cfg(target_os = "linux")]
static JS_RUNTIME_INIT: Once = Once::new();

fn ensure_js_runtime_platform_initialized() {
    #[cfg(target_os = "linux")]
    JS_RUNTIME_INIT.call_once(|| {
        JsRuntime::init_platform(None);
    });
}

fn normalize_douyu_cdn(input: Option<&str>) -> &'static str {
    match input
        .map(|s| s.trim().to_ascii_lowercase())
        .filter(|s| !s.is_empty())
        .as_deref()
    {
        Some("ws-h5") => "ws-h5",
        Some("tct-h5") => "tct-h5",
        Some("ali-h5") => "ali-h5",
        Some("hs-h5") => "hs-h5",
        _ => DEFAULT_DOUYU_CDN,
    }
}

impl DouYu {
    async fn new(rid: &str) -> Result<Self, Box<dyn std::error::Error>> {
        // 迁移到 reqwest：禁用系统代理、限制重定向、设置默认 UA/语言等头部
        let mut default_headers = HeaderMap::new();
        default_headers.insert(
            "User-Agent",
            HeaderValue::from_static(DEFAULT_DOUYU_UA),
        );
        default_headers.insert(
            "Accept-Language",
            HeaderValue::from_static("zh-CN,zh;q=0.9"),
        );
        let client = Client::builder()
            .redirect(Policy::limited(10))
            .no_proxy()
            .timeout(std::time::Duration::from_secs(12))
            .default_headers(default_headers)
            .build()?;

        Ok(Self {
            did: DEFAULT_DOUYU_DID.to_string(),
            rid: rid.to_string(),
            client,
            cookie: None,
        })
    }

    async fn execute_js_sign(
        &self,
        script: &str,
        rid: &str,
        did: &str,
        ts: i64,
    ) -> Result<String, Box<dyn std::error::Error>> {
        ensure_js_runtime_platform_initialized();
        let mut runtime = JsRuntime::new(RuntimeOptions::default());

        runtime.execute_script(
            "[douyu]",
            deno_core::FastString::from(String::from(CRYPTO_JS)),
        )?;
        runtime.execute_script("[douyu]", deno_core::FastString::from(script.to_string()))?;

        let rid_js = serde_json::to_string(rid)?;
        let did_js = serde_json::to_string(did)?;
        let call_expr = format!("ub98484234({rid_js},{did_js},{ts});");
        let js_result =
            runtime.execute_script("[douyu]", deno_core::FastString::from(call_expr))?;

        let params = {
            let scope = &mut runtime.handle_scope();
            let result = js_result.open(scope);
            result.to_rust_string_lossy(scope)
        };

        Ok(params)
    }

    async fn fetch_room_detail(&self) -> Result<(String, bool), Box<dyn std::error::Error>> {
        let url = format!("https://www.douyu.com/betard/{}", self.rid);
        let json = self
            .client
            .get(url)
            .header("Referer", format!("https://www.douyu.com/{}", self.rid))
            .send()
            .await?
            .json::<BetardResponse>()
            .await?;

        let room = json.room.ok_or("Missing room data")?;
        let room_id_value = room.room_id.ok_or("Missing room_id")?;
        let room_id = value_to_string(&room_id_value).ok_or("Invalid room_id")?;
        let show_status = room
            .show_status
            .as_ref()
            .and_then(value_to_i32)
            .unwrap_or(0);
        Ok((room_id, show_status == 1))
    }

    async fn get_h5_enc(&self, room_id: &str) -> Result<String, Box<dyn std::error::Error>> {
        let url = format!("https://www.douyu.com/swf_api/homeH5Enc?rids={}", room_id);
        let json = self
            .client
            .get(url)
            .header("Referer", format!("https://www.douyu.com/{}", room_id))
            .send()
            .await?
            .json::<Value>()
            .await?;

        let error_code = json.get("error").and_then(value_to_i32).unwrap_or(-1);
        if error_code != 0 {
            return Err(format!("homeH5Enc error: {}", error_code).into());
        }

        let key = format!("room{}", room_id);
        let crptext = json
            .get("data")
            .and_then(|v| v.get(&key))
            .and_then(|v| v.as_str())
            .ok_or("Missing homeH5Enc data")?;
        Ok(crptext.to_string())
    }

    async fn build_sign_params(
        &self,
        room_id: &str,
    ) -> Result<String, Box<dyn std::error::Error>> {
        let crptext = self.get_h5_enc(room_id).await?;
        let ts = SystemTime::now().duration_since(UNIX_EPOCH)?.as_secs() as i64;
        let params = self
            .execute_js_sign(&crptext, room_id, &self.did, ts)
            .await?;
        Ok(params)
    }

    async fn build_v1_sign_params(&self, room_id: &str) -> Result<String, Box<dyn std::error::Error>> {
        let mut request = self.client.get("https://www.douyu.com/wgapi/livenc/liveweb/websec/getEncryption")
            .query(&[("did", self.did.as_str())])
            .header("Referer", format!("https://www.douyu.com/{room_id}"));
        if let Some(cookie) = &self.cookie { request = request.header("Cookie", cookie); }
        let response: Value = request.send().await?.error_for_status()?.json().await?;
        if response.get("error").and_then(value_to_i32) != Some(0) { return Err("斗鱼新版签名参数获取失败".into()); }
        let data = &response["data"];
        let timestamp = SystemTime::now().duration_since(UNIX_EPOCH)?.as_secs();
        let auth = super::web_signature::stream_auth(data, room_id, timestamp)?;
        let encrypted = data["enc_data"].as_str().filter(|v| !v.is_empty()).ok_or("斗鱼未返回新版签名数据")?;
        Ok(serde_urlencoded::to_string([("enc_data", encrypted.to_string()), ("tt", timestamp.to_string()), ("did", self.did.clone()), ("auth", auth)])?)
    }

    async fn get_play_qualities(
        &self,
        room_id: &str,
        sign_data: &str,
        use_v1: bool,
        prefer_hevc: bool,
    ) -> Result<DouyuPlayInfo, Box<dyn std::error::Error>> {
        let payload = format!(
            "{}&cdn=&rate=-1&ver={}&iar=0&ive=0&sov=0&hevc={}&fa=0",
            sign_data, if use_v1 { "Douyu_new" } else { "Douyu_223061205" }, if prefer_hevc { 1 } else { 0 }
        );
        let endpoint = if use_v1 { "getH5PlayV1" } else { "getH5Play" };
        let url = format!("https://www.douyu.com/lapi/live/{endpoint}/{room_id}");
        let mut request = self
            .client
            .post(url)
            .header("Content-Type", "application/x-www-form-urlencoded")
            .body(payload);
        if let Some(cookie) = &self.cookie { request = request.header("Cookie", cookie); }
        let json = request
            .send()
            .await?
            .json::<Value>()
            .await?;

        let error_code = json.get("error").and_then(value_to_i32).unwrap_or(-1);
        if error_code != 0 {
            let msg = json
                .get("msg")
                .and_then(|v| v.as_str())
                .unwrap_or("getH5Play failed");
            return Err(format!("getH5Play error {}: {}", error_code, msg).into());
        }

        let data = json.get("data").ok_or("No data field in response")?;
        let cdns = data
            .get("cdnsWithName")
            .and_then(|v| v.as_array())
            .map(|arr| {
                arr.iter()
                    .filter_map(|item| {
                        item.get("cdn")
                            .and_then(|v| v.as_str())
                            .map(|s| s.to_string())
                    })
                    .collect::<Vec<String>>()
            })
            .unwrap_or_default();

        let mut cdns_sorted = cdns;
        cdns_sorted.sort_by(|a, b| {
            let a_is_scdn = a.starts_with("scdn");
            let b_is_scdn = b.starts_with("scdn");
            (a_is_scdn, a).cmp(&(b_is_scdn, b))
        });

        let variants = data
            .get("multirates")
            .and_then(|v| v.as_array())
            .map(|arr| {
                arr.iter()
                    .filter_map(|item| {
                        let name = item
                            .get("name")
                            .and_then(|v| v.as_str())
                            .map(|s| s.to_string())?;
                        let rate_value = item.get("rate").and_then(value_to_i32)?;
                        let bit_value = item.get("bit").and_then(value_to_i32);
                        Some(DouyuRateVariant {
                            name,
                            rate: rate_value,
                            bit: bit_value,
                        })
                    })
                    .collect::<Vec<DouyuRateVariant>>()
            })
            .unwrap_or_default();

        Ok(DouyuPlayInfo {
            variants,
            cdns: cdns_sorted,
        })
    }

    async fn get_play_url(
        &self,
        room_id: &str,
        sign_data: &str,
        use_v1: bool,
        rate: i32,
        cdn: &str,
        prefer_hevc: bool,
        variants: &[DouyuRateVariant],
    ) -> Result<DouyuPlayback, Box<dyn std::error::Error>> {
        let uid = self.cookie.as_deref().and_then(|c| cookie_value(c, "acf_uid"))
            .filter(|v| !v.is_empty() && v.bytes().all(|b| b.is_ascii_digit())).unwrap_or("0");
        let mut payload = format!("{}&cdn={}&rate={}&hevc={}&ver={}&iar=0&ive=0&sov=0&fa=0", sign_data, urlencoding::encode(cdn), rate, if prefer_hevc { 1 } else { 0 }, if use_v1 { "Douyu_new" } else { "Douyu_223061205" });
        if !use_v1 { payload.push_str(&format!("&aid=web-alone&uid={uid}")); }
        let endpoint = if use_v1 { "getH5PlayV1" } else { "getH5Play" };
        let url = format!("https://www.douyu.com/lapi/live/{endpoint}/{room_id}");
        let mut request = self
            .client
            .post(url)
            .header("Content-Type", "application/x-www-form-urlencoded")
            .header("Referer", format!("https://www.douyu.com/{}", room_id))
            .body(payload);
        if let Some(cookie) = &self.cookie { request = request.header("Cookie", cookie); }
        let json = request
            .send()
            .await?
            .json::<Value>()
            .await?;

        let error_code = json.get("error").and_then(value_to_i32).unwrap_or(-1);
        if error_code != 0 {
            let msg = json
                .get("msg")
                .and_then(|v| v.as_str())
                .unwrap_or("getH5Play failed");
            return Err(format!("getH5Play error {}: {}", error_code, msg).into());
        }

        let data = json.get("data").ok_or("No data field in response")?;
        let rtmp_url = data
            .get("rtmp_url")
            .and_then(|v| v.as_str())
            .ok_or("No rtmp_url field")?;
        let rtmp_live = data
            .get("rtmp_live")
            .and_then(|v| v.as_str())
            .ok_or("No rtmp_live field")?;
        let rtmp_live = decode_html_entities(rtmp_live).to_string();
        let actual_rate = data.get("rate").and_then(value_to_i32);
        let actual = actual_rate.and_then(|r| variants.iter().find(|v| v.rate == r));
        Ok(DouyuPlayback {
            // Some responses provide the HEVC stream separately from the AVC URL.
            url: if prefer_hevc {
                data.get("player_1").and_then(Value::as_str).map(str::trim)
                    .filter(|url| url.starts_with("https://") || url.starts_with("http://"))
                    .map(str::to_string).unwrap_or_else(|| format!("{}/{}", rtmp_url, rtmp_live))
            } else { format!("{}/{}", rtmp_url, rtmp_live) },
            actual_quality: actual.map(|v| v.name.clone()).unwrap_or_else(|| "画质待确认".into()),
            quality_limited: actual_rate.is_some_and(|r| r != rate),
            line: data.get("rtmp_cdn").or_else(|| data.get("cdn")).and_then(Value::as_str).unwrap_or(cdn).to_string(),
            requested_hevc: prefer_hevc,
            requested_rate: rate, actual_rate, available_qualities: variants.to_vec(), api: if use_v1 { "web-v1".into() } else { "web".into() },
        })
    }

    // The app endpoint exposes the original stream that the H5 endpoint may
    // silently cap to rate=4. Same public playback flow as biliup; no account
    // token is sent. Standard signed CDN URLs are kept untouched.
    async fn get_app_play_url(&self, room_id: &str, rate: i32, cdn: &str, prefer_hevc: bool, variants: &[DouyuRateVariant]) -> Result<DouyuPlayback, Box<dyn std::error::Error>> {
        let timestamp = SystemTime::now().duration_since(UNIX_EPOCH)?.as_secs();
        let path = format!("/lapi/live/appGetPlayer/stream/{room_id}");
        let device_id = app_signature::DEFAULT_DEVICE_ID;
        use rand::Rng;
        let device = {
            let mut rng = rand::thread_rng();
            format!("{}{}{}-{}{}{}{}", (b'A'+rng.gen_range(0..26)) as char, (b'A'+rng.gen_range(0..26)) as char, (b'A'+rng.gen_range(0..26)) as char, (b'A'+rng.gen_range(0..26)) as char, (b'A'+rng.gen_range(0..26)) as char, rng.gen_range(0..10), rng.gen_range(0..10))
        };
        let mut params = BTreeMap::new();
        for (key,value) in [("txdw","0"),("cdn",cdn.trim_end_matches("-h5")),("token",""),("hevc","1"),("ilow","0"),("iar","0"),("net","WIFI"),("device",device.as_str())] {
            params.insert(key.to_string(),value.to_string());
        }
        params.insert("rate".into(),rate.to_string());
        let signature = app_signature::csign(room_id.parse()?, device_id, timestamp, &params);
        let amd = app_signature::amd(&signature, device_id);
        params.insert("csign".into(),signature);
        params.insert("cptl".into(),"0103".into());
        params.insert("amd".into(),amd);
        params.insert("client_sys".into(),"android".into());
        let auth = app_signature::header_auth(&path,timestamp,"android1",&params);
        let json: Value = self.client.get(format!("https://playclient.douyucdn.cn{path}"))
            .query(&params)
            .header("User-Device",base64::engine::general_purpose::STANDARD.encode(format!("{device_id}|v8.2.2.0")))
            .header("aid","android1").header("channel","447")
            .header("User-Agent",format!("android/8.2.2.0 (android 16; ; {device})"))
            .header("time",timestamp.to_string()).header("auth",auth)
            .header("Cookie",format!("acf_did={device_id}"))
            .timeout(std::time::Duration::from_secs(8)).send().await?.error_for_status()?.json().await?;
        let error = json.get("error").and_then(value_to_i32).unwrap_or(-1);
        if error != 0 {
            return Err(format!("斗鱼播放接口错误 {}: {}",error,json["msg"].as_str().unwrap_or("")).into());
        }
        let data = &json["data"];
        let avc_url = format!("{}/{}",data["rtmp_url"].as_str().ok_or("斗鱼未返回播放地址")?.trim_end_matches('/'),data["rtmp_live"].as_str().ok_or("斗鱼未返回播放地址")?.trim_start_matches('/'));
        let hevc_url = data["player_1"].as_str().map(str::trim)
            .filter(|s| s.starts_with("https://") || s.starts_with("http://"));
        let url = if prefer_hevc { hevc_url.unwrap_or(&avc_url) } else { &avc_url };
        let actual_rate = data.get("rate").and_then(value_to_i32);
        let actual = actual_rate.and_then(|r| variants.iter().find(|v| v.rate == r));
        Ok(DouyuPlayback {
            url: decode_html_entities(url).to_string(),
            actual_quality: actual.map(|v| v.name.clone()).unwrap_or_else(|| "画质待确认".into()),
            quality_limited: actual_rate.is_some_and(|r| r != rate),
            line: data["cdn"].as_str().unwrap_or(cdn).into(),
            requested_hevc: prefer_hevc && hevc_url.is_some(), requested_rate: rate,
            actual_rate, available_qualities: variants.to_vec(), api: "app".into(),
        })
    }

    fn select_cdn(requested: Option<&str>, available: &[String]) -> String {
        if let Some(cdn) = requested {
            let trimmed = cdn.trim();
            if !trimmed.is_empty() {
                let target = trimmed.to_ascii_lowercase();
                if let Some(hit) = available
                    .iter()
                    .find(|item| item.to_ascii_lowercase() == target)
                {
                    return hit.clone();
                }
            }
        }
        available
            .first()
            .cloned()
            .unwrap_or_else(|| normalize_douyu_cdn(requested).to_string())
    }

    pub async fn get_real_url(&self, cdn: Option<&str>) -> Result<String, Box<dyn std::error::Error>> {
        Ok(self.get_playback("原画", cdn, false, 0).await?.url)
    }

    pub async fn get_real_url_with_quality(&self, quality: &str, cdn: Option<&str>) -> Result<String, Box<dyn std::error::Error>> {
        Ok(self.get_playback(quality, cdn, false, 0).await?.url)
    }

    pub async fn get_playback(&self, quality: &str, cdn: Option<&str>, prefer_hevc: bool, route: usize) -> Result<DouyuPlayback, Box<dyn std::error::Error>> {
        let (real_room_id, is_live) = self.fetch_room_detail().await?;
        if !is_live { return Err("主播未开播".into()); }
        let (mut sign_data, mut use_v1) = match self.build_v1_sign_params(&real_room_id).await.map_err(|e| e.to_string()) {
            Ok(sign) => (sign, true),
            Err(_) => (self.build_sign_params(&real_room_id).await?, false),
        };
        let info = match self.get_play_qualities(&real_room_id, &sign_data, use_v1, prefer_hevc).await.map_err(|e| e.to_string()) {
            Ok(info) => info,
            Err(_) if use_v1 => {
                sign_data = self.build_sign_params(&real_room_id).await?;
                use_v1 = false;
                self.get_play_qualities(&real_room_id, &sign_data, false, prefer_hevc).await?
            }
            Err(error) => return Err(error.into()),
        };
        let selected_rate = quality_policy::select(&info.variants, quality).map(|v| v.rate).unwrap_or(0);
        let primary = Self::select_cdn(cdn, &info.cdns);
        let base = info.cdns.iter().position(|v| v == &primary).unwrap_or(0);
        let selected_cdn = if info.cdns.is_empty() { primary } else { info.cdns[(base + route) % info.cdns.len()].clone() };
        // Web login cookies belong to Douyu's web endpoint, not its anonymous app API.
        let authenticated_web = if self.cookie.is_some() {
            let stream = self.get_play_url(&real_room_id, &sign_data, use_v1, selected_rate, &selected_cdn, prefer_hevc, &info.variants).await.map_err(|e| e.to_string());
            if let Ok(value) = &stream {
                if value.actual_rate == Some(selected_rate) { return Ok(value.clone()); }
            }
            Some(stream)
        } else { None };
        // H5 may only advertise its capped fallback CDN. The app endpoint has
        // its own CDN set; don't inherit that H5 restriction for the app request.
        let app_cdns = ["ws-h5", "tct-h5", "ali-h5", "hs-h5"];
        let app_base = app_cdns.iter().position(|c| *c == normalize_douyu_cdn(cdn)).unwrap_or(0);
        let app_cdn = app_cdns[(app_base + route) % app_cdns.len()];
        let app_result = self.get_app_play_url(&real_room_id, selected_rate, app_cdn, prefer_hevc, &info.variants).await.map_err(|e| e.to_string());
        if let Ok(stream) = &app_result {
            if stream.actual_rate == Some(selected_rate) { return Ok(stream.clone()); }
        }
        // A nominally successful endpoint may have capped the stream. Compare
        // actual returned rates before accepting it, including the H5 fallback.
        let mut web_result = match authenticated_web {
            Some(result) => result,
            None => self.get_play_url(&real_room_id, &sign_data, use_v1, selected_rate, &selected_cdn, prefer_hevc, &info.variants).await.map_err(|e| e.to_string()),
        };
        if web_result.is_err() && prefer_hevc {
            web_result = self.get_play_url(&real_room_id, &sign_data, use_v1, selected_rate, &selected_cdn, false, &info.variants).await.map_err(|e| e.to_string());
        }
        match (app_result, web_result) {
            (Ok(app), Ok(web)) => {
                let app_better = quality_policy::returned_rate_is_better(app.actual_rate, web.actual_rate, &info.variants);
                if app_better { Ok(app) } else { Ok(web) }
            },
            (Ok(app), Err(_)) => Ok(app),
            (_, Ok(web)) => Ok(web),
            (_, Err(e)) => Err(e.into()),
        }
    }
}

pub async fn get_playback(room_id: &str, quality: &str, cdn: Option<&str>, prefer_hevc: bool, route: usize) -> Result<DouyuPlayback, Box<dyn std::error::Error>> {
    let douyu = DouYu::new(room_id).await?;
    douyu.get_playback(quality, cdn, prefer_hevc, route).await
}

fn cookie_value<'a>(cookie: &'a str, name: &str) -> Option<&'a str> {
    cookie.split(';').filter_map(|part| part.trim().split_once('='))
        .find(|(key, _)| *key == name).map(|(_, value)| value)
}

pub async fn get_playback_with_cookie(room_id: &str, quality: &str, cdn: Option<&str>, prefer_hevc: bool, route: usize, cookie: Option<String>) -> Result<DouyuPlayback, Box<dyn std::error::Error>> {
    let mut douyu = DouYu::new(room_id).await?;
    if let Some(value) = &cookie {
        if let Some(did) = cookie_value(value, "dy_did").or_else(|| cookie_value(value, "acf_did")) {
            if !did.is_empty() && did.len() <= 64 && did.bytes().all(|b| b.is_ascii_alphanumeric()) { douyu.did = did.to_string(); }
        }
    }
    douyu.cookie = cookie;
    douyu.get_playback(quality, cdn, prefer_hevc, route).await
}

pub async fn get_stream_url(
    room_id: &str,
    cdn: Option<&str>,
) -> Result<String, Box<dyn std::error::Error>> {
    let douyu = DouYu::new(room_id).await?;
    let url = douyu.get_real_url(cdn).await?;
    Ok(url)
}

pub async fn get_stream_url_with_quality(
    room_id: &str,
    quality: &str,
    cdn: Option<&str>,
) -> Result<String, Box<dyn std::error::Error>> {
    let douyu = DouYu::new(room_id).await?;
    let url = douyu.get_real_url_with_quality(quality, cdn).await?;
    Ok(url)
}
