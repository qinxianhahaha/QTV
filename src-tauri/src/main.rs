// 在开发模式下允许控制台窗口
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use reqwest;
use std::panic;
use std::env;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::sync::oneshot;
use tauri::Manager;
use tauri_plugin_opener::OpenerExt;
mod logging;
mod config_transfer;
mod lan_sync;
mod sync_transfer;
mod platforms;
mod proxy;
mod network_policy;
mod network_settings;
mod direct_media;
mod direct_media_transport;
mod media_traffic;
mod media_playlist;
mod media_network_policy;
mod version_check;
mod window_layout;
use platforms::common::{DouyinDanmakuState, FollowHttpClient, HuyaDanmakuState};
use platforms::douyin::danmu::signature::generate_douyin_ms_token;
use platforms::douyin::fetch_douyin_partition_rooms;
use platforms::douyin::fetch_douyin_room_info;
use platforms::douyin::fetch_douyin_streamer_info;
use platforms::douyin::{start_douyin_danmu_listener, stop_douyin_danmu_listener};
use platforms::douyin::{get_douyin_live_stream_url, get_douyin_live_stream_url_with_quality};
use platforms::douyu::fetch_categories;
use platforms::douyu::fetch_douyu_room_info;
use platforms::douyu::fetch_three_cate;
use platforms::douyu::{fetch_live_list, fetch_live_list_for_cate3};
use platforms::huya::stop_huya_danmaku_listener;
use platforms::huya::{fetch_huya_live_list, start_huya_danmaku_listener};
// use platforms::huya::get_huya_stream_url_with_quality; // removed in favor of unified cmd

#[derive(Default, Clone)]
pub struct StreamUrlStore {
    pub url: Arc<Mutex<String>>,
}

// State for managing Douyu danmaku listener handles (stop signals)
#[derive(Default, Clone)]
pub struct DouyuDanmakuHandles(Arc<Mutex<Option<oneshot::Sender<()>>>>);

#[tauri::command]
async fn get_stream_url_cmd(room_id: String) -> Result<String, String> {
    // Call the actual function to fetch the stream URL from the new location
    platforms::douyu::get_stream_url(&room_id, None)
        .await
        .map_err(|e| {
            eprintln!(
                "[Rust Error] Failed to get stream URL for room {}: {}",
                room_id,
                e.to_string()
            );
            format!("Failed to get stream URL: {}", e.to_string())
        })
}

#[tauri::command]
async fn get_stream_url_with_quality_cmd(
    room_id: String,
    quality: String,
    line: Option<String>,
) -> Result<String, String> {
    platforms::douyu::get_stream_url_with_quality(&room_id, &quality, line.as_deref())
        .await
        .map_err(|e| {
            eprintln!(
                "[Rust Error] Failed to get stream URL with quality {} for room {}: {}",
                quality,
                room_id,
                e.to_string()
            );
            format!("Failed to get stream URL with quality: {}", e.to_string())
        })
}

#[tauri::command]
async fn get_douyu_playback_cmd(app: tauri::AppHandle, room_id: String, quality: String, line: Option<String>, prefer_hevc: Option<bool>, route: Option<usize>) -> Result<platforms::douyu::stream_url::DouyuPlayback, String> {
    tokio::time::timeout(std::time::Duration::from_secs(30), async {
        let cookie = platforms::douyu::cookie::playback_cookie(app).await?;
        platforms::douyu::stream_url::get_playback_with_cookie(&room_id, &quality, line.as_deref(), prefer_hevc.unwrap_or(false), route.unwrap_or(0), cookie)
            .await.map_err(|e| e.to_string())
    }).await.map_err(|_| "获取斗鱼直播流超时，请检查网络后重试".to_string())?
}

// Legacy Huya stream URL command removed in favor of unified command

// This is the command that should be used for setting stream URL if it interacts with StreamUrlStore
#[tauri::command]
async fn set_stream_url_cmd(
    url: String,
    state: tauri::State<'_, StreamUrlStore>,
) -> Result<(), String> {
    let mut current_url = state.url.lock().unwrap();
    *current_url = url;
    Ok(())
}

