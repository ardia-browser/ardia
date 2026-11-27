use std::cell::RefCell;
use std::collections::HashMap;

pub const MAX_WHEN_LENGTH: usize = 200;
const MAX_DEPTH: usize = 16;
const MAX_GLOB: usize = 128;
const MAX_GLOB_VALUE: usize = 2048;
const KEYS: [&str; 7] = [
    "urlHost",
    "urlScheme",
    "isPinned",
    "isInGroup",
    "isSplit",
    "isActive",
    "tabCount",
];

#[derive(Clone, Debug, PartialEq)]
pub enum WhenValue {
    Text(String),
    Number(f64),
    Flag(bool),
}

impl WhenValue {
    fn truthy(&self) -> bool {
        match self {
            WhenValue::Text(text) => !text.is_empty(),
            WhenValue::Number(n) => *n != 0.0,
            WhenValue::Flag(on) => *on,
        }
    }

    fn shown(&self) -> String {
        match self {
            WhenValue::Text(text) => text.clone(),
            WhenValue::Number(n) if n.fract() == 0.0 && n.abs() < 1e15 => format!("{}", *n as i64),
            WhenValue::Number(n) => n.to_string(),
            WhenValue::Flag(on) => on.to_string(),
        }
    }
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct WhenContext {
    pub url_host: String,
    pub url_scheme: String,
    pub is_pinned: bool,
    pub is_in_group: bool,
    pub is_split: bool,
    pub is_active: bool,
    pub tab_count: usize,
}

impl WhenContext {
    fn get(&self, key: &str) -> Option<WhenValue> {
        Some(match key {
            "urlHost" => WhenValue::Text(self.url_host.clone()),
            "urlScheme" => WhenValue::Text(self.url_scheme.clone()),
            "isPinned" => WhenValue::Flag(self.is_pinned),
            "isInGroup" => WhenValue::Flag(self.is_in_group),
            "isSplit" => WhenValue::Flag(self.is_split),
            "isActive" => WhenValue::Flag(self.is_active),
            "tabCount" => WhenValue::Number(self.tab_count as f64),
            _ => return None,
        })
    }
}

#[derive(Clone, Debug, PartialEq)]
enum Operand {
    Literal(WhenValue),
    Key(&'static str),
}

#[derive(Clone, Debug, PartialEq)]
enum Compare {
    Same,
    Differs,
    Glob,
}

#[derive(Clone, Debug, PartialEq)]
enum Expr {
    Operand(Operand),
    Not(Box<Expr>),
    And(Box<Expr>, Box<Expr>),
    Or(Box<Expr>, Box<Expr>),
    Compare(Compare, Operand, Operand),
}

#[derive(Clone, Debug, PartialEq)]
enum Token {
    Op(&'static str),
    Text(String),
    Number(f64),
    Word(String),
}

const OPERATORS: [&str; 8] = ["&&", "||", "==", "!=", "~=", "!", "(", ")"];

fn tokenize(source: &str) -> Result<Vec<Token>, String> {
    let chars: Vec<char> = source.chars().collect();
    let mut tokens = Vec::new();
    let mut i = 0;
    while i < chars.len() {
        let ch = chars[i];
        if ch == ' ' || ch == '\t' {
            i += 1;
            continue;
        }
        let rest: String = chars[i..chars.len().min(i + 2)].iter().collect();
        if let Some(op) = OPERATORS.iter().find(|op| rest.starts_with(**op)) {
            tokens.push(Token::Op(op));
            i += op.len();
            continue;
        }
        if ch == '"' || ch == '\'' {
            let Some(end) = chars[i + 1..].iter().position(|c| *c == ch) else {
                return Err("has a string without its closing quote".into());
            };
            tokens.push(Token::Text(chars[i + 1..i + 1 + end].iter().collect()));
            i += end + 2;
            continue;
        }
        let digit_next = chars.get(i + 1).is_some_and(char::is_ascii_digit);
        if ch.is_ascii_digit() || (ch == '-' && digit_next) {
            let mut end = i + 1;
            while end < chars.len() && (chars[end].is_ascii_digit() || chars[end] == '.') {
                end += 1;
            }
            let text: String = chars[i..end].iter().collect();
            match text.parse::<f64>() {
                Ok(value) if value.is_finite() => tokens.push(Token::Number(value)),
                _ => return Err(format!("has a bad number at {i}")),
            }
            i = end;
            continue;
        }
        if ch.is_ascii_alphabetic() || ch == '_' {
            let mut end = i + 1;
            while end < chars.len() && (chars[end].is_ascii_alphanumeric() || chars[end] == '_') {
                end += 1;
            }
            tokens.push(Token::Word(chars[i..end].iter().collect()));
            i = end;
            continue;
        }
        return Err(format!("has an unexpected {ch:?} at {i}"));
    }
    Ok(tokens)
}

struct Parser {
    tokens: Vec<Token>,
    at: usize,
}

impl Parser {
    fn peek_op(&self, op: &str) -> bool {
        matches!(self.tokens.get(self.at), Some(Token::Op(o)) if *o == op)
    }

