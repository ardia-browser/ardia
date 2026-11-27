use std::borrow::Cow;

const UTF8_BOM: &[u8] = b"\xEF\xBB\xBF";
const COMMENT_OPEN: &str = "<!--";
const COMMENT_CLOSE: &str = "-->";
const LONGEST_ENTITY: usize = 11;

pub(crate) fn decode_text(bytes: &[u8]) -> Cow<'_, str> {
    let body = bytes.strip_prefix(UTF8_BOM).unwrap_or(bytes);
    match std::str::from_utf8(body) {
        Ok(text) => Cow::Borrowed(text),
        Err(_) => Cow::Owned(body.iter().copied().map(char::from).collect()),
    }
}

pub(crate) fn is_space(byte: u8) -> bool {
    matches!(byte, b' ' | b'\t' | b'\n' | b'\r' | b'\x0B' | b'\x0C')
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Attribute {
    Href,
    AddDate,
    Id,
    PersonalToolbarFolder,
    UnfiledBookmarksFolder,
}

impl Attribute {
    const ALL: [Attribute; 5] = [
        Attribute::Href,
        Attribute::AddDate,
        Attribute::Id,
        Attribute::PersonalToolbarFolder,
        Attribute::UnfiledBookmarksFolder,
    ];

    fn name(self) -> &'static str {
        match self {
            Attribute::Href => "href",
            Attribute::AddDate => "add_date",
            Attribute::Id => "id",
            Attribute::PersonalToolbarFolder => "personal_toolbar_folder",
            Attribute::UnfiledBookmarksFolder => "unfiled_bookmarks_folder",
        }
    }

    fn named(key: &str) -> Option<Attribute> {
        Attribute::ALL
            .into_iter()
            .find(|attribute| key.eq_ignore_ascii_case(attribute.name()))
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Tag<'a> {
    pub closing: bool,
    pub name: &'a str,
    attributes: [Option<&'a str>; Attribute::ALL.len()],
}

impl<'a> Tag<'a> {
    pub fn is(&self, name: &str) -> bool {
        self.name.eq_ignore_ascii_case(name)
    }

    pub fn opens(&self, name: &str) -> bool {
        !self.closing && self.is(name)
    }

    pub fn closes(&self, name: &str) -> bool {
        self.closing && self.is(name)
    }

    pub fn attribute(&self, which: Attribute) -> Option<&'a str> {
        self.attributes[which as usize]
    }

    fn ends_text(&self) -> bool {
        self.closes("dl") || (!self.closing && ["dt", "dd", "dl", "h3", "a"].iter().any(|name| self.is(name)))
    }
}

pub(crate) struct Scanner<'a> {
    text: &'a str,
    at: usize,
}

impl<'a> Scanner<'a> {
    pub fn new(text: &'a str) -> Self {
        Scanner { text, at: 0 }
    }

