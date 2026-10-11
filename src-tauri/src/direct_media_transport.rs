use actix_web::{web, HttpRequest, HttpResponse};
use futures_util::{StreamExt, TryStreamExt};
use reqwest::{dns::{Addrs, Name, Resolve, Resolving}, Client};
use std::{collections::{HashMap, VecDeque}, sync::{Arc, Mutex}, time::Duration};
use url::Url;
use crate::{media_network_policy::{media_url_allowed, public_ip}, media_playlist::rewrite_playlist};

struct PublicDns { fallback: Client }
fn dns_answers(value: &serde_json::Value) -> Vec<std::net::SocketAddr> {
    if value["Status"].as_u64() != Some(0) { return Vec::new(); }
    value["Answer"].as_array().into_iter().flatten()
        .filter(|record| matches!(record["type"].as_u64(), Some(1 | 28)))
        .filter_map(|record| record["data"].as_str()?.parse::<std::net::IpAddr>().ok())
        .filter(|ip| public_ip(*ip)).map(|ip| std::net::SocketAddr::new(ip, 0)).collect()
}
impl Resolve for PublicDns {
    fn resolve(&self, name: Name) -> Resolving {
        let host = name.as_str().to_owned();
        let fallback = self.fallback.clone();
        Box::pin(async move {
            let mut addresses: Vec<_> = match tokio::time::timeout(Duration::from_secs(5), tokio::net::lookup_host((host.as_str(), 0))).await {
                Ok(Ok(addresses)) => addresses.filter(|address| public_ip(address.ip())).collect(),
                _ => Vec::new(),
            };
            if addresses.is_empty() {
                // Proxy software can publish Fake-IP DNS records even when its
                // HTTP proxy is bypassed. Bootstrap an ordinary domestic DoH
                // service with fixed public addresses, keeping SNI/TLS validation.
                // Send only the hostname; never cookies or signed stream URLs.
                let mut response = fallback.get("https://dns.alidns.com/resolve")
                    .query(&[("name", host.as_str()), ("type", "A")]).send().await?.error_for_status()?;
                let mut bytes = Vec::new();
                while let Some(chunk) = response.chunk().await? {
                    if bytes.len() + chunk.len() > 64 * 1024 { return Err("DNS response too large".into()); }
                    bytes.extend_from_slice(&chunk);
                }
                addresses = dns_answers(&serde_json::from_slice(&bytes)?);
            }
            if addresses.is_empty() { return Err("Direct media DNS returned no public addresses".into()); }
            Ok(Box::new(addresses.into_iter()) as Addrs)
        })
    }
}

pub(crate) struct Resources {
    pub(crate) base: String,
    pub(crate) urls: HashMap<String, Url>,
    pub(crate) ids: HashMap<String, String>,
    pub(crate) order: VecDeque<String>,
    pub(crate) next_id: u64,
}
impl Resources {
    pub(crate) fn register(&mut self, url: Url) -> Result<String, String> {
        if !media_url_allowed(&url) { return Err("Unsupported media address".into()); }
        let id = if let Some(id) = self.ids.get(url.as_str()) { id.clone() } else {
            self.next_id += 1;
            let id = self.next_id.to_string();
            self.ids.insert(url.to_string(), id.clone());
            self.urls.insert(id.clone(), url.clone());
            self.order.push_back(id.clone());
            if self.order.len() > 8192 {
                if let Some(old) = self.order.pop_front() {
                    if let Some(url) = self.urls.remove(&old) { self.ids.remove(url.as_str()); }
                }
            }
            id
        };
        let extension = if url.path().ends_with(".m3u8") { "m3u8" } else { "bin" };
        Ok(format!("{}/{id}/media.{extension}", self.base))
    }
}

