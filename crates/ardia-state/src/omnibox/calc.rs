use std::f64::consts::{E, PI, TAU};

#[derive(Clone, Debug, PartialEq)]
enum Token {
    Num(f64),
    Op(&'static str),
    Id(String),
}

const FUNCTIONS: [&str; 23] = [
    "sqrt", "cbrt", "abs", "sin", "cos", "tan", "asin", "acos", "atan", "sinh", "cosh", "tanh",
    "ln", "log", "log2", "log10", "exp", "floor", "ceil", "round", "min", "max", "pow",
];

fn constant(id: &str) -> Option<f64> {
    match id {
        "pi" | "π" => Some(PI),
        "e" => Some(E),
        "tau" | "τ" => Some(TAU),
        _ => None,
    }
}

fn js_round(x: f64) -> f64 {
    (x + 0.5).floor()
}

fn call(name: &str, args: &[f64]) -> Option<f64> {
    let x = *args.first()?;
    let one = |f: fn(f64) -> f64| (args.len() == 1).then(|| f(x));
    match name {
        "sqrt" => one(f64::sqrt),
        "cbrt" => one(f64::cbrt),
        "abs" => one(f64::abs),
        "sin" => one(f64::sin),
        "cos" => one(f64::cos),
        "tan" => one(f64::tan),
        "asin" => one(f64::asin),
        "acos" => one(f64::acos),
        "atan" => one(f64::atan),
        "sinh" => one(f64::sinh),
        "cosh" => one(f64::cosh),
        "tanh" => one(f64::tanh),
        "ln" => one(f64::ln),
        "log2" => one(f64::log2),
        "log10" => one(f64::log10),
        "exp" => one(f64::exp),
        "floor" => one(f64::floor),
        "ceil" => one(f64::ceil),
        "round" => one(js_round),
        "log" => match args {
            [x] => Some(x.log10()),
            [x, base] => Some(x.ln() / base.ln()),
            _ => None,
        },
        "min" => Some(args.iter().copied().fold(f64::INFINITY, f64::min)),
        "max" => Some(args.iter().copied().fold(f64::NEG_INFINITY, f64::max)),
        "pow" => match args {
            [x, y] => Some(x.powf(*y)),
            _ => None,
        },
        _ => None,
    }
}

const OPERATORS: [(&str, &str); 19] = [
    ("**", "^"),
    ("-", "-"),
    ("+", "+"),
    ("*", "*"),
    ("/", "/"),
    ("^", "^"),
    ("%", "%"),
    ("!", "!"),
    ("(", "("),
    (")", ")"),
    (",", ","),
    ("×", "*"),
    ("·", "*"),
    ("÷", "/"),
    ("−", "-"),
    ("–", "-"),
    ("°", "°"),
    ("π", "π"),
    ("τ", "τ"),
];

fn number_len(text: &str) -> usize {
    let bytes = text.as_bytes();
    let digits = |from: usize| {
        bytes[from..]
            .iter()
            .take_while(|b| b.is_ascii_digit())
            .count()
    };
    let mut at = digits(0);
    if at > 0 {
        if bytes.get(at) == Some(&b'.') {
            at += 1 + digits(at + 1);
        }
    } else if bytes.first() == Some(&b'.') && digits(1) > 0 {
        at = 1 + digits(1);
    } else {
        return 0;
    }
    if matches!(bytes.get(at), Some(b'e' | b'E')) {
        let sign = usize::from(matches!(bytes.get(at + 1), Some(b'+' | b'-')));
        let exp = digits(at + 1 + sign);
        if exp > 0 {
            at += 1 + sign + exp;
        }
    }
    at
}

fn tokenize(source: &str) -> Option<Vec<Token>> {
    let mut tokens = Vec::new();
    let mut rest = source;
    while !rest.is_empty() {
        let trimmed = rest.trim_start();
        if trimmed.len() != rest.len() {
            rest = trimmed;
            continue;
        }
        let n = number_len(rest);
        if n > 0 {
            let text = rest[..n].replace(".e", ".0e").replace(".E", ".0E");
            let text = if text.ends_with('.') {
                format!("{text}0")
            } else {
                text
            };
            tokens.push(Token::Num(text.parse().ok()?));
            rest = &rest[n..];
            continue;
        }
        if let Some((text, op)) = OPERATORS.iter().find(|(text, _)| rest.starts_with(text)) {
            match *op {
                "π" | "τ" => tokens.push(Token::Id((*op).to_owned())),
                op => tokens.push(Token::Op(op)),
            }
            rest = &rest[text.len()..];
            continue;
        }
        let first = rest.chars().next()?;
        if !first.is_ascii_alphabetic() {
            return None;
        }
        let len = rest
            .find(|c: char| !c.is_ascii_alphanumeric())
            .unwrap_or(rest.len());
        tokens.push(Token::Id(rest[..len].to_ascii_lowercase()));
        rest = &rest[len..];
    }
    Some(tokens)
}

const MAX_DEPTH: usize = 64;

struct Parser {
    tokens: Vec<Token>,
    at: usize,
    depth: usize,
}

impl Parser {
    fn peek(&self, offset: usize) -> Option<&Token> {
        self.tokens.get(self.at + offset)
    }