// Command to start Douyu danmaku listener
#[tauri::command]
async fn start_danmaku_listener(
    room_id: String,
    window: tauri::Window,
    danmaku_handles: tauri::State<'_, DouyuDanmakuHandles>,
) -> Result<(), String> {
    // Business rule: only one room at a time. Always stop any previous listener first.
    let previous_sender = {
        let mut lock = danmaku_handles.0.lock().unwrap();
        lock.take()
    };
    if let Some(sender) = previous_sender {
        let _ = sender.send(());
    }

    let (stop_tx, stop_rx) = oneshot::channel();
    {
        let mut lock = danmaku_handles.0.lock().unwrap();
        *lock = Some(stop_tx);
    }

    let window_clone = window.clone();
    let room_id_clone = room_id.clone();
    tokio::spawn(async move {
        let mut client = platforms::douyu::danmu_start::DanmakuClient::new(
            &room_id_clone,
            window_clone,
            stop_rx, // Pass the receiver part of the oneshot channel
        );
        if let Err(e) = client.start().await {
            eprintln!(
                "[Rust Main] Douyu danmaku client for room {} failed: {}",
                room_id_clone, e
            );
        }
    });

    Ok(())
}

// Command to stop Douyu danmaku listener
#[tauri::command]
async fn stop_danmaku_listener(
    room_id: String,
    danmaku_handles: tauri::State<'_, DouyuDanmakuHandles>,
) -> Result<(), String> {
    // The `room_id` parameter is kept for frontend compatibility.
    // This backend is single-instance, so we always stop the current listener (if any).
    let sender = {
        let mut lock = danmaku_handles.0.lock().unwrap();
        lock.take()
    };
    if let Some(sender) = sender {
        match sender.send(()) {
            Ok(_) => Ok(()),
            Err(_) => Err(format!(
                "Failed to stop Douyu danmaku listener (requested room {}): receiver dropped.",
                room_id
            )),
        }
    } else {
        Ok(())
    }
}

// search_anchor seems fine, assuming douyu::search_anchor is correct
#[tauri::command]
async fn search_anchor(keyword: String) -> Result<String, String> {
    platforms::douyu::perform_anchor_search(&keyword)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn open_in_default_browser(app: tauri::AppHandle, url: String) -> Result<(), String> {
    let trimmed = url.trim();
    let parsed = url::Url::parse(trimmed).map_err(|_| "Invalid URL".to_string())?;
    if !network_policy::external_url_allowed(&parsed) {
        return Err("Only HTTP(S) links can be opened.".into());
    }
    app.opener()
        .open_url(trimmed, None::<String>)
        .map_err(|e| e.to_string())
}

// Use AppKit's native live-resize constraint: no JS resize feedback loop/jitter.
#[tauri::command]
async fn set_playback_aspect(window: tauri::WebviewWindow, locked: bool) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        let (tx, rx) = oneshot::channel();
        let target = window.clone();
        window.run_on_main_thread(move || {
            let result = target.ns_window().map_err(|e| e.to_string()).map(|ptr| {
                // Tauri owns this NSWindow; access is confined to its main thread.
                let native = unsafe { &*(ptr as *const objc2_app_kit::NSWindow) };
                let ratio = if locked { objc2_foundation::NSSize::new(16.0, 9.0) }
                    else { objc2_foundation::NSSize::new(0.0, 0.0) };
                native.setAspectRatio(ratio);
            });
            let _ = tx.send(result);
        }).map_err(|e| e.to_string())?;
        rx.await.map_err(|e| e.to_string())?
    }
    #[cfg(not(target_os = "macos"))]
    { let _ = (window, locked); Ok(()) }
}

