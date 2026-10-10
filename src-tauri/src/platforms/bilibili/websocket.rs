// src/websocket.rs
use native_tls::TlsStream;
use serde_json::Value;
use std::collections::VecDeque;
use std::net::{TcpStream, ToSocketAddrs};
use std::sync::OnceLock;
use std::time::{Duration, Instant};
use tungstenite::{client, Message, WebSocket};
use url::Url;

use super::auth::{init_server_no_cookie, init_server_with_cookie};
use super::models::{BiliMessage, DanmuServer};

static DEBUG_FLAG: OnceLock<bool> = OnceLock::new();

pub fn is_debug_enabled() -> bool {
    *DEBUG_FLAG.get_or_init(|| {
        std::env::var("DMF_DEBUG")
            .map(|v| v == "1" || v.eq_ignore_ascii_case("true"))
            .unwrap_or(false)
    })
}

macro_rules! ws_debug {
    ($($arg:tt)*) => {
        if crate::platforms::bilibili::websocket::is_debug_enabled() {
            println!($($arg)*);
        }
    }
}

pub struct BiliLiveClient {
    ws: WebSocket<TlsStream<TcpStream>>,
    auth_msg: String,
    // Keep server host list for reconnection
    host_list: Value,
    // Heartbeat scheduling
    last_heartbeat: Instant,
    heartbeat_interval: Duration,
    // Pending messages parsed from current/previous frames
    pending: VecDeque<BiliMessage>,
    last_reconnect: Instant,
}

impl BiliLiveClient {
    pub fn new_with_cookie(cookies: &str, room_id: &str) -> anyhow::Result<Self> {
        let (v, auth) = init_server_with_cookie(cookies, room_id)?;
        ws_debug!("[websocket] server_info host_list: {:?}", v["host_list"]);
        let ws = connect(v["host_list"].clone())?;
        ws_debug!("[websocket] connected via cookie for room {}", room_id);
        Ok(BiliLiveClient {
            ws,
            auth_msg: serde_json::to_string(&auth)?,
            host_list: v["host_list"].clone(),
            last_heartbeat: Instant::now(),
            heartbeat_interval: Duration::from_secs(30),
            pending: VecDeque::new(),
            last_reconnect: Instant::now(),
        })
    }

    pub fn new_without_cookie(room_id: &str) -> anyhow::Result<Self> {
        let (v, auth) = init_server_no_cookie(room_id)?;
        ws_debug!("[websocket] server_info host_list: {:?}", v["host_list"]);
        let ws = connect(v["host_list"].clone())?;
        ws_debug!("[websocket] connected without cookie for room {}", room_id);
        Ok(BiliLiveClient {
            ws,
            auth_msg: serde_json::to_string(&auth)?,
            host_list: v["host_list"].clone(),
            last_heartbeat: Instant::now(),
            heartbeat_interval: Duration::from_secs(30),
            pending: VecDeque::new(),
            last_reconnect: Instant::now(),
        })
    }

    pub fn send_auth(&mut self) {
        let pkt = make_packet(self.auth_msg.as_str(), Operation::AUTH);
        ws_debug!("[websocket] sending auth packet, len={}", pkt.len());
        let _ = self.ws.send(Message::Binary(pkt));
    }

    pub fn send_heart_beat(&mut self) {
        let pkt = make_packet("{}", Operation::HEARTBEAT);
        ws_debug!("[websocket] sending heartbeat, len={}", pkt.len());
        let _ = self.ws.send(Message::Binary(pkt));
        // update heartbeat timestamp
        self.last_heartbeat = Instant::now();
    }

    // Periodically send heartbeat to keep the connection alive
    fn maybe_send_heartbeat(&mut self) {
        if self.last_heartbeat.elapsed() >= self.heartbeat_interval {
            ws_debug!("[websocket] periodic heartbeat due");
            self.send_heart_beat();
        }
    }

    // Try to reconnect using the cached host list, and re-authenticate
    fn reconnect(&mut self) {
        if self.last_reconnect.elapsed() < Duration::from_secs(5) { return; }
        self.last_reconnect = Instant::now();
        if let Ok(ws) = connect(self.host_list.clone()) { self.ws = ws; self.send_auth(); }
    }

    pub fn parse_ws_message(&mut self, bytes: Vec<u8>) -> Option<BiliMessage> {
        for value in super::packet::decode_packets(&bytes) {
            if let Some(message) = handle(value) {
                if self.pending.len() >= 200 { self.pending.pop_front(); }
                self.pending.push_back(message);
            }
        }
        None
    }

