use std::collections::HashMap;

use crate::omnibox::url::host_of;

const SEPARATORS: [&str; 8] = [" / ", " | ", " - ", " — ", " – ", " · ", " • ", " :: "];

pub struct Member<'a> {
    pub url: &'a str,
    pub title: &'a str,
}

fn squash(text: &str) -> String {
    text.to_lowercase()
        .chars()
        .filter(char::is_ascii_alphanumeric)
        .collect()
}

fn is_ipv4(host: &str) -> bool {
    let parts: Vec<&str> = host.split('.').collect();
    parts.len() == 4
        && parts
            .iter()
            .all(|p| (1..=3).contains(&p.len()) && p.chars().all(|c| c.is_ascii_digit()))
}

fn is_ip_address(host: &str) -> bool {
    host.starts_with('[') || (host.starts_with(|c: char| c.is_ascii_digit()) && is_ipv4(host))
}

fn host_label(host: &str) -> String {
    if is_ip_address(host) {
        return host.to_owned();
    }
    let parts: Vec<&str> = host.split('.').filter(|p| !p.is_empty()).collect();
    match parts.len() {
        0 => String::new(),
        1 => parts[0].to_owned(),
        n => {
            let second = parts[n - 2];
            if n > 2 && second.chars().count() <= 3 && parts[n - 1].chars().count() <= 2 {
                parts[n - 3].to_owned()
            } else {
                second.to_owned()
            }
        }
    }
}

pub fn site_key(url: &str) -> String {
    host_label(&host_of(url)).to_lowercase()
}

fn tidy_host(host: &str) -> String {
    let label = host_label(host);
    let mut chars = label.chars();
    match chars.next() {
        Some(first) => first.to_uppercase().chain(chars).collect(),
        None => String::new(),
    }
}

fn ends(title: &str) -> Vec<(String, String)> {
    let mut out = Vec::new();
    for sep in SEPARATORS {
        if let Some(last) = title.rfind(sep).filter(|at| *at > 0) {
            out.push((
                title[last + sep.len()..].trim().to_owned(),
                title[..last].trim().to_owned(),
            ));
        }
        if let Some(first) = title.find(sep).filter(|at| *at > 0) {
            out.push((
                title[..first].trim().to_owned(),
                title[first + sep.len()..].trim().to_owned(),
            ));
        }
    }
    out.retain(|(site, page)| !site.is_empty() && !page.is_empty());
    out
}

fn in_every_title(titles: &[&str], site: &str) -> bool {
    titles
        .iter()
        .all(|t| ends(t).iter().any(|(s, _)| s == site))
}

fn site_from_titles(host: &str, titles: &[&str]) -> Option<String> {
    let label = squash(&host_label(host));
    let looks_like_host = |site: &str| {
        let s = squash(site);
        !s.is_empty()
            && !label.is_empty()
            && (s == label || (s.len() >= 3 && (label.contains(&s) || s.contains(&label))))
    };
    let first = ends(titles.first()?);
    for (site, _) in &first {
        if site.split(' ').count() <= 3 && looks_like_host(site) && in_every_title(titles, site) {
            return Some(site.clone());
        }
    }
    if titles.len() < 2 {
        return None;
    }
    first
        .into_iter()
        .map(|(site, _)| site)
        .find(|site| in_every_title(titles, site))
}

fn page_of(title: &str, site: Option<&str>) -> String {
    let Some(site) = site else {
        return title.trim().to_owned();
    };
    ends(title)
        .into_iter()
        .find(|(s, _)| s == site)
        .map_or_else(|| title.trim().to_owned(), |(_, page)| page)
}

fn is_loaded(member: &Member) -> bool {
    !member.title.is_empty() && member.title != member.url
}

pub fn site_name(members: &[Member]) -> String {
    let host = members
        .iter()
        .map(|m| host_of(m.url))
        .find(|h| !h.is_empty())
        .unwrap_or_default();
    let titles: Vec<&str> = members
        .iter()
        .filter(|m| !m.title.is_empty() && m.title != m.url)
        .map(|m| m.title)
        .collect();
    let label = squash(&host_label(&host));
    let titled_like_host = (!label.is_empty())
        .then(|| titles.iter().find(|t| squash(t) == label))
        .flatten()
        .map(|t| t.trim().to_owned());
    (!titles.is_empty())
        .then(|| site_from_titles(&host, &titles))
        .flatten()
        .or(titled_like_host)
        .unwrap_or_else(|| tidy_host(&host))
}

