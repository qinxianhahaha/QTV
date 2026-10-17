//! Loopback media transport, preserving source quality and native decoding.
use actix_web::{dev::ServerHandle, web, App, HttpServer};
use rand::{distributions::Alphanumeric, Rng};
use std::{collections::{HashMap, VecDeque}, net::TcpListener, sync::Mutex};
use tauri::State;
use url::Url;
use crate::{media_network_policy::media_url_allowed, network_settings::NetworkSettingsState,
    direct_media_transport::{Resources, Transport, relay, direct_client_builder}};

#[derive(Default)]
pub struct DirectMediaState(pub Mutex<Option<ServerHandle>>);

#[tauri::command]
pub async fn prepare_direct_media_url(url: String, platform: String, settings: State<'_, NetworkSettingsState>, state: State<'_, DirectMediaState>) -> Result<String, String> {
    if !settings.0.lock().map_err(|_| "Network settings unavailable")?.direct_playback { return Ok(url); }
    let parsed = Url::parse(&url).map_err(|_| "Invalid media URL")?;
    // Existing platform FLV relays already connect directly. Avoid copying a
    // live stream through two relays or destroying its existing transport.
    if parsed.scheme() == "http" && parsed.host_str() == Some("127.0.0.1") { return Ok(url); }
    if !media_url_allowed(&parsed) { return Err("Unsupported direct media URL".into()); }
    let previous = state.0.lock().map_err(|_| "Media state unavailable")?.take();
    if let Some(handle) = previous { handle.stop(false).await; }
    let referer = match platform.as_str() {
        "douyu" => "https://www.douyu.com/", "huya" => "https://www.huya.com/",
        "douyin" => "https://live.douyin.com/", "bilibili" => "https://live.bilibili.com/",
        _ => return Err("Unsupported platform".into()),
    };
    let listener = TcpListener::bind(("127.0.0.1", 0)).map_err(|e| e.to_string())?;
    let port = listener.local_addr().map_err(|e| e.to_string())?.port();
    let token: String = rand::thread_rng().sample_iter(&Alphanumeric).take(32).map(char::from).collect();
    let prefix = format!("/{token}");
    let mut resources = Resources { base: format!("http://127.0.0.1:{port}{prefix}"), urls: HashMap::new(), ids: HashMap::new(), order: VecDeque::new(), next_id: 0 };
    let output = resources.register(parsed)?;
    let client = direct_client_builder().and_then(|builder| builder.build()).map_err(|e| e.to_string())?;
    let transport = web::Data::new(Transport { client, resources: Mutex::new(resources), referer });
    let route = format!("{prefix}/{{id}}/{{file}}");
    let traffic_route = format!("{prefix}/traffic");
    let traffic = web::Data::new(crate::media_traffic::MediaTraffic::default());
    let server = HttpServer::new(move || App::new().app_data(transport.clone()).app_data(traffic.clone())
        .wrap(actix_cors::Cors::default().allowed_origin("tauri://localhost").allowed_origin("http://tauri.localhost")
            .allowed_origin("https://tauri.localhost").allowed_origin("http://localhost:2896")
            .allowed_methods(vec!["GET", "HEAD", "OPTIONS"]).allow_any_header().expose_headers(vec!["Content-Range", "Accept-Ranges", "Content-Length"]))
        .route(&traffic_route, web::get().to(crate::media_traffic::snapshot))
        .route(&route, web::get().to(relay)).route(&route, web::head().to(relay)))
        .workers(2).listen(listener).map_err(|e| e.to_string())?.run();
    *state.0.lock().map_err(|_| "Media state unavailable")? = Some(server.handle());
    tauri::async_runtime::spawn(server);
    Ok(output)
}

#[tauri::command]
pub async fn stop_direct_media(state: State<'_, DirectMediaState>) -> Result<(), String> {
    let handle = state.0.lock().map_err(|_| "Media state unavailable")?.take();
    if let Some(handle) = handle { handle.stop(false).await; }
    Ok(())
}
