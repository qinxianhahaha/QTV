use std::net::IpAddr;
use url::Url;

pub fn public_ip(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(ip) => {
            let [a, b, c, _] = ip.octets();
            !ip.is_private() && !ip.is_loopback() && !ip.is_link_local() && !ip.is_broadcast()
                && a != 0 && a < 224 && !(a == 100 && (64..=127).contains(&b))
                && !(a == 192 && b == 0 && (c == 0 || c == 2))
                && !(a == 198 && (b == 18 || b == 19 || b == 51 && c == 100))
                && !(a == 203 && b == 0 && c == 113)
        }
        IpAddr::V6(ip) => {
            if let Some(v4) = ip.to_ipv4_mapped() { return public_ip(v4.into()); }
            let segments = ip.segments();
            // Only ordinary globally routed unicast; exclude documentation.
            segments[0] & 0xe000 == 0x2000 && !(segments[0] == 0x2001 && segments[1] == 0xdb8)
        }
    }
}

pub fn media_url_allowed(url: &Url) -> bool {
    if !matches!(url.scheme(), "http" | "https") || !url.username().is_empty() || url.password().is_some()
        || !matches!(url.port(), None | Some(80) | Some(443)) { return false; }
    match url.host() {
        Some(url::Host::Ipv4(ip)) => public_ip(ip.into()),
        Some(url::Host::Ipv6(ip)) => public_ip(ip.into()),
        Some(url::Host::Domain(host)) => host.contains('.') && !host.ends_with('.')
            && !host.ends_with(".localhost") && !host.ends_with(".local"),
        None => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn rejects_private_ranges_and_non_http_resources() {
        for ip in ["127.0.0.1", "10.0.0.1", "192.168.1.1", "169.254.1.1", "100.64.0.1", "198.18.0.1", "::1", "::ffff:127.0.0.1", "fe80::1", "fc00::1", "2001:db8::1"] {
            assert!(!public_ip(ip.parse().unwrap()), "{ip}");
        }
        for value in ["file:///etc/passwd", "https://localhost/", "https://evil.local/", "https://127.0.0.1/", "https://user:pass@cdn.example/", "http://cdn.example:9999/"] {
            assert!(!media_url_allowed(&Url::parse(value).unwrap()), "{value}");
        }
        assert!(media_url_allowed(&Url::parse("https://live.cdn.example/index.m3u8?t=123").unwrap()));
        assert!(public_ip("8.8.8.8".parse().unwrap()));
        assert!(public_ip("2606:4700::1111".parse().unwrap()));
    }
}
