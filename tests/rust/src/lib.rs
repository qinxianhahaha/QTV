// Test production policies without building the desktop UI/V8.
#[path = "../../../src-tauri/src/platforms/bilibili/quality_policy.rs"]
pub mod bilibili_quality;
#[path = "../../../src-tauri/src/platforms/bilibili/master_playlist.rs"]
pub mod bilibili_playlist;
#[path = "../../../src-tauri/src/platforms/douyin/quality_policy.rs"]
pub mod douyin_quality;
#[path = "../../../src-tauri/src/platforms/douyu/quality_policy.rs"]
pub mod douyu_quality;
#[path = "../../../src-tauri/src/platforms/douyu/app_signature.rs"]
pub mod douyu_signature;
#[path = "../../../src-tauri/src/window_layout.rs"]
pub mod window_layout;
#[path = "../../../src-tauri/src/network_policy.rs"]
pub mod network_policy;
#[path = "../../../src-tauri/src/media_playlist.rs"]
pub mod media_playlist;
#[path = "../../../src-tauri/src/media_network_policy.rs"]
pub mod media_network_policy;
#[path = "../../../src-tauri/src/platforms/bilibili/packet.rs"]
pub mod bilibili_packet;

#[path = "../../../src-tauri/src/platforms/douyu/cookie_policy.rs"]
pub mod douyu_cookie;

#[path = "../../../src-tauri/src/platforms/douyu/web_signature.rs"]
pub mod douyu_web_signature;

#[path = "../../../src-tauri/src/direct_media_transport.rs"]
pub mod direct_media_transport;
