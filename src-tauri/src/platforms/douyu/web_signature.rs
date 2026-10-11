use md5::{Digest, Md5};
use serde_json::Value;

// Matches Douyu's current official web signing flow (web-encrypt-57bbddd0.js).
// getH5PlayV1 authenticates the signature, requested room and timestamp together.
pub fn stream_auth(data: &Value, room: &str, timestamp: u64) -> Result<String, &'static str> {
    let key = data["key"].as_str().filter(|v| !v.is_empty()).ok_or("斗鱼签名缺少 key")?;
    let mut auth = data["rand_str"].as_str().filter(|v| !v.is_empty()).ok_or("斗鱼签名缺少随机值")?.to_string();
    let rounds = data["enc_time"].as_u64().filter(|v| *v <= 100_000).ok_or("斗鱼签名迭代次数无效")?;
    for _ in 0..rounds { auth = format!("{:x}", Md5::digest(format!("{auth}{key}"))); }
    let suffix = if data["is_special"].as_i64() == Some(1) { String::new() } else { format!("{room}{timestamp}") };
    Ok(format!("{:x}", Md5::digest(format!("{auth}{key}{suffix}"))))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn matches_independent_official_protocol_vectors() {
        let key = json!({"key":"key","rand_str":"seed","enc_time":2,"is_special":0});
        assert_eq!(stream_auth(&key, "71415", 1700000000).unwrap(), "9be3c67b5a0d664156890e7553b0372d");
        let mut special = key.clone();
        special["is_special"] = json!(1);
        assert_eq!(stream_auth(&special, "71415", 1700000000).unwrap(), "4bb8b1c8328f39f138d71dfe7485bffb");
    }

    #[test]
    fn invalid_keys_cannot_trigger_unbounded_work() {
        for key in [json!({}), json!({"key":"key","rand_str":"seed","enc_time":-1}), json!({"key":"key","rand_str":"seed","enc_time":100001})] {
            assert!(stream_auth(&key, "71415", 1700000000).is_err());
        }
    }
}