    fn is_op(&self, op: &str, offset: usize) -> bool {
        matches!(self.peek(offset), Some(Token::Op(o)) if *o == op)
    }

    fn is_id(&self, id: &str) -> bool {
        matches!(self.peek(0), Some(Token::Id(i)) if i == id)
    }

    fn starts_primary(&self, offset: usize) -> bool {
        match self.peek(offset) {
            Some(Token::Num(_)) => true,
            Some(Token::Id(id)) => constant(id).is_some() || FUNCTIONS.contains(&id.as_str()),
            Some(Token::Op(op)) => *op == "(",
            None => false,
        }
    }

    fn parse(mut self) -> Option<f64> {
        let value = self.expr()?;
        (self.at == self.tokens.len()).then_some(value)
    }

    fn expr(&mut self) -> Option<f64> {
        let mut value = self.term()?;
        while self.is_op("+", 0) || self.is_op("-", 0) {
            let plus = self.is_op("+", 0);
            self.at += 1;
            let rhs = self.term()?;
            value = if plus { value + rhs } else { value - rhs };
        }
        Some(value)
    }

    fn term(&mut self) -> Option<f64> {
        let mut value = self.unary()?;
        loop {
            if self.is_op("*", 0)
                || self.is_op("/", 0)
                || self.is_id("mod")
                || self.is_id("of")
                || self.is_id("x")
            {
                let divide = self.is_op("/", 0);
                let modulo = self.is_id("mod");
                self.at += 1;
                let rhs = self.unary()?;
                value = if divide {
                    value / rhs
                } else if modulo {
                    value % rhs
                } else {
                    value * rhs
                };
            } else if self.is_op("%", 0) && self.starts_primary(1) {
                self.at += 1;
                value %= self.unary()?;
            } else if !matches!(self.peek(0), Some(Token::Num(_))) && self.starts_primary(0) {
                value *= self.unary()?;
            } else {
                return Some(value);
            }
        }
    }

    fn unary(&mut self) -> Option<f64> {
        if self.depth >= MAX_DEPTH {
            return None;
        }
        self.depth += 1;
        let value = self.signed();
        self.depth -= 1;
        value
    }

    fn signed(&mut self) -> Option<f64> {
        if self.is_op("-", 0) {
            self.at += 1;
            return self.unary().map(|v| -v);
        }
        if self.is_op("+", 0) {
            self.at += 1;
            return self.unary();
        }
        self.power()
    }

    fn power(&mut self) -> Option<f64> {
        let base = self.postfix()?;
        if self.is_op("^", 0) {
            self.at += 1;
            return Some(base.powf(self.unary()?));
        }
        Some(base)
    }

    fn postfix(&mut self) -> Option<f64> {
        let mut value = self.primary()?;
        loop {
            if self.is_op("!", 0) {
                self.at += 1;
                value = factorial(value);
            } else if self.is_op("%", 0) && !self.starts_primary(1) {
                self.at += 1;
                value /= 100.0;
            } else if self.is_op("°", 0) || self.is_id("deg") || self.is_id("degrees") {
                self.at += 1;
                value *= PI / 180.0;
            } else {
                return Some(value);
            }
        }
    }

