//! Count media response bodies only, without buffering or changing playback.
use actix_web::{web, HttpResponse};
use std::sync::atomic::{AtomicU64, Ordering};

#[derive(Default)]
pub(crate) struct MediaTraffic(AtomicU64);

impl MediaTraffic {
    pub(crate) fn add(&self, bytes: usize) {
        self.0.fetch_add(bytes as u64, Ordering::Relaxed);
    }
    pub(crate) fn total(&self) -> u64 { self.0.load(Ordering::Relaxed) }
}

pub(crate) async fn snapshot(traffic: web::Data<MediaTraffic>) -> HttpResponse {
    HttpResponse::Ok().insert_header(("Cache-Control", "no-store"))
        .json(serde_json::json!({ "totalBytes": traffic.total() }))
}
