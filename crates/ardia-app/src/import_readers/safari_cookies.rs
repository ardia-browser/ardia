use std::path::{Path, PathBuf};

use zeroize::Zeroizing;

use super::chromium_secrets::Cookie;
use super::plist::COCOA_EPOCH_SECONDS;

const MAX_FILE_SIZE: u64 = 512 << 20;
const HEADER_SIZE: usize = 56;
const DAMAGED: &str = "Safari's cookie file is damaged";

pub fn file(home: &Path) -> Option<PathBuf> {
    [
        "Library/Containers/com.apple.Safari/Data/Library/Cookies/Cookies.binarycookies",
        "Library/Cookies/Cookies.binarycookies",
    ]
    .iter()
    .map(|relative| home.join(relative))
    .find(|path| path.is_file())
}

pub fn load(home: &Path, now_ms: f64) -> Result<Vec<Cookie>, String> {
    let path = file(home).ok_or("No Safari cookies")?;
    let size = std::fs::metadata(&path).map_err(|e| e.to_string())?.len();
    if size > MAX_FILE_SIZE {
        return Err("Cookies.binarycookies is too large".into());
    }
    let bytes = Zeroizing::new(
        std::fs::read(&path).map_err(|e| format!("Couldn't read Cookies.binarycookies: {e}"))?,
    );
    parse(&bytes, now_ms)
}

fn be32(p: &[u8], at: usize) -> Option<usize> {
    Some(u32::from_be_bytes(p.get(at..at + 4)?.try_into().ok()?) as usize)
}

fn le32(p: &[u8], at: usize) -> Option<usize> {
    Some(u32::from_le_bytes(p.get(at..at + 4)?.try_into().ok()?) as usize)
}

fn le_f64(p: &[u8], at: usize) -> Option<f64> {
    Some(f64::from_le_bytes(p.get(at..at + 8)?.try_into().ok()?))
}

fn string(c: &[u8], field: usize) -> Option<&[u8]> {
    let offset = le32(c, field)?;
    if offset < HEADER_SIZE || offset >= c.len() {
        return None;
    }
    let end = offset + c[offset..].iter().position(|b| *b == 0)?;
    Some(&c[offset..end])
}

fn cocoa_ms(seconds: f64) -> Option<f64> {
    (seconds.is_finite() && seconds > 0.0).then_some((seconds + COCOA_EPOCH_SECONDS) * 1000.0)
}

fn page(page: &[u8], now_ms: f64, out: &mut Vec<Cookie>) -> Option<()> {
    if page.len() < 8 || page[..4] != [0, 0, 1, 0] {
        return None;
    }
    let count = le32(page, 4)?;
    if count > (page.len() - 8) / 4 {
        return None;
    }
    let mut used = 8 + 4 * count;
    for i in 0..count {
        let start = le32(page, 8 + 4 * i)?;
        if start < used || start > page.len().checked_sub(HEADER_SIZE)? {
            return None;
        }
        let size = le32(page, start)?;
        if size < HEADER_SIZE || size > page.len() - start {
            return None;
        }
        used = start + size;
        let c = &page[start..start + size];
        let flags = le32(c, 8)?;
        let has_port = le32(c, 12)? != 0;
        let text = |field| string(c, field).map(|s| String::from_utf8_lossy(s).into_owned());
        let domain = text(16)?;
        let name = text(20)?;
        let path = text(24)?;
        let value = string(c, 28)?;
        let expires = cocoa_ms(le_f64(c, 40)?);
        let created = cocoa_ms(le_f64(c, 48)?);
        let port = if has_port {
            i64::from(*c.get(56)?) | (i64::from(*c.get(57)?) << 8)
        } else {
            -1
        };
        if domain.is_empty() || (name.is_empty() && value.is_empty()) {
            continue;
        }
        if expires.is_some_and(|at| at < now_ms) {
            continue;
        }
        out.push(Cookie {
            domain,
            name,
            value: Zeroizing::new(String::from_utf8_lossy(value).into_owned()),
            path: if path.is_empty() { "/".into() } else { path },
            created,
            expires,
            last_access: None,
            secure: flags & 1 != 0,
            http_only: flags & 4 != 0,
            same_site: "unspecified",
            priority: "medium",
            source_scheme: "unset",
            source_port: port,
            partition: None,
        });
    }
    Some(())
}

pub fn parse(p: &[u8], now_ms: f64) -> Result<Vec<Cookie>, String> {
    (|| {
        if p.len() < 8 || &p[..4] != b"cook" {
            return None;
        }
        let pages = be32(p, 4)?;
        if pages > (p.len() - 8) / 4 {
            return None;
        }
        let mut start = 8 + 4 * pages;
        let mut out = Vec::new();
        for i in 0..pages {
            let size = be32(p, 8 + 4 * i)?;
            if size > p.len() - start {
                return None;
            }
            page(&p[start..start + size], now_ms, &mut out)?;
            start += size;
        }
        Some(out)
    })()
    .ok_or_else(|| DAMAGED.to_owned())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::import_readers::fixture;

    #[test]
    fn safari_binary_cookies_read_like_the_old_importer() {
        let cookies = load(&fixture("home"), ardia_state::store::now_ms() as f64).unwrap();
        let names: Vec<&str> = cookies.iter().map(|c| c.name.as_str()).collect();
        assert_eq!(names, ["dc", "hc", "both"]);
        assert_eq!(cookies[0].domain, ".apple.example");
        assert_eq!(cookies[0].value.as_str(), "domain-cookie");
        assert!(cookies[0].secure && !cookies[0].http_only);
        assert_eq!(cookies[0].created, Some(1_788_220_800_000.0));
        assert_eq!(cookies[1].path, "/path");
        assert_eq!(cookies[1].source_port, 8443);
        assert!(cookies[1].http_only && !cookies[1].secure);
        assert_eq!(cookies[2].value.as_str(), "v\"al\\ue");
    }

    #[test]
    fn damaged_cookie_files_are_refused() {
        for name in [
            "bad-magic",
            "truncated",
            "bad-offset",
            "page-count",
            "no-nul",
        ] {
            let bytes = std::fs::read(fixture(&format!("misc/binarycookies/{name}.binarycookies")))
                .unwrap();
            assert!(parse(&bytes, 0.0).is_err(), "{name}");
        }
        let good = std::fs::read(fixture(
            "home/Library/Containers/com.apple.Safari/Data/Library/Cookies/Cookies.binarycookies",
        ))
        .unwrap();
        for cut in [0, 4, 8, 20] {
            assert!(parse(&good[..cut], 0.0).is_err(), "prefix {cut}");
        }
    }
}
