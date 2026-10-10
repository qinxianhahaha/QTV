use serde_json::Value;

fn codecs(playurl: &Value) -> impl Iterator<Item = &Value> {
    playurl["stream"].as_array().into_iter().flatten()
        .flat_map(|s| s["format"].as_array().into_iter().flatten())
        .flat_map(|f| f["codec"].as_array().into_iter().flatten())
}

pub fn select_qn(playurl: &Value, quality: &str) -> i32 {
    let mut accepted: Vec<i32> = codecs(playurl)
        .flat_map(|c| c["accept_qn"].as_array().into_iter().flatten())
        .filter_map(|q| q.as_i64().filter(|q| *q > 0).map(|q| q as i32)).collect();
    accepted.sort_unstable();
    accepted.dedup();
    let preferred = match quality { "高清" => 400, "标清" => 250, _ => i32::MAX };
    accepted.iter().rev().find(|q| **q <= preferred).copied()
        .or_else(|| accepted.first().copied()).unwrap_or(10000)
}

pub fn best_returned_qn(playurl: &Value) -> Option<i32> {
    codecs(playurl).filter(|c| c["base_url"].as_str().is_some_and(|s| !s.is_empty())
        && c["url_info"].as_array().is_some_and(|a| !a.is_empty()))
        .filter_map(|c| c["current_qn"].as_i64().map(|q| q as i32)).max()
}

pub fn quality_desc(playurl: &Value, qn: i32) -> String {
    let entry = playurl["g_qn_desc"].as_array().and_then(|a| a.iter().find(|v| v["qn"].as_i64() == Some(qn as i64)));
    entry.and_then(|v| v["media_base_desc"]["detail_desc"]["desc"].as_str().or_else(|| v["desc"].as_str()))
        .map(str::to_string).unwrap_or_else(|| format!("画质 {}", qn))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn highest_uses_all_supported_streams_not_global_descriptions() {
        let p = json!({"g_qn_desc":[{"qn":30000,"desc":"杜比"}],"stream":[{"format":[{"codec":[{"accept_qn":[250,400,10000]},{"accept_qn":[15000,400]}]}]}]});
        assert_eq!(select_qn(&p,"原画"),15000);
        assert_eq!(select_qn(&p,"高清"),400);
        assert_eq!(select_qn(&p,"标清"),250);
    }
    #[test]
    fn downgrade_is_reported_and_higher_quality_beats_transport_order() {
        let p = json!({"g_qn_desc":[{"qn":250,"desc":"超清","media_base_desc":{"detail_desc":{"desc":"720P 超清"}}}],"stream":[{"format":[{"codec":[{"base_url":"low","url_info":[{}],"current_qn":250},{"base_url":"high","url_info":[{}],"current_qn":10000}]}]}]});
        assert_eq!(best_returned_qn(&p),Some(10000));
        assert_eq!(quality_desc(&p,250),"720P 超清");
    }
    #[test]
    fn unavailable_high_quality_url_is_not_selected() {
        let p = json!({"stream":[{"format":[{"codec":[{"base_url":"low","url_info":[{}],"current_qn":250},{"current_qn":10000}]}]}]});
        assert_eq!(best_returned_qn(&p),Some(250));
        assert_eq!(select_qn(&json!({}),"原画"),10000);
    }
}
