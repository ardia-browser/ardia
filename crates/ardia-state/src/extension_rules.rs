use std::collections::BTreeSet;

pub const MAX_SITE_LENGTH: usize = 2048;

pub const INVALID_SITE: &str = "Enter a site like example.com or https://*.example.com. A port needs http:// or https:// in front.";

pub const NOT_A_STORE_LINK: &str = "That isn't a link to an extension in the Chrome Web Store.";

pub fn is_extension_id(text: &str) -> bool {
    text.len() == 32 && text.bytes().all(|b| (b'a'..=b'p').contains(&b))
}

pub fn web_store_extension_id(url_or_id: &str) -> Option<String> {
    let text = url_or_id.trim();
    if is_extension_id(text) {
        return Some(text.to_owned());
    }
    let url = url::Url::parse(text).ok()?;
    let host = url.host_str()?;
    let store = host == "chromewebstore.google.com"
        || (host == "chrome.google.com" && url.path().starts_with("/webstore/"));
    if !store {
        return None;
    }
    url.path()
        .split('/')
        .find(|part| is_extension_id(part))
        .map(str::to_owned)
}

pub fn web_store_detail_url(id: &str) -> String {
    format!("https://chromewebstore.google.com/detail/{id}")
}

fn split_scheme(text: &str) -> Option<(&str, &str)> {
    let at = text.find("://")?;
    let scheme = &text[..at];
    let mut chars = scheme.chars();
    let first = chars.next()?;
    let valid = first.is_ascii_alphabetic()
        && chars.all(|c| c.is_ascii_alphanumeric() || matches!(c, '+' | '.' | '-'));
    valid.then(|| (scheme, &text[at + 3..]))
}

fn port_of(authority: &str) -> Option<&str> {
    let after = if authority.starts_with('[') {
        authority.find(']').map_or("", |end| &authority[end + 1..])
    } else {
        authority
    };
    after.find(':').map(|colon| &after[colon + 1..])
}

fn is_dotted_quad(host: &str) -> bool {
    let parts: Vec<&str> = host.split('.').collect();
    parts.len() == 4
        && parts
            .iter()
            .all(|p| !p.is_empty() && p.len() <= 3 && p.bytes().all(|b| b.is_ascii_digit()))
}

fn numeric_label(label: &str) -> bool {
    let lower = label.to_ascii_lowercase();
    if let Some(hex) = lower.strip_prefix("0x") {
        return hex.bytes().all(|b| b.is_ascii_hexdigit());
    }
    !lower.is_empty() && lower.bytes().all(|b| b.is_ascii_digit())
}

fn valid_port(port: &str) -> bool {
    let digits = !port.is_empty()
        && port.len() <= 5
        && !port.starts_with('0')
        && port.bytes().all(|b| b.is_ascii_digit());
    digits && port.parse::<u32>().is_ok_and(|n| n <= 65535)
}

pub fn extension_site_pattern(typed: &str) -> Option<String> {
    let trimmed = typed.trim();
    if trimmed.is_empty()
        || trimmed.chars().count() > MAX_SITE_LENGTH
        || trimmed.chars().any(char::is_whitespace)
    {
        return None;
    }
    let (scheme, rest) = match split_scheme(trimmed) {
        Some((scheme, rest)) => (scheme.to_ascii_lowercase(), rest),
        None => ("*".to_owned(), trimmed),
    };
    if !matches!(scheme.as_str(), "*" | "http" | "https") {
        return None;
    }
    let wildcard = rest.starts_with("*.");
    let rest = if wildcard { &rest[2..] } else { rest };
    let authority = rest.split(['/', '?', '#']).next().unwrap_or_default();
    if authority.is_empty() || authority.contains(['@', '%', '\\']) {
        return None;
    }
    let port = port_of(authority);
    if let Some(port) = port
        && (scheme == "*" || !valid_port(port))
    {
        return None;
    }
    let raw_host = match port {
        Some(port) => &authority[..authority.len() - port.len() - 1],
        None => authority,
    };
    if !raw_host.starts_with('[') {
        let last = raw_host
            .trim_end_matches('.')
            .rsplit('.')
            .next()
            .unwrap_or_default();
        if numeric_label(last) && !is_dotted_quad(raw_host.trim_end_matches('.')) {
            return None;
        }
    }
    let base = if scheme == "*" { "https" } else { &scheme };
    let parsed = url::Url::parse(&format!("{base}://{raw_host}/")).ok()?;
    let host = match parsed.host()? {
        url::Host::Domain(domain) => domain.to_owned(),
        url::Host::Ipv4(ip) => ip.to_string(),
        url::Host::Ipv6(ip) => format!("[{ip}]"),
    };
    if host.is_empty() {
        return None;
    }
    if !host.starts_with('[')
        && !host
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'-' | b'_'))
    {
        return None;
    }
    if wildcard
        && (host.starts_with('[')
            || is_dotted_quad(&host)
            || !host.trim_end_matches('.').contains('.'))
    {
        return None;
    }
    let star = if wildcard { "*." } else { "" };
    let port = port.map(|p| format!(":{p}")).unwrap_or_default();
    Some(format!("{scheme}://{star}{host}{port}/*"))
}

