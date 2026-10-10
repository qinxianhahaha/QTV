use reqwest::header::{HeaderMap, HeaderValue, COOKIE, REFERER, USER_AGENT};
use serde_json::Value;
use tauri::{command, AppHandle, State};

use crate::platforms::common::types::StreamVariant;
use crate::proxy::{start_proxy, ProxyServerHandle};
use crate::StreamUrlStore;

#[command]
pub async fn get_bilibili_live_stream_url_with_quality(
    app_handle: AppHandle,
    stream_url_store: State<'_, StreamUrlStore>,
    proxy_server_handle: State<'_, ProxyServerHandle>,
    payload: crate::platforms::common::GetStreamUrlPayload, quality: String, cookie: Option<String>, route: Option<usize>,
) -> Result<crate::platforms::common::LiveStreamInfo, String> {
    tokio::time::timeout(std::time::Duration::from_secs(35), get_bilibili_live_stream_url_with_quality_inner(app_handle, stream_url_store, proxy_server_handle, payload, quality, cookie, route)).await
        .map_err(|_| "获取直播流超时，请检查网络后重试".to_string())?
}

async fn get_bilibili_live_stream_url_with_quality_inner(
    app_handle: AppHandle,
    stream_url_store: State<'_, StreamUrlStore>,
    proxy_server_handle: State<'_, ProxyServerHandle>,
    payload: crate::platforms::common::GetStreamUrlPayload,
    quality: String,
    cookie: Option<String>,
    route: Option<usize>,
) -> Result<crate::platforms::common::LiveStreamInfo, String> {
    let room_id = payload.args.room_id_str.clone();
    if room_id.trim().is_empty() {
        return Ok(crate::platforms::common::LiveStreamInfo {
            title: None,
            anchor_name: None,
            avatar: None,
            cover_url: None,
            stream_url: None,
            status: None,
            error_message: Some("房间ID未提供".to_string()),
            upstream_url: None,
            available_streams: None,
            normalized_room_id: None,
            web_rid: None,
        });
    }

    let ua = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36";

    // Build headers
    let mut headers = HeaderMap::new();
    headers.insert(USER_AGENT, HeaderValue::from_str(ua).unwrap());
    headers.insert(
        REFERER,
        HeaderValue::from_static("https://live.bilibili.com/"),
    );
    if let Some(c) = cookie.as_ref() {
        let c_trimmed = c.trim();
        if !c_trimmed.is_empty() {
            match HeaderValue::from_str(c_trimmed) {
                Ok(val) => {
                    headers.insert(COOKIE, val);
                    eprintln!("[Bilibili] Cookie header set (content hidden)");
                }
                Err(err) => {
                    eprintln!("[Bilibili] Invalid cookie header, skipping. Error: {}", err);
                }
            }
        } else {
            eprintln!("[Bilibili] Cookie provided is empty after trimming, skipping insertion.");
        }
    }

    // 添加必要的 Origin，以符合部分接口对 CSRF 的检查
    headers.insert(
        reqwest::header::ORIGIN,
        HeaderValue::from_static("https://live.bilibili.com"),
    );
    let client = reqwest::Client::builder()
        .default_headers(headers)
        .http1_only()
        .connect_timeout(std::time::Duration::from_secs(15))
        .no_proxy()
        .build()
        .map_err(|e| format!("Failed to build client: {}", e))?;

    // Helper: request playinfo with optional qn
    async fn request_playinfo(
        client: &reqwest::Client,
        room_id: &str,
        qn: Option<i32>,
    ) -> Result<Value, String> {
        let url = "https://api.live.bilibili.com/xlive/web-room/v2/index/getRoomPlayInfo";
        let mut params = vec![
            ("room_id", room_id.to_string()),
            ("protocol", "0,1".to_string()),
            ("format", "0,1,2".to_string()),
            // AVC is supported by the current FLV/HLS player; request desktop streams.
            ("codec", "0".to_string()),
            ("platform", "web".to_string()),
            ("dolby", "5".to_string()),
        ];
        if let Some(q) = qn {
            params.push(("qn", q.to_string()));
        }
        let resp = client
            .get(url)
            .query(&params)
            .send()
            .await
            .map_err(|e| format!("PlayInfo request failed: {}", e))?;
        let status = resp.status();
        let text = resp
            .text()
            .await
            .map_err(|e| format!("Read text failed: {}", e))?;
        if !status.is_success() {
            return Err(format!("PlayInfo status: {} body: {}", status, text));
        }
        let data: Value = serde_json::from_str(&text).map_err(|e| format!("JSON parse failed: {}", e))?;
        if data["code"].as_i64() != Some(0) {
            return Err(format!("B站播放接口错误：{}", data["message"].as_str().unwrap_or("请求失败")));
        }
        Ok(data)
    }

    // Determine live status from room_init
    let room_init_url = format!(
        "https://api.live.bilibili.com/room/v1/Room/room_init?id={}",
        room_id
    );
    let init_resp = client
        .get(&room_init_url)
        .send()
        .await
        .map_err(|e| format!("room_init failed: {}", e))?;
    let init_text = init_resp
        .text()
        .await
        .map_err(|e| format!("room_init read text failed: {}", e))?;
    let init_json: Value = serde_json::from_str(&init_text)
        .map_err(|e| format!("room_init json failed: {} | {}", e, init_text))?;
    let live_status = init_json["data"]["live_status"].as_i64().unwrap_or(0);
    if live_status != 1 {
        return Ok(crate::platforms::common::LiveStreamInfo {
            title: init_json["data"]["title"].as_str().map(|s| s.to_string()),
            anchor_name: init_json["data"]["uname"].as_str().map(|s| s.to_string()),
            avatar: None,
            cover_url: None,
            stream_url: None,
            status: Some(0),
            error_message: None,
            upstream_url: None,
            available_streams: None,
            normalized_room_id: None,
            web_rid: None,
        });
    }

    enum SelectedStream {
        Flv(String),
        Hls(String),
    }

    fn parse_stream_variants(
        playurl: &Value,
        requested_qn: Option<i32>,

    ) -> (Vec<StreamVariant>, Option<String>, Vec<String>) {
        let mut variants: Vec<StreamVariant> = Vec::new();
        let best_qn = super::quality_policy::best_returned_qn(playurl);
        let mut hls_candidates: Vec<String> = Vec::new();
        let mut flv_candidate: Option<String> = None;

        if let Some(streams) = playurl.get("stream").and_then(|v| v.as_array()) {
            for stream_item in streams {
                let protocol_name = stream_item
                    .get("protocol_name")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string();
                if let Some(formats) = stream_item.get("format").and_then(|v| v.as_array()) {
                    for format_item in formats {
                        let format_name = format_item
                            .get("format_name")
                            .and_then(|v| v.as_str())
                            .unwrap_or("");
                        if let Some(codecs) = format_item.get("codec").and_then(|v| v.as_array()) {
                            for codec_item in codecs {
                                let actual_qn = codec_item["current_qn"].as_i64().map(|q| q as i32);
                                // Transport preference must never beat actual picture quality.
                                if actual_qn != best_qn { continue; }
                                let actual_desc = actual_qn.map(|q| super::quality_policy::quality_desc(playurl, q));
                                let base_url = codec_item
                                    .get("base_url")
                                    .and_then(|v| v.as_str())
                                    .unwrap_or("");
                                if let Some(url_infos) =
                                    codec_item.get("url_info").and_then(|v| v.as_array())
                                {
                                    for ui in url_infos {
                                        let host =
                                            ui.get("host").and_then(|v| v.as_str()).unwrap_or("");
                                        let extra =
                                            ui.get("extra").and_then(|v| v.as_str()).unwrap_or("");
                                        let composed = format!("{}{}{}", host, base_url, extra);
                                        if composed.is_empty() {
                                            continue;
                                        }

                                        variants.push(StreamVariant { fps: None, codec: Some("avc1".into()),
                                            requested_qn,
                                            url: composed.clone(),
                                            format: Some(format_name.to_string()),
                                            desc: actual_desc.clone(),
                                            qn: actual_qn,
                                            protocol: if protocol_name.is_empty() {
                                                None
                                            } else {
                                                Some(protocol_name.clone())
                                            },
                                        });

                                        let is_hls_format = matches!(
                                            format_name,
                                            "ts" | "fmp4" | "mp4" | "m4s" | "m3u8"
                                        );
                                        let is_hls_protocol = protocol_name.contains("hls");
                                        if is_hls_format || is_hls_protocol {
                                            hls_candidates.push(composed.clone());
                                        }
                                        if format_name == "flv" && flv_candidate.is_none() {
                                            flv_candidate = Some(composed.clone());
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }

        (variants, flv_candidate, hls_candidates)
    }

    async fn verify_hls_candidates(
        client: &reqwest::Client,
        room_id: &str,
        candidates: &[String],
    ) -> Option<String> {
        for candidate in candidates.iter().take(4) {
            match client.get(candidate).send().await {
                Ok(resp) => {
                    if resp.status().is_success() {
                        eprintln!(
                            "[Bilibili] Verified HLS candidate for room {} -> {}",
                            room_id, candidate
                        );
                        return Some(candidate.clone());
                    } else {
                        eprintln!(
                            "[Bilibili] HLS candidate returned status {} for room {} -> {}",
                            resp.status(),
                            room_id,
                            candidate
                        );
                    }
                }
                Err(err) => {
                    eprintln!(
                        "[Bilibili] Failed to probe HLS candidate for room {} -> {} ({})",
                        room_id, candidate, err
                    );
                }
            }
        }
        None
    }

    const MAX_HLS_RETRY: usize = 3;
    let mut selected_stream: Option<SelectedStream> = None;
    let mut variants_for_response: Vec<StreamVariant> = Vec::new();
    let mut fallback_hls_url: Option<String> = None;
    let mut fallback_variants: Option<Vec<StreamVariant>> = None;

    // The gateway exposes an HLS master with actual resolution and quality metadata.
    // Use its selected media playlist directly: adaptive playback must not downgrade it.
    let normalized_room = init_json["data"]["room_id"].as_u64().map(|n| n.to_string()).unwrap_or_else(|| room_id.clone());
    let gateway = async {
        let response = client.get("https://api.live.bilibili.com/xlive/play-gateway/master/url")
            .query(&[("cid", normalized_room.as_str()), ("mid", "0"), ("pt", "web"),
                ("p2p_type", "-1"), ("net", "0"), ("free_type", "0"), ("build", "0"),
                ("feature", "2"), ("qn", "10000"), ("drm_type", "0"), ("codec", "0,1")])
            .timeout(std::time::Duration::from_secs(8)).send().await.ok()?.error_for_status().ok()?;
        let text = response.text().await.ok()?;
        let mut candidates = super::master_playlist::parse(&text, &quality);
        if !candidates.is_empty() {
            let offset = route.unwrap_or(0) % candidates.len();
            candidates.rotate_left(offset);
        }
        for candidate in candidates.iter().take(3) {
            let response = match client.get(&candidate.url).timeout(std::time::Duration::from_secs(4)).send().await {
                Ok(r) if r.status().is_success() => r,
                _ => continue,
            };
            let media = match response.text().await { Ok(t) => t, Err(_) => continue };
            if !media.trim_start().starts_with("#EXTM3U") || !media.contains("#EXTINF:") { continue; }
            return Some((candidate.clone(), candidates));
        }
        None
    };
    if let Ok(Some((selected, candidates))) = tokio::time::timeout(std::time::Duration::from_secs(18), gateway).await {
        eprintln!("[Bilibili] gateway selected {} (qn={})", selected.label, selected.qn);
        variants_for_response = candidates.into_iter().map(|v| StreamVariant { fps: v.fps, codec: v.codec,
            url: v.url, format: Some("fmp4".into()), desc: Some(v.label),
            qn: Some(v.qn), requested_qn: Some(v.qn), protocol: Some("http_hls".into()),
        }).collect();
        selected_stream = Some(SelectedStream::Hls(selected.url));
    }
    let selected_qn = if selected_stream.is_none() {
        let playinfo = request_playinfo(&client, &room_id, Some(10000)).await?;
        Some(super::quality_policy::select_qn(&playinfo["data"]["playurl_info"]["playurl"], &quality))
    } else { None };

    for attempt in 0..=MAX_HLS_RETRY {
        if selected_stream.is_some() { break; }
        let attempt_display = attempt + 1;
        let playinfo_attempt = request_playinfo(&client, &room_id, selected_qn).await?;
        let playurl_attempt = playinfo_attempt["data"]["playurl_info"]["playurl"].clone();
        let (variants, flv_candidate, hls_candidates) =
            parse_stream_variants(&playurl_attempt, selected_qn);

        variants_for_response = variants.clone();

        let best_qn = variants.iter().filter_map(|v| v.qn).max();
        let same_quality_flv: Vec<_> = variants.iter().filter(|v| v.qn == best_qn && v.format.as_deref() == Some("flv")).collect();
        let flv_candidate = if same_quality_flv.is_empty() { flv_candidate } else { Some(same_quality_flv[route.unwrap_or(0) % same_quality_flv.len()].url.clone()) };
        if let Some(flv_url) = flv_candidate {
            eprintln!(
                "[Bilibili] Attempt {} obtained FLV stream for room {}, stop retrying",
                attempt_display, room_id
            );
            selected_stream = Some(SelectedStream::Flv(flv_url));
            break;
        }

        if hls_candidates.is_empty() {
            eprintln!(
                "[Bilibili] Attempt {} returned no HLS candidates for room {}",
                attempt_display, room_id
            );
            if attempt == MAX_HLS_RETRY {
                break;
            }
            continue;
        }

        let (preferred_candidates, other_candidates): (Vec<String>, Vec<String>) = hls_candidates
            .into_iter()
            .partition(|url| url.contains("d1--cn"));

        if let Some(url) = verify_hls_candidates(&client, &room_id, &preferred_candidates).await {
            eprintln!(
                "[Bilibili] Selected HLS stream containing 'd1--cn' on attempt {} for room {}",
                attempt_display, room_id
            );
            selected_stream = Some(SelectedStream::Hls(url));
            break;
        }

        if fallback_hls_url.is_none() {
            if let Some(url) = verify_hls_candidates(&client, &room_id, &other_candidates).await {
                fallback_hls_url = Some(url.clone());
                fallback_variants = Some(variants.clone());
            }
        }

        if attempt == MAX_HLS_RETRY {
            if let Some(url) = fallback_hls_url.clone() {
                eprintln!(
                    "[Bilibili] Using non 'd1--cn' HLS stream after {} attempts for room {}",
                    attempt_display, room_id
                );
                selected_stream = Some(SelectedStream::Hls(url));
                if let Some(fallback) = fallback_variants.clone() {
                    variants_for_response = fallback;
                }
            } else if let Some(url) =
                verify_hls_candidates(&client, &room_id, &other_candidates).await
            {
                eprintln!(
                    "[Bilibili] Final attempt picked non 'd1--cn' HLS stream for room {}",
                    room_id
                );
                selected_stream = Some(SelectedStream::Hls(url));
                variants_for_response = variants.clone();
            }
        }
    }

    if selected_stream.is_none() {
        if let Some(url) = fallback_hls_url.clone() {
            eprintln!(
                "[Bilibili] Falling back to cached non 'd1--cn' HLS stream for room {}",
                room_id
            );
            selected_stream = Some(SelectedStream::Hls(url));
            if let Some(fallback) = fallback_variants.clone() {
                variants_for_response = fallback;
            }
        }
    }

    let selected_stream = match selected_stream {
        Some(stream) => stream,
        None => {
            return Ok(crate::platforms::common::LiveStreamInfo {
                title: init_json["data"]["title"].as_str().map(|s| s.to_string()),
                anchor_name: init_json["data"]["uname"].as_str().map(|s| s.to_string()),
                avatar: None,
                cover_url: None,
                stream_url: None,
                status: Some(2),
                error_message: Some("未找到可用的直播流地址".to_string()),
                upstream_url: None,
                available_streams: Some(variants_for_response),
                normalized_room_id: None,
                web_rid: None,
            });
        }
    };

    match selected_stream {
        SelectedStream::Flv(real_url) => {
            // FLV：写入到 Store 并启动代理
            let proxied_url = {
                {
                    let mut current_url_in_store = stream_url_store.url.lock().unwrap();
                    *current_url_in_store = real_url.clone();
                }
                match start_proxy(app_handle, proxy_server_handle, stream_url_store).await {
                    Ok(proxy) => Some(proxy),
                    Err(e) => {
                        eprintln!("[Bilibili] Failed to start proxy: {}", e);
                        None
                    }
                }
            };

            let final_error_message = if proxied_url.is_none() {
                Some("代理启动失败".to_string())
            } else {
                None
            };

            Ok(crate::platforms::common::LiveStreamInfo {
                title: init_json["data"]["title"].as_str().map(|s| s.to_string()),
                anchor_name: init_json["data"]["uname"].as_str().map(|s| s.to_string()),
                avatar: None,
                cover_url: None,
                stream_url: proxied_url,
                status: Some(if final_error_message.is_some() { 2 } else { 1 }),
                error_message: final_error_message,
                upstream_url: Some(real_url),
                available_streams: Some(variants_for_response.clone()),
                normalized_room_id: None,
                web_rid: None,
            })
        }
        SelectedStream::Hls(real_url) => {
            // HLS：无需本地代理，若存在旧的 FLV 代理则关闭并清空存储
            {
                let handle_to_stop = { proxy_server_handle.0.lock().unwrap().take() };
                if let Some(handle) = handle_to_stop {
                    handle.stop(false).await;
                    eprintln!("[Bilibili] Stopped existing FLV proxy before using HLS stream");
                }
            }
            {
                let mut current_url_in_store = stream_url_store.url.lock().unwrap();
                *current_url_in_store = String::new();
            }

            Ok(crate::platforms::common::LiveStreamInfo {
                title: init_json["data"]["title"].as_str().map(|s| s.to_string()),
                anchor_name: init_json["data"]["uname"].as_str().map(|s| s.to_string()),
                avatar: None,
                cover_url: None,
                stream_url: Some(real_url.clone()),
                status: Some(1),
                error_message: None,
                upstream_url: Some(real_url),
                available_streams: Some(variants_for_response),
                normalized_room_id: None,
                web_rid: None,
            })
        }
    }
}