    pub fn next_tag(&mut self) -> Option<Tag<'a>> {
        while let Some(found) = self.text[self.at..].find('<') {
            let start = self.at + found;
            if self.text[start..].starts_with(COMMENT_OPEN) {
                self.at = self.after_comment(start);
                continue;
            }
            match self.tag_at(start) {
                Some((tag, end)) => {
                    self.at = end;
                    return Some(tag);
                }
                None if self.bogus_markup(start) => self.at = self.after_bogus_markup(start),
                None => self.at = start + 1,
            }
        }
        self.at = self.text.len();
        None
    }

    pub fn text_until(&mut self, closer: &str) -> String {
        let mut out = String::new();
        let mut run = self.at;
        while let Some(found) = self.text[self.at..].find('<') {
            let start = self.at + found;
            if self.text[start..].starts_with(COMMENT_OPEN) {
                out.push_str(&self.text[run..start]);
                self.at = self.after_comment(start);
                run = self.at;
                continue;
            }
            let Some((tag, end)) = self.tag_at(start) else {
                if self.bogus_markup(start) {
                    out.push_str(&self.text[run..start]);
                    self.at = self.after_bogus_markup(start);
                    run = self.at;
                } else {
                    self.at = start + 1;
                }
                continue;
            };
            out.push_str(&self.text[run..start]);
            if tag.closes(closer) {
                self.at = end;
                return out;
            }
            if tag.ends_text() {
                self.at = start;
                return out;
            }
            self.at = end;
            run = end;
        }
        out.push_str(&self.text[run..]);
        self.at = self.text.len();
        out
    }

    fn after_comment(&self, start: usize) -> usize {
        let body = start + COMMENT_OPEN.len();
        self.text[body..]
            .find(COMMENT_CLOSE)
            .map_or(self.text.len(), |end| body + end + COMMENT_CLOSE.len())
    }

    fn bogus_markup(&self, start: usize) -> bool {
        let bytes = self.text.as_bytes();
        match bytes.get(start + 1) {
            Some(b'!' | b'?') => true,
            Some(b'/') => bytes.get(start + 2).is_some_and(|byte| !byte.is_ascii_alphabetic()),
            _ => false,
        }
    }

    fn after_bogus_markup(&self, start: usize) -> usize {
        self.text[start..]
            .find('>')
            .map_or(self.text.len(), |end| start + end + 1)
    }

    fn tag_at(&self, start: usize) -> Option<(Tag<'a>, usize)> {
        let text = self.text;
        let bytes = text.as_bytes();
        let mut at = start + 1;
        let closing = bytes.get(at) == Some(&b'/');
        if closing {
            at += 1;
        }
        let name_start = at;
        if !bytes.get(at).is_some_and(u8::is_ascii_alphabetic) {
            return None;
        }
        while bytes.get(at).is_some_and(u8::is_ascii_alphanumeric) {
            at += 1;
        }
        if at == name_start {
            return None;
        }
        let name = &text[name_start..at];
        let mut attributes = [None; Attribute::ALL.len()];
        while let Some(&byte) = bytes.get(at) {
            if byte == b'>' {
                at += 1;
                break;
            }
            if is_space(byte) || byte == b'/' {
                at += 1;
                continue;
            }
            let key_start = at;
            while bytes
                .get(at)
                .is_some_and(|&byte| !is_space(byte) && byte != b'=' && byte != b'>')
            {
                at += 1;
            }
            let key = &text[key_start..at];
            let mut value = "";
            let mut look = at;
            while bytes.get(look).copied().is_some_and(is_space) {
                look += 1;
            }
            if bytes.get(look) == Some(&b'=') {
                at = look + 1;
                while bytes.get(at).copied().is_some_and(is_space) {
                    at += 1;
                }
                match bytes.get(at) {
                    Some(&quote) if quote == b'"' || quote == b'\'' => {
                        let value_start = at + 1;
                        let value_end = text[value_start..]
                            .find(char::from(quote))
                            .map_or(text.len(), |end| value_start + end);
                        value = &text[value_start..value_end];
                        at = (value_end + 1).min(text.len());
                    }
                    _ => {
                        let value_start = at;
                        while bytes.get(at).is_some_and(|&byte| !is_space(byte) && byte != b'>') {
                            at += 1;
                        }
                        value = &text[value_start..at];
                    }
                }
            }
            if let Some(which) = Attribute::named(key) {
                attributes[which as usize].get_or_insert(value);
            }
        }
        Some((
            Tag {
                closing,
                name,
                attributes,
            },
            at,
        ))
    }
}

pub(crate) fn decode_entities(text: &str) -> Cow<'_, str> {
    if !text.contains('&') {
        return Cow::Borrowed(text);
    }
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(amp) = rest.find('&') {
        out.push_str(&rest[..amp]);
        let after = &rest[amp + 1..];
        let window = &after.as_bytes()[..after.len().min(LONGEST_ENTITY)];
        let decoded = window
            .iter()
            .position(|&byte| byte == b';')
            .and_then(|semi| entity(&after[..semi]).map(|value| (value, semi)));
        match decoded {
            Some((value, semi)) => {
                out.push(value);
                rest = &after[semi + 1..];
            }
            None => {
                out.push('&');
                rest = after;
            }
        }
    }
    out.push_str(rest);
    Cow::Owned(out)
}