pub fn extension_site_label(pattern: &str) -> String {
    let without_scheme = pattern.strip_prefix("*://").unwrap_or(pattern);
    without_scheme
        .strip_suffix("/*")
        .unwrap_or(without_scheme)
        .to_owned()
}

const PERMISSION_WARNINGS: [(&str, &str); 20] = [
    ("bookmarks", "Read and change your bookmarks"),
    ("clipboardRead", "Read data you copy and paste"),
    ("clipboardWrite", "Modify data you copy and paste"),
    (
        "contentSettings",
        "Change your settings that control websites' access to features such as cookies, JavaScript, plugins, geolocation, microphone, camera etc.",
    ),
    ("desktopCapture", "Capture content of your screen"),
    ("downloads", "Manage your downloads"),
    ("downloads.open", "Open downloaded files"),
    ("geolocation", "Detect your physical location"),
    ("management", "Manage your apps, extensions, and themes"),
    (
        "nativeMessaging",
        "Communicate with cooperating native applications",
    ),
    ("notifications", "Display notifications"),
    ("privacy", "Change your privacy-related settings"),
    ("readingList", "Read and change entries in the reading list"),
    (
        "sessions",
        "Read your browsing history on all your signed-in devices",
    ),
    ("system.storage", "Identify and eject storage devices"),
    ("tabCapture", "Capture content of your screen"),
    ("tabGroups", "View and manage your tab groups"),
    (
        "topSites",
        "Read a list of your most frequently visited websites",
    ),
    ("ttsEngine", "Read all text spoken using synthesized speech"),
    (
        "webAuthenticationProxy",
        "Read and change all your data on all websites",
    ),
];

fn host_label(pattern: &str) -> Option<String> {
    let at = pattern.find("://")?;
    if at == 0 {
        return None;
    }
    let rest = &pattern[at + 3..];
    let (wild, rest) = match rest.strip_prefix("*.") {
        Some(rest) => (true, rest),
        None => (false, rest),
    };
    let host = rest.split('/').next().unwrap_or_default();
    if host.is_empty() {
        return None;
    }
    Some(if wild {
        format!("all {host} sites")
    } else {
        host.to_owned()
    })
}

fn all_hosts_pattern(pattern: &str) -> bool {
    if pattern == "<all_urls>" {
        return true;
    }
    ["*", "http", "https", "ws", "wss"]
        .iter()
        .any(|scheme| pattern.starts_with(&format!("{scheme}://*/")))
}

pub fn permission_warnings(permissions: &[String], host_permissions: &[String]) -> Vec<String> {
    let perms: BTreeSet<&str> = permissions.iter().map(String::as_str).collect();
    let hosts: Vec<&String> = host_permissions
        .iter()
        .filter(|h| {
            !["chrome:", "chrome-extension:", "about:", "data:"]
                .iter()
                .any(|scheme| h.starts_with(scheme))
        })
        .collect();
    let all_hosts = hosts.iter().any(|h| all_hosts_pattern(h)) || perms.contains("debugger");
    let mut warnings: Vec<String> = Vec::new();
    if all_hosts || perms.contains("proxy") || perms.contains("pageCapture") {
        warnings.push("Read and change all your data on all websites".to_owned());
    } else if !hosts.is_empty() {
        let mut names: Vec<String> = Vec::new();
        for name in hosts.iter().filter_map(|h| host_label(h)) {
            if !names.contains(&name) {
                names.push(name);
            }
        }
        match names.as_slice() {
            [] => {}
            [one] => warnings.push(format!("Read and change your data on {one}")),
            [one, two] => warnings.push(format!("Read and change your data on {one} and {two}")),
            [one, two, three] => warnings.push(format!(
                "Read and change your data on {one}, {two}, and {three}"
            )),
            _ => warnings.push("Read and change your data on a number of websites".to_owned()),
        }
    }
    let clipboard = perms.contains("clipboardRead") && perms.contains("clipboardWrite");
    if clipboard {
        warnings.push("Read and modify data you copy and paste".to_owned());
    }
    for (permission, message) in PERMISSION_WARNINGS {
        if clipboard && permission.starts_with("clipboard") {
            continue;
        }
        if perms.contains(permission) {
            warnings.push(message.to_owned());
        }
    }
    if perms.contains("declarativeNetRequest")
        && !all_hosts
        && !perms.contains("declarativeNetRequestWithHostAccess")
    {
        warnings.push("Block content on any page".to_owned());
    }
    let history = perms.contains("history");
    if !history && (perms.contains("tabs") || perms.contains("webNavigation")) && !all_hosts {
        warnings.push("Read your browsing history".to_owned());
    }
    if history {
        warnings
            .push("Read and change your browsing history on all your signed-in devices".to_owned());
    }
    let mut seen = BTreeSet::new();
    warnings.retain(|w| seen.insert(w.clone()));
    warnings
}

