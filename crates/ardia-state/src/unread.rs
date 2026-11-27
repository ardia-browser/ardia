use crate::omnibox::url::host_of;
use crate::settings::Settings;
use crate::tabs::Tab;

#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub enum Unread {
    Dot,
    Count(String),
}

const MAX_LABEL_WORDS: usize = 3;
const MAX_LABEL_CHARS: usize = 32;
const UNREAD_LABEL_WORDS: &[&str] = &[
    "inbox",
    "mail",
    "email",
    "messages",
    "message",
    "chat",
    "chats",
    "notifications",
    "notification",
    "mentions",
    "activity",
    "conversations",
    "dms",
    "unread",
    "updates",
    "alerts",
];
const STAR_MEANS_UNREAD: &[&str] = &["slack.com"];
const PHRASE_TAILS: &[&str] = &[
    "unread",
    "new messages",
    "new message",
    "new notifications",
    "new notification",
    "new e-mails",
    "new e-mail",
    "new emails",
    "new email",
    "new mails",
    "new mail",
    "new chats",
    "new chat",
];
const SEGMENT_MARKS: &[char] = &['-', '–', '—', '|', '·', '•', ':', '/'];

pub fn unread_count(n: u64, more: bool) -> Option<Unread> {
    if n < 1 {
        return None;
    }
    Some(Unread::Count(if n > 99 {
        "99+".to_owned()
    } else if more {
        format!("{n}+")
    } else {
        n.to_string()
    }))
}

struct Counted {
    digits: String,
    more: bool,
    end: usize,
}

fn count_at(chars: &[char], start: usize) -> Option<Counted> {
    let run = chars[start..]
        .iter()
        .take_while(|c| c.is_ascii_digit())
        .count();
    if run == 0 {
        return None;
    }
    let mut end = start + run;
    let mut digits: String = chars[start..end].iter().collect();
    let mut grouped = false;
    if run <= 3 {
        while end + 4 <= chars.len()
            && chars.get(end) == Some(&',')
            && chars[end + 1..end + 4].iter().all(char::is_ascii_digit)
        {
            digits.extend(&chars[end + 1..end + 4]);
            end += 4;
            grouped = true;
        }
    }
    if !grouped && run > 6 {
        return None;
    }
    let more = chars.get(end) == Some(&'+');
    if more {
        end += 1;
    }
    Some(Counted { digits, more, end })
}

fn count_of(counted: &Counted) -> Option<Unread> {
    let digits = &counted.digits;
    let n: u64 = digits.parse().ok()?;
    if digits.len() == 4 && (1900..=2100).contains(&n) {
        return None;
    }
    unread_count(n, counted.more)
}

fn leading_count(chars: &[char]) -> Option<Unread> {
    if !matches!(chars.first(), Some('(' | '[')) {
        return None;
    }
    let counted = count_at(chars, 1)?;
    if !matches!(chars.get(counted.end), Some(')' | ']')) {
        return None;
    }
    chars[counted.end + 1..]
        .iter()
        .find(|c| !c.is_whitespace())
        .and(count_of(&counted))
}

fn is_word(c: char) -> bool {
    c.is_ascii_alphanumeric() || c == '_'
}

fn phrase_count(chars: &[char]) -> Option<Unread> {
    let lower: Vec<char> = chars.iter().map(|c| c.to_ascii_lowercase()).collect();
    for start in 0..chars.len() {
        let boundary =
            start == 0 || matches!(chars[start - 1], '(' | '[') || chars[start - 1].is_whitespace();
        if !boundary || !chars[start].is_ascii_digit() {
            continue;
        }
        let Some(counted) = count_at(chars, start) else {
            continue;
        };
        let spaces = lower[counted.end..]
            .iter()
            .take_while(|c| c.is_whitespace())
            .count();
        if spaces == 0 {
            continue;
        }
        let rest = &lower[counted.end + spaces..];
        let said = PHRASE_TAILS.iter().any(|tail| {
            let tail: Vec<char> = tail.chars().collect();
            rest.starts_with(&tail) && rest.get(tail.len()).is_none_or(|c| !is_word(*c))
        });
        if said {
            return count_of(&counted);
        }
    }
    None
}

fn first_segment(title: &[char]) -> &[char] {
    let mut at = 0;
    while at < title.len() {
        if title[at].is_whitespace() {
            let mut mark = at;
            while mark < title.len() && title[mark].is_whitespace() {
                mark += 1;
            }
            if mark < title.len() && SEGMENT_MARKS.contains(&title[mark]) {
                let after = mark + 1;
                if after < title.len() && title[after].is_whitespace() {
                    return &title[..at];
                }
            }
            at = mark;
        } else {
            at += 1;
        }
    }
    title
}

fn brand_of(host: &str) -> &str {
    let labels: Vec<&str> = host.split('.').filter(|l| !l.is_empty()).collect();
    match labels.len() {
        0 => "",
        1 => labels[0],
        n => labels[n - 2],
    }
}

