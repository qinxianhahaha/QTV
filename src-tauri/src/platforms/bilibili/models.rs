// src/models.rs
use serde::{Deserialize, Serialize};

#[derive(Debug)]
#[allow(dead_code)]
pub struct DanmuServer {
    pub host: String,
    pub port: i32,
    pub wss_port: i32,
    pub ws_port: i32,
}

impl Default for DanmuServer {
    fn default() -> Self {
        Self {
            host: String::from("broadcastlv.chat.bilibili.com"),
            port: 2243,
            wss_port: 443,
            ws_port: 2244,
        }
    }
}

#[derive(Debug, Serialize, Deserialize)]
pub struct AuthMessage {
    pub uid: u64,
    pub roomid: u64,
    pub protover: i32,
    pub platform: String,
    #[serde(rename = "type")]
    pub type_: i32,
    pub key: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub enum BiliMessage {
    Danmu { user: String, text: String },
    Gift { user: String, gift: String },
    Unsupported { cmd: String },
}