    fn or(&mut self, depth: usize) -> Result<Expr, String> {
        let mut left = self.and(depth)?;
        while self.peek_op("||") {
            self.at += 1;
            left = Expr::Or(Box::new(left), Box::new(self.and(depth)?));
        }
        Ok(left)
    }

    fn and(&mut self, depth: usize) -> Result<Expr, String> {
        let mut left = self.unary(depth)?;
        while self.peek_op("&&") {
            self.at += 1;
            left = Expr::And(Box::new(left), Box::new(self.unary(depth)?));
        }
        Ok(left)
    }

    fn unary(&mut self, depth: usize) -> Result<Expr, String> {
        if depth > MAX_DEPTH {
            return Err(format!("nests deeper than {MAX_DEPTH}"));
        }
        if self.peek_op("!") {
            self.at += 1;
            return Ok(Expr::Not(Box::new(self.unary(depth + 1)?)));
        }
        if self.peek_op("(") {
            self.at += 1;
            let inner = self.or(depth + 1)?;
            if !self.peek_op(")") {
                return Err("has a ( without its )".into());
            }
            self.at += 1;
            return Ok(inner);
        }
        let left = self.operand()?;
        let compare = match self.tokens.get(self.at) {
            Some(Token::Op("==")) => Some(Compare::Same),
            Some(Token::Op("!=")) => Some(Compare::Differs),
            Some(Token::Op("~=")) => Some(Compare::Glob),
            _ => None,
        };
        match compare {
            Some(op) => {
                self.at += 1;
                let right = self.operand()?;
                Ok(Expr::Compare(op, left, right))
            }
            None => Ok(Expr::Operand(left)),
        }
    }

