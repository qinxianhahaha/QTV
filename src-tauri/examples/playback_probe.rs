// Local diagnostic tool; not included in the application bundle.
#[path = "../src/platforms/common/http_client.rs"]
pub mod http_client;
#[path = "../src/platforms/douyu/quality_policy.rs"]
pub mod quality_policy;
#[path = "../src/platforms/douyu/app_signature.rs"]
pub mod app_signature;
#[path = "../src/platforms/douyu/stream_url.rs"]
pub mod douyu_stream;
#[path = "../src/platforms/douyin/quality_policy.rs"]
pub mod douyin_quality;
#[path = "../src/platforms/douyin/a_bogus.rs"]
pub mod a_bogus;
#[path = "../src/platforms/douyin/web_api.rs"]
pub mod web_api;
mod platforms {
    pub mod common { pub use crate::http_client; }
    pub mod douyin { pub use crate::a_bogus; }
}

#[tokio::main]
async fn main() {
    let args: Vec<String> = std::env::args().collect();
    if args.len() < 4 || !matches!(args[1].as_str(), "douyu" | "douyin") {
        eprintln!("Usage: playback_probe <douyu|douyin> <room-id> <output.json> [hevc|avc] [quality]");
        std::process::exit(2);
    }
    let result = if args[1] == "douyu" {
        match douyu_stream::get_playback(&args[2], args.get(5).map(String::as_str).unwrap_or("原画"), Some("ws-h5"), args.get(4).is_some_and(|s| s == "hevc"), 0).await {
            Ok(value) => serde_json::to_value(value).unwrap(),
            Err(e) => serde_json::json!({"error":e.to_string()}),
        }
    } else {
        let client = http_client::HttpClient::new_direct_connection().unwrap();
        match web_api::fetch_room_data(&client, &args[2], None).await {
            Ok(value) => {
                let all = douyin_quality::collect(&value.room, true);
                let variants: Vec<_> = all.iter().map(|v| serde_json::json!({"url":v.url,"rank":v.rank,"label":v.label,"hevc":v.hevc,"fps":v.fps,"format":v.format})).collect();
                serde_json::json!({"status":value.room["status"],"variants":variants})
            },
            Err(e) => serde_json::json!({"error":e}),
        }
    };
    std::fs::write(&args[3], serde_json::to_string_pretty(&result).unwrap()).unwrap();
}