    fn expect(&mut self, op: &str) -> Option<()> {
        self.is_op(op, 0).then(|| self.at += 1)
    }

    fn primary(&mut self) -> Option<f64> {
        let token = self.tokens.get(self.at)?.clone();
        self.at += 1;
        match token {
            Token::Num(n) => Some(n),
            Token::Op("(") => {
                let value = self.expr()?;
                self.expect(")")?;
                Some(value)
            }
            Token::Id(id) => {
                if let Some(c) = constant(&id) {
                    return Some(c);
                }
                if !FUNCTIONS.contains(&id.as_str()) {
                    return None;
                }
                self.expect("(")?;
                let mut args = vec![self.expr()?];
                while self.is_op(",", 0) {
                    self.at += 1;
                    args.push(self.expr()?);
                }
                self.expect(")")?;
                call(&id, &args)
            }
            Token::Op(_) => None,
        }
    }
}

fn factorial(n: f64) -> f64 {
    if n.fract() != 0.0 || !(0.0..=170.0).contains(&n) {
        return f64::NAN;
    }
    (2..=n as u32).fold(1.0, |acc, k| acc * f64::from(k))
}

fn without_thousands(expression: &str) -> String {
    let chars: Vec<char> = expression.chars().collect();
    let mut out = String::with_capacity(expression.len());
    for (i, &c) in chars.iter().enumerate() {
        let separator = c == ','
            && i > 0
            && chars[i - 1].is_ascii_digit()
            && chars
                .get(i + 1..i + 4)
                .is_some_and(|d| d.iter().all(char::is_ascii_digit))
            && !chars.get(i + 4).is_some_and(char::is_ascii_digit);
        if !separator {
            out.push(c);
        }
    }
    out
}

fn calls_function(expression: &str) -> bool {
    let lower = expression.to_ascii_lowercase();
    lower.char_indices().any(|(i, c)| {
        c.is_ascii_alphabetic() && lower[i + c.len_utf8()..].trim_start().starts_with('(')
    })
}

pub fn evaluate(expression: &str) -> Option<f64> {
    let source = if calls_function(expression) {
        expression.to_owned()
    } else {
        without_thousands(expression)
    };
    let tokens = tokenize(&source)?;
    if tokens.is_empty() {
        return None;
    }
    Parser {
        tokens,
        at: 0,
        depth: 0,
    }
    .parse()
    .filter(|v| v.is_finite())
}

fn js_string(v: f64) -> String {
    let abs = v.abs();
    if abs != 0.0 && (abs >= 1e21 || abs < 1e-6) {
        exponential(v)
    } else {
        format!("{v}")
    }
}

fn exponential(v: f64) -> String {
    let text = format!("{v:e}");
    match text.split_once('e') {
        Some((mantissa, exp)) if !exp.starts_with('-') => format!("{mantissa}e+{exp}"),
        _ => text,
    }
}

pub fn format_number(value: f64, digits: usize) -> String {
    if value == 0.0 {
        return "0".to_owned();
    }
    let rounded: f64 = format!("{:.*e}", digits.saturating_sub(1), value)
        .parse()
        .unwrap_or(value);
    let abs = rounded.abs();
    if abs >= 1e21 || abs < 1e-9 {
        exponential(rounded)
    } else {
        js_string(rounded)
    }
}

#[derive(Clone, Copy)]
struct Unit {
    dim: &'static str,
    factor: f64,
    label: &'static str,
}

const UNITS: &[(&str, &str, f64, &[&str])] = &[
    ("length", "m", 1.0, &["meter", "meters", "metre", "metres"]),
    (
        "length",
        "km",
        1000.0,
        &["kilometer", "kilometers", "kilometre", "kilometres"],
    ),
    ("length", "cm", 0.01, &["centimeter", "centimeters"]),
    ("length", "mm", 0.001, &["millimeter", "millimeters"]),
    ("length", "mi", 1609.344, &["mile", "miles"]),
    ("length", "yd", 0.9144, &["yard", "yards"]),
    ("length", "ft", 0.3048, &["foot", "feet"]),
    ("length", "in", 0.0254, &["inch", "inches"]),
    ("length", "nmi", 1852.0, &["nautical mile"]),
    (
        "mass",
        "kg",
        1.0,
        &["kilogram", "kilograms", "kilo", "kilos"],
    ),
    ("mass", "g", 0.001, &["gram", "grams"]),
    ("mass", "mg", 1e-6, &["milligram", "milligrams"]),
    ("mass", "lb", 0.453_592_37, &["lbs", "pound", "pounds"]),
    ("mass", "oz", 0.028_349_523_125, &["ounce", "ounces"]),
    ("mass", "st", 6.350_293_18, &["stone", "stones"]),
    ("mass", "t", 1000.0, &["tonne", "tonnes"]),
    ("volume", "l", 1.0, &["liter", "liters", "litre", "litres"]),
    (
        "volume",
        "ml",
        0.001,
        &["milliliter", "milliliters", "millilitre", "millilitres"],
    ),
    ("volume", "gal", 3.785_411_784, &["gallon", "gallons"]),
    ("volume", "qt", 0.946_352_946, &["quart", "quarts"]),
    ("volume", "pt", 0.473_176_473, &["pint", "pints"]),
    ("volume", "cup", 0.236_588_236_5, &["cups"]),
    ("volume", "fl oz", 0.029_573_529_562_5, &["floz"]),
    (
        "volume",
        "tbsp",
        0.014_786_764_781_25,
        &["tablespoon", "tablespoons"],
    ),
    (
        "volume",
        "tsp",
        0.004_928_921_593_75,
        &["teaspoon", "teaspoons"],
    ),
    ("time", "ms", 0.001, &["millisecond", "milliseconds"]),
    ("time", "s", 1.0, &["sec", "secs", "second", "seconds"]),
    ("time", "min", 60.0, &["mins", "minute", "minutes"]),
    ("time", "h", 3600.0, &["hr", "hrs", "hour", "hours"]),
    ("time", "days", 86400.0, &["day", "d"]),
    ("time", "weeks", 604_800.0, &["week", "wk"]),
    ("time", "years", 31_556_952.0, &["year", "yr"]),
    ("data", "bits", 0.125, &["bit"]),
    ("data", "bytes", 1.0, &["byte", "B"]),
    ("data", "KB", 1e3, &["kilobyte", "kilobytes"]),
    ("data", "MB", 1e6, &["megabyte", "megabytes"]),
    ("data", "GB", 1e9, &["gigabyte", "gigabytes"]),
    ("data", "TB", 1e12, &["terabyte", "terabytes"]),
    ("data", "KiB", 1024.0, &[]),
    ("data", "MiB", 1_048_576.0, &[]),
    ("data", "GiB", 1_073_741_824.0, &[]),
    ("data", "TiB", 1_099_511_627_776.0, &[]),
    ("speed", "m/s", 1.0, &[]),
    ("speed", "km/h", 1000.0 / 3600.0, &["kph", "kmh"]),
    ("speed", "mph", 1609.344 / 3600.0, &[]),
    ("speed", "knots", 1852.0 / 3600.0, &["knot", "kn"]),
];

type UnitName = (String, Option<Unit>, Option<char>);

const TEMPERATURES: [(&str, char); 8] = [
    ("c", 'C'),
    ("°c", 'C'),
    ("celsius", 'C'),
    ("f", 'F'),
    ("°f", 'F'),
    ("fahrenheit", 'F'),
    ("k", 'K'),
    ("kelvin", 'K'),
];
const CONNECTORS: [&str; 7] = ["to", "in", "into", "as", "=", "->", "→"];

fn unit_names() -> &'static [UnitName] {
    static NAMES: std::sync::OnceLock<Vec<UnitName>> = std::sync::OnceLock::new();
    NAMES.get_or_init(|| {
        let mut names: Vec<UnitName> = Vec::new();
        for (dim, label, factor, aliases) in UNITS {
            for name in std::iter::once(*label).chain(aliases.iter().copied()) {
                let key = name.to_lowercase();
                if !names.iter().any(|(n, _, _)| *n == key) {
                    names.push((
                        key,
                        Some(Unit {
                            dim,
                            factor: *factor,
                            label,
                        }),
                        None,
                    ));
                }
            }
        }
        for (name, scale) in TEMPERATURES {
            names.push((name.to_owned(), None, Some(scale)));
        }
        names.sort_by_key(|(name, _, _)| std::cmp::Reverse(name.chars().count()));
        names
    })
}