fn entity(name: &str) -> Option<char> {
    match name {
        "amp" => Some('&'),
        "lt" => Some('<'),
        "gt" => Some('>'),
        "quot" => Some('"'),
        "apos" => Some('\''),
        "nbsp" => Some('\u{A0}'),
        _ => {
            let number = name.strip_prefix('#')?;
            let (digits, radix) = match number.strip_prefix(['x', 'X']) {
                Some(hex) => (hex, 16),
                None => (number, 10),
            };
            if digits.is_empty() || !digits.chars().all(|c| c.is_digit(radix)) {
                return None;
            }
            let code = u32::from_str_radix(digits, radix).ok()?;
            char::from_u32(code).filter(|&c| c != '\0')
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    type Scanned = (bool, String, Vec<(String, String)>);

    fn tags(text: &str) -> Vec<Scanned> {
        let mut scanner = Scanner::new(text);
        let mut out = Vec::new();
        while let Some(tag) = scanner.next_tag() {
            let attributes = Attribute::ALL
                .into_iter()
                .filter_map(|which| Some((which.name().to_owned(), tag.attribute(which)?.to_owned())))
                .collect();
            out.push((tag.closing, tag.name.to_ascii_lowercase(), attributes));
        }
        out
    }

    #[test]
    fn entities_decode_once_within_eleven_bytes() {
        for (text, want) in [
            ("a &amp; b", "a & b"),
            ("&amp;lt;", "&lt;"),
            ("&lt;&gt;&quot;&apos;&nbsp;", "<>\"'\u{A0}"),
            ("&#65;&#x41;&#X41;&#000000065;&#x0010FFFF;", "AAAA\u{10FFFF}"),
            ("&#0000000065;", "&#0000000065;"),
            (
                "&#0;&#xD800;&#x110000;&#;&#x;&#+65;&#-1;",
                "&#0;&#xD800;&#x110000;&#;&#x;&#+65;&#-1;",
            ),
            ("&AMP; &copy; &amp", "&AMP; &copy; &amp"),
            ("&&amp;;", "&&;"),
            ("é&#233;", "éé"),
        ] {
            assert_eq!(decode_entities(text), want, "{text}");
        }
    }

    #[test]
    fn latin1_is_the_fallback_for_invalid_utf8() {
        assert_eq!(decode_text(b"\xEF\xBB\xBFcaf\xC3\xA9"), "café");
        assert_eq!(decode_text(b"caf\xE9"), "café");
        assert_eq!(decode_text(b"\xEF\xBB\xBFcaf\xE9"), "café");
        assert_eq!(decode_text(b"\xEF\xBB\xBF\xEF\xBB\xBFx"), "\u{FEFF}x");
        assert_eq!(decode_text(b"\xED\xA0\x80"), "\u{ED}\u{A0}\u{80}");
    }

    #[test]
    fn tags_and_attributes_are_case_insensitive_and_the_first_attribute_wins() {
        assert_eq!(
            tags(concat!(
                r#"<DT><A HREF="x" href='y' ADD_DATE = 5 empty data-x=a"b/ Id=i>"#,
                r#"<H3 personal_TOOLBAR_folder unfiled_bookmarks_folder=true PERSONAL_TOOLBAR_FOLDER=true></a>"#
            )),
            vec![
                (false, "dt".into(), vec![]),
                (
                    false,
                    "a".into(),
                    vec![
                        ("href".into(), "x".into()),
                        ("add_date".into(), "5".into()),
                        ("id".into(), "i".into()),
                    ]
                ),
                (
                    false,
                    "h3".into(),
                    vec![
                        ("personal_toolbar_folder".into(), "".into()),
                        ("unfiled_bookmarks_folder".into(), "true".into()),
                    ]
                ),
                (true, "a".into(), vec![]),
            ]
        );
        let mut scanner = Scanner::new(r#"<a HREF="first" href="second">"#);
        assert_eq!(scanner.next_tag().unwrap().attribute(Attribute::Href), Some("first"));
    }

    #[test]
    fn a_tag_keeps_one_slot_per_attribute_it_reads_however_many_it_carries() {
        assert!(size_of::<Tag<'_>>() <= 128);
        let mut text = String::from("<A ");
        for index in 0..200_000 {
            text.push_str(&format!("x{index}=1 HREF=\"later{index}\" add_date=9 "));
        }
        text.insert_str(3, "href=\"first\" ");
        text.push('>');
        let tag = Scanner::new(&text).next_tag().unwrap();
        assert_eq!(tag.attribute(Attribute::Href), Some("first"));
        assert_eq!(tag.attribute(Attribute::AddDate), Some("9"));
        assert_eq!(tag.attribute(Attribute::Id), None);
    }

    #[test]
    fn comments_and_non_tags_are_skipped() {
        assert_eq!(
            tags("<!-- <A HREF=x> --><!DOCTYPE x <a>>< b><1x></ <a>><?php <a>?><h1></><dl>"),
            vec![(false, "h1".into(), vec![]), (false, "dl".into(), vec![])]
        );
        assert!(tags("<!DOCTYPE <a").is_empty());
        assert!(tags("<!-- <A HREF=x>").is_empty());
        assert_eq!(
            tags("<a href=\"x>"),
            vec![(false, "a".into(), vec![("href".into(), "x>".into())])]
        );
    }

    #[test]
    fn text_keeps_literal_brackets_and_stops_at_structure() {
        let mut scanner = Scanner::new("a < b <3 <b>c</b><!-- x -->d<!x>e<?y>f</ z>g</a>rest");
        assert_eq!(scanner.text_until("a"), "a < b <3 cdefg");
        assert_eq!(scanner.text_until("a"), "rest");
        for (text, want, next) in [
            ("title<DT><A>", "title", "dt"),
            ("title<DD>about", "title", "dd"),
            ("title</DL>", "title", "dl"),
            ("title<H3>", "title", "h3"),
            ("title</H3>more</A>", "titlemore", ""),
        ] {
            let mut scanner = Scanner::new(text);
            assert_eq!(scanner.text_until("a"), want);
            assert_eq!(scanner.next_tag().map_or("", |tag| tag.name).to_ascii_lowercase(), next);
        }
    }
}
