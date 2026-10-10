#[derive(Debug, Clone)]
pub struct Variant {
    pub url: String,
    pub qn: i32,
    pub fps: Option<f64>,
    pub codec: Option<String>,
    pub label: String,
}

// Attribute values can contain commas (notably CODECS).
fn attributes(line: &str) -> Vec<(&str, &str)> {
    let mut quoted = false;
    let mut start = 0;
    let mut parts = Vec::new();
    for (i, c) in line.char_indices() {
        if c == '"' { quoted = !quoted; }
        if c == ',' && !quoted { parts.push(&line[start..i]); start = i + 1; }
    }
    parts.push(&line[start..]);
    parts.into_iter().filter_map(|s| s.split_once('='))
        .map(|(k,v)| (k.trim(), v.trim().trim_matches('"'))).collect()
}

pub fn parse(text: &str, quality: &str) -> Vec<Variant> {
    if !text.trim_start_matches('\u{feff}').trim_start().starts_with("#EXTM3U") { return vec![]; }
    let mut pending = None;
    let mut variants = Vec::new();
    for line in text.lines().map(str::trim) {
        if let Some(info) = line.strip_prefix("#EXT-X-STREAM-INF:") {
            pending = Some(attributes(info));
        } else if !line.is_empty() && !line.starts_with('#') {
            let Some(attrs) = pending.take() else { continue };
            let get = |key| attrs.iter().find(|(k,_)| *k == key).map(|(_,v)| *v);
            // Keep the tested hardware-decodable AVC path used by our HLS player.
            if !get("CODECS").is_some_and(|v| v.split(',').any(|c| c.trim().starts_with("avc1"))) { continue; }
            if !line.starts_with("https://") { continue; }
            let Some(qn) = get("BILI-QN").and_then(|v| v.parse::<i32>().ok()).filter(|q| *q > 0) else { continue };
            let name = get("BILI-DISPLAY").unwrap_or("直播");
            let height = get("RESOLUTION").and_then(|v| v.split_once('x')).and_then(|(_,h)| h.parse::<u32>().ok());
            let label = height.map(|h| format!("{}P {}", h, name)).unwrap_or_else(|| name.to_string());
            let fps = get("FRAME-RATE").and_then(|v| v.parse::<f64>().ok()).filter(|n| *n > 0.0 && *n <= 240.0);
            let codec = get("CODECS").and_then(|v| v.split(',').find(|c| c.trim().starts_with("avc1"))).map(|c| c.trim().to_string());
            variants.push(Variant { url: line.to_string(), qn, label, fps, codec });
        }
    }
    let cap = match quality { "高清" => 400, "标清" => 250, _ => i32::MAX };
    let target = variants.iter().map(|v| v.qn).filter(|q| *q <= cap).max()
        .or_else(|| variants.iter().map(|v| v.qn).min());
    variants.retain(|v| Some(v.qn) == target);
    variants
}

#[cfg(test)]
mod tests {
    use super::*;
    const PLAYLIST: &str = "#EXTM3U\n#EXT-X-STREAM-INF:CODECS=\"hvc1.1,mp4a.40.2\",BILI-QN=20000\nhttps://cdn/hevc\n#EXT-X-STREAM-INF:CODECS=\"avc1.640032,mp4a.40.2\",BILI-QN=10000,RESOLUTION=1920x1080,BILI-DISPLAY=\"原画\"\nhttps://cdn/high?a=1&b=2\n#EXT-X-STREAM-INF:CODECS=\"avc1.640032\",BILI-QN=250,RESOLUTION=1280x720,BILI-DISPLAY=\"超清\"\nhttps://cdn/low";
    #[test] fn selects_highest_avc_and_preserves_signed_url() {
        let v = parse(PLAYLIST,"原画"); assert_eq!(v.len(),1);
        assert_eq!(v[0].url,"https://cdn/high?a=1&b=2"); assert_eq!(v[0].label,"1080P 原画");
    }
    #[test] fn lower_quality_does_not_silently_select_highest() {
        assert_eq!(parse(PLAYLIST,"标清")[0].qn,250);
        assert_eq!(parse(PLAYLIST,"高清")[0].qn,250);
    }
    #[test] fn errors_and_incomplete_entries_fall_back() {
        assert!(parse("{\"code\":-1}","原画").is_empty());
        assert!(parse("#EXTM3U\n#EXT-X-STREAM-INF:BILI-QN=10000", "原画").is_empty());
        assert!(parse("#EXTM3U\nhttps://cdn/unknown", "原画").is_empty());
    }
}