fn label_means_unread(label: &str, host: &str) -> bool {
    let lowered = label.trim().to_lowercase();
    let words: Vec<&str> = lowered.split_whitespace().collect();
    if words.len() > MAX_LABEL_WORDS {
        return false;
    }
    let brand = brand_of(host);
    words
        .iter()
        .any(|w| UNREAD_LABEL_WORDS.contains(w) || (brand.chars().count() > 2 && *w == brand))
}

fn label_count(segment: &[char], host: &str) -> Option<Unread> {
    if segment.last() != Some(&')') {
        return None;
    }
    let open = segment.iter().rposition(|c| *c == '(')?;
    if open < 2 || segment[open - 1] != ' ' {
        return None;
    }
    let counted = count_at(segment, open + 1)?;
    if counted.end + 1 != segment.len() {
        return None;
    }
    let label = &segment[..open - 1];
    let fits = (1..=MAX_LABEL_CHARS).contains(&label.len())
        && label
            .iter()
            .all(|c| !c.is_ascii_digit() && !matches!(c, '(' | ')' | '[' | ']'));
    if !fits {
        return None;
    }
    let label: String = label.iter().collect();
    label_means_unread(&label, host)
        .then(|| count_of(&counted))
        .flatten()
}

fn leading_mark(chars: &[char], mark: char) -> bool {
    if chars.first() != Some(&mark) {
        return false;
    }
    let spaces = chars[1..].iter().take_while(|c| c.is_whitespace()).count();
    spaces > 0
        && chars
            .get(1 + spaces)
            .is_some_and(|c| !c.is_whitespace() && *c != mark && !c.is_ascii_digit())
}

fn on_site(host: &str, sites: &[&str]) -> bool {
    sites
        .iter()
        .any(|site| host == *site || host.ends_with(&format!(".{site}")))
}

pub fn unread_in_title(raw: &str, host: &str) -> Option<Unread> {
    let chars: Vec<char> = raw.trim().chars().collect();
    if chars.is_empty() {
        return None;
    }
    if let Some(unread) = leading_count(&chars) {
        return Some(unread);
    }
    if let Some(unread) = phrase_count(&chars) {
        return Some(unread);
    }
    if let Some(unread) = label_count(first_segment(&chars), host) {
        return Some(unread);
    }
    if leading_mark(&chars, '•') {
        return Some(Unread::Dot);
    }
    (leading_mark(&chars, '*') && on_site(host, STAR_MEANS_UNREAD)).then_some(Unread::Dot)
}

pub fn title_without_unread<'a>(title: &'a str, unread: Option<&Unread>) -> &'a str {
    let Some(unread) = unread else {
        return title;
    };
    let trimmed = title.trim_start();
    let chars: Vec<char> = trimmed.chars().collect();
    let (said, mark_chars) = match chars.first() {
        Some('(' | '[') => match count_at(&chars, 1) {
            Some(counted) if matches!(chars.get(counted.end), Some(')' | ']')) => {
                (count_of(&counted), counted.end + 1)
            }
            _ => return title,
        },
        Some('•') => (Some(Unread::Dot), 1),
        _ => return title,
    };
    let spaces = chars[mark_chars..]
        .iter()
        .take_while(|c| c.is_whitespace())
        .count();
    let rest = mark_chars + spaces;
    if rest >= chars.len() || (chars[0] == '•' && spaces == 0) || said.as_ref() != Some(unread) {
        return title;
    }
    let byte_at: usize = chars[..rest].iter().map(|c| c.len_utf8()).sum();
    &trimmed[byte_at..]
}

pub fn origin_host(url: &str) -> Option<String> {
    let scheme_end = url.find("://")?;
    if scheme_end == 0
        || !url[..scheme_end]
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '+' | '.' | '-'))
    {
        return None;
    }
    let rest = &url[scheme_end + 3..];
    let authority = rest.split(['/', '?', '#']).next().unwrap_or("");
    let host = authority.rsplit('@').next().unwrap_or("");
    let host = match host.rfind(':') {
        Some(at) if host[at + 1..].chars().all(|c| c.is_ascii_digit()) && !host.ends_with(']') => {
            &host[..at]
        }
        _ => host,
    };
    (!host.is_empty()).then(|| host.to_lowercase())
}

pub fn is_unread_shown(settings: &Settings, url: &str) -> bool {
    if !settings.show_unread_counts {
        return false;
    }
    if url.is_empty() || settings.unread_hidden_sites.is_empty() {
        return true;
    }
    let host = host_of(url);
    host.is_empty() || !settings.unread_hidden_sites.contains(&host)
}

pub fn tab_unread(settings: &Settings, tab: &Tab) -> Option<Unread> {
    if tab.url.is_empty() || !is_unread_shown(settings, &tab.url) {
        return None;
    }
    page_unread(tab)
}

