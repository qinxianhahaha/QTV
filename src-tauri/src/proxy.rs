use actix_web::{dev::ServerHandle, web, App, HttpRequest, HttpResponse, HttpServer};
use futures_util::{StreamExt, TryStreamExt};
use rand::{distributions::Alphanumeric, Rng};
use reqwest::Client;
use serde::Deserialize;
use std::{net::TcpListener, sync::Mutex, time::Duration};
use tauri::{AppHandle, State};
use crate::{network_policy::image_url_allowed, StreamUrlStore};

#[derive(Default)]
pub struct ProxyServerHandle(pub Mutex<Option<ServerHandle>>);
#[derive(Default)]
pub struct StaticProxyState(Mutex<Option<(String, ServerHandle)>>);

fn nonce() -> String {
    rand::thread_rng().sample_iter(&Alphanumeric).take(32).map(char::from).collect()
}

fn cors() -> actix_cors::Cors {
    actix_cors::Cors::default()
        .allowed_origin("tauri://localhost")
        .allowed_origin("http://tauri.localhost")
        .allowed_origin("https://tauri.localhost")
        .allowed_origin("http://localhost:2896")
        .allowed_methods(vec!["GET", "HEAD", "OPTIONS"])
        .allow_any_header()
}

fn image_client() -> Result<Client, String> {
    Client::builder().no_proxy().connect_timeout(Duration::from_secs(8))
        .timeout(Duration::from_secs(20)).pool_max_idle_per_host(4)
        .redirect(reqwest::redirect::Policy::custom(|attempt| {
            if attempt.previous().len() >= 4 || !image_url_allowed(attempt.url()) {
                attempt.error("Image redirect is outside supported CDN domains")
            } else { attempt.follow() }
        })).build().map_err(|e| e.to_string())
}

#[derive(Deserialize)]
struct ImageQuery { url: String, fresh: Option<String> }

async fn image_proxy_handler(query: web::Query<ImageQuery>, client: web::Data<Client>) -> HttpResponse {
    let Ok(url) = reqwest::Url::parse(&query.url) else { return HttpResponse::BadRequest().finish() };
    if !image_url_allowed(&url) { return HttpResponse::Forbidden().body("Unsupported image host") }
    let host = url.host_str().unwrap_or("");
    let referer = if host.ends_with("hdslb.com") || host.ends_with("bilibili.com") { "https://live.bilibili.com/" }
        else if host.ends_with("msstatic.com") || host.contains("huya") { "https://www.huya.com/" }
        else if host.contains("douyu") { "https://www.douyu.com/" }
        else { "https://www.douyin.com/" };
    let mut request = client.get(url).header("User-Agent", "Mozilla/5.0")
        .header("Referer", referer).header("Accept", "image/*");
    if query.fresh.is_some() { request = request.header("Cache-Control", "no-cache"); }
    let Ok(response) = request.send().await else { return HttpResponse::BadGateway().finish() };
    if !response.status().is_success() { return HttpResponse::BadGateway().finish() }
    let mime = response.headers().get(reqwest::header::CONTENT_TYPE).and_then(|v| v.to_str().ok()).unwrap_or("").to_owned();
    if !mime.starts_with("image/") { return HttpResponse::UnsupportedMediaType().finish() }
    const LIMIT: usize = 10 * 1024 * 1024;
    if response.content_length().is_some_and(|len| len > LIMIT as u64) { return HttpResponse::PayloadTooLarge().finish() }
    let mut body = Vec::new();
    let mut stream = response.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let Ok(chunk) = chunk else { return HttpResponse::BadGateway().finish() };
        if body.len().saturating_add(chunk.len()) > LIMIT { return HttpResponse::PayloadTooLarge().finish() }
        body.extend_from_slice(&chunk);
    }
    HttpResponse::Ok().content_type(mime)
        .insert_header(("X-Content-Type-Options", "nosniff"))
        .insert_header(("Cache-Control", if query.fresh.is_some() { "no-store" } else { "private, max-age=86400" }))
        .body(body)
}