pub(crate) struct Transport { pub(crate) client: Client, pub(crate) resources: Mutex<Resources>, pub(crate) referer: &'static str }

pub(crate) async fn relay(request: HttpRequest, transport: web::Data<Transport>) -> HttpResponse {
    let Some(id) = request.match_info().get("id") else { return HttpResponse::NotFound().finish(); };
    let url = transport.resources.lock().ok().and_then(|r| r.urls.get(id).cloned());
    let Some(url) = url else { return HttpResponse::NotFound().finish(); };
    let mut upstream = transport.client.request(if request.method() == actix_web::http::Method::HEAD { reqwest::Method::HEAD } else { reqwest::Method::GET }, url.clone()).header("User-Agent", "Mozilla/5.0")
        .header("Referer", transport.referer).header("Accept", "*/*");
    for header in ["range", "if-range"] {
        if let Some(value) = request.headers().get(header).and_then(|v| v.to_str().ok()) { upstream = upstream.header(header, value); }
    }
    let response = match upstream.send().await {
        Ok(response) => response,
        Err(_) => return HttpResponse::BadGateway().body("Direct media connection failed"),
    };
    let status = actix_web::http::StatusCode::from_u16(response.status().as_u16()).unwrap_or(actix_web::http::StatusCode::BAD_GATEWAY);
    if !response.status().is_success() { return HttpResponse::build(status).finish(); }
    let mime = response.headers().get("content-type").and_then(|v| v.to_str().ok()).unwrap_or("application/octet-stream").to_owned();
    let playlist = mime.to_ascii_lowercase().contains("mpegurl") || response.url().path().ends_with(".m3u8") || url.path().ends_with(".m3u8");
    if request.method() == actix_web::http::Method::HEAD {
        let mut output = HttpResponse::build(status);
        output.content_type(mime).insert_header(("Cache-Control", "no-store"));
        if !playlist {
            for name in ["content-length", "content-range", "accept-ranges"] {
                if let Some(value) = response.headers().get(name).and_then(|v| v.to_str().ok()) { output.insert_header((name, value)); }
            }
        }
        return output.finish();
    }
    if playlist {
        let base = response.url().clone();
        let read_playlist = async {
            let mut bytes = Vec::new();
            let mut stream = response.bytes_stream();
            while let Some(chunk) = stream.next().await {
                let chunk = chunk.map_err(|_| ())?;
                if bytes.len() + chunk.len() > 2 * 1024 * 1024 { return Err(()); }
                bytes.extend_from_slice(&chunk);
            }
            String::from_utf8(bytes).map_err(|_| ())
        };
        let text = match tokio::time::timeout(Duration::from_secs(15), read_playlist).await {
            Ok(Ok(text)) if text.trim_start().starts_with("#EXTM3U") => text,
            _ => return HttpResponse::BadGateway().body("Invalid media playlist"),
        };
        let output = transport.resources.lock().map_err(|_| "Resource lock failed".to_string())
            .and_then(|mut r| rewrite_playlist(&text, &base, |url| r.register(url)));
        return match output {
            Ok(output) => HttpResponse::Ok().content_type("application/vnd.apple.mpegurl").insert_header(("Cache-Control", "no-store")).body(output),
            Err(_) => HttpResponse::BadGateway().body("Unsupported playlist resource"),
        };
    }
    let mut output = HttpResponse::build(status);
    output.content_type(mime).insert_header(("Cache-Control", "no-store"));
    for name in ["content-length", "content-range", "accept-ranges"] {
        if let Some(value) = response.headers().get(name).and_then(|v| v.to_str().ok()) { output.insert_header((name, value)); }
    }
    let stream = response.bytes_stream().map_err(|_| actix_web::error::ErrorBadGateway("Media stream ended"));
    output.streaming(stream)
}


pub(crate) fn direct_client_builder() -> Result<reqwest::ClientBuilder, reqwest::Error> {
    let fallback = Client::builder().no_proxy().http1_only()
        .resolve_to_addrs("dns.alidns.com", &["223.5.5.5:443".parse().unwrap(), "223.6.6.6:443".parse().unwrap()])
        .connect_timeout(Duration::from_secs(4)).timeout(Duration::from_secs(8))
        .redirect(reqwest::redirect::Policy::none()).build()?;
    Ok(Client::builder().no_proxy().dns_resolver(Arc::new(PublicDns { fallback }))
        .http1_only().gzip(false).brotli(false).connect_timeout(Duration::from_secs(10))
        .tcp_keepalive(Duration::from_secs(30))
        .redirect(reqwest::redirect::Policy::custom(|attempt| {
            if attempt.previous().len() >= 5 || !media_url_allowed(attempt.url()) { attempt.error("Unsupported media redirect") } else { attempt.follow() }
        })))

}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};
    use std::net::TcpListener;
    use actix_web::App;
    static ENV_LOCK: Mutex<()> = Mutex::new(());
    struct ProxyEnv(Vec<(&'static str, Option<std::ffi::OsString>)>);
    impl ProxyEnv {
        fn dead_proxy() -> Self {
            let keys = ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy", "NO_PROXY", "no_proxy"];
            let old = keys.iter().map(|key| (*key, std::env::var_os(key))).collect();
            for key in keys { std::env::set_var(key, if key.eq_ignore_ascii_case("no_proxy") { "" } else { "http://127.0.0.1:1" }); }
            Self(old)
        }
    }
    impl Drop for ProxyEnv {
        fn drop(&mut self) { for (key, value) in &self.0 { if let Some(value) = value { std::env::set_var(key, value); } else { std::env::remove_var(key); } } }
    }

    #[actix_web::test]
    async fn ignores_proxy_and_preserves_media_bytes_ranges_and_head() {
        let _guard = ENV_LOCK.lock().unwrap();
        let _env = ProxyEnv::dead_proxy();
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let requests = Arc::new(Mutex::new(Vec::new()));
        let captured = requests.clone();
        let upstream = std::thread::spawn(move || {
            for _ in 0..3 {
                let (mut socket, _) = listener.accept().unwrap();
                socket.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
                let mut bytes = Vec::new();
                loop {
                    let mut byte = [0];
                    socket.read_exact(&mut byte).unwrap(); bytes.push(byte[0]);
                    if bytes.ends_with(b"\r\n\r\n") { break; }
                }
                let request = String::from_utf8(bytes).unwrap();
                captured.lock().unwrap().push(request.clone());
                let range = request.to_ascii_lowercase().contains("range: bytes=1-3");
                let (status, body) = if range { ("206 Partial Content", "BCD") } else { ("200 OK", "ABCDEF") };
                let header = format!("HTTP/1.1 {status}\r\nContent-Type: video/mp2t\r\nContent-Length: {}\r\nAccept-Ranges: bytes\r\n{}Connection: close\r\n\r\n", body.len(), if range { "Content-Range: bytes 1-3/6\r\n" } else { "" });
                socket.write_all(header.as_bytes()).unwrap();
                if !request.starts_with("HEAD ") { socket.write_all(body.as_bytes()).unwrap(); }
            }
        });
        // The local fixture is injected into the private registry only in this
        // test. Production registration and DNS reject loopback upstreams.
        let url = Url::parse(&format!("http://{address}/video.ts")).unwrap();
        let transport = web::Data::new(Transport {
            client: direct_client_builder().unwrap().build().unwrap(), referer: "https://live.bilibili.com/",
            resources: Mutex::new(Resources { base: "http://127.0.0.1/direct".into(), urls: HashMap::from([("1".into(), url)]), ids: HashMap::new(), order: VecDeque::new(), next_id: 1 }),
        });
        let app = actix_web::test::init_service(App::new().app_data(transport).route("/direct/{id}/{file}", web::get().to(relay)).route("/direct/{id}/{file}", web::head().to(relay))).await;
        let response = actix_web::test::call_service(&app, actix_web::test::TestRequest::get().uri("/direct/1/video.ts").to_request()).await;
        assert!(response.status().is_success());
        assert_eq!(actix_web::test::read_body(response).await.as_ref(), b"ABCDEF");
        let response = actix_web::test::call_service(&app, actix_web::test::TestRequest::get().uri("/direct/1/video.ts").insert_header(("Range", "bytes=1-3")).to_request()).await;
        assert_eq!(response.status().as_u16(), 206);
        assert_eq!(response.headers().get("Content-Range").unwrap(), "bytes 1-3/6");
        assert_eq!(actix_web::test::read_body(response).await.as_ref(), b"BCD");
        let response = actix_web::test::call_service(&app, actix_web::test::TestRequest::default().method(actix_web::http::Method::HEAD).uri("/direct/1/video.ts").to_request()).await;
        assert_eq!(response.headers().get("Content-Length").unwrap(), "6");
        assert!(actix_web::test::read_body(response).await.is_empty());
        let response = actix_web::test::call_service(&app, actix_web::test::TestRequest::get().uri("/direct/999/video.ts").to_request()).await;
        assert_eq!(response.status().as_u16(), 404);
        upstream.join().unwrap();
        let requests = requests.lock().unwrap();
        assert!(requests[1].to_ascii_lowercase().contains("range: bytes=1-3"));
        assert!(requests[2].starts_with("HEAD "));
    }

    #[test]
    fn live_resource_registry_remains_bounded_and_reuses_keys() {
        let mut r = Resources { base: "http://127.0.0.1/direct".into(), urls: HashMap::new(), ids: HashMap::new(), order: VecDeque::new(), next_id: 0 };
        let key = Url::parse("https://cdn.example/key").unwrap();
        assert_eq!(r.register(key.clone()).unwrap(), r.register(key).unwrap());
        for n in 0..9000 { r.register(Url::parse(&format!("https://cdn.example/{n}.ts")).unwrap()).unwrap(); }
        assert_eq!(r.urls.len(), 8192);
        assert_eq!(r.ids.len(), 8192);
        assert_eq!(r.order.len(), 8192);
        assert!(r.register(Url::parse("http://127.0.0.1/private").unwrap()).is_err());
    }

    #[test]
    fn domestic_dns_answers_reject_fake_ip_and_private_addresses() {
        let data = serde_json::json!({"Status":0,"Answer":[
            {"type":5,"data":"alias.cdn.example."}, {"type":1,"data":"198.18.0.1"},
            {"type":1,"data":"127.0.0.1"}, {"type":1,"data":"36.159.62.159"},
            {"type":28,"data":"2606:4700::1111"}, {"type":1,"data":"invalid"}
        ]});
        let result = dns_answers(&data);
        assert_eq!(result.len(), 2);
        assert_eq!(result[0].ip().to_string(), "36.159.62.159");
        assert!(dns_answers(&serde_json::json!({"Status":3,"Answer":[{"type":1,"data":"8.8.8.8"}]})).is_empty());
    }
}