    pub fn read_once(&mut self) -> Option<BiliMessage> {
        // If we already have pending messages, deliver one immediately
        if let Some(m) = self.pending.pop_front() {
            return Some(m);
        }

        // ensure heartbeat keeps alive
        self.maybe_send_heartbeat();

        let readable = self.ws.can_read();
        ws_debug!("[websocket] can_read={} ", readable);
        if self.ws.can_read() {
            let msg = self.ws.read();
            match msg {
                Ok(m) => {
                    let res = m.into_data();
                    ws_debug!("[websocket] read frame bytes={} ", res.len());
                    if res.len() >= 16 {
                        // parse and fill pending queue
                        let _ = self.parse_ws_message(res);
                        // return one
                        return self.pending.pop_front();
                    } else {
                        ws_debug!("[websocket] frame too short (<16), ignore");
                    }
                }
                Err(tungstenite::Error::Io(e)) if matches!(e.kind(), std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut) => {}
                Err(e) => {
                    ws_debug!("[websocket] read error: {:?}", e);
                    // try to reconnect on read error
                    self.reconnect();
                }
            }
        } else { self.reconnect(); }
        None
    }
}

pub fn gen_damu_list(list: &serde_json::Value) -> Vec<DanmuServer> {
    let mut res: Vec<DanmuServer> = Vec::new();
    if let Some(server_list) = list.as_array() {
        ws_debug!("[websocket] host_list size={}", server_list.len());
        if server_list.is_empty() {
            ws_debug!("[websocket] host_list empty, using default server");
            res.push(DanmuServer::default());
        } else {
            for s in server_list {
                let host = s["host"]
                    .as_str()
                    .unwrap_or("broadcastlv.chat.bilibili.com");
                let port = s["port"].as_i64().unwrap_or(2243) as i32;
                let wss_port = s["wss_port"].as_i64().unwrap_or(443) as i32;
                let ws_port = s["ws_port"].as_i64().unwrap_or(2244) as i32;
                ws_debug!(
                    "[websocket] server {}:{} (wss_port={}, ws_port={})",
                    host,
                    port,
                    wss_port,
                    ws_port
                );
                res.push(DanmuServer {
                    host: host.to_string(),
                    port,
                    wss_port,
                    ws_port,
                });
            }
        }
    } else {
        ws_debug!("[websocket] host_list not an array, using default server");
        res.push(DanmuServer::default());
    }
    res
}

fn find_server(vd: Vec<DanmuServer>) -> (String, String, String) {
    let first = vd.into_iter().next().unwrap_or_default();
    let (host, wss_port) = (first.host, first.wss_port);
    ws_debug!(
        "[websocket] choose server host={} wss_port={}",
        host,
        wss_port
    );
    (
        host.clone(),
        format!("{}:{}", host.clone(), wss_port),
        format!("wss://{}:{}/sub", host, wss_port),
    )
}

pub fn connect(v: Value) -> anyhow::Result<WebSocket<TlsStream<TcpStream>>> {
    let (host, address, ws_url) = find_server(gen_damu_list(&v));
    anyhow::ensure!(host == "bilibili.com" || host.ends_with(".bilibili.com"), "Unexpected danmaku host");
    let socket_address = address.to_socket_addrs()?.next().ok_or_else(|| anyhow::anyhow!("No danmaku address"))?;
    let stream = TcpStream::connect_timeout(&socket_address, Duration::from_secs(5))?;
    stream.set_read_timeout(Some(Duration::from_secs(5)))?;
    stream.set_write_timeout(Some(Duration::from_secs(5)))?;
    let tls = native_tls::TlsConnector::new()?.connect(&host, stream)?;
    let (socket, _) = client(Url::parse(&ws_url)?, tls)?;
    socket.get_ref().get_ref().set_read_timeout(Some(Duration::from_secs(1)))?;
    Ok(socket)
}

pub enum Operation {
    AUTH,
    HEARTBEAT,
}

pub fn make_packet(body: &str, ops: Operation) -> Vec<u8> {
    let body_content = body.as_bytes();
    let pack_len: [u8; 4] = ((16 + body.len()) as u32).to_be_bytes();
    let raw_header_size: [u8; 2] = (16 as u16).to_be_bytes();
    let ver: [u8; 2] = (1 as u16).to_be_bytes();
    let operation: [u8; 4] = match ops {
        Operation::AUTH => (7 as u32).to_be_bytes(),
        Operation::HEARTBEAT => (2 as u32).to_be_bytes(),
    };
    let seq_id: [u8; 4] = (1 as u32).to_be_bytes();
    let mut res = pack_len.to_vec();
    res.append(&mut raw_header_size.to_vec());
    res.append(&mut ver.to_vec());
    res.append(&mut operation.to_vec());
    res.append(&mut seq_id.to_vec());
    res.append(&mut body_content.to_vec());
    res
}

pub fn handle(json: Value) -> Option<BiliMessage> {
    let category = json["cmd"].as_str().unwrap_or("");
    match category {
        "DANMU_MSG" => Some(BiliMessage::Danmu {
            user: json["info"][2][1]
                .as_str()
                .unwrap_or("<unknown>")
                .to_string(),
            text: json["info"][1].as_str().unwrap_or("").to_string(),
        }),
        "SEND_GIFT" => Some(BiliMessage::Gift {
            user: json["info"][2][1]
                .as_str()
                .unwrap_or("<unknown>")
                .to_string(),
            gift: json["info"][1].as_str().unwrap_or("").to_string(),
        }),
        _ => Some(BiliMessage::Unsupported {
            cmd: category.to_string(),
        }),
    }
}