    fn operand(&mut self) -> Result<Operand, String> {
        let token = self.tokens.get(self.at).cloned().ok_or("ends too soon")?;
        self.at += 1;
        match token {
            Token::Text(text) => Ok(Operand::Literal(WhenValue::Text(text))),
            Token::Number(n) => Ok(Operand::Literal(WhenValue::Number(n))),
            Token::Word(word) if word == "true" || word == "false" => {
                Ok(Operand::Literal(WhenValue::Flag(word == "true")))
            }
            Token::Word(word) => KEYS
                .iter()
                .find(|key| **key == word)
                .map(|key| Operand::Key(key))
                .ok_or_else(|| format!("names {word}, which isn't one of {}", KEYS.join(", "))),
            Token::Op(op) => Err(format!("has {op} where a key or value goes")),
        }
    }
}

fn parse(source: &str) -> Result<Expr, String> {
    if source.trim().is_empty() {
        return Err("is empty".into());
    }
    if source.chars().count() > MAX_WHEN_LENGTH {
        return Err(format!("is over {MAX_WHEN_LENGTH} characters"));
    }
    let mut parser = Parser {
        tokens: tokenize(source)?,
        at: 0,
    };
    let expr = parser.or(0)?;
    if parser.at < parser.tokens.len() {
        return Err(format!(
            "has something unexpected after position {}",
            parser.at
        ));
    }
    Ok(expr)
}

pub fn glob_matches(pattern: &str, value: &str) -> bool {
    let pattern: Vec<char> = pattern.chars().collect();
    let value: Vec<char> = value.chars().collect();
    if pattern.len() > MAX_GLOB || value.len() > MAX_GLOB_VALUE {
        return false;
    }
    let (mut p, mut v, mut star, mut mark) = (0usize, 0usize, None::<usize>, 0usize);
    while v < value.len() {
        if p < pattern.len() && pattern[p] != '*' && pattern[p] == value[v] {
            p += 1;
            v += 1;
        } else if p < pattern.len() && pattern[p] == '*' {
            star = Some(p);
            p += 1;
            mark = v;
        } else if let Some(s) = star {
            p = s + 1;
            mark += 1;
            v = mark;
        } else {
            return false;
        }
    }
    while p < pattern.len() && pattern[p] == '*' {
        p += 1;
    }
    p == pattern.len()
}

fn value_of(operand: &Operand, context: &WhenContext) -> Option<WhenValue> {
    match operand {
        Operand::Literal(value) => Some(value.clone()),
        Operand::Key(key) => context.get(key),
    }
}

fn same(a: Option<&WhenValue>, b: Option<&WhenValue>) -> bool {
    match (a, b) {
        (Some(WhenValue::Number(x)), Some(WhenValue::Number(y))) => x == y,
        _ => {
            a.map(WhenValue::shown).unwrap_or_default()
                == b.map(WhenValue::shown).unwrap_or_default()
        }
    }
}

fn evaluate(expr: &Expr, context: &WhenContext) -> bool {
    match expr {
        Expr::Operand(operand) => value_of(operand, context).is_some_and(|v| v.truthy()),
        Expr::Not(inner) => !evaluate(inner, context),
        Expr::And(a, b) => evaluate(a, context) && evaluate(b, context),
        Expr::Or(a, b) => evaluate(a, context) || evaluate(b, context),
        Expr::Compare(op, left, right) => {
            let (l, r) = (value_of(left, context), value_of(right, context));
            match op {
                Compare::Same => same(l.as_ref(), r.as_ref()),
                Compare::Differs => !same(l.as_ref(), r.as_ref()),
                Compare::Glob => glob_matches(
                    &r.map(|v| v.shown()).unwrap_or_default().to_lowercase(),
                    &l.map(|v| v.shown()).unwrap_or_default().to_lowercase(),
                ),
            }
        }
    }
}

thread_local! {
    static PARSED: RefCell<HashMap<String, Result<Expr, String>>> = RefCell::new(HashMap::new());
}

pub fn when_holds(source: Option<&str>, context: &WhenContext) -> bool {
    let Some(source) = source.filter(|s| !s.is_empty()) else {
        return true;
    };
    PARSED.with(|parsed| {
        let mut parsed = parsed.borrow_mut();
        if !parsed.contains_key(source) {
            if parsed.len() > 512 {
                parsed.clear();
            }
            parsed.insert(source.to_owned(), parse(source));
        }
        parsed
            .get(source)
            .and_then(|read| read.as_ref().ok())
            .is_some_and(|expr| evaluate(expr, context))
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn github(active: bool) -> WhenContext {
        WhenContext {
            url_host: "github.com".into(),
            url_scheme: "https".into(),
            is_pinned: false,
            is_in_group: true,
            is_split: false,
            is_active: active,
            tab_count: 3,
        }
    }

    #[test]
    fn expressions_follow_the_old_grammar() {
        let c = github(true);
        assert!(when_holds(None, &c));
        assert!(when_holds(Some("urlHost == 'github.com'"), &c));
        assert!(when_holds(Some("urlHost ~= '*.COM' && isActive"), &c));
        assert!(when_holds(Some("!isPinned && (isSplit || isInGroup)"), &c));
        assert!(when_holds(Some("tabCount == 3 && tabCount != 4"), &c));
        assert!(!when_holds(Some("isActive"), &github(false)));
        assert!(!when_holds(Some("unknownKey"), &c));
        assert!(!when_holds(Some("urlHost == "), &c));
        assert!(!when_holds(Some("'open"), &c));
        assert!(!when_holds(Some(&"(".repeat(20)), &c));
    }

    #[test]
    fn globs_match_like_the_old_matcher() {
        assert!(glob_matches("*.example.com", "a.example.com"));
        assert!(glob_matches("a*c", "abbbc"));
        assert!(!glob_matches("a*c", "abd"));
        assert!(!glob_matches(&"*".repeat(200), "x"));
    }
}
