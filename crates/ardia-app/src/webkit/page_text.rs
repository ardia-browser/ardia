use serde_json::{Value, json};

pub const PAGE_ACTION_SCHEME: &str = "ardia-page";
pub const MAX_WAITING_DIALOGS: usize = 4;
pub const MESSAGE_ROWS: usize = 24;
pub const MESSAGE_COLUMNS: usize = 80;
pub const PROMPT_TEXT_LIMIT: usize = 2000;
pub const SUPPRESS_DIALOGS: &str = "Prevent this page from creating additional dialogs";
pub const BLOCKED_POPUPS_KEPT: usize = 20;
pub const POPUP_SETTING: &str = "popups";

pub const NSURL_ERROR_DOMAIN: &str = "NSURLErrorDomain";
pub const CANCELLED: i64 = -999;
pub const BAD_URL: i64 = -1000;
pub const TIMED_OUT: i64 = -1001;
pub const UNSUPPORTED_URL: i64 = -1002;
pub const CANNOT_FIND_HOST: i64 = -1003;
pub const CANNOT_CONNECT_TO_HOST: i64 = -1004;
pub const NETWORK_CONNECTION_LOST: i64 = -1005;
pub const DNS_LOOKUP_FAILED: i64 = -1006;
pub const TOO_MANY_REDIRECTS: i64 = -1007;
pub const NOT_CONNECTED_TO_INTERNET: i64 = -1009;
pub const BAD_SERVER_RESPONSE: i64 = -1011;
pub const ZERO_BYTE_RESOURCE: i64 = -1014;
pub const INTERNATIONAL_ROAMING_OFF: i64 = -1018;
pub const DATA_NOT_ALLOWED: i64 = -1020;
pub const FILE_DOES_NOT_EXIST: i64 = -1100;
pub const NO_PERMISSIONS_TO_READ_FILE: i64 = -1102;
pub const SECURE_CONNECTION_FAILED: i64 = -1200;
pub const CERT_BAD_DATE: i64 = -1201;
pub const CERT_UNTRUSTED: i64 = -1202;
pub const CERT_UNKNOWN_ROOT: i64 = -1203;
pub const CERT_NOT_YET_VALID: i64 = -1204;
pub const CLIENT_CERT_REJECTED: i64 = -1205;
pub const CLIENT_CERT_REQUIRED: i64 = -1206;

pub fn elided_prompt_text(text: &str) -> String {
    if text.chars().count() <= PROMPT_TEXT_LIMIT {
        return text.to_owned();
    }
    let mut out: String = text.chars().take(PROMPT_TEXT_LIMIT - 1).collect();
    out.push('\u{2026}');
    out
}

pub fn elided_message(text: &str) -> String {
    let mut rows: Vec<String> = Vec::new();
    for line in text.split('\n') {
        let chars: Vec<char> = line.chars().collect();
        let mut start = 0;
        loop {
            let end = (start + MESSAGE_COLUMNS).min(chars.len());
            rows.push(chars[start..end].iter().collect());
            start = end;
            if start >= chars.len() || rows.len() > MESSAGE_ROWS {
                break;
            }
        }
        if rows.len() > MESSAGE_ROWS {
            break;
        }
    }
    if rows.len() <= MESSAGE_ROWS {
        return text.to_owned();
    }
    let mut out = rows[..MESSAGE_ROWS].join("\n");
    out.push('\u{2026}');
    out
}

pub fn sheet_title(host: &str) -> String {
    if host.is_empty() {
        "This page says".to_owned()
    } else {
        format!("{host} says")
    }
}

pub fn escape(text: &str) -> String {
    text.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&#39;")
}

pub fn page_action(name: &str, token: &str) -> String {
    format!("{PAGE_ACTION_SCHEME}://page/{name}/{token}")
}

pub fn page_action_parts(url: &str) -> Option<(String, String)> {
    let rest = url.strip_prefix(&format!("{PAGE_ACTION_SCHEME}://"))?;
    let (host, path) = rest.split_once('/')?;
    if host != "page" {
        return None;
    }
    let parts: Vec<&str> = path.split('/').filter(|p| !p.is_empty()).collect();
    (parts.len() == 2).then(|| (parts[0].to_owned(), parts[1].to_owned()))
}

pub fn is_cancelled(domain: &str, code: i64) -> bool {
    code == CANCELLED || (domain == "WebKitErrorDomain" && (code == 102 || code == 204))
}

pub fn is_certificate_failure(domain: &str, code: i64) -> bool {
    domain == NSURL_ERROR_DOMAIN
        && matches!(
            code,
            CERT_BAD_DATE
                | CERT_UNTRUSTED
                | CERT_UNKNOWN_ROOT
                | CERT_NOT_YET_VALID
                | SECURE_CONNECTION_FAILED
        )
}