// Resize and reposition together on the AppKit main thread, without showing an
// intermediate enlarged window at the small player's former corner position.
#[tauri::command]
async fn set_playback_layout(window: tauri::WebviewWindow, width: f64, compact: bool, center: bool, anchor_x: Option<f64>, anchor_y: Option<f64>) -> Result<(), String> {
    if !width.is_finite() || width < 1.0 || width > 20000.0 {
        return Err("Invalid window width".into());
    }
    #[cfg(target_os = "macos")]
    {
        let (tx, rx) = oneshot::channel();
        let target = window.clone();
        window.run_on_main_thread(move || {
            let result = target.ns_window().map_err(|e| e.to_string()).map(|ptr| {
                let native = unsafe { &*(ptr as *const objc2_app_kit::NSWindow) };
                let previous = native.frame();
                let pointer = match (anchor_x, anchor_y) {
                    (Some(x), Some(y)) if x.is_finite() && y.is_finite() =>
                        objc2_foundation::NSPoint::new(previous.origin.x + x, previous.origin.y + previous.size.height - y),
                    _ => objc2_app_kit::NSEvent::mouseLocation(),
                };
                let pointer_screen = if compact {
                    objc2_foundation::MainThreadMarker::new().and_then(|mtm| {
                        objc2_app_kit::NSScreen::screens(mtm).iter().find(|screen| {
                            let r = screen.frame();
                            pointer.x >= r.origin.x && pointer.x < r.origin.x + r.size.width
                                && pointer.y >= r.origin.y && pointer.y < r.origin.y + r.size.height
                        })
                    })
                } else { None };
                let area = pointer_screen.or_else(|| native.screen()).map(|screen| screen.visibleFrame());
                let to_frame = |rect: objc2_foundation::NSRect| window_layout::Frame {
                    x: rect.origin.x, y: rect.origin.y, width: rect.size.width, height: rect.size.height
                };
                let frame = window_layout::playback_frame(to_frame(previous), area.map(to_frame), width, center);
                let frame = if compact && !center {
                    window_layout::frame_at_pointer(frame, area.map(to_frame), pointer.x, pointer.y)
                } else { frame };
                let size = objc2_foundation::NSSize::new(frame.width, frame.height);
                let min_width = if compact { 480.0_f64 } else { 960.0_f64 }.min(frame.width);
                native.setContentMinSize(objc2_foundation::NSSize::new(min_width, min_width * 9.0 / 16.0));
                native.setAspectRatio(objc2_foundation::NSSize::new(16.0, 9.0));
                let origin = objc2_foundation::NSPoint::new(frame.x, frame.y);
                native.setFrame_display(objc2_foundation::NSRect::new(origin, size), true);
            });
            let _ = tx.send(result);
        }).map_err(|e| e.to_string())?;
        rx.await.map_err(|e| e.to_string())?
    }
    #[cfg(not(target_os = "macos"))]
    {
        let min_width = if compact { 480.0_f64 } else { 960.0_f64 }.min(width);
        window.set_min_size(Some(tauri::LogicalSize::new(min_width, min_width * 9.0 / 16.0))).map_err(|e| e.to_string())?;
        window.set_size(tauri::LogicalSize::new(width, width * 9.0 / 16.0)).map_err(|e| e.to_string())?;
        if center { window.center().map_err(|e| e.to_string())?; }
        Ok(())
    }
}