#[cfg(test)]
mod tests {
    use super::*;

    const ID: &str = "abcdefghijklmnopabcdefghijklmnop";

    #[test]
    fn store_links_and_bare_ids_give_the_extension_id() {
        assert_eq!(web_store_extension_id(ID).as_deref(), Some(ID));
        assert_eq!(
            web_store_extension_id(&format!(
                " https://chromewebstore.google.com/detail/ublock/{ID}?hl=en "
            ))
            .as_deref(),
            Some(ID)
        );
        assert_eq!(
            web_store_extension_id(&format!("https://chrome.google.com/webstore/detail/x/{ID}"))
                .as_deref(),
            Some(ID)
        );
        assert_eq!(
            web_store_extension_id(&format!("https://chrome.google.com/other/{ID}")),
            None
        );
        assert_eq!(
            web_store_extension_id(&format!("https://evil.com/detail/{ID}")),
            None
        );
        assert_eq!(
            web_store_extension_id("ABCDEFGHIJKLMNOPABCDEFGHIJKLMNOP"),
            None
        );
        assert_eq!(
            web_store_extension_id("chromewebstore.google.com/detail/x"),
            None
        );
    }

    #[test]
    fn typed_sites_become_match_patterns_like_the_old_app() {
        let cases = [
            ("example.com", Some("*://example.com/*")),
            ("  Example.COM/path?q#h ", Some("*://example.com/*")),
            ("https://*.example.com", Some("https://*.example.com/*")),
            ("http://example.com:8080", Some("http://example.com:8080/*")),
            ("example.com:8080", None),
            ("https://example.com:0", None),
            ("https://example.com:65536", None),
            ("ftp://example.com", None),
            ("*.com", None),
            ("*.1.2.3.4", None),
            ("1.2.3.4", Some("*://1.2.3.4/*")),
            ("1.2.3", None),
            ("user@example.com", None),
            ("exa mple.com", None),
            ("", None),
            ("bücher.de", Some("*://xn--bcher-kva.de/*")),
            ("[::1]", Some("*://[::1]/*")),
        ];
        for (typed, want) in cases {
            assert_eq!(extension_site_pattern(typed).as_deref(), want, "{typed}");
        }
        assert_eq!(extension_site_pattern(&"a".repeat(2049)), None);
    }

    #[test]
    fn site_labels_drop_only_the_any_scheme_and_path() {
        assert_eq!(extension_site_label("*://example.com/*"), "example.com");
        assert_eq!(
            extension_site_label("https://*.example.com/*"),
            "https://*.example.com"
        );
        assert_eq!(extension_site_label("<all_urls>"), "<all_urls>");
    }

    #[test]
    fn permission_warnings_follow_the_old_rules() {
        let s = |v: &[&str]| v.iter().map(|x| x.to_string()).collect::<Vec<_>>();
        assert_eq!(
            permission_warnings(&s(&["tabs", "storage"]), &s(&["<all_urls>"])),
            vec!["Read and change all your data on all websites"]
        );
        assert_eq!(
            permission_warnings(&s(&["tabs"]), &s(&["https://*.a.com/*", "https://b.com/*"])),
            vec![
                "Read and change your data on all a.com sites and b.com",
                "Read your browsing history"
            ]
        );
        assert_eq!(
            permission_warnings(&s(&["clipboardRead", "clipboardWrite", "history"]), &[]),
            vec![
                "Read and modify data you copy and paste",
                "Read and change your browsing history on all your signed-in devices"
            ]
        );
        assert_eq!(
            permission_warnings(&s(&["declarativeNetRequest"]), &s(&["chrome://x/*"])),
            vec!["Block content on any page"]
        );
        assert_eq!(
            permission_warnings(
                &[],
                &s(&[
                    "https://a.com/*",
                    "https://b.com/*",
                    "https://c.com/*",
                    "https://d.com/*"
                ])
            ),
            vec!["Read and change your data on a number of websites"]
        );
        assert!(permission_warnings(&[], &[]).is_empty());
    }
}