async fn flv_proxy_handler(_req: HttpRequest, store: web::Data<StreamUrlStore>, client: web::Data<Client>) -> HttpResponse {
    let raw = store.url.lock().unwrap().clone();
    let Ok(url) = reqwest::Url::parse(&raw) else { return HttpResponse::NotFound().finish() };
    if !crate::network_policy::external_url_allowed(&url) { return HttpResponse::BadRequest().finish() }
    let host = url.host_str().unwrap_or("");
    let huya = host.contains("huya") || host.ends_with("hy-cdn.com");
    let bilibili = host.contains("bilivideo") || host.ends_with("hdslb.com") || host.ends_with("bilibili.com");
    let mut request = client.get(url.clone()).header("Accept", "video/x-flv,application/octet-stream,*/*")
        .header("Range", "bytes=0-").header("User-Agent", "Mozilla/5.0");
    if huya {
        request = request.header("User-Agent", "HYSDK(Windows,30000002)_APP(pc_exe&7080000&official)_SDK(trans&2.34.0.5795)")
            .header("Referer", "https://www.huya.com/").header("Origin", "https://www.huya.com");
    } else if bilibili { request = request.header("Referer", "https://live.bilibili.com/"); }
    let Ok(response) = request.send().await else { return HttpResponse::BadGateway().finish() };
    if !response.status().is_success() { return HttpResponse::BadGateway().finish() }
    let stream = response.bytes_stream().map_err(|_| actix_web::error::ErrorBadGateway("Upstream stream ended"));
    HttpResponse::Ok().content_type("video/x-flv").insert_header(("Cache-Control", "no-store")).streaming(stream)
}

#[tauri::command]
pub async fn start_proxy(_app_handle: AppHandle, server_handle_state: State<'_, ProxyServerHandle>, stream_url_store: State<'_, StreamUrlStore>) -> Result<String, String> {
    if stream_url_store.url.lock().unwrap().is_empty() { return Err("Stream URL is empty".into()) }
    let previous = server_handle_state.0.lock().unwrap().take();
    if let Some(handle) = previous { handle.stop(false).await; }
    let listener = TcpListener::bind(("127.0.0.1", 0)).map_err(|e| e.to_string())?;
    let port = listener.local_addr().map_err(|e| e.to_string())?.port();
    let path = format!("/{}/live.flv", nonce());
    let output = format!("http://127.0.0.1:{port}{path}");
    let store = stream_url_store.inner().clone();
    // No whole-request deadline on a live stream: it may play for hours.
    let client = Client::builder().no_proxy().http1_only().gzip(false).brotli(false)
        .connect_timeout(Duration::from_secs(10)).tcp_keepalive(Duration::from_secs(30))
        .build().map_err(|e| e.to_string())?;
    let server = HttpServer::new(move || App::new().wrap(cors())
        .app_data(web::Data::new(store.clone())).app_data(web::Data::new(client.clone()))
        .route(&path, web::get().to(flv_proxy_handler)))
        .workers(2).listen(listener).map_err(|e| e.to_string())?.run();
    *server_handle_state.0.lock().unwrap() = Some(server.handle());
    tauri::async_runtime::spawn(server);
    Ok(output)
}

#[tauri::command]
pub async fn start_static_proxy_server(_app_handle: AppHandle, state: State<'_, StaticProxyState>) -> Result<String, String> {
    let mut guard = state.0.lock().unwrap();
    if let Some((base, _)) = guard.as_ref() { return Ok(base.clone()) }
    let listener = TcpListener::bind(("127.0.0.1", 0)).map_err(|e| e.to_string())?;
    let port = listener.local_addr().map_err(|e| e.to_string())?.port();
    let prefix = nonce();
    let base = format!("http://127.0.0.1:{port}/{prefix}");
    let client = image_client()?;
    let server = HttpServer::new(move || App::new().wrap(cors())
        .app_data(web::Data::new(client.clone()))
        .route(&format!("/{prefix}/image"), web::get().to(image_proxy_handler)))
        .workers(2).listen(listener).map_err(|e| e.to_string())?.run();
    *guard = Some((base.clone(), server.handle()));
    tauri::async_runtime::spawn(server);
    Ok(base)
}

#[tauri::command]
pub async fn stop_proxy(state: State<'_, ProxyServerHandle>) -> Result<(), String> {
    let handle = state.0.lock().unwrap().take();
    if let Some(handle) = handle { handle.stop(false).await; }
    Ok(())
}
