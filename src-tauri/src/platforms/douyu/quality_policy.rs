use serde::Serialize;

#[derive(Clone, Debug, Serialize)]
pub struct RateVariant {
    pub name: String,
    pub rate: i32,
    pub bit: Option<i32>,
}

pub fn returned_rate_is_better(candidate: Option<i32>, baseline: Option<i32>, variants: &[RateVariant]) -> bool {
    let Some(candidate) = candidate.and_then(|r| variants.iter().find(|v| v.rate == r)) else { return false };
    let Some(baseline) = baseline.and_then(|r| variants.iter().find(|v| v.rate == r)) else { return true };
    let pair = [candidate.clone(), baseline.clone()];
    candidate.rate != baseline.rate && select(&pair, "原画").is_some_and(|v| v.rate == candidate.rate)
}

// `rate` is an opaque identifier, not a ranking. Prefer advertised bitrate;
// rate=0 is the original stream when the API doesn't provide a bitrate for it.
pub fn select<'a>(variants: &'a [RateVariant], quality: &str) -> Option<&'a RateVariant> {
    let max_bit = variants.iter().filter_map(|v| v.bit).max().unwrap_or(0);
    let score = |v: &&RateVariant| {
        let bit = v.bit.filter(|b| *b > 0).unwrap_or(if v.rate == 0 { max_bit } else { 0 });
        (bit, v.name.contains("4K"), v.name.contains("2K"), v.name.contains("120"), v.rate == 0)
    };
    let mut sorted: Vec<_> = variants.iter().collect();
    sorted.sort_by_key(score);
    match quality.trim() {
        "标清" | "standard" => sorted.first().copied(),
        "高清" | "high" => sorted.iter().rev().find(|v| v.rate != sorted.last().unwrap().rate).copied().or_else(|| sorted.last().copied()),
        "原画" | "origin" | "" => sorted.last().copied(),
        name => variants.iter().find(|v| v.name == name).or_else(|| sorted.last().copied()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn v(name: &str, rate: i32, bit: Option<i32>) -> RateVariant { RateVariant {name:name.into(),rate,bit} }
    #[test] fn high_rate_number_is_not_high_quality() {
        let all=vec![v("原画",0,Some(8000)),v("标清",99,Some(1200)),v("2K120",7,Some(20000))];
        assert_eq!(select(&all,"原画").unwrap().rate,7);
        assert_eq!(select(&all,"高清").unwrap().rate,0);
        assert_eq!(select(&all,"标清").unwrap().rate,99);
    }
    #[test] fn unknown_original_bitrate_remains_original() {
        let all=vec![v("原画",0,None),v("蓝光",4,Some(4000))];
        assert_eq!(select(&all,"原画").unwrap().rate,0);
        assert!(select(&[],"原画").is_none());
        assert_eq!(select(&all[..1],"高清").unwrap().rate,0);
    }
    #[test] fn a_capped_app_response_cannot_replace_a_better_web_stream() {
        let all=vec![v("原画2K60",0,Some(20000)),v("蓝光4M",4,Some(4000)),v("超清",3,Some(2000))];
        assert!(!returned_rate_is_better(Some(3),Some(4),&all));
        assert!(returned_rate_is_better(Some(0),Some(4),&all));
        assert!(!returned_rate_is_better(None,Some(4),&all));
    }
}
