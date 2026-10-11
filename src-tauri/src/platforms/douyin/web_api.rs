use crate::platforms::common::http_client::HttpClient;
use crate::platforms::douyin::a_bogus::generate_a_bogus;
use crate::platforms::douyin::quality_policy;
use reqwest::header::{HeaderMap, HeaderValue, ACCEPT_ENCODING, COOKIE, REFERER, USER_AGENT};
use serde_json::Value;

// Use the tested cookie from douyin_rust sample to improve API success.
const DEFAULT_COOKIE: &str =
    "ttwid=1%7C2iDIYVmjzMcpZ20fcaFde0VghXAA3NaNXE_SLR68IyE%7C1761045455%7Cab35197d5cfb21df6cbb2fa7ef1c9262206b062c315b9d04da746d0b37dfbc7d";
// Align UA with the working Douyin Rust sample to keep a_bogus inputs consistent.
pub const DEFAULT_USER_AGENT: &str =
    "Mozilla/5.0 (Windows NT 10.0; WOW64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/116.0.5845.97 Safari/537.36 Core/1.116.567.400 QQBrowser/19.7.6764.400";

#[derive(Debug, Clone)]
pub struct DouyinRoomData {
    pub room: Value,
}

async fn fetch_room_from_api(
    http_client: &HttpClient,
    web_id: &str,
    cookies: Option<&str>,
) -> Result<DouyinRoomData, String> {
    let mut headers = HeaderMap::new();
    headers.insert(USER_AGENT, HeaderValue::from_static(DEFAULT_USER_AGENT));
    headers.insert(REFERER, HeaderValue::from_str(&format!("https://live.douyin.com/{web_id}")).map_err(|e| format!("Invalid Referer: {e}"))?);
    headers.insert(ACCEPT_ENCODING, HeaderValue::from_static("identity"));
    headers.insert(COOKIE, HeaderValue::from_str(cookies.unwrap_or(DEFAULT_COOKIE)).map_err(|e| format!("Invalid cookie header value: {}", e))?);

    let params = vec![
        ("aid", "6383"),
        ("app_name", "douyin_web"),
        ("live_id", "1"),
        ("device_platform", "web"),
        ("language", "zh-CN"),
        ("browser_language", "zh-CN"),
        ("browser_platform", "Win32"),
        ("browser_name", "Chrome"),
        ("browser_version", "116.0.0.0"),
        ("web_rid", web_id),
        ("msToken", ""),
    ];
    let query = serde_urlencoded::to_string(&params)
        .map_err(|e| format!("Failed to encode Douyin enter params: {}", e))?;
    let sign = generate_a_bogus(&query, DEFAULT_USER_AGENT);
    let api = format!(
        "https://live.douyin.com/webcast/room/web/enter/?{}&a_bogus={}",
        query,
        sign
    );
    let json: Value = http_client
        .inner
        .get(&api)
        .headers(headers)
        .send()
        .await
        .map_err(|e| format!("Failed to request Douyin web enter API: {}", e))?
        .json()
        .await
        .map_err(|e| format!("Failed to parse Douyin web enter response: {}", e))?;

    let room = json
        .get("data")
        .and_then(|d| d.get("data"))
        .and_then(|arr| arr.get(0))
        .cloned()
        .ok_or_else(|| "Douyin web enter API did not return room data".to_string())?;

    let anchor_name = json
        .get("data")
        .and_then(|d| d.get("user"))
        .and_then(|u| u.get("nickname"))
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());

    let mut room_mut = room;
    if let Some(name) = anchor_name {
        if let Some(obj) = room_mut.as_object_mut() {
            obj.insert("anchor_name".to_string(), Value::String(name));
        }
    }
    Ok(DouyinRoomData { room: room_mut })
}

/// Normalize user input into a Douyin web_id. Supports raw IDs and full URLs such as
/// `https://live.douyin.com/123456` or `https://www.douyin.com/follow/live/123456`.
pub fn normalize_douyin_live_id(id_or_url: &str) -> String {
    let trimmed = id_or_url.trim();
    if trimmed.is_empty() {
        return String::new();
    }

    // Prefer explicit room/query parameters if present.
    if let Some(qpos) = trimmed.find('?') {
        let query = &trimmed[qpos + 1..];
        for kv in query.split('&') {
            if let Some(val) = kv
                .strip_prefix("room_id=")
                .or_else(|| kv.strip_prefix("roomId="))
                .or_else(|| kv.strip_prefix("web_rid="))
                .or_else(|| kv.strip_prefix("webId="))
            {
                let cleaned = val
                    .split(['&', '#'])
                    .find(|s| !s.is_empty())
                    .unwrap_or(val);
                if !cleaned.is_empty() {
                    return cleaned.to_string();
                }
            }
        }
    }

    // Handle any douyin.com URL (live.douyin.com, www.douyin.com/follow/live/xxx, etc.).
    if let Some(pos) = trimmed.find("douyin.com/") {
        let start = pos + "douyin.com/".len();
        let remainder = &trimmed[start..];
        let path_only = remainder.split(['?', '#']).next().unwrap_or(remainder);
        if let Some(segment) = path_only
            .rsplit('/')
            .find(|segment| !segment.is_empty())
        {
            return segment
                .split(['?', '&', '#'])
                .find(|s| !s.is_empty())
                .unwrap_or(segment)
                .to_string();
        }
    }

    // Fallback: strip trailing query/hash from raw input.
    trimmed
        .split(['?', '&', '#'])
        .find(|s| !s.is_empty())
        .unwrap_or(trimmed)
        .to_string()
}

pub async fn fetch_room_data(
    http_client: &HttpClient,
    raw_id: &str,
    cookies: Option<&str>,
) -> Result<DouyinRoomData, String> {
    let web_id = normalize_douyin_live_id(raw_id);
    // 简化逻辑：直接走网页版接口 + a_bogus，避免 HTML 解析失败。
    fetch_room_from_api(http_client, &web_id, cookies).await
}

/// Validate CDN redirects with TLS verification before handing the URL to WebKit.
/// A broken primary CDN must not prevent a working, equally sharp backup playing.
pub async fn select_reachable_stream(
    client: &HttpClient,
    candidates: &[quality_policy::Candidate],
    quality: &str,
    route: usize,
) -> Result<quality_policy::Candidate, String> {
    let first = quality_policy::select(candidates, quality, route)
        .ok_or_else(|| "主播在线，但没有可播放的视频流".to_string())?;
    let count = candidates.iter().filter(|v| v.rank == first.rank).count();
    for offset in 0..count.min(3) {
        let candidate = quality_policy::select(candidates, quality, route.wrapping_add(offset)).unwrap();
        // Drop the response immediately after receiving headers; never buffer a live stream.
        let result = client.inner.get(&candidate.url)
            .header(USER_AGENT, DEFAULT_USER_AGENT)
            .header(REFERER, "https://live.douyin.com/")
            .header(reqwest::header::RANGE, "bytes=0-1023")
            .timeout(std::time::Duration::from_secs(4))
            .send().await;
        if result.is_ok_and(|response| response.status().is_success()) {
            return Ok(candidate);
        }
    }
    Err("主播在线，但当前画质的播放线路暂时不可用，请刷新或切换线路重试".into())
}
