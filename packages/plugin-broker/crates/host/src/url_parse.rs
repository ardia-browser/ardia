use url::Url;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ParsedUrl {
    pub protocol: String,
    pub username: String,
    pub password: String,
    pub hostname: String,
    pub port: String,
    pub pathname: String,
    pub search: String,
    pub hash: String,
    pub authority: bool,
    pub special: bool,
}

const SPECIAL: [&str; 6] = ["http", "https", "ws", "wss", "ftp", "file"];

fn marked(prefix: char, part: Option<&str>) -> String {
    match part {
        None => String::new(),
        Some(text) => format!("{prefix}{text}"),
    }
}

pub fn parse(input: &str, base: Option<&str>) -> Option<ParsedUrl> {
    let url = match base {
        None => Url::parse(input).ok()?,
        Some(base) => {
            let base = Url::parse(base).ok()?;
            Url::options().base_url(Some(&base)).parse(input).ok()?
        }
    };
    let scheme = url.scheme().to_string();
    Some(ParsedUrl {
        special: SPECIAL.contains(&scheme.as_str()),
        protocol: format!("{scheme}:"),
        username: url.username().to_string(),
        password: url.password().unwrap_or("").to_string(),
        hostname: url.host_str().unwrap_or("").to_string(),
        port: url.port().map(|port| port.to_string()).unwrap_or_default(),
        pathname: url.path().to_string(),
        search: marked('?', url.query()),
        hash: marked('#', url.fragment()),
        authority: url.has_authority(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn href(p: &ParsedUrl) -> String {
        let auth = if p.username.is_empty() {
            String::new()
        } else if p.password.is_empty() {
            format!("{}@", p.username)
        } else {
            format!("{}:{}@", p.username, p.password)
        };
        let host = if p.hostname.contains(':') && !p.hostname.starts_with('[') { format!("[{}]", p.hostname) } else { p.hostname.clone() };
        let port = if p.port.is_empty() { String::new() } else { format!(":{}", p.port) };
        if p.authority {
            format!("{}//{}{}{}{}{}{}", p.protocol, auth, host, port, p.pathname, p.search, p.hash)
        } else {
            format!("{}{}{}{}", p.protocol, p.pathname, p.search, p.hash)
        }
    }

    #[test]
    fn composes_back_to_the_whatwg_href() {
        for input in [
            "https://user:pa%20ss@Example.COM:8080/a/../b?x=1#frag",
            "http://example.com",
            "http://example.com:80/",
            "file:///etc/hosts",
            "mailto:someone@example.com",
            "http://[::1]:3000/x",
            "http://example.com/?",
            "http://example.com/#",
            "data:text/plain,hi",
            "foo://Host/path",
            "https://bücher.de/",
        ] {
            let url = Url::parse(input).unwrap();
            assert_eq!(href(&parse(input, None).unwrap()), url.as_str(), "{input}");
        }
    }

    #[test]
    fn resolves_against_a_base() {
        let p = parse("../c?q", Some("https://example.com/a/b/")).unwrap();
        assert_eq!(p.pathname, "/a/c");
        assert_eq!(p.search, "?q");
        assert_eq!(parse("//other.org/x", Some("https://example.com/")).unwrap().hostname, "other.org");
        assert!(parse("x", Some("not a url")).is_none());
        assert!(parse("relative/only", None).is_none());
    }

    #[test]
    fn reports_the_shape_the_prelude_expects() {
        let p = parse("HTTPS://Example.com:443/", None).unwrap();
        assert_eq!(
            p,
            ParsedUrl {
                protocol: "https:".into(),
                username: String::new(),
                password: String::new(),
                hostname: "example.com".into(),
                port: String::new(),
                pathname: "/".into(),
                search: String::new(),
                hash: String::new(),
                authority: true,
                special: true,
            }
        );
        let opaque = parse("mailto:a@b.c", None).unwrap();
        assert!(!opaque.authority);
        assert!(!opaque.special);
        assert_eq!(opaque.pathname, "a@b.c");
    }
}
