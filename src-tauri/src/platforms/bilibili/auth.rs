// src/auth.rs
use md5::{Digest, Md5};
use reqwest::header::HeaderMap;
#[allow(unused_imports)]
use reqwest::StatusCode;
use std::time::{SystemTime, UNIX_EPOCH};

// WBI signing constants and functions (extracted)
const MIXIN_KEY_ENC_TAB: [usize; 64] = [
    46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49, 33, 9, 42, 19, 29,
    28, 14, 39, 12, 38, 41, 13, 37, 48, 7, 16, 24, 55, 40, 61, 26, 17, 0, 1, 60, 51, 30, 4, 22, 25,
    54, 21, 56, 59, 6, 63, 57, 62, 11, 36, 20, 34, 44, 52,
];

fn get_mixin_key(orig: &[u8]) -> String {
    MIXIN_KEY_ENC_TAB
        .iter()
        .take(32)
        .filter_map(|&i| orig.get(i).map(|byte| *byte as char))
        .collect::<String>()
}

fn get_url_encoded(s: &str) -> String {
    s.chars()
        .filter_map(|c| match c.is_ascii_alphanumeric() || "-_.~".contains(c) {
            true => Some(c.to_string()),
            false => {
                if "!'()*".contains(c) {
                    return None;
                }
                let encoded = c
                    .encode_utf8(&mut [0; 4])
                    .bytes()
                    .fold("".to_string(), |acc, b| acc + &format!("%{:02X}", b));
                Some(encoded)
            }
        })
        .collect::<String>()
}

fn encode_wbi(params: Vec<(&str, String)>, (img_key, sub_key): (String, String)) -> String {
    let cur_time = match SystemTime::now().duration_since(UNIX_EPOCH) {
        Ok(t) => t.as_secs(),
        Err(_) => 0,
    };
    _encode_wbi(params, (img_key, sub_key), cur_time)
}

fn _encode_wbi(
    mut params: Vec<(&str, String)>,
    (img_key, sub_key): (String, String),
    timestamp: u64,
) -> String {
    let mixin_key = get_mixin_key((img_key + &sub_key).as_bytes());
    params.push(("wts", timestamp.to_string()));
    params.sort_by(|a, b| a.0.cmp(b.0));
    let query = params
        .iter()
        .map(|(k, v)| format!("{}={}", get_url_encoded(k), get_url_encoded(v)))
        .collect::<Vec<_>>()
        .join("&");
    let mut hasher = Md5::new();
    hasher.update((query.clone() + &mixin_key).as_bytes());
    let digest = hasher.finalize();
    let web_sign = format!("{:x}", digest);
    query + &format!("&w_rid={}", web_sign)
}


use anyhow::{Context, Result};
use super::models::AuthMessage;
use serde_json::Value;
use std::time::Duration;

pub const UID_INIT_URL: &str = "https://api.bilibili.com/x/web-interface/nav";
pub const DANMAKU_SERVER_CONF_URL: &str = "https://api.live.bilibili.com/xlive/web-room/v1/index/getDanmuInfo";
pub const USER_AGENT: &str = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15";

fn init_server(cookie: Option<&str>, room_id: &str) -> Result<(Value, AuthMessage)> {
    let roomid = room_id.parse::<u64>().context("Invalid Bilibili room ID")?;
    let client = reqwest::blocking::Client::builder().https_only(true).no_proxy()
        .connect_timeout(Duration::from_secs(5)).timeout(Duration::from_secs(10)).build()?;
    let mut headers = HeaderMap::new();
    headers.insert("User-Agent", reqwest::header::HeaderValue::from_static(USER_AGENT));
    if let Some(cookie) = cookie.filter(|v| !v.trim().is_empty()) {
        headers.insert("Cookie", reqwest::header::HeaderValue::from_str(cookie).context("Invalid cookie header")?);
    }
    let nav: Value = client.get(UID_INIT_URL).headers(headers.clone()).send()?.error_for_status()?.json()?;
    let take_key = |name: &str| -> Result<String> {
        let raw = nav["data"]["wbi_img"][name].as_str().context("Missing WBI image key")?;
        let key = raw.rsplit_once('/').and_then(|(_, s)| s.rsplit_once('.')).map(|(s, _)| s).context("Invalid WBI image key")?;
        anyhow::ensure!(key.len() == 32 && key.bytes().all(|b| b.is_ascii_hexdigit()), "Malformed WBI key");
        Ok(key.to_string())
    };
    let query = encode_wbi(vec![("id", roomid.to_string()), ("type", "0".into()), ("web_location", "444.8".into())], (take_key("img_url")?, take_key("sub_url")?));
    let response: Value = client.get(format!("{DANMAKU_SERVER_CONF_URL}?{query}")).headers(headers).send()?.error_for_status()?.json()?;
    anyhow::ensure!(response["code"].as_i64() == Some(0), "Bilibili danmaku endpoint rejected the request");
    let data = response["data"].clone();
    let key = data["token"].as_str().filter(|s| !s.is_empty()).context("Missing danmaku token")?.to_owned();
    let auth = AuthMessage { uid: nav["data"]["mid"].as_u64().unwrap_or(0), roomid, protover: 3, platform: "web".into(), type_: 2, key };
    Ok((data, auth))
}

pub fn init_server_with_cookie(cookie: &str, room_id: &str) -> Result<(Value, AuthMessage)> { init_server(Some(cookie), room_id) }
pub fn init_server_no_cookie(room_id: &str) -> Result<(Value, AuthMessage)> { init_server(None, room_id) }