fn collapse(text: &str) -> String {
    text.split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .to_lowercase()
}

fn unit_named(text: &str) -> Option<&'static UnitName> {
    let key = collapse(text).replace("fl oz", "floz");
    unit_names()
        .iter()
        .find(|(name, _, _)| name.replace("fl oz", "floz") == key)
}

fn unit_suffix(text: &str) -> Option<(&str, &'static UnitName)> {
    let lower = text.to_lowercase();
    if lower.len() != text.len() {
        return None;
    }
    for entry in unit_names() {
        let name = &entry.0;
        let candidates = if name == "fl oz" {
            vec!["fl oz".to_owned(), "floz".to_owned()]
        } else {
            vec![name.clone()]
        };
        for candidate in candidates {
            if lower.ends_with(&candidate) && text.is_char_boundary(text.len() - candidate.len()) {
                let amount = text[..text.len() - candidate.len()].trim_end();
                if !amount.is_empty() {
                    return Some((amount, entry));
                }
            }
        }
    }
    None
}

fn to_celsius(scale: char, v: f64) -> f64 {
    match scale {
        'F' => (v - 32.0) * 5.0 / 9.0,
        'K' => v - 273.15,
        _ => v,
    }
}

fn from_celsius(scale: char, v: f64) -> f64 {
    match scale {
        'F' => v * 9.0 / 5.0 + 32.0,
        'K' => v + 273.15,
        _ => v,
    }
}