pub fn auto_group_name(members: &[Member]) -> String {
    let Some(first) = members.first() else {
        return String::new();
    };
    let hosts: Vec<String> = members.iter().map(|m| host_of(m.url)).collect();
    let mut titled_by_host: HashMap<&str, Vec<&str>> = HashMap::new();
    let mut loaded_by_url: HashMap<&str, &Member> = HashMap::new();
    for (member, host) in members.iter().zip(&hosts) {
        if !is_loaded(member) {
            continue;
        }
        titled_by_host
            .entry(host.as_str())
            .or_default()
            .push(member.title);
        loaded_by_url.entry(member.url).or_insert(member);
    }
    let mut site_of_host: HashMap<&str, String> = HashMap::new();
    for host in &hosts {
        if site_of_host.contains_key(host.as_str()) {
            continue;
        }
        let site = titled_by_host
            .get(host.as_str())
            .and_then(|titles| site_from_titles(host, titles))
            .unwrap_or_else(|| tidy_host(host));
        site_of_host.insert(host.as_str(), site);
    }
    let sites: Vec<&str> = hosts
        .iter()
        .map(|h| site_of_host.get(h.as_str()).map_or("", String::as_str))
        .collect();
    let site = sites[0];
    if site.is_empty() || sites.iter().any(|s| *s != site) {
        return if site.is_empty() {
            first.title.to_owned()
        } else {
            site.to_owned()
        };
    }
    let site_in_titles = members
        .iter()
        .any(|m| !m.title.is_empty() && page_of(m.title, Some(site)) != m.title.trim())
        .then_some(site);
    let pages: Vec<Option<String>> = members
        .iter()
        .map(|m| {
            let loaded = if is_loaded(m) {
                Some(m)
            } else {
                loaded_by_url.get(m.url).copied()
            };
            loaded.map(|l| page_of(l.title, site_in_titles))
        })
        .collect();
    let page = &pages[0];
    match (site_in_titles, page) {
        (Some(_), Some(page))
            if pages.iter().all(|p| p.as_ref() == Some(page)) && squash(page) != squash(site) =>
        {
            format!("{site} {page}")
        }
        _ => site.to_owned(),
    }
}

pub fn group_label(name: &str, members: &[Member]) -> String {
    if !name.is_empty() {
        return name.to_owned();
    }
    let loaded: Vec<Member> = members
        .iter()
        .filter(|m| !m.url.is_empty())
        .map(|m| Member {
            url: m.url,
            title: m.title,
        })
        .collect();
    let label = auto_group_name(&loaded);
    if label.is_empty() {
        "New Group".to_owned()
    } else {
        label
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn name(members: &[(&str, &str)]) -> String {
        let members: Vec<Member> = members
            .iter()
            .map(|(url, title)| Member { url, title })
            .collect();
        auto_group_name(&members)
    }

    #[test]
    fn addresses_and_country_domains_name_the_group() {
        assert_eq!(name(&[("http://127.0.0.1:9471/d", "")]), "127.0.0.1");
        assert_eq!(name(&[("http://[::1]:8080/", "")]), "[::1]");
        assert_eq!(name(&[("https://news.bbc.co.uk/x", "")]), "Bbc");
    }

    #[test]
    fn a_shared_site_and_page_join_and_mixed_sites_fall_back() {
        assert_eq!(
            name(&[
                ("https://github.com/a", "Pull requests · GitHub"),
                ("https://github.com/b", "Issues · GitHub"),
            ]),
            "GitHub"
        );
        assert_eq!(
            name(&[
                ("https://github.com/a", "Pull requests · GitHub"),
                ("https://github.com/b", "Pull requests · GitHub"),
            ]),
            "GitHub Pull requests"
        );
        assert_eq!(
            name(&[("https://a.com/", "A"), ("https://b.org/", "B")]),
            "A"
        );
        assert_eq!(name(&[]), "");
    }

    #[test]
    fn unnamed_groups_without_pages_read_new_group() {
        assert_eq!(group_label("Work", &[]), "Work");
        assert_eq!(group_label("", &[]), "New Group");
        assert_eq!(
            group_label(
                "",
                &[Member {
                    url: "https://example.com/",
                    title: ""
                }]
            ),
            "Example"
        );
    }
}
