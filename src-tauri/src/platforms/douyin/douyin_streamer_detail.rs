use crate::platforms::common::http_client::HttpClient;
use crate::platforms::common::types::StreamVariant;
use crate::platforms::common::GetStreamUrlPayload;
use crate::platforms::common::LiveStreamInfo as CommonLiveStreamInfo;
use crate::platforms::douyin::web_api::{
    fetch_room_data, normalize_douyin_live_id, DouyinRoomData,
    DEFAULT_USER_AGENT,
};
use crate::proxy::ProxyServerHandle;
use crate::StreamUrlStore;
use regex::Regex;
use reqwest::header::{HeaderMap, HeaderValue, REFERER, USER_AGENT};
use serde_json::Value;
use tauri::{command, AppHandle, State};

const QUALITY_OD: &str = "OD";
#[command]
pub async fn get_douyin_live_stream_url(
    app_handle: AppHandle,
    stream_url_store: State<'_, StreamUrlStore>,
    proxy_server_handle: State<'_, ProxyServerHandle>,
    payload: GetStreamUrlPayload,
) -> Result<CommonLiveStreamInfo, String> {
    get_douyin_live_stream_url_with_quality(
        app_handle,
        stream_url_store,
        proxy_server_handle,
        payload,
        QUALITY_OD.to_string(),
        None,
        None,
    )
    .await
}

#[command]
pub async fn get_douyin_live_stream_url_with_quality(
    app_handle: AppHandle,
    stream_url_store: State<'_, StreamUrlStore>,
    proxy_server_handle: State<'_, ProxyServerHandle>,
    payload: GetStreamUrlPayload, quality: String, route: Option<usize>, allow_hevc: Option<bool>,
) -> Result<CommonLiveStreamInfo, String> {
    tokio::time::timeout(std::time::Duration::from_secs(25), get_douyin_live_stream_url_with_quality_inner(app_handle, stream_url_store, proxy_server_handle, payload, quality, route, allow_hevc)).await
        .map_err(|_| "获取直播流超时，请检查网络后重试".to_string())?
}

async fn get_douyin_live_stream_url_with_quality_inner(
    _app_handle: AppHandle,
    _stream_url_store: State<'_, StreamUrlStore>,
    _proxy_server_handle: State<'_, ProxyServerHandle>,
    payload: GetStreamUrlPayload,
    quality: String,
    route: Option<usize>,
    allow_hevc: Option<bool>,
) -> Result<CommonLiveStreamInfo, String> {
    let requested_id = payload.args.room_id_str.trim().to_string();
    if requested_id.is_empty() {
        return Ok(CommonLiveStreamInfo {
            title: None,
            anchor_name: None,
            avatar: None,
            cover_url: None,
            stream_url: None,
            status: None,
            error_message: Some("Douyin web_id cannot be empty.".to_string()),
            upstream_url: None,
            available_streams: None,
            normalized_room_id: None,
            web_rid: None,
        });
    }

    println!(
        "[Douyin Stream Detail] Fetching stream for '{}' with requested quality '{}'",
        requested_id, quality
    );

    let http_client = HttpClient::new_direct_connection()
        .map_err(|e| format!("Failed to create direct connection HttpClient: {}", e))?;

    let normalized_id = normalize_douyin_live_id(&requested_id);
    let DouyinRoomData { mut room } = fetch_room_data(&http_client, &normalized_id, None).await?;
    let room_id_str = room
        .get("id_str")
        .and_then(|v| v.as_str())
        .or_else(|| room.get("id").and_then(|v| v.as_str()))
        .map(|s| s.to_string())
        .unwrap_or_else(|| normalized_id.clone());
    let web_rid = extract_web_rid(&room).unwrap_or_else(|| normalized_id.clone());
    let status = room
        .get("status")
        .and_then(|v| v.as_i64())
        .unwrap_or_default() as i32;
    let title = room
        .get("title")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());
    let anchor_name = extract_anchor_name(&room);
    let avatar = extract_avatar(&room);
    let available_streams = collect_available_streams(&room);

    if status != 2 {
        println!(
            "[Douyin Stream Detail] Room '{}' is not live (status={}). Returning metadata only.",
            web_rid, status
        );
        return Ok(CommonLiveStreamInfo {
            title,
            anchor_name,
            avatar,
            cover_url: None,
            stream_url: None,
            status: Some(status),
            error_message: None,
            upstream_url: None,
            available_streams: available_streams.clone(),
            normalized_room_id: Some(room_id_str),
            web_rid: Some(web_rid),
        });
    }

    let mut candidates = super::quality_policy::collect(&room, allow_hevc.unwrap_or(false));
    // HTML parsing is only a last resort. It must not replace a structured SDK
    // original stream or add a page request to every normal channel switch.
    if candidates.is_empty() {
        if let Ok(Some(url)) = fetch_origin_flv_from_live_page(&http_client, &normalized_id).await {
            insert_origin_flv(&mut room, &url);
            candidates = super::quality_policy::collect(&room, allow_hevc.unwrap_or(false));
        }
    }
    let selected = super::web_api::select_reachable_stream(&http_client, &candidates, &quality, route.unwrap_or(0)).await?;
    let available_streams = Some(candidates.iter().map(|v| StreamVariant { fps: v.fps, codec: if v.hevc { Some("h265".into()) } else { None },
        url: v.url.clone(), format: Some(v.format.clone()), desc: Some(v.label.clone()),
        qn: Some(v.rank), requested_qn: None, protocol: Some("https".into()),
    }).collect());
    let sanitized_url = selected.url;

    Ok(CommonLiveStreamInfo {
        title,
        anchor_name,
        avatar,
        cover_url: None,
        stream_url: Some(sanitized_url.clone()),
        status: Some(status),
        error_message: None,
        upstream_url: Some(sanitized_url),
        available_streams,
        normalized_room_id: Some(room_id_str),
        web_rid: Some(web_rid),
    })
}

