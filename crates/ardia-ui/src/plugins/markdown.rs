use super::nodes::plugin_web_url;

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Span {
    pub text: String,
    pub bold: bool,
    pub italic: bool,
    pub code: bool,
    pub url: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ListItem {
    pub marker: String,
    pub depth: usize,
    pub spans: Vec<Span>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Block {
    Heading {
        level: u8,
        spans: Vec<Span>,
    },
    Paragraph(Vec<Span>),
    Code {
        text: String,
        language: Option<String>,
    },
    List {
        ordered: bool,
        items: Vec<ListItem>,
    },
    Quote(Vec<Block>),
    Rule,
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
struct Style {
    bold: Option<bool>,
    italic: Option<bool>,
    code: Option<bool>,
    url: Option<String>,
}

const ESCAPABLE: &str = "\\`*_[]()#>!+.-";
const MAX_DEPTH: usize = 4;
const MAX_INLINE_DEPTH: usize = 16;

pub fn markdown_link(raw: &str) -> Option<String> {
    plugin_web_url(raw)
}

struct Token {
    end: usize,
    text: String,
    extra: Style,
    nested: bool,
    href: Option<String>,
}

#[derive(Default)]
struct Forward {
    asked: Option<usize>,
    found: Option<usize>,
}

impl Forward {
    fn search(&mut self, from: usize, find: impl Fn(usize) -> Option<usize>) -> Option<usize> {
        if let Some(asked) = self.asked
            && from >= asked
            && self.found.is_none_or(|found| found >= from)
        {
            return self.found;
        }
        self.asked = Some(from);
        self.found = find(from);
        self.found
    }
}

struct Scanner<'a> {
    source: &'a str,
    bytes: &'a [u8],
    tick: Forward,
    bracket: Forward,
    star: Forward,
    strong_star: Forward,
    strong_under: Forward,
    line_end: Forward,
}

fn is_line_end(c: char) -> bool {
    matches!(c, '\n' | '\r' | '\u{2028}' | '\u{2029}')
}

impl<'a> Scanner<'a> {
    fn new(source: &'a str) -> Self {
        Scanner {
            source,
            bytes: source.as_bytes(),
            tick: Forward::default(),
            bracket: Forward::default(),
            star: Forward::default(),
            strong_star: Forward::default(),
            strong_under: Forward::default(),
            line_end: Forward::default(),
        }
    }

    fn byte(&self, at: usize) -> Option<u8> {
        self.bytes.get(at).copied()
    }

    fn char_after(source: &str, mark: u8, from: usize) -> Option<usize> {
        source
            .as_bytes()
            .get(from..)?
            .iter()
            .position(|b| *b == mark)
            .map(|p| p + from)
    }

    fn doubled_close(source: &str, mark: u8, from: usize) -> Option<usize> {
        let bytes = source.as_bytes();
        let mut at = from;
        while at + 1 < bytes.len() {
            if bytes[at] == mark && bytes[at + 1] == mark && bytes.get(at + 2) != Some(&mark) {
                return Some(at);
            }
            at += 1;
        }
        None
    }

    fn is_space_at(&self, at: Option<usize>) -> bool {
        match at {
            None => true,
            Some(at) => self
                .source
                .get(at..)
                .and_then(|rest| rest.chars().next())
                .is_none_or(char::is_whitespace),
        }
    }

    fn space_before(&self, at: usize) -> bool {
        self.source
            .get(..at)
            .and_then(|head| head.chars().next_back())
            .is_none_or(char::is_whitespace)
    }

    fn link_tail(&self, at: usize) -> Option<(usize, String)> {
        let rest = self.source.get(at..)?;
        let mut chars = rest.char_indices().peekable();
        if chars.next()?.1 != '(' {
            return None;
        }
        while chars.peek().is_some_and(|(_, c)| c.is_whitespace()) {
            chars.next();
        }
        if chars.peek().is_some_and(|(_, c)| *c == '<') {
            chars.next();
        }
        let mut href = String::new();
        loop {
            match chars.peek().copied() {
                Some((_, '(')) => {
                    let mut inner = String::from("(");
                    chars.next();
                    loop {
                        match chars.next() {
                            Some((_, ')')) => {
                                inner.push(')');
                                break;
                            }
                            Some((_, c)) if c != '(' && !c.is_whitespace() => inner.push(c),
                            _ => return None,
                        }
                    }
                    href.push_str(&inner);
                }
                Some((_, c)) if c != ')' && c != '<' && c != '>' && !c.is_whitespace() => {
                    href.push(c);
                    chars.next();
                }
                _ => break,
            }
        }
        if href.is_empty() {
            return None;
        }
        if chars.peek().is_some_and(|(_, c)| *c == '>') {
            chars.next();
        }
        let checkpoint: Vec<(usize, char)> = chars.clone().collect();
        let mut index = 0;
        let mut spaced = 0;
        while checkpoint
            .get(index)
            .is_some_and(|(_, c)| c.is_whitespace())
        {
            index += 1;
            spaced += 1;
        }
        if spaced > 0 && checkpoint.get(index).is_some_and(|(_, c)| *c == '"') {
            if let Some(close) = checkpoint[index + 1..].iter().position(|(_, c)| *c == '"') {
                index += close + 2;
            } else {
                index -= spaced;
            }
        } else {
            index -= spaced;
        }
        while checkpoint
            .get(index)
            .is_some_and(|(_, c)| c.is_whitespace())
        {
            index += 1;
        }
        let (end, c) = *checkpoint.get(index)?;
        (c == ')').then(|| (at + end + 1, href))
    }

    fn doubled(&mut self, at: usize, mark: u8) -> Option<Token> {
        if self.byte(at + 1) != Some(mark) {
            return None;
        }
        let source = self.source;
        let forward = if mark == b'*' {
            &mut self.strong_star
        } else {
            &mut self.strong_under
        };
        let close = forward.search(at + 3, |from| Self::doubled_close(source, mark, from))?;
        let line_end = self.line_end.search(at + 2, |from| {
            source
                .get(from..)?
                .char_indices()
                .find(|(_, c)| is_line_end(*c))
                .map(|(i, _)| i + from)
        });
        if line_end.is_some_and(|end| end < close) {
            return None;
        }
        Some(Token {
            end: close + 2,
            text: source.get(at + 2..close)?.to_owned(),
            extra: Style {
                bold: Some(true),
                ..Style::default()
            },
            nested: true,
            href: None,
        })
    }

    fn token_at(&mut self, at: usize) -> Option<Token> {
        let source = self.source;
        match self.byte(at)? {
            b'\\' => {
                let next = source.get(at + 1..)?.chars().next()?;
                ESCAPABLE.contains(next).then(|| Token {
                    end: at + 1 + next.len_utf8(),
                    text: next.to_string(),
                    extra: Style::default(),
                    nested: false,
                    href: None,
                })
            }
            b'`' => {
                let close = self
                    .tick
                    .search(at + 1, |from| Self::char_after(source, b'`', from))?;
                (close > at + 1).then(|| Token {
                    end: close + 1,
                    text: source[at + 1..close].to_owned(),
                    extra: Style {
                        code: Some(true),
                        ..Style::default()
                    },
                    nested: false,
                    href: None,
                })
            }
            b'[' => {
                let close = self
                    .bracket
                    .search(at + 1, |from| Self::char_after(source, b']', from))?;
                if close <= at + 1 {
                    return None;
                }
                let (end, href) = self.link_tail(close + 1)?;
                Some(Token {
                    end,
                    text: source[at + 1..close].to_owned(),
                    extra: Style::default(),
                    nested: true,
                    href: Some(href),
                })
            }
            b'_' => self.doubled(at, b'_'),
            b'*' => {
                if let Some(strong) = self.doubled(at, b'*') {
                    return Some(strong);
                }
                if self.is_space_at(Some(at + 1)) || self.byte(at + 1) == Some(b'*') {
                    return None;
                }
                let close = self
                    .star
                    .search(at + 2, |from| Self::char_after(source, b'*', from))?;
                if self.space_before(close) {
                    return None;
                }
                Some(Token {
                    end: close + 1,
                    text: source[at + 1..close].to_owned(),
                    extra: Style {
                        italic: Some(true),
                        ..Style::default()
                    },
                    nested: true,
                    href: None,
                })
            }
            _ => None,
        }
    }
}

fn push(spans: &mut Vec<Span>, style: &Style, text: &str, extra: &Style) {
    if text.is_empty() {
        return;
    }
    let next = Span {
        text: text.to_owned(),
        bold: extra.bold.or(style.bold).unwrap_or(false),
        italic: extra.italic.or(style.italic).unwrap_or(false),
        code: extra.code.or(style.code).unwrap_or(false),
        url: extra.url.clone().or_else(|| style.url.clone()),
    };
    if let Some(last) = spans.last_mut()
        && last.bold == next.bold
        && last.italic == next.italic
        && last.code == next.code
        && last.url == next.url
    {
        last.text.push_str(text);
        return;
    }
    spans.push(next);
}

fn style_of(span: &Span) -> Style {
    Style {
        bold: span.bold.then_some(true),
        italic: span.italic.then_some(true),
        code: span.code.then_some(true),
        url: span.url.clone(),
    }
}

fn parse_inline_styled(source: &str, style: &Style, depth: usize) -> Vec<Span> {
    let mut spans = Vec::new();
    let mut scanner = Scanner::new(source);
    let bytes = source.as_bytes();
    let mut text_from = 0;
    let mut at = 0;
    while at < bytes.len() {
        if !matches!(bytes[at], b'\\' | b'`' | b'[' | b'*' | b'_') {
            at += 1;
            continue;
        }
        let Some(token) = scanner.token_at(at) else {
            at += 1;
            continue;
        };
        push(&mut spans, style, &source[text_from..at], &Style::default());
        if !token.nested {
            push(&mut spans, style, &token.text, &token.extra);
        } else if depth >= MAX_INLINE_DEPTH {
            let extra = match &token.href {
                None => token.extra.clone(),
                Some(href) => Style {
                    url: style.url.clone().or_else(|| markdown_link(href)),
                    ..Style::default()
                },
            };
            push(&mut spans, style, &token.text, &extra);
        } else {
            let inner = match &token.href {
                None => Style {
                    bold: token.extra.bold.or(style.bold),
                    italic: token.extra.italic.or(style.italic),
                    code: token.extra.code.or(style.code),
                    url: style.url.clone(),
                },
                Some(href) => Style {
                    url: style.url.clone().or_else(|| markdown_link(href)),
                    ..style.clone()
                },
            };
            for span in parse_inline_styled(&token.text, &inner, depth + 1) {
                push(&mut spans, style, &span.text, &style_of(&span));
            }
        }
        text_from = token.end;
        at = token.end;
    }
    push(&mut spans, style, &source[text_from..], &Style::default());
    spans
}

pub fn parse_inline(source: &str) -> Vec<Span> {
    parse_inline_styled(source, &Style::default(), 0)
}

fn lead_spaces(line: &str) -> Option<&str> {
    let trimmed = line.trim_start_matches(' ');
    (line.len() - trimmed.len() <= 3).then_some(trimmed)
}

fn fence(line: &str) -> Option<(char, usize, Option<String>)> {
    let rest = lead_spaces(line)?;
    let mark = rest.chars().next().filter(|c| *c == '`' || *c == '~')?;
    let run = rest.chars().take_while(|c| *c == mark).count();
    if run < 3 {
        return None;
    }
    let after = rest[run..].trim_start();
    let language: String = after
        .chars()
        .take_while(|c| *c != '`' && !c.is_whitespace())
        .collect();
    Some((mark, run, (!language.is_empty()).then_some(language)))
}

fn closes_fence(line: &str, mark: char, run: usize) -> bool {
    lead_spaces(line).is_some_and(|rest| {
        let count = rest.chars().take_while(|c| *c == mark).count();
        count >= run && rest[count..].trim().is_empty()
    })
}

fn heading(line: &str) -> Option<(u8, String)> {
    let rest = lead_spaces(line)?;
    let hashes = rest.chars().take_while(|c| *c == '#').count();
    if !(1..=6).contains(&hashes) {
        return None;
    }
    let after = &rest[hashes..];
    if !after.is_empty() && !after.starts_with(char::is_whitespace) {
        return None;
    }
    let mut text = after.trim().to_owned();
    let without_hashes = text.trim_end_matches('#');
    if without_hashes.len() < text.len() && without_hashes.ends_with(char::is_whitespace) {
        text = without_hashes.trim_end().to_owned();
    }
    Some((hashes.min(3) as u8, text))
}

fn is_rule(line: &str) -> bool {
    let Some(rest) = lead_spaces(line) else {
        return false;
    };
    let Some(mark) = rest.chars().next().filter(|c| matches!(c, '-' | '*' | '_')) else {
        return false;
    };
    let mut marks = 0;
    for c in rest.chars() {
        if c == mark {
            marks += 1;
        } else if !c.is_whitespace() {
            return false;
        }
    }
    marks >= 3
}

fn quote(line: &str) -> Option<String> {
    let rest = lead_spaces(line)?.strip_prefix('>')?;
    let rest = rest
        .strip_prefix(|c: char| c.is_whitespace())
        .unwrap_or(rest);
    Some(rest.to_owned())
}

struct ListMatch {
    ordered: bool,
    depth: usize,
    marker: String,
    text: String,
}

fn indent_of(lead: &str) -> usize {
    (lead.replace('\t', "    ").chars().count() / 2).min(MAX_DEPTH)
}

fn list_match(line: &str) -> Option<ListMatch> {
    let body = line.trim_start();
    let lead = &line[..line.len() - body.len()];
    let first = body.chars().next()?;
    if matches!(first, '-' | '*' | '+') {
        let after = &body[1..];
        let text = after.trim_start();
        if text.len() < after.len() && !text.is_empty() {
            return Some(ListMatch {
                ordered: false,
                depth: indent_of(lead),
                marker: "•".into(),
                text: text.to_owned(),
            });
        }
    }
    let digits = body.chars().take_while(char::is_ascii_digit).count();
    if (1..=9).contains(&digits) {
        let after = &body[digits..];
        if let Some(after) = after.strip_prefix(['.', ')']) {
            let text = after.trim_start();
            if text.len() < after.len() && !text.is_empty() {
                let number: u64 = body[..digits].parse().ok()?;
                return Some(ListMatch {
                    ordered: true,
                    depth: indent_of(lead),
                    marker: format!("{number}."),
                    text: text.to_owned(),
                });
            }
        }
    }
    None
}

fn starts_block(line: &str, quotes: bool) -> bool {
    fence(line).is_some()
        || heading(line).is_some()
        || is_rule(line)
        || (quotes && quote(line).is_some())
        || list_match(line).is_some()
}

pub fn parse_markdown(source: &str) -> Vec<Block> {
    parse_blocks(source, 0)
}

fn parse_blocks(source: &str, depth: usize) -> Vec<Block> {
    let quotes = depth < MAX_DEPTH;
    let normalized = source.replace("\r\n", "\n").replace('\r', "\n");
    let lines: Vec<&str> = normalized.split('\n').collect();
    let mut blocks = Vec::new();
    let mut at = 0;
    while at < lines.len() {
        let line = lines[at];
        if line.trim().is_empty() {
            at += 1;
            continue;
        }
        if let Some((mark, run, language)) = fence(line) {
            let mut body = Vec::new();
            at += 1;
            while at < lines.len() && !closes_fence(lines[at], mark, run) {
                body.push(lines[at]);
                at += 1;
            }
            at += 1;
            blocks.push(Block::Code {
                text: body.join("\n"),
                language,
            });
            continue;
        }
        if let Some((level, text)) = heading(line) {
            blocks.push(Block::Heading {
                level,
                spans: parse_inline(&text),
            });
            at += 1;
            continue;
        }
        if is_rule(line) {
            blocks.push(Block::Rule);
            at += 1;
            continue;
        }
        if quotes && quote(line).is_some() {
            let mut inner = Vec::new();
            while at < lines.len() {
                let Some(text) = quote(lines[at]) else {
                    break;
                };
                inner.push(text);
                at += 1;
            }
            blocks.push(Block::Quote(parse_blocks(&inner.join("\n"), depth + 1)));
            continue;
        }
        if let Some(first) = list_match(line) {
            let mut items: Vec<(String, usize)> = Vec::new();
            let mut texts: Vec<String> = Vec::new();
            while at < lines.len() {
                let current = lines[at];
                let item = list_match(current);
                match item {
                    Some(item) if item.depth > 0 || item.ordered == first.ordered => {
                        items.push((item.marker, item.depth));
                        texts.push(item.text);
                    }
                    None if !current.trim().is_empty()
                        && current.starts_with(char::is_whitespace)
                        && !texts.is_empty() =>
                    {
                        if let Some(last) = texts.last_mut() {
                            last.push(' ');
                            last.push_str(current.trim());
                        }
                    }
                    _ => break,
                }
                at += 1;
            }
            blocks.push(Block::List {
                ordered: first.ordered,
                items: items
                    .into_iter()
                    .zip(texts)
                    .map(|((marker, depth), text)| ListItem {
                        marker,
                        depth,
                        spans: parse_inline(&text),
                    })
                    .collect(),
            });
            continue;
        }
        let mut paragraph = vec![line.trim().to_owned()];
        at += 1;
        while at < lines.len() && !lines[at].trim().is_empty() && !starts_block(lines[at], quotes) {
            paragraph.push(lines[at].trim().to_owned());
            at += 1;
        }
        blocks.push(Block::Paragraph(parse_inline(&paragraph.join(" "))));
    }
    blocks
}

#[cfg(test)]
mod tests {
    use super::*;

    fn span(text: &str) -> Span {
        Span {
            text: text.into(),
            ..Span::default()
        }
    }

    #[test]
    fn inline_styles_links_and_escapes() {
        let spans = parse_inline("a **b** *c* `d` [e](https://x.y) \\*f");
        assert_eq!(spans[0], span("a "));
        assert!(spans[1].bold && spans[1].text == "b");
        assert!(spans[3].italic && spans[3].text == "c");
        assert!(spans[5].code && spans[5].text == "d");
        assert_eq!(spans[7].url.as_deref(), Some("https://x.y"));
        assert_eq!(spans[8], span(" *f"));
        assert_eq!(parse_inline("[x](javascript:y)")[0].url, None);
        assert_eq!(parse_inline("* not italic")[0], span("* not italic"));
        let titled = parse_inline("[t](https://a.b \"title\")");
        assert_eq!(titled[0].url.as_deref(), Some("https://a.b"));
    }

    #[test]
    fn blocks_cover_every_kind() {
        let blocks = parse_markdown(
            "# Title #\n\npara\nline\n\n- one\n  more\n  - two\n1. first\n\n> quote\n\n---\n```rs\ncode\n```\n####### seven",
        );
        assert_eq!(
            blocks[0],
            Block::Heading {
                level: 1,
                spans: vec![span("Title")]
            }
        );
        assert_eq!(blocks[1], Block::Paragraph(vec![span("para line")]));
        let Block::List { ordered, items } = &blocks[2] else {
            panic!("list")
        };
        assert!(!ordered);
        assert_eq!(items.len(), 2);
        assert_eq!(items[0].spans, vec![span("one more")]);
        assert_eq!(items[1].depth, 1);
        assert!(
            matches!(&blocks[3], Block::List { ordered: true, items } if items[0].marker == "1.")
        );
        assert_eq!(
            blocks[4],
            Block::Quote(vec![Block::Paragraph(vec![span("quote")])])
        );
        assert_eq!(blocks[5], Block::Rule);
        assert_eq!(
            blocks[6],
            Block::Code {
                text: "code".into(),
                language: Some("rs".into())
            }
        );
        assert_eq!(blocks[7], Block::Paragraph(vec![span("####### seven")]));
    }
}