// Main function corrected
fn main() {
    logging::init();
    panic::set_hook(Box::new(|info| {
        eprintln!("[panic] {}", info);
    }));
    // Create a new HTTP client instance to be managed by Tauri
    let client = reqwest::Client::builder()
        .user_agent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36")
        .http1_only()
        .connect_timeout(Duration::from_secs(15))
        .no_proxy()
        .timeout(Duration::from_secs(45))
        .build()
        .expect("Failed to create reqwest client");
    let follow_http_client = FollowHttpClient::new().expect("Failed to create follow http client");

    tauri::Builder::default()
            .plugin(tauri_plugin_os::init())
            .plugin(tauri_plugin_opener::init())
            .plugin(tauri_plugin_window_state::Builder::default()
                .skip_initial_state("main")
                .with_state_flags(
                    tauri_plugin_window_state::StateFlags::SIZE
                        | tauri_plugin_window_state::StateFlags::POSITION
                        | tauri_plugin_window_state::StateFlags::MAXIMIZED
                )
                .build())
            .setup(|_app| {
                *_app.state::<network_settings::NetworkSettingsState>().0.lock().map_err(|_| "Network settings unavailable")? = network_settings::load(_app.handle())?;
                // Apply macOS vibrancy to the main window when running on macOS
                #[cfg(target_os = "macos")]
                {
                    use window_vibrancy::{apply_vibrancy, NSVisualEffectMaterial};
                    if let Some(window) = _app.get_webview_window("main") {
                        // Lock the home window from launch, before any player is opened.
                        if let Ok(ptr) = window.ns_window() {
                            let native = unsafe { &*(ptr as *const objc2_app_kit::NSWindow) };
                            native.setAspectRatio(objc2_foundation::NSSize::new(16.0, 9.0));
                            // Tauri's initial content size can include a titlebar rounding
                            // point. Normalize the outer frame before the first interaction.
                            let to_frame = |rect: objc2_foundation::NSRect| window_layout::Frame {
                                x: rect.origin.x, y: rect.origin.y,
                                width: rect.size.width, height: rect.size.height,
                            };
                            let previous = native.frame();
                            let area = native.screen().map(|screen| to_frame(screen.visibleFrame()));
                            let frame = window_layout::playback_frame(to_frame(previous), area, previous.size.width, true);
                            native.setFrame_display(objc2_foundation::NSRect::new(
                                objc2_foundation::NSPoint::new(frame.x, frame.y),
                                objc2_foundation::NSSize::new(frame.width, frame.height),
                            ), true);
                        }
                        match apply_vibrancy(&window, NSVisualEffectMaterial::HudWindow, None, None) {
                            Ok(_) => println!("vibrancy applied successfully"),
                            Err(e) => eprintln!("vibrancy error: {:?}", e),
                        }
                    }
                }
                Ok(())
            })
            .manage(client) // Manage the reqwest client
            .manage(network_settings::NetworkSettingsState::default())
            .manage(direct_media::DirectMediaState::default())
            .manage(follow_http_client) // 专用关注刷新客户端，避免占用默认连接池
            .manage(DouyuDanmakuHandles::default()) // Manage new DouyuDanmakuHandles
            .manage(DouyinDanmakuState::default()) // Manage DouyinDanmakuState
            .manage(HuyaDanmakuState::default()) // Manage HuyaDanmakuState
            .manage(platforms::common::BilibiliDanmakuState::default()) // Manage BilibiliDanmakuState
            .manage(StreamUrlStore::default())
            .manage(proxy::ProxyServerHandle::default())
            .manage(proxy::StaticProxyState::default())
            .manage(platforms::bilibili::state::BilibiliState::default())
            .manage(lan_sync::LanSyncServerState::default())
            .invoke_handler(tauri::generate_handler![
                network_settings::get_network_settings,
                network_settings::set_network_settings,
                direct_media::prepare_direct_media_url,
                direct_media::stop_direct_media,
                get_stream_url_cmd,
                set_playback_aspect,
                set_playback_layout,
                get_stream_url_with_quality_cmd,
            get_douyu_playback_cmd,
            platforms::douyu::cookie::open_douyu_login,
            platforms::douyu::cookie::get_douyu_login_status,
            platforms::douyu::cookie::close_douyu_login,
            platforms::douyu::cookie::clear_douyu_login,
                set_stream_url_cmd,
                search_anchor,
                config_transfer::save_config_export,
                config_transfer::pick_config_import,
                sync_transfer::export_lan_sync_json_to_desktop,
                sync_transfer::pick_lan_sync_json_import,
                sync_transfer::import_latest_lan_sync_json_from_desktop,
                lan_sync::lan_sync_start_server,
                lan_sync::lan_sync_stop_server,
                lan_sync::lan_sync_status,
                lan_sync::lan_sync_discover,
                lan_sync::lan_sync_fetch_manifest,
                lan_sync::lan_sync_fetch_payload,
                start_danmaku_listener,      // Douyu danmaku start
                stop_danmaku_listener,       // Douyu danmaku stop
                start_douyin_danmu_listener, // Added Douyin danmaku listener command
                stop_douyin_danmu_listener,  // Added Douyin danmaku stop command
                start_huya_danmaku_listener, // Added Huya danmaku listener command
                stop_huya_danmaku_listener,  // Added Huya danmaku stop command
                platforms::bilibili::danmaku::start_bilibili_danmaku_listener,
                platforms::bilibili::danmaku::stop_bilibili_danmaku_listener,
                proxy::start_proxy,
                proxy::stop_proxy,
                proxy::start_static_proxy_server,
                fetch_categories,
                fetch_live_list,
                fetch_live_list_for_cate3,
                fetch_douyu_room_info,
                fetch_three_cate,
                generate_douyin_ms_token,
                fetch_douyin_partition_rooms,
                get_douyin_live_stream_url,
                get_douyin_live_stream_url_with_quality,
                fetch_douyin_room_info,
                fetch_douyin_streamer_info,
                fetch_huya_live_list,
                platforms::huya::danmaku::fetch_huya_join_params,
                platforms::huya::stream_url::get_huya_unified_cmd,
                platforms::bilibili::state::generate_bilibili_w_webid,
                platforms::bilibili::live_list::fetch_bilibili_live_list,
                platforms::bilibili::stream_url::get_bilibili_live_stream_url_with_quality,
                platforms::bilibili::streamer_info::fetch_bilibili_streamer_info,
                platforms::bilibili::cookie::get_bilibili_cookie,
                platforms::bilibili::cookie::clear_bilibili_cookie,
                platforms::bilibili::cookie::bootstrap_bilibili_cookie,
                platforms::bilibili::search::search_bilibili_rooms,
                platforms::huya::search::search_huya_anchors,
                open_in_default_browser,
                version_check::check_version_cmd,
            ])
            .run(tauri::generate_context!())
            .expect("error while running tauri application");
}
