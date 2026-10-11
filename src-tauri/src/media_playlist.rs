//! Rewrite every HLS resource through the same direct transport, including
//! variant playlists, encryption keys, initialization maps and byte ranges.
use url::Url;

pub fn rewrite_playlist(
    text: &str,
    base: &Url,
    mut register: impl FnMut(Url) -> Result<String, String>,
) -> Result<String, String> {
    let resolve = |value: &str, register: &mut dyn FnMut(Url) -> Result<String, String>| {
        if value.starts_with("data:") { return Ok(value.to_owned()); }
        register(base.join(value).map_err(|_| "Invalid playlist resource".to_string())?)
    };
    let mut output = String::with_capacity(text.len());
    for line in text.lines() {
        let trimmed = line.trim();
        if trimmed.starts_with('#') {
            let mut rest = line;
            while let Some(at) = rest.find("URI=\"") {
                output.push_str(&rest[..at + 5]);
                rest = &rest[at + 5..];
                let end = rest.find('"').ok_or("Unterminated playlist URI")?;
                output.push_str(&resolve(&rest[..end], &mut register)?);
                output.push('"');
                rest = &rest[end + 1..];
            }
            output.push_str(rest);
        } else if !trimmed.is_empty() {
            output.push_str(&resolve(trimmed, &mut register)?);
        }
        output.push('\n');
    }
    Ok(output)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn rewrites_variants_segments_keys_maps_and_partial_segments() {
        let base = Url::parse("https://cdn.example/live/master.m3u8?token=secret").unwrap();
        let input = "#EXTM3U\n#EXT-X-MEDIA:TYPE=AUDIO,URI=\"audio.m3u8\"\n#EXT-X-KEY:METHOD=AES-128,URI=\"../key?k=1\"\n#EXT-X-MAP:URI=\"init.mp4\",BYTERANGE=\"100@0\"\n#EXT-X-PART:DURATION=0.3,URI=\"part.m4s\"\n#EXT-X-STREAM-INF:BANDWIDTH=20000000\nhi/index.m3u8\n#EXT-X-BYTERANGE:123@456\n//other.example/seg.ts?t=2\n";
        let mut urls = Vec::new();
        let result = rewrite_playlist(input, &base, |url| { urls.push(url); Ok(format!("http://127.0.0.1/resource/{}", urls.len())) }).unwrap();
        assert_eq!(urls.len(), 6);
        assert_eq!(urls[1].as_str(), "https://cdn.example/key?k=1");
        assert_eq!(urls[4].as_str(), "https://cdn.example/live/hi/index.m3u8");
        assert_eq!(urls[5].as_str(), "https://other.example/seg.ts?t=2");
        assert!(result.contains("BANDWIDTH=20000000"));
        assert!(result.contains("BYTERANGE=\"100@0\""));
        assert!(result.contains("#EXT-X-BYTERANGE:123@456"));
        assert!(!result.contains("secret"));
    }
    #[test]
    fn preserves_inline_keys_and_rejects_invalid_resources() {
        let base = Url::parse("https://cdn.example/index.m3u8").unwrap();
        let input = "#EXTM3U\n#EXT-X-KEY:URI=\"data:application/octet-stream;base64,YQ==\"\n";
        assert_eq!(rewrite_playlist(input, &base, |_| panic!("inline key must not be fetched")).unwrap(), input);
        assert!(rewrite_playlist("#EXT-X-KEY:URI=\"broken", &base, |_| Ok(String::new())).is_err());
        assert!(rewrite_playlist("http://127.0.0.1/private", &base, |_| Err("private target".into())).is_err());
    }
}