fn word_spans(text: &str) -> Vec<(usize, &str)> {
    let mut spans = Vec::new();
    let mut start = None;
    for (i, c) in text.char_indices() {
        match (c.is_whitespace(), start) {
            (true, Some(s)) => {
                spans.push((s, &text[s..i]));
                start = None;
            }
            (false, None) => start = Some(i),
            _ => {}
        }
    }
    if let Some(s) = start {
        spans.push((s, &text[s..]));
    }
    spans
}

fn convert(input: &str) -> Option<(f64, String)> {
    let words = word_spans(input);
    for (i, (at, word)) in words.iter().enumerate() {
        if i == 0
            || i + 1 == words.len()
            || !CONNECTORS.iter().any(|c| c.eq_ignore_ascii_case(word))
        {
            continue;
        }
        let left = input[..*at].trim_end();
        let right = input[at + word.len()..].trim();
        let Some((_, to_unit, to_scale)) = unit_named(right) else {
            continue;
        };
        let Some((amount, (_, from_unit, from_scale))) = unit_suffix(left) else {
            continue;
        };
        let value = evaluate(amount)?;
        return match (from_scale, to_scale, from_unit, to_unit) {
            (Some(from), Some(to), _, _) => {
                let label = if *to == 'K' {
                    "K".to_owned()
                } else {
                    format!("°{to}")
                };
                Some((from_celsius(*to, to_celsius(*from, value)), label))
            }
            (_, _, Some(a), Some(b)) if a.dim == b.dim => {
                Some((value * a.factor / b.factor, b.label.to_owned()))
            }
            _ => None,
        };
    }
    None
}

#[derive(Clone, Debug, PartialEq)]
pub struct Calculation {
    pub expression: String,
    pub value: f64,
    pub display: String,
}