pub fn certificate_fallback(code: i64) -> Vec<String> {
    match code {
        CERT_BAD_DATE | CERT_NOT_YET_VALID => vec!["dateInvalid".into()],
        SECURE_CONNECTION_FAILED => Vec::new(),
        _ => vec!["authorityInvalid".into()],
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct ErrorPage {
    pub title: String,
    pub html: String,
}

struct NetError {
    heading: &'static str,
    summary: String,
    code: &'static str,
    suggestions: Option<&'static str>,
}

fn net_error(domain: &str, code: i64, host: &str, url: &str) -> NetError {
    let site = format!("<strong>{}</strong>", escape(host));
    let unreachable = "This site can’t be reached";
    let dns_tips = "Checking the proxy, firewall, and DNS configuration";
    let proxy_tips = "Checking the proxy and the firewall";
    let broken = "This page isn’t working";
    let made = |heading, summary: String, code, suggestions| NetError {
        heading,
        summary,
        code,
        suggestions,
    };
    if domain != NSURL_ERROR_DOMAIN {
        return made(
            broken,
            format!("{site} sent an invalid response."),
            "ERR_FAILED",
            None,
        );
    }
    match code {
        CANNOT_FIND_HOST => made(
            unreachable,
            format!("{site}’s server IP address could not be found."),
            "ERR_NAME_NOT_RESOLVED",
            Some(dns_tips),
        ),
        DNS_LOOKUP_FAILED => made(
            unreachable,
            format!("{site}’s server IP address could not be found."),
            "ERR_NAME_RESOLUTION_FAILED",
            Some(dns_tips),
        ),
        CANNOT_CONNECT_TO_HOST => made(
            unreachable,
            format!("{site} refused to connect."),
            "ERR_CONNECTION_REFUSED",
            Some(proxy_tips),
        ),
        TIMED_OUT => made(
            unreachable,
            format!("{site} took too long to respond."),
            "ERR_CONNECTION_TIMED_OUT",
            Some(proxy_tips),
        ),
        NETWORK_CONNECTION_LOST => made(
            unreachable,
            "The connection was reset.".into(),
            "ERR_CONNECTION_RESET",
            Some(proxy_tips),
        ),
        TOO_MANY_REDIRECTS => made(
            broken,
            format!("{site} redirected you too many times."),
            "ERR_TOO_MANY_REDIRECTS",
            None,
        ),
        BAD_SERVER_RESPONSE => made(
            broken,
            format!("{site} sent an invalid response."),
            "ERR_INVALID_RESPONSE",
            None,
        ),
        ZERO_BYTE_RESOURCE => made(
            broken,
            format!("{site} didn’t send any data."),
            "ERR_EMPTY_RESPONSE",
            None,
        ),
        SECURE_CONNECTION_FAILED | CLIENT_CERT_REJECTED | CLIENT_CERT_REQUIRED => made(
            "This site can’t provide a secure connection",
            format!("{site} sent an invalid response."),
            if code == SECURE_CONNECTION_FAILED {
                "ERR_SSL_PROTOCOL_ERROR"
            } else {
                "ERR_BAD_SSL_CLIENT_AUTH_CERT"
            },
            None,
        ),
        FILE_DOES_NOT_EXIST => made(
            "Your file couldn’t be accessed",
            "It may have been moved, edited, or deleted.".into(),
            "ERR_FILE_NOT_FOUND",
            None,
        ),
        NO_PERMISSIONS_TO_READ_FILE => made(
            "Access to the file was denied",
            format!(
                "The file at {site} is not readable. It may have been removed, moved, or file permissions may be preventing access."
            ),
            "ERR_ACCESS_DENIED",
            None,
        ),
        UNSUPPORTED_URL => made(
            unreachable,
            format!("{site} uses an unsupported protocol."),
            "ERR_UNKNOWN_URL_SCHEME",
            None,
        ),
        _ => made(
            unreachable,
            format!(
                "The webpage at <strong>{}</strong> might be temporarily down or it may have moved permanently to a new web address.",
                escape(url)
            ),
            "ERR_FAILED",
            None,
        ),
    }
}

const SWATCHES: [(&str, (f64, f64, f64)); 8] = [
    ("plum", (192.0, 122.0, 152.0)),
    ("blue", (70.0, 145.0, 195.0)),
    ("purple", (120.0, 115.0, 175.0)),
    ("pink", (211.0, 123.0, 139.0)),
    ("red", (193.0, 87.0, 92.0)),
    ("orange", (216.0, 114.0, 73.0)),
    ("yellow", (227.0, 172.0, 56.0)),
    ("neutral", (142.0, 142.0, 147.0)),
];

pub fn theme_variables(name: Option<&str>) -> String {
    let key = if name == Some("incognito") {
        "neutral"
    } else {
        name.unwrap_or("")
    };
    let Some(&(_, mut c)) = SWATCHES.iter().find(|(n, _)| *n == key) else {
        return String::new();
    };
    if key == "neutral" {
        let y = (c.0 * 0.2126 + c.1 * 0.7152 + c.2 * 0.0722).round();
        c = (y, y, y);
    }
    let mix = |target: (f64, f64, f64), t: f64| {
        let channel = |a: f64, b: f64| (a + (b - a) * t).round() as i64;
        format!(
            "rgb({} {} {}",
            channel(c.0, target.0),
            channel(c.1, target.1),
            channel(c.2, target.2)
        )
    };
    let black = (0.0, 0.0, 0.0);
    let paper = (247.0, 245.0, 238.0);
    let light_bg = mix(paper, 0.88);
    let dark_bg = mix(black, 0.82);
    let light_text = mix(black, 0.8);
    let dark_text = mix(paper, 0.9);
    let rule = |name: &str, light: &str, dark: &str| format!("{name}:light-dark({light}),{dark}))");
    [
        rule("--bg", &light_bg, &dark_bg),
        rule("--text", &light_text, &dark_text),
        rule(
            "--text-2",
            &format!("{light_text} / .68"),
            &format!("{dark_text} / .68"),
        ),
        rule(
            "--text-3",
            &format!("{light_text} / .46"),
            &format!("{dark_text} / .45"),
        ),
        rule("--primary", &mix(black, 0.66), &mix(paper, 0.6)),
        rule("--primary-text", &light_bg, &dark_bg),
    ]
    .join(";")
}

pub fn error_page(
    url: &str,
    host: &str,
    domain: &str,
    code: i64,
    page_color: Option<&str>,
    token: &str,
) -> ErrorPage {
    let offline = domain == NSURL_ERROR_DOMAIN
        && matches!(
            code,
            NOT_CONNECTED_TO_INTERNET | DATA_NOT_ALLOWED | INTERNATIONAL_ROAMING_OFF
        );
    if offline {
        return offline_page(host, page_color, token);
    }
    let failure = net_error(domain, code, host, url);
    let suggestions = failure
        .suggestions
        .map(|tip| format!("<p>Try:</p><ul><li>Checking the connection</li><li>{tip}</li></ul>"))
        .unwrap_or_default();
    let html = format!(
        r#"<!doctype html><html><head><meta charset="utf-8"><meta name="color-scheme" content="light dark"><title>{title}</title>
<style>
:root{{--bg:#fff;--text:#5f6368;--heading:#202124;--button:#1a73e8;--button-text:#fff}}
@media (prefers-color-scheme: dark){{:root{{--bg:#202124;--text:#9aa0a6;--heading:#e8eaed;--button:#8ab4f8;--button-text:#202124}}}}
html,body{{margin:0;background:var(--bg);color:var(--text)}}
body{{font:15px/1.6 -apple-system,system-ui,sans-serif;word-wrap:break-word}}
main{{box-sizing:border-box;max-width:600px;margin:14vh auto 0;padding:0 24px}}
svg{{display:block;margin:0 0 40px}}
h1{{color:var(--heading);font-size:1.6em;font-weight:400;line-height:1.25em;margin:0 0 16px}}
p{{margin:0 0 4px}}ul{{margin:4px 0 0;padding-left:20px}}
.code{{display:block;margin-top:12px;font-size:.86667em;text-transform:uppercase}}
.button{{display:inline-block;margin-top:44px;padding:8px 16px;border-radius:20px;background:var(--button);color:var(--button-text);font-size:.875em;font-weight:500;text-decoration:none}}
</style></head><body><main>
<svg width="72" height="72" viewBox="0 0 72 72" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="4" d="M16 6h28l16 16v44H16z"/><path fill="currentColor" d="M27 36h5v5h-5zm13 0h5v5h-5zM26 53c6-6 14-6 20 0l-3 3c-4-4-10-4-14 0z"/></svg>
<h1>{heading}</h1><p>{summary}</p>{suggestions}<span class="code">{code}</span>
<a class="button" id="reload" href="{reload}">Reload</a>
</main></body></html>"#,
        title = escape(host),
        heading = failure.heading,
        summary = failure.summary,
        code = failure.code,
        reload = page_action("reload", token),
    );
    ErrorPage {
        title: host.to_owned(),
        html,
    }
}

fn offline_page(host: &str, page_color: Option<&str>, token: &str) -> ErrorPage {
    let dark = if page_color == Some("incognito") {
        " data-theme=\"dark\""
    } else {
        ""
    };
    let html = format!(
        r#"<!doctype html><html{dark} style="{style}"><head><meta charset="utf-8"><meta name="color-scheme" content="light dark"><title>{host} · No internet</title>
<style>
:root{{--bg:light-dark(#f2f0df,#182d24);--text:light-dark(#182d24,#f2f0df);--text-2:light-dark(rgba(24,45,36,.68),rgba(242,240,223,.68));--text-3:light-dark(rgba(24,45,36,.46),rgba(242,240,223,.45));--primary:light-dark(#203f32,#d3deb5);--primary-text:light-dark(#f2f0df,#182d24);color-scheme:light dark}}
:root[data-theme="dark"]{{color-scheme:dark}}
html,body{{margin:0;height:100%;background:var(--bg);color:var(--text)}}
body{{font:13px/1.45 -apple-system,system-ui,sans-serif;-webkit-font-smoothing:antialiased;display:grid;place-items:center}}
header{{display:grid;grid-template-columns:auto 1fr auto;align-items:center;gap:16px;max-width:760px;width:calc(100% - 48px)}}
svg{{color:var(--text-3)}}
h1{{margin:0 0 2px;font:600 23px/1.2 ui-serif,"New York",Georgia,serif;letter-spacing:-.01em}}
p{{margin:0;color:var(--text-2)}}
.code{{margin-top:6px;font:11px/1.4 Menlo,ui-monospace,monospace;color:var(--text-3);text-transform:uppercase;letter-spacing:.02em}}
.host{{text-transform:none}}
.button{{display:inline-flex;align-items:center;height:28px;padding:0 12px;border-radius:8px;background:var(--primary);color:var(--primary-text);font:500 13px/1 -apple-system,system-ui,sans-serif;text-decoration:none}}
</style></head><body><header>
<svg viewBox="0 0 48 48" width="48" height="48" aria-hidden="true"><path d="M8 18.5a23 23 0 0 1 32 0M13.5 24.5a15 15 0 0 1 21 0M19 30.5a7 7 0 0 1 10 0" fill="none" stroke="currentColor" stroke-width="3.2" stroke-linecap="round"/><path d="M6 6l36 36" stroke="currentColor" stroke-width="3.2" stroke-linecap="round"/></svg>
<div><h1>No internet</h1><p>Try checking your network cables, router, or Wi‑Fi.</p>
<p class="code">ERR_INTERNET_DISCONNECTED<span class="host"> · {host}</span></p></div>
<a class="button" id="reload" href="{reload}">Retry</a>
</header></body></html>"#,
        style = theme_variables(page_color),
        host = escape(host),
        reload = page_action("reload", token),
    );
    ErrorPage {
        title: format!("{host} · No internet"),
        html,
    }
}

const ERROR_CHECKS: [(&str, &[&str]); 9] = [
    ("revoked", &["Revocation", "RevocationResponseRequired"]),
    (
        "authorityInvalid",
        &[
            "AnchorTrusted",
            "MissingIntermediate",
            "IssuerCommonName",
            "BlackListedLeaf",
            "GrayListedLeaf",
        ],
    ),
    ("nameMismatch", &["SSLHostname"]),
    ("certificateTransparency", &["CTRequired"]),
    (
        "weakSignature",
        &["SignatureHashAlgorithms", "WeakSignature"],
    ),
    (
        "dateInvalid",
        &[
            "TemporalValidity",
            "ValidLeaf",
            "ValidIntermediates",
            "ValidRoot",
        ],
    ),
    ("validityTooLong", &["ValidityPeriodMaximums"]),
    (
        "nameConstraint",
        &["NameConstraints", "PermittedSubtrees", "ExcludedSubtrees"],
    ),
    (
        "weakKey",
        &[
            "KeySize",
            "WeakKeySize",
            "WeakLeaf",
            "WeakIntermediates",
            "WeakRoot",
        ],
    ),
];

const DISPLAY_ORDER: [&str; 10] = [
    "nameMismatch",
    "dateInvalid",
    "authorityInvalid",
    "revoked",
    "invalid",
    "weakSignature",
    "weakKey",
    "nameConstraint",
    "validityTooLong",
    "certificateTransparency",
];

const PRIMARY_ORDER: [&str; 10] = [
    "invalid",
    "revoked",
    "authorityInvalid",
    "nameMismatch",
    "certificateTransparency",
    "nameConstraint",
    "weakSignature",
    "weakKey",
    "dateInvalid",
    "validityTooLong",
];

pub fn error_names(failing_keys: &[String], failed: bool) -> Vec<String> {
    if !failed {
        return Vec::new();
    }
    let names: Vec<&str> = ERROR_CHECKS
        .iter()
        .filter(|(_, keys)| keys.iter().any(|k| failing_keys.iter().any(|f| f == k)))
        .map(|(name, _)| *name)
        .collect();
    if names.is_empty() {
        return vec!["invalid".into()];
    }
    DISPLAY_ORDER
        .iter()
        .filter(|n| names.contains(n))
        .map(|n| (*n).to_owned())
        .collect()
}

pub fn primary_error(errors: &[String]) -> String {
    PRIMARY_ORDER
        .iter()
        .find(|p| errors.iter().any(|e| e == *p))
        .map(|p| (*p).to_owned())
        .or_else(|| errors.first().cloned())
        .unwrap_or_else(|| "invalid".into())
}

fn net_error_name(primary: &str) -> &'static str {
    match primary {
        "nameMismatch" => "ERR_CERT_COMMON_NAME_INVALID",
        "dateInvalid" => "NET::ERR_CERT_DATE_INVALID",
        "authorityInvalid" => "NET::ERR_CERT_AUTHORITY_INVALID",
        "revoked" => "NET::ERR_CERT_REVOKED",
        "weakSignature" => "NET::ERR_CERT_WEAK_SIGNATURE_ALGORITHM",
        "weakKey" => "NET::ERR_CERT_WEAK_KEY",
        "nameConstraint" => "NET::ERR_CERT_NAME_CONSTRAINT_VIOLATION",
        "validityTooLong" => "NET::ERR_CERT_VALIDITY_TOO_LONG",
        "certificateTransparency" => "NET::ERR_CERTIFICATE_TRANSPARENCY_REQUIRED",
        _ => "NET::ERR_CERT_INVALID",
    }
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct Interstitial {
    pub url: String,
    pub host: String,
    pub errors: Vec<String>,
    pub fingerprint: Option<String>,
    pub overridable: bool,
    pub strict_transport: bool,
    pub certificate: Option<Value>,
}

pub fn interstitial_explanation(
    primary: &str,
    host: &str,
    certificate: Option<&Value>,
    now_ms: f64,
    clock: &str,
) -> String {
    let site = format!("<strong>{}</strong>", escape(host));
    let prove = format!("This server could not prove that it is {site};");
    let cause =
        "This may be caused by a misconfiguration or an attacker intercepting your connection.";
    let day = 86_400_000.0;
    match primary {
        "authorityInvalid" => format!(
            "{prove} its security certificate is not trusted by your computer's operating system. {cause}"
        ),
        "nameMismatch" => {
            let subject = certificate
                .and_then(|c| c.pointer("/subject/commonName"))
                .and_then(Value::as_str)
                .unwrap_or("");
            if subject.is_empty() {
                format!("{prove} its security certificate contains errors. {cause}")
            } else {
                format!(
                    "{prove} its security certificate is from <strong>{}</strong>. {cause}",
                    escape(subject)
                )
            }
        }
        "dateInvalid" => {
            let number = |key: &str| {
                certificate
                    .and_then(|c| c.get(key))
                    .and_then(Value::as_f64)
                    .unwrap_or(0.0)
            };
            let from = number("validFrom");
            let until = number("validUntil");
            if from > now_ms {
                let days = ((from - now_ms) / day).ceil() as i64;
                return if days <= 1 {
                    format!("{prove} its security certificate is supposedly from tomorrow. {cause}")
                } else {
                    format!(
                        "{prove} its security certificate is supposedly from {days} days in the future. {cause}"
                    )
                };
            }
            let days = ((now_ms - until) / day).floor() as i64;
            let expired = if days <= 1 {
                "its security certificate expired in the last day.".to_owned()
            } else {
                format!("its security certificate expired {days} days ago.")
            };
            format!(
                "{prove} {expired} {cause} Your computer's clock is currently set to {clock}. Does that look right? If not, you should correct your system's clock and then refresh this page."
            )
        }
        _ => format!("{prove} its security certificate contains errors. {cause}"),
    }
}

pub fn interstitial_page(blocked: &Interstitial, token: &str, now_ms: f64, clock: &str) -> String {
    let primary = primary_error(&blocked.errors);
    let site = escape(&blocked.host);
    let explain = || {
        interstitial_explanation(
            &primary,
            &blocked.host,
            blocked.certificate.as_ref(),
            now_ms,
            clock,
        )
    };
    let details = if blocked.overridable {
        format!(
            "<p>{}</p><p><a id=\"proceed\" href=\"{}\">Proceed to {site} (unsafe)</a></p>",
            explain(),
            page_action("proceed", token)
        )
    } else if primary == "revoked" {
        format!(
            "<p>You cannot visit {site} right now because its certificate has been revoked. Network errors and attacks are usually temporary, so this page will probably work later.</p>"
        )
    } else if blocked.strict_transport {
        format!(
            "<p>{}</p><p>You cannot visit {site} right now because the website uses HSTS. Network errors and attacks are usually temporary, so this page will probably work later.</p>",
            explain()
        )
    } else {
        format!(
            "<p>You cannot visit {site} right now because the website sent scrambled credentials that Ardia cannot process. Network errors and attacks are usually temporary, so this page will probably work later.</p>"
        )
    };
    format!(
        r#"<!doctype html><html><head><meta charset="utf-8"><meta name="color-scheme" content="light dark"><title>Privacy error</title>
<style>
:root{{--bg:#fff;--text:#5f6368;--heading:#202124;--accent:#1a73e8;--accent-text:#fff;--border:#dadce0;--danger:#d93025}}
@media (prefers-color-scheme: dark){{:root{{--bg:#202124;--text:#9aa0a6;--heading:#e8eaed;--accent:#8ab4f8;--accent-text:#202124;--border:#5f6368;--danger:#f28b82}}}}
html,body{{margin:0;background:var(--bg);color:var(--text)}}
body{{font:15px/1.6 -apple-system,system-ui,sans-serif;word-wrap:break-word}}
main{{box-sizing:border-box;max-width:600px;margin:14vh auto 0;padding:0 24px}}
svg{{display:block;margin:0 0 40px;color:var(--danger)}}
h1{{color:var(--heading);font-size:1.6em;font-weight:400;line-height:1.25em;margin:0 0 16px}}
p{{margin:0 0 12px}}a{{color:var(--accent)}}
.code{{display:block;margin-top:12px;font-size:.86667em;text-transform:uppercase}}
.buttons{{display:flex;flex-direction:row-reverse;justify-content:space-between;align-items:center;margin-top:44px}}
.button{{font-family:inherit;display:inline-block;padding:8px 16px;border-radius:20px;font-size:.875em;font-weight:500;text-decoration:none;border:1px solid var(--accent);background:var(--accent);color:var(--accent-text);cursor:default}}
.button.secondary{{background:transparent;color:var(--accent);border-color:var(--border)}}
#details{{display:none;margin-top:40px;padding-top:16px}}#details.open{{display:block}}
</style></head><body><main>
<svg width="72" height="72" viewBox="0 0 72 72" aria-hidden="true"><path fill="currentColor" d="M36 6 2 66h68zm0 12 23 42H13zm-3 14h6v14h-6zm0 18h6v6h-6z"/></svg>
<h1>Your connection is not private</h1>
<p>Attackers might be trying to steal your information from <strong>{site}</strong> (for example, passwords, messages, or credit cards).</p>
<span class="code">{code}</span>
<div class="buttons"><a class="button" id="back" href="{back}">Back to safety</a>
<button class="button secondary" id="advanced" type="button" onclick="var o=document.getElementById('details').classList.toggle('open');this.textContent=o?'Hide advanced':'Advanced'">Advanced</button></div>
<div id="details">{details}</div>
</main></body></html>"#,
        code = net_error_name(&primary),
        back = page_action("back", token),
    )
}

pub fn is_ip_address(host: &str) -> bool {
    let bare = host.trim_matches(|c| c == '[' || c == ']');
    bare.parse::<std::net::IpAddr>().is_ok()
}

pub fn upgrades_to_https(host: &str, port: Option<u16>) -> bool {
    if !(port.is_none() || port == Some(80)) || is_ip_address(host) || !host.contains('.') {
        return false;
    }
    const RESERVED: [&str; 8] = [
        ".local",
        ".localhost",
        ".test",
        ".example",
        ".invalid",
        ".internal",
        ".lan",
        ".home.arpa",
    ];
    !RESERVED.iter().any(|suffix| host.ends_with(suffix))
}

pub fn safe_download_name(name: &str) -> String {
    const MAX_BYTES: usize = 255;
    const MAX_EXTENSION_BYTES: usize = 32;
    let visible: String = name
        .chars()
        .filter(|c| {
            !(c.is_control() || matches!(*c as u32, 0xFFFE | 0xFFFF))
                || matches!(*c, '\u{200C}' | '\u{200D}')
        })
        .collect();
    let cleaned = visible.replace(['/', ':'], "_");
    let trimmed = cleaned.trim_matches(|c: char| c == '.' || c == ' ' || c.is_whitespace());
    if trimmed.is_empty() {
        return "download".into();
    }
    if trimmed.len() <= MAX_BYTES {
        return trimmed.to_owned();
    }
    let ext = std::path::Path::new(trimmed)
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("");
    let suffix = if ext.is_empty() || ext.len() > MAX_EXTENSION_BYTES {
        String::new()
    } else {
        format!(".{ext}")
    };
    let mut stem: String = if suffix.is_empty() {
        trimmed.to_owned()
    } else {
        trimmed[..trimmed.len() - suffix.len()].to_owned()
    };
    while stem.len() + suffix.len() > MAX_BYTES {
        stem.pop();
    }
    stem + &suffix
}

pub const BLOCKED_SCHEMES: [&str; 15] = [
    "afp",
    "cifs",
    "disk",
    "disks",
    "hcp",
    "ms-help",
    "nfs",
    "res",
    "shell",
    "smb",
    "vbscript",
    "view-source",
    "vnc",
    "x-man-page",
    "x-apple.systempreferences",
];

pub fn is_trustworthy(origin: &str) -> bool {
    let Ok(url) = url::Url::parse(origin) else {
        return false;
    };
    let Some(host) = url.host_str().map(str::to_ascii_lowercase) else {
        return false;
    };
    match url.scheme() {
        "https" => true,
        "http" => {
            host == "localhost"
                || host.ends_with(".localhost")
                || host == "127.0.0.1"
                || host == "::1"
                || host == "[::1]"
        }
        _ => false,
    }
}

pub fn origin_of(url: &str) -> Option<String> {
    let parsed = url::Url::parse(url).ok()?;
    let origin = parsed.origin();
    origin.is_tuple().then(|| origin.ascii_serialization())
}

pub struct ExternalApp<'a> {
    pub id: &'a str,
    pub url: &'a str,
    pub scheme: &'a str,
    pub origin: Option<&'a str>,
    pub app: Option<&'a str>,
    pub app_path: Option<&'a str>,
    pub icon: Option<&'a str>,
    pub rememberable: bool,
}

pub fn external_app_request(request: &ExternalApp) -> Value {
    let title = request.app.map_or_else(
        || "No application is set to open this link".to_owned(),
        |name| format!("Open “{name}”?"),
    );
    let message = if request.app.is_none() {
        format!(
            "Your Mac doesn’t have an app for “{}:” links.",
            request.scheme
        )
    } else {
        request.origin.map_or_else(
            || "This page wants to open this application.".to_owned(),
            |origin| format!("{origin} wants to open this application."),
        )
    };
    let remember = match (request.rememberable, request.origin, request.app) {
        (true, Some(origin), Some(app)) => Value::String(format!(
            "Always allow {origin} to open links of this type in {app}"
        )),
        _ => Value::Null,
    };
    json!({
        "id": request.id,
        "url": request.url,
        "scheme": request.scheme,
        "origin": request.origin,
        "app": request.app,
        "appPath": request.app_path,
        "icon": request.icon,
        "title": title,
        "message": message,
        "remember": remember,
    })
}

pub fn hex_upper(text: &str) -> String {
    text.bytes().map(|b| format!("{b:02X}")).collect()
}

pub fn same_page(a: &str, b: &str) -> bool {
    let strip = |url: &str| url.split('#').next().unwrap_or(url).to_owned();
    strip(a) == strip(b)
}

pub fn content_disposition_attachment(header: Option<&str>) -> bool {
    header.is_some_and(|h| {
        h.trim_start()
            .to_ascii_lowercase()
            .starts_with("attachment")
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dialog_text_is_elided_like_the_old_app() {
        assert_eq!(elided_message("short"), "short");
        let long = "x".repeat(80 * 30);
        let out = elided_message(&long);
        assert!(out.ends_with('\u{2026}'));
        assert_eq!(out.lines().count(), MESSAGE_ROWS);
        assert_eq!(elided_prompt_text("abc"), "abc");
        assert_eq!(elided_prompt_text(&"y".repeat(3000)).chars().count(), 2000);
        assert_eq!(sheet_title(""), "This page says");
        assert_eq!(sheet_title("example.com"), "example.com says");
    }

    #[test]
    fn error_pages_use_chromium_codes() {
        let page = error_page(
            "https://nope.invalid/",
            "nope.invalid",
            NSURL_ERROR_DOMAIN,
            CANNOT_FIND_HOST,
            None,
            "t",
        );
        assert!(page.html.contains("ERR_NAME_NOT_RESOLVED"));
        assert!(
            page.html
                .contains("<strong>nope.invalid</strong>’s server IP address")
        );
        assert!(page.html.contains("ardia-page://page/reload/t"));
        assert_eq!(page.title, "nope.invalid");
        let offline = error_page(
            "https://a.com/",
            "a.com",
            NSURL_ERROR_DOMAIN,
            NOT_CONNECTED_TO_INTERNET,
            Some("incognito"),
            "t",
        );
        assert_eq!(offline.title, "a.com · No internet");
        assert!(offline.html.contains("data-theme=\"dark\""));
        assert!(offline.html.contains("--bg:light-dark(rgb("));
        assert_eq!(
            page_action_parts("ardia-page://page/reload/t"),
            Some(("reload".into(), "t".into()))
        );
        assert_eq!(page_action_parts("ardia-page://x/reload/t"), None);
        assert!(is_cancelled("WebKitErrorDomain", 102));
        assert!(is_cancelled(NSURL_ERROR_DOMAIN, CANCELLED));
    }

    #[test]
    fn certificate_errors_order_and_copy() {
        let names = error_names(&["SSLHostname".into(), "TemporalValidity".into()], true);
        assert_eq!(names, vec!["nameMismatch", "dateInvalid"]);
        assert_eq!(primary_error(&names), "nameMismatch");
        assert_eq!(error_names(&[], true), vec!["invalid"]);
        assert!(error_names(&["SSLHostname".into()], false).is_empty());
        let blocked = Interstitial {
            url: "https://a.com/".into(),
            host: "a.com".into(),
            errors: vec!["authorityInvalid".into()],
            fingerprint: Some("AA".into()),
            overridable: true,
            ..Interstitial::default()
        };
        let html = interstitial_page(&blocked, "tok", 0.0, "Monday");
        assert!(html.contains("NET::ERR_CERT_AUTHORITY_INVALID"));
        assert!(html.contains("Proceed to a.com (unsafe)"));
        assert!(html.contains("ardia-page://page/proceed/tok"));
        let expired = interstitial_explanation(
            "dateInvalid",
            "a.com",
            Some(&json!({"validFrom": 0.0, "validUntil": 0.0})),
            86_400_000.0 * 5.0,
            "Monday, January 6, 1970",
        );
        assert!(expired.contains("expired 5 days ago"));
    }

    #[test]
    fn https_upgrades_skip_local_names() {
        assert!(upgrades_to_https("example.org", None));
        assert!(!upgrades_to_https("printer.local", None));
        assert!(!upgrades_to_https("10.0.0.1", None));
        assert!(!upgrades_to_https("intranet", None));
        assert!(!upgrades_to_https("example.org", Some(8080)));
    }

    #[test]
    fn download_names_are_safe() {
        assert_eq!(safe_download_name("a/b:c.txt"), "a_b_c.txt");
        assert_eq!(safe_download_name(" .. "), "download");
        let long = format!("{}.pdf", "n".repeat(300));
        let fitted = safe_download_name(&long);
        assert!(fitted.ends_with(".pdf") && fitted.len() == 255);
    }

    #[test]
    fn external_app_requests_match_the_old_copy() {
        assert!(is_trustworthy("https://a.com"));
        assert!(is_trustworthy("http://localhost:3000"));
        assert!(!is_trustworthy("http://a.com"));
        let request = external_app_request(&ExternalApp {
            id: "wk-external-1",
            url: "mailto:a@b.c",
            scheme: "mailto",
            origin: Some("https://a.com"),
            app: Some("Mail"),
            app_path: Some("/System/Applications/Mail.app"),
            icon: None,
            rememberable: true,
        });
        assert_eq!(request["title"], "Open “Mail”?");
        assert_eq!(
            request["message"],
            "https://a.com wants to open this application."
        );
        assert_eq!(
            request["remember"],
            "Always allow https://a.com to open links of this type in Mail"
        );
        let none = external_app_request(&ExternalApp {
            id: "x",
            url: "zz:1",
            scheme: "zz",
            origin: None,
            app: None,
            app_path: None,
            icon: None,
            rememberable: false,
        });
        assert_eq!(
            none["message"],
            "Your Mac doesn’t have an app for “zz:” links."
        );
        assert_eq!(
            origin_of("https://a.com/x?y").as_deref(),
            Some("https://a.com")
        );
        assert!(same_page("https://a.com/#x", "https://a.com/"));
        assert_eq!(hex_upper("ab"), "6162");
        assert!(content_disposition_attachment(Some(
            "Attachment; filename=x"
        )));
    }
}
