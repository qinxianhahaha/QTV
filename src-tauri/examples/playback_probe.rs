// Local diagnostic tool; not included in the application bundle.
#[path = "../src/platforms/common/http_client.rs"]
pub mod http_client;
#[path = "../src/platforms/douyu/quality_policy.rs"]
pub mod quality_policy;
#[path = "../src/platforms/douyu/app_signature.rs"]
pub mod app_signature;
#[path = "../src/platforms/douyu/web_signature.rs"]
pub mod web_signature;
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
    pub mod douyin { pub use crate::a_bogus; pub use crate::douyin_quality as quality_policy; }
}


#[tokio::main]
async fn main() {
    let args: Vec<String> = std::env::args().collect();
    if args.len() < 4 || !matches!(args[1].as_str(), "douyu" | "douyin") {
        eprintln!("Usage: playback_probe <douyu|douyin> <room-id> <output.json> [hevc|avc] [quality]");
        std::process::exit(2);
    }
    let result = if args[1] == "douyu" {
        let cookie = std::env::var("QTV_DOUYU_COOKIE_FILE").ok().map(|path| std::fs::read_to_string(path).expect("Cannot read local cookie file"));
        match douyu_stream::get_playback_with_cookie(&args[2], args.get(5).map(String::as_str).unwrap_or("原画"), Some(args.get(6).map(String::as_str).unwrap_or("ws-h5")), args.get(4).is_some_and(|s| s == "hevc"), 0, cookie).await {
            Ok(value) => serde_json::to_value(value).unwrap(),
            Err(e) => serde_json::json!({"error":e.to_string()}),
        }
    } else {
        let client = http_client::HttpClient::new_direct_connection().unwrap();
        match web_api::fetch_room_data(&client, &args[2], None).await {
            Ok(value) => {
                let all = douyin_quality::collect(&value.room, true);
                let selected = web_api::select_reachable_stream(&client, &all, "OD", 0).await;
                let variants: Vec<_> = all.iter().map(|v| serde_json::json!({"url":v.url,"rank":v.rank,"label":v.label,"hevc":v.hevc,"fps":v.fps,"format":v.format})).collect();
                serde_json::json!({"status":value.room["status"],"variants":variants,"selected_url":selected.as_ref().ok().map(|v| &v.url),"selection_error":selected.err()})
            },
            Err(e) => serde_json::json!({"error":e}),
        }
    };
    std::fs::write(&args[3], serde_json::to_string_pretty(&result).unwrap()).unwrap();
}