fn has_operator(expression: &str) -> bool {
    let lower = expression.to_lowercase();
    if lower.trim_end().ends_with(['!', '%', '°']) {
        return true;
    }
    let chars: Vec<char> = lower.chars().collect();
    let left_ok = |c: char| c.is_ascii_alphanumeric() || "_).πτ".contains(c);
    let right_ok = |c: char| c.is_ascii_alphanumeric() || "(.πτ".contains(c);
    for (i, &c) in chars.iter().enumerate() {
        if !left_ok(c) {
            continue;
        }
        let mut j = i + 1;
        while chars.get(j).is_some_and(|c| c.is_whitespace()) {
            j += 1;
        }
        let rest: String = chars[j..].iter().collect();
        let op_len = ["**", "mod", "of", "x"]
            .iter()
            .find(|op| rest.starts_with(**op))
            .map(|op| op.chars().count())
            .or_else(|| {
                chars
                    .get(j)
                    .filter(|c| "-+*/^%×·÷−–".contains(**c))
                    .map(|_| 1)
            });
        let Some(op_len) = op_len else { continue };
        let mut k = j + op_len;
        while chars.get(k).is_some_and(|c| c.is_whitespace()) {
            k += 1;
        }
        if chars.get(k).is_some_and(|c| right_ok(*c)) {
            return true;
        }
    }
    false
}

pub fn calculate(raw: &str) -> Option<Calculation> {
    let trimmed = raw.trim();
    let expression = trimmed.strip_prefix('=').map_or(trimmed, str::trim_start);
    let expression = expression
        .strip_suffix('?')
        .map(str::trim_end)
        .and_then(|e| e.strip_suffix('='))
        .or_else(|| expression.strip_suffix('='))
        .map_or(expression, str::trim_end);
    if expression.is_empty() || expression.chars().count() > 200 {
        return None;
    }
    let lower = expression.to_lowercase();
    let mentions_number = lower
        .chars()
        .any(|c| c.is_ascii_digit() || c == 'π' || c == 'τ')
        || lower
            .split(|c: char| !c.is_alphanumeric())
            .any(|w| matches!(w, "pi" | "e" | "tau"));
    if !mentions_number || looks_like_date_or_version(expression) {
        return None;
    }
    if let Some((value, unit)) = convert(expression) {
        return Some(Calculation {
            expression: expression.to_owned(),
            value,
            display: format!("{} {unit}", format_number(value, 9)),
        });
    }
    let has_function = FUNCTIONS.iter().any(|f| {
        lower.match_indices(f).any(|(at, _)| {
            let before_ok = at == 0
                || !lower[..at]
                    .chars()
                    .next_back()
                    .is_some_and(|c| c.is_alphanumeric() || c == '_');
            before_ok && lower[at + f.len()..].trim_start().starts_with('(')
        })
    });
    if !has_operator(expression) && !has_function {
        return None;
    }
    let value = evaluate(expression)?;
    Some(Calculation {
        expression: expression.to_owned(),
        value,
        display: format_number(value, 12),
    })
}

fn looks_like_date_or_version(expression: &str) -> bool {
    let parts: Vec<&str> = expression.split('-').collect();
    let date = parts.len() == 3
        && parts[0].len() == 4
        && parts
            .iter()
            .all(|p| !p.is_empty() && p.bytes().all(|b| b.is_ascii_digit()))
        && parts[1].len() <= 2
        && parts[2].len() <= 2;
    let dots: Vec<&str> = expression.split('.').collect();
    let version = dots.len() >= 3
        && dots
            .iter()
            .all(|p| !p.is_empty() && p.bytes().all(|b| b.is_ascii_digit()));
    date || version
}

#[cfg(test)]
mod tests {
    use super::*;

    fn shown(text: &str) -> Option<String> {
        calculate(text).map(|c| c.display)
    }

