/// The playback API is hosted at www.douyu.com. Do not forward cookies
/// belonging only to the passport site, other subdomains, or lookalike hosts.
pub fn is_playback_domain(domain: &str) -> bool {
    matches!(domain.trim_start_matches('.').to_ascii_lowercase().as_str(), "douyu.com" | "www.douyu.com")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn includes_parent_domain_authentication_cookies() {
        assert!(is_playback_domain(".douyu.com"));
        assert!(is_playback_domain("douyu.com"));
        assert!(is_playback_domain("www.douyu.com"));
        assert!(is_playback_domain(".www.douyu.com"));
    }

    #[test]
    fn excludes_other_cookie_scopes_and_lookalike_hosts() {
        for domain in ["passport.douyu.com", "yuba.douyu.com", "douyu.com.evil.example", "notdouyu.com", ""] {
            assert!(!is_playback_domain(domain), "{domain}");
        }
    }
}
