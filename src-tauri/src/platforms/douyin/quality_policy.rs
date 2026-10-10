use serde_json::Value;

#[derive(Clone, Debug)]
pub struct Candidate {
    pub url: String,
    pub rank: i32,
    pub label: String,
    pub format: String,
    pub hevc: bool,
    pub fps: Option<f64>,
}

fn rank(key: &str) -> i32 {
    match key.to_ascii_lowercase().as_str() {
        "origin" | "od" => 600,
        "uhd" | "full_hd1" | "bd" => 500,
        "hd" | "hd1" => 400,
        "sd" | "sd1" => 300,
        "ld" | "sd2" => 200,
        "md" => 100,
        _ => 0,
    }
}
fn label(rank: i32) -> &'static str {
    match rank { 600 => "原画", 500 => "超清", 400 => "高清", 300 => "标清", 200 => "流畅", _ => "直播" }
}

pub fn is_live_video_url(url: &str) -> bool {
    (url.starts_with("https://") || url.starts_with("http://"))
        && !url.contains("only_audio=1") && !url.contains("only_audio%3D1")
        && !url.contains("reflow_room_info")
}

fn add(out: &mut Vec<Candidate>, key: &str, format: &str, url: &str, hevc: bool) {
    if !is_live_video_url(url) || out.iter().any(|v| v.url == url) { return; }
    let rank = rank(key);
    // Unknown keys (such as SDK audio-only `ao`) must never outrank video.
    if rank == 0 { return; }
    out.push(Candidate { url: url.replacen("http://", "https://", 1), rank, label: label(rank).into(), format: format.into(), hevc, fps: None });
}

fn read_sdk(out: &mut Vec<Candidate>, encoded: &Value) {
    let parsed;
    let data = if let Some(text) = encoded.as_str() {
        parsed = serde_json::from_str::<Value>(text).unwrap_or(Value::Null);
        &parsed
    } else { encoded };
    let Some(qualities) = data.get("data").and_then(Value::as_object) else { return };
    for (key, entry) in qualities {
        for path in ["main", "backup"] {
            let Some(main) = entry.get(path) else { continue };
            let sdk = main.get("sdk_params").and_then(Value::as_str)
                .and_then(|s| serde_json::from_str::<Value>(s).ok()).unwrap_or(Value::Null);
            let codec = sdk.get("VCodec").and_then(Value::as_str).unwrap_or("").to_ascii_lowercase();
            let hevc = codec.contains("265") || codec.contains("hevc");
            for format in ["flv", "hls"] {
                if let Some(url) = main.get(format).and_then(Value::as_str) {
                    add(out, key, format, url, hevc);
                    if let Some(v) = out.iter_mut().find(|v| v.url == url) {
                        v.fps = sdk.get("VFrameRate").or_else(|| sdk.get("fps")).and_then(|v| v.as_f64().or_else(|| v.as_str().and_then(|s| s.parse().ok()))).filter(|n| *n > 0.0 && *n <= 240.0);
                    }
                }
            }
        }
    }
}

pub fn collect(room: &Value, allow_hevc: bool) -> Vec<Candidate> {
    let stream = &room["stream_url"];
    let mut out = Vec::new();
    // The primary SDK data has precedence; inspect every pull_data, not the
    // first alphabetically sorted entry (which may be an audio-only stream).
    read_sdk(&mut out, &stream["live_core_sdk_data"]["pull_data"]["stream_data"]);
    if let Some(datas) = stream["pull_datas"].as_object() {
        for entry in datas.values() { read_sdk(&mut out, &entry["stream_data"]); }
    }
    for (map, format) in [("flv_pull_url", "flv"), ("hls_pull_url_map", "hls")] {
        if let Some(entries) = stream[map].as_object() {
            for (key, value) in entries {
                if let Some(url) = value.as_str() {
                    let hevc = url.contains("codec=h265") || url.contains("codec=hevc");
                    add(&mut out, key, format, url, hevc);
                }
            }
        }
    }
    out.retain(|v| allow_hevc || !v.hevc);
    // Stable sorting preserves API primary order within the same quality.
    out.sort_by_key(|v| (std::cmp::Reverse(v.rank), v.format != "flv", v.hevc));
    out
}

pub fn select(candidates: &[Candidate], quality: &str, route: usize) -> Option<Candidate> {
    let cap = match quality { "UHD" | "高清" => 500, "BD" | "标清" => 400, _ => 600 };
    let target = candidates.iter().map(|v| v.rank).filter(|r| *r <= cap).max()
        .or_else(|| candidates.iter().map(|v| v.rank).min())?;
    let same_quality: Vec<_> = candidates.iter().filter(|v| v.rank == target).collect();
    same_quality.get(route % same_quality.len()).map(|v| (*v).clone())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test] fn sdk_original_precedes_legacy_map_and_is_not_rewritten() {
        let room = json!({"stream_url":{"live_core_sdk_data":{"pull_data":{"stream_data":json!({"data":{"origin":{"main":{"flv":"https://cdn/origin?signature=a%2Bb","sdk_params":"{\"VCodec\":\"h264\"}"}},"uhd":{"main":{"flv":"https://cdn/uhd"}}}}).to_string()}},"flv_pull_url":{"ORIGIN":"https://cdn/legacy","HD1":"https://cdn/hd"}}});
        let all=collect(&room,false);
        assert_eq!(select(&all,"OD",0).unwrap().url,"https://cdn/origin?signature=a%2Bb");
        assert_eq!(select(&all,"OD",1).unwrap().rank,600);
        assert_eq!(select(&all,"UHD",0).unwrap().url,"https://cdn/uhd");
        assert_eq!(select(&all,"BD",0).unwrap().url,"https://cdn/hd");
    }
    #[test] fn audio_replays_and_incompatible_codecs_are_excluded() {
        let room=json!({"stream_url":{"pull_datas":{"audio":{"stream_data":"{}"},"video":{"stream_data":{"data":{"origin":{"main":{"flv":"https://cdn/hevc","sdk_params":"{\"VCodec\":\"h265\"}"}},"uhd":{"main":{"flv":"https://cdn/video"}}}}}},"flv_pull_url":{"ORIGIN":"https://cdn/replay?rtm_expr_tag=reflow_room_info","HD1":"https://cdn/audio?only_audio=1"}}});
        assert_eq!(collect(&room,false).len(),1);
        assert_eq!(select(&collect(&room,true),"OD",0).unwrap().url,"https://cdn/hevc");
        assert!(select(&[],"OD",0).is_none());
    }
    #[test] fn recovery_never_silently_rotates_into_a_lower_quality() {
        let room=json!({"stream_url":{"flv_pull_url":{"HD1":"https://cdn/hd","FULL_HD1":"https://cdn/full","ORIGIN":"https://cdn/origin"},"hls_pull_url_map":{"ORIGIN":"https://cdn/origin.m3u8"}}});
        let all=collect(&room,false);
        for route in 0..8 { assert_eq!(select(&all,"OD",route).unwrap().rank,600); }
    }
}