    #[test]
    fn arithmetic_precedence_and_postfix_operators() {
        assert_eq!(shown("2+3*4"), Some("14".into()));
        assert_eq!(shown("(2+3)*4"), Some("20".into()));
        assert_eq!(shown("2^3^2"), Some("512".into()));
        assert_eq!(shown("-2^2"), Some("-4".into()));
        assert_eq!(shown("5!"), Some("120".into()));
        assert_eq!(shown("50%"), Some("0.5".into()));
        assert_eq!(shown("20% of 50"), Some("10".into()));
        assert_eq!(shown("10 % 3"), Some("1".into()));
        assert_eq!(shown("7 mod 4"), Some("3".into()));
        assert_eq!(shown("3 x 4"), Some("12".into()));
        assert_eq!(shown("0.1+0.2"), Some("0.3".into()));
        assert_eq!(shown("1,000 * 2"), Some("2000".into()));
        assert_eq!(shown("6 ÷ 3 × 2 − 1"), Some("3".into()));
        assert_eq!(shown("= 2 * 21 ="), Some("42".into()));
        assert_eq!(shown("2 * 21 =?"), Some("42".into()));
    }

    #[test]
    fn deep_nesting_is_refused_instead_of_overflowing_the_stack() {
        let deep = format!("{}1{}", "(".repeat(100_000), ")".repeat(100_000));
        assert_eq!(evaluate(&deep), None);
        assert_eq!(evaluate(&"-".repeat(100_000)), None);
        assert_eq!(evaluate(&format!("2{}", "^2".repeat(100_000))), None);
        assert_eq!(
            evaluate(&format!("{}1{}", "(".repeat(20), ")".repeat(20))),
            Some(1.0)
        );
    }

    #[test]
    fn functions_constants_and_implicit_multiplication() {
        assert_eq!(shown("sqrt(16)"), Some("4".into()));
        assert_eq!(shown("3 + 2pi"), Some("9.28318530718".into()));
        assert_eq!(shown("2pi"), None);
        assert_eq!(shown("log(100)"), Some("2".into()));
        assert_eq!(shown("log(8, 2)"), Some("3".into()));
        assert_eq!(shown("max(1, 9, 3) + min(4, 2)"), Some("11".into()));
        assert_eq!(shown("sin(90°)"), Some("1".into()));
        assert_eq!(shown("round(2.5) + round(-2.5)"), Some("1".into()));
        assert_eq!(shown("2^100"), Some("1.26765060023e+30".into()));
        assert_eq!(shown("1/3"), Some("0.333333333333".into()));
        assert_eq!(shown("2^-40"), None);
        assert_eq!(shown("1/2^40"), Some("9.09494701773e-13".into()));
    }

    #[test]
    fn unit_and_temperature_conversions() {
        assert_eq!(shown("5 km to mi"), Some("3.10685596 mi".into()));
        assert_eq!(shown("100 c to f"), Some("212 °F".into()));
        assert_eq!(shown("0 celsius in kelvin"), Some("273.15 K".into()));
        assert_eq!(shown("2 fl oz to ml"), Some("59.1470591 ml".into()));
        assert_eq!(shown("1 GiB to MB"), Some("1073.74182 MB".into()));
        assert_eq!(shown("5 in to cm"), Some("12.7 cm".into()));
        assert_eq!(shown("1.e2 m in km"), Some("0.1 km".into()));
        assert_eq!(shown("90 min as h"), Some("1.5 h".into()));
        assert_eq!(shown("5 kg to km"), None);
    }

    #[test]
    fn non_math_text_is_ignored() {
        for text in [
            "hello",
            "2026-11-25",
            "1.2.3",
            "",
            "=",
            "iphone 15",
            "x",
            "100",
            "github.com",
            "(",
            "2+",
            "1/0",
            "171!",
            "e",
        ] {
            assert_eq!(calculate(text), None, "{text}");
        }
        assert_eq!(evaluate("1/0"), None);
        assert_eq!(evaluate("(((("), None);
        assert_eq!(calculate(&"1+".repeat(150)), None);
    }

    #[test]
    fn number_formatting_matches_javascript() {
        assert_eq!(format_number(0.0, 12), "0");
        assert_eq!(format_number(1e21, 12), "1e+21");
        assert_eq!(format_number(1.5e-10, 12), "1.5e-10");
        assert_eq!(format_number(2.5e-7, 12), "2.5e-7");
        assert_eq!(format_number(123_456_789.0, 12), "123456789");
        assert_eq!(format_number(-0.000_001, 12), "-0.000001");
    }
}