pub(crate) fn extract_web_rid(room: &Value) -> Option<String> {
    room.get("owner")
        .and_then(|o| o.get("web_rid"))
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
        .or_else(|| {
            room.get("anchor")
                .and_then(|a| a.get("web_rid"))
                .and_then(|v| v.as_str())
                .map(|s| s.to_string())
        })
        .or_else(|| {
            room.get("web_rid")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string())
        })
}

pub(crate) fn extract_anchor_name(room: &Value) -> Option<String> {
    room.get("anchor_name")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
        .or_else(|| {
            room.get("owner")
                .and_then(|o| o.get("nickname"))
                .and_then(|v| v.as_str())
                .map(|s| s.to_string())
        })
        .or_else(|| {
            room.get("anchor")
                .and_then(|a| a.get("nickname"))
                .and_then(|v| v.as_str())
                .map(|s| s.to_string())
        })
}

pub(crate) fn extract_avatar(room: &Value) -> Option<String> {
    room.get("owner")
        .and_then(|o| o.get("avatar_thumb"))
        .and_then(|thumb| thumb.get("url_list"))
        .and_then(|list| list.get(0))
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
        .or_else(|| {
            room.get("anchor")
                .and_then(|a| a.get("avatar_thumb"))
                .and_then(|thumb| thumb.get("url_list"))
                .and_then(|list| list.get(0))
                .and_then(|v| v.as_str())
                .map(|s| s.to_string())
        })
}

pub(crate) fn collect_available_streams(room: &Value) -> Option<Vec<StreamVariant>> {
    let all = super::quality_policy::collect(room, false);
    if all.is_empty() { return None; }
    Some(all.into_iter().map(|v| StreamVariant { fps: v.fps, codec: if v.hevc { Some("h265".into()) } else { None }, url: v.url, format: Some(v.format), desc: Some(v.label), qn: Some(v.rank), requested_qn: None, protocol: Some("https".into()) }).collect())
}

fn insert_origin_flv(room: &mut Value, origin_url: &str) {
    let Some(stream_url) = room.get_mut("stream_url") else {
        return;
    };
    let flv_map_val = stream_url.get_mut("flv_pull_url");
    match flv_map_val {
        Some(map_val) if map_val.is_object() => {
            if let Some(map) = map_val.as_object_mut() {
                map.insert("ORIGIN".to_string(), Value::String(origin_url.to_string()));
            }
        }
        _ => {
            let mut new_map = serde_json::Map::new();
            new_map.insert("ORIGIN".to_string(), Value::String(origin_url.to_string()));
            stream_url.as_object_mut().map(|obj| {
                obj.insert("flv_pull_url".to_string(), Value::Object(new_map))
            });
        }
    }
}

async fn fetch_origin_flv_from_live_page(
    http_client: &HttpClient,
    web_id: &str,
) -> Result<Option<String>, String> {
    let url = format!("https://live.douyin.com/{}", web_id);
    let mut headers = HeaderMap::new();
    headers.insert(USER_AGENT, HeaderValue::from_static(DEFAULT_USER_AGENT));
    headers.insert(
        REFERER,
        HeaderValue::from_str(&url).map_err(|e| format!("Invalid Referer header: {}", e))?,
    );

    let html = http_client
        .get_text_with_headers(&url, Some(headers))
        .await?;
    Ok(extract_origin_flv_from_html(&html))
}

fn extract_origin_flv_from_html(html: &str) -> Option<String> {
    let re = Regex::new(r#"https?://[^"'\s]*stream-\d+\.flv[^"'\s]*"#).ok()?;
    for m in re.find_iter(html) {
        let mut url = unescape_js_escapes(m.as_str());
        url = url.replace("&amp;", "&");
        let host = url
            .split("://")
            .nth(1)
            .and_then(|rest| rest.split('/').next())
            .unwrap_or("");
        if super::quality_policy::is_live_video_url(&url)
            && !url.contains("_uhd.flv")
            && !url.contains("only_audio=1")
            && !url.contains("pull-hs")
            && !url.contains("wsSecret")
            && host.contains("flv")
        {
            return Some(url);
        }
    }
    None
}

fn unescape_js_escapes(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    let mut chars = input.chars().peekable();
    while let Some(ch) = chars.next() {
        if ch == '\\' {
            match chars.peek() {
                Some('u') => {
                    chars.next();
                    let mut hex = String::new();
                    for _ in 0..4 {
                        if let Some(h) = chars.next() {
                            hex.push(h);
                        } else {
                            break;
                        }
                    }
                    if let Ok(code) = u16::from_str_radix(&hex, 16) {
                        if let Some(decoded) = char::from_u32(code as u32) {
                            out.push(decoded);
                            continue;
                        }
                    }
                    out.push('\\');
                    out.push('u');
                    out.push_str(&hex);
                }
                Some('/') => {
                    chars.next();
                    out.push('/');
                }
                Some('\\') => {
                    chars.next();
                    out.push('\\');
                }
                Some('"') => {
                    chars.next();
                    out.push('"');
                }
                Some('\'') => {
                    chars.next();
                    out.push('\'');
                }
                Some('n') => {
                    chars.next();
                    out.push('\n');
                }
                Some('r') => {
                    chars.next();
                    out.push('\r');
                }
                Some('t') => {
                    chars.next();
                    out.push('\t');
                }
                _ => out.push(ch),
            }
        } else {
            out.push(ch);
        }
    }
    out
}
