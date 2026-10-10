//! Boundaries for requests initiated by the local image proxy and external links.
use url::Url;

pub fn domain_matches(host: &str, domain: &str) -> bool {
    host == domain || host.strip_suffix(domain).is_some_and(|prefix| prefix.ends_with('.'))
}

pub fn image_url_allowed(url: &Url) -> bool {
    const DOMAINS: &[&str] = &[
        "hdslb.com", "bilibili.com", "huya.com", "huyaimg.com", "msstatic.com", "yy.com",
        "douyucdn.cn", "douyu.com", "douyinpic.com", "douyin.com", "douyincdn.com",
        "byteimg.com", "bytecdn.cn", "pstatp.com", "snssdk.com", "ibytedtos.com", "toutiaoimg.com",
    ];
    matches!(url.scheme(), "http" | "https") && url.username().is_empty() && url.password().is_none()
        && matches!(url.port(), None | Some(80) | Some(443))
        && url.host_str().is_some_and(|host| DOMAINS.iter().any(|domain| domain_matches(host, domain)))
}

pub fn external_url_allowed(url: &Url) -> bool {
    matches!(url.scheme(), "https" | "http") && url.has_host() && url.username().is_empty() && url.password().is_none()
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn image_proxy_rejects_local_files_private_hosts_and_suffix_tricks() {
        for value in ["file:///etc/passwd", "http://127.0.0.1/admin", "http://192.168.1.1/", "https://hdslb.com.evil.test/x", "https://evilhdslb.com/x", "https://user:pass@i0.hdslb.com/x", "https://i0.hdslb.com:8080/x"] {
            assert!(!image_url_allowed(&Url::parse(value).unwrap()), "{value}");
        }
        assert!(image_url_allowed(&Url::parse("https://i0.hdslb.com/bfs/live/image.jpg").unwrap()));
        assert!(image_url_allowed(&Url::parse("https://huyaimg.msstatic.com/avatar.jpg").unwrap()));
    }
    #[test]
    fn external_links_cannot_launch_arbitrary_protocol_handlers() {
        for value in ["file:///Applications/QTV.app", "javascript:alert(1)", "ssh://host/", "qtv://anything"] {
            assert!(!external_url_allowed(&Url::parse(value).unwrap()));
        }
        assert!(external_url_allowed(&Url::parse("https://github.com/qinxianhahaha/QTV").unwrap()));
    }
}