pub fn page_unread(tab: &Tab) -> Option<Unread> {
    if tab.url.is_empty() {
        return None;
    }
    tab.live.engine_tab_id.as_ref()?;
    let host = origin_host(&tab.url)?;
    if tab.live.unread_count > 0 {
        return unread_count(u64::from(tab.live.unread_count), false);
    }
    unread_in_title(&tab.title, &host).or_else(|| {
        tab.favicon
            .as_deref()
            .filter(|favicon| favicon_is_badge_named(favicon))
            .map(|_| Unread::Dot)
    })
}

const BADGE_TOKENS: &[&str] = &[
    "unread",
    "badge",
    "badged",
    "notif",
    "notification",
    "notifications",
    "alert",
    "dot",
    "count",
    "mention",
    "mentions",
];

fn file_name_of(url: &str) -> &str {
    let path = url.split(['?', '#']).next().unwrap_or("");
    let path = path.find("://").map_or(path, |at| {
        let rest = &path[at + 3..];
        rest.find('/').map_or("", |slash| &rest[slash..])
    });
    path.rsplit('/').next().unwrap_or("")
}

pub fn favicon_is_badge_named(url: &str) -> bool {
    if url.starts_with("data:") {
        return false;
    }
    let name = file_name_of(url).to_ascii_lowercase();
    let bytes = name.as_bytes();
    BADGE_TOKENS.iter().any(|token| {
        name.match_indices(token).any(|(at, _)| {
            let before = at == 0 || matches!(bytes[at - 1], b'-' | b'_' | b'.');
            let after = bytes
                .get(at + token.len())
                .is_none_or(|c| matches!(c, b'-' | b'_' | b'.') || c.is_ascii_digit());
            before && after
        })
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn count(label: &str) -> Option<Unread> {
        Some(Unread::Count(label.to_owned()))
    }

    #[test]
    fn titles_with_leading_counts_read_as_unread() {
        assert_eq!(
            unread_in_title("(3) Inbox - Gmail", "mail.google.com"),
            count("3")
        );
        assert_eq!(unread_in_title("[12] Chat", ""), count("12"));
        assert_eq!(unread_in_title("(1,234) Feed", ""), count("99+"));
        assert_eq!(unread_in_title("(20+) Facebook", ""), count("20+"));
        assert_eq!(unread_in_title("(2024) Recap", ""), None);
        assert_eq!(unread_in_title("(0) Inbox", ""), None);
        assert_eq!(unread_in_title("(1234567) Big", ""), None);
        assert_eq!(unread_in_title("(3)", ""), None);
    }

    #[test]
    fn phrases_and_labels_read_as_unread() {
        assert_eq!(unread_in_title("Mail - 5 unread", ""), count("5"));
        assert_eq!(unread_in_title("You have 7 new messages", ""), count("7"));
        assert_eq!(unread_in_title("2 new e-mails waiting", ""), count("2"));
        assert_eq!(unread_in_title("Version 5 unreadable", ""), None);
        assert_eq!(
            unread_in_title("Inbox (4) - me@x.com - Gmail", "mail.google.com"),
            count("4")
        );
        assert_eq!(unread_in_title("Slack (9)", "app.slack.com"), count("9"));
        assert_eq!(unread_in_title("Season (4)", "tv.com"), None);
    }

    #[test]
    fn leading_bullets_and_slack_stars_are_dots() {
        assert_eq!(
            unread_in_title("• Discord | general", ""),
            Some(Unread::Dot)
        );
        assert_eq!(
            unread_in_title("* general - Slack", "app.slack.com"),
            Some(Unread::Dot)
        );
        assert_eq!(unread_in_title("* general - Notes", "notes.com"), None);
        assert_eq!(unread_in_title("•• weird", ""), None);
    }

    #[test]
    fn shown_badges_take_their_mark_off_the_title() {
        let three = Unread::Count("3".to_owned());
        assert_eq!(title_without_unread("(3) Inbox", Some(&three)), "Inbox");
        assert_eq!(title_without_unread("(4) Inbox", Some(&three)), "(4) Inbox");
        assert_eq!(
            title_without_unread("• Discord", Some(&Unread::Dot)),
            "Discord"
        );
        assert_eq!(title_without_unread("(3) Inbox", None), "(3) Inbox");
    }

    #[test]
    fn counts_cap_at_ninety_nine() {
        assert_eq!(unread_count(150, false), count("99+"));
        assert_eq!(unread_count(0, false), None);
        assert_eq!(unread_count(4, true), count("4+"));
    }

    #[test]
    fn badge_named_favicons_mark_a_dot() {
        assert!(favicon_is_badge_named("https://x.com/favicon-unread.ico"));
        assert!(favicon_is_badge_named("https://a.com/img/notif_3.png?v=1"));
        assert!(!favicon_is_badge_named("https://a.com/favicon.ico"));
        assert!(!favicon_is_badge_named("https://a.com/dotted.png"));
        assert!(!favicon_is_badge_named("data:image/png;base64,badge"));
    }

    #[test]
    fn origins_ignore_ports_and_credentials() {
        assert_eq!(
            origin_host("https://user@Mail.Example.com:8080/x"),
            Some("mail.example.com".to_owned())
        );
        assert_eq!(origin_host("about:blank"), None);
    }
}
