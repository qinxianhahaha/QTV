//! Bounded, non-panicking parsing of untrusted Bilibili danmaku packets.
use serde_json::Value;
use std::io::Read;
const MAX_BYTES: usize = 8 * 1024 * 1024;

pub fn decode_packets(bytes: &[u8]) -> Vec<Value> {
    let mut out = Vec::new();
    let mut budget = MAX_BYTES;
    decode(bytes, 0, &mut budget, &mut out);
    out
}
fn decode(mut bytes: &[u8], depth: usize, budget: &mut usize, out: &mut Vec<Value>) {
    if depth > 4 || bytes.len() > MAX_BYTES { return; }
    while bytes.len() >= 16 && out.len() < 200 {
        let size = u32::from_be_bytes(bytes[0..4].try_into().unwrap()) as usize;
        let header = u16::from_be_bytes(bytes[4..6].try_into().unwrap()) as usize;
        if header < 16 || size < header || size > bytes.len() { return; }
        let version = u16::from_be_bytes(bytes[6..8].try_into().unwrap());
        let operation = u32::from_be_bytes(bytes[8..12].try_into().unwrap());
        let body = &bytes[header..size];
        if operation == 5 {
            if version == 0 || version == 1 {
                if let Ok(value) = serde_json::from_slice(body) { out.push(value); }
            } else if version == 2 || version == 3 {
                let reader: Box<dyn Read + '_> = if version == 3 { Box::new(brotlic::DecompressorReader::new(body)) }
                    else { Box::new(flate2::read::ZlibDecoder::new(body)) };
                let mut decoded = Vec::new();
                if reader.take(*budget as u64 + 1).read_to_end(&mut decoded).is_ok() && decoded.len() <= *budget {
                    *budget -= decoded.len();
                    decode(&decoded, depth + 1, budget, out);
                }
            }
        }
        bytes = &bytes[size..];
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    fn packet(body: &[u8], version: u16) -> Vec<u8> {
        let mut p = Vec::new(); p.extend_from_slice(&((body.len() + 16) as u32).to_be_bytes());
        p.extend_from_slice(&16u16.to_be_bytes()); p.extend_from_slice(&version.to_be_bytes());
        p.extend_from_slice(&5u32.to_be_bytes()); p.extend_from_slice(&1u32.to_be_bytes()); p.extend_from_slice(body); p
    }
    #[test]
    fn malformed_frames_never_panic_or_loop() {
        for length in 0..64 { assert!(decode_packets(&vec![0; length]).is_empty()); }
        let mut p = packet(b"{}", 0); p[4..6].copy_from_slice(&99u16.to_be_bytes());
        assert!(decode_packets(&p).is_empty());
        assert!(decode_packets(&packet(b"not brotli", 3)).is_empty());
    }
    #[test]
    fn coalesced_frames_are_bounded_and_preserve_messages() {
        let one = packet(br#"{"cmd":"DANMU_MSG"}"#, 0);
        assert_eq!(decode_packets(&one.repeat(2)).len(), 2);
        assert_eq!(decode_packets(&one.repeat(500)).len(), 200);
    }
    #[test]
    fn zlib_frame_is_decoded() {
        use std::io::Write;
        let mut encoder = flate2::write::ZlibEncoder::new(Vec::new(), flate2::Compression::default());
        encoder.write_all(&packet(br#"{"cmd":"test"}"#, 0)).unwrap();
        assert_eq!(decode_packets(&packet(&encoder.finish().unwrap(), 2))[0]["cmd"], "test");
    }
}
