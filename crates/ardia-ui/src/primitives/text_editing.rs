use std::ops::Range;
use std::sync::Arc;

use gpui::{App, Global, Pixels, Point};
use parking_lot::Mutex;
use unicode_segmentation::UnicodeSegmentation;

use crate::host::NativeMenuItem;

pub const UNDO_LIMIT: usize = 200;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TextState {
    pub text: String,
    pub selection: Range<usize>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum EditKind {
    Typing,
    Deleting,
    Discrete,
}

#[derive(Clone, Debug, Default)]
pub struct UndoHistory {
    undo: Vec<TextState>,
    redo: Vec<TextState>,
    open_run: Option<EditKind>,
}

impl UndoHistory {
    pub fn record(&mut self, before: TextState, kind: EditKind) {
        let coalesce =
            kind != EditKind::Discrete && self.open_run == Some(kind) && !self.undo.is_empty();
        if !coalesce {
            self.undo.push(before);
            if self.undo.len() > UNDO_LIMIT {
                self.undo.remove(0);
            }
        }
        self.open_run = (kind != EditKind::Discrete).then_some(kind);
        self.redo.clear();
    }

    pub fn break_typing(&mut self) {
        self.open_run = None;
    }

    pub fn undo(&mut self, current: TextState) -> Option<TextState> {
        let previous = self.undo.pop()?;
        self.redo.push(current);
        self.open_run = None;
        Some(previous)
    }

    pub fn redo(&mut self, current: TextState) -> Option<TextState> {
        let next = self.redo.pop()?;
        self.undo.push(current);
        self.open_run = None;
        Some(next)
    }

    pub fn can_undo(&self) -> bool {
        !self.undo.is_empty()
    }

    pub fn can_redo(&self) -> bool {
        !self.redo.is_empty()
    }

    pub fn clear(&mut self) {
        self.undo.clear();
        self.redo.clear();
        self.open_run = None;
    }
}

const LINE_BREAKS: [char; 7] = [
    '\r', '\n', '\u{0B}', '\u{0C}', '\u{85}', '\u{2028}', '\u{2029}',
];

fn is_line_break(c: char) -> bool {
    LINE_BREAKS.contains(&c)
}

fn is_paste_space(c: char) -> bool {
    c.is_whitespace() || is_line_break(c)
}

pub fn fold_pasted_lines(text: &str) -> String {
    if text.is_empty() {
        return String::new();
    }
    let trimmed = text.trim_matches(is_paste_space);
    if trimmed.is_empty() {
        return " ".to_owned();
    }
    let mut words: Vec<&str> = Vec::new();
    let mut gaps: Vec<(&str, bool)> = Vec::new();
    let mut rest = trimmed;
    while !rest.is_empty() {
        let word_end = rest.find(is_paste_space).unwrap_or(rest.len());
        words.push(&rest[..word_end]);
        rest = &rest[word_end..];
        if rest.is_empty() {
            break;
        }
        let gap_end = rest
            .find(|c: char| !is_paste_space(c))
            .unwrap_or(rest.len());
        let gap = &rest[..gap_end];
        gaps.push((gap, gap.chars().any(is_line_break)));
        rest = &rest[gap_end..];
    }
    let spaced = gaps.iter().any(|(_, breaks)| !breaks);
    let fill = if spaced { " " } else { "" };
    let mut joined = String::with_capacity(trimmed.len());
    for (index, word) in words.iter().enumerate() {
        joined.push_str(word);
        if let Some((gap, breaks)) = gaps.get(index) {
            joined.push_str(if *breaks { fill } else { gap });
        }
    }
    joined
}

pub fn transpose_at(text: &str, caret: usize) -> Option<(Range<usize>, String, usize)> {
    let bounds: Vec<usize> = text
        .grapheme_indices(true)
        .map(|(index, _)| index)
        .chain([text.len()])
        .collect();
    if bounds.len() < 3 {
        return None;
    }
    let at = bounds.iter().position(|&index| index >= caret)?;
    let middle = if bounds[at] == text.len() {
        bounds.len() - 2
    } else {
        at.max(1)
    };
    let start = bounds[middle - 1];
    let split = bounds[middle];
    let end = bounds[middle + 1];
    let swapped = format!("{}{}", &text[split..end], &text[start..split]);
    Some((start..end, swapped, end))
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CaseChange {
    Upper,
    Lower,
    Capitalize,
}

pub fn change_case(text: &str, change: CaseChange) -> String {
    match change {
        CaseChange::Upper => text.to_uppercase(),
        CaseChange::Lower => text.to_lowercase(),
        CaseChange::Capitalize => text
            .split_word_bounds()
            .map(|word| {
                let mut chars = word.chars();
                match chars.next() {
                    Some(first) if first.is_alphanumeric() => {
                        first.to_uppercase().collect::<String>() + &chars.as_str().to_lowercase()
                    }
                    _ => word.to_owned(),
                }
            })
            .collect(),
    }
}

pub fn word_range_at(text: &str, offset: usize) -> Range<usize> {
    let mut fallback = offset..offset;
    for (index, piece) in text.split_word_bound_indices() {
        let range = index..index + piece.len();
        let wordy = piece.chars().any(char::is_alphanumeric);
        if (range.contains(&offset) || range.end == offset) && wordy {
            return range;
        }
        if range.start >= offset && wordy {
            return range;
        }
        if range.contains(&offset) {
            fallback = range;
        }
    }
    fallback
}

pub fn smart_delete_range(text: &str, range: Range<usize>) -> Range<usize> {
    let before = text[..range.start].chars().next_back();
    let after = text[range.end..].chars().next();
    match (before, after) {
        (Some(' '), Some(' ')) => range.start..range.end + 1,
        (Some(' '), None) => range.start - 1..range.end,
        (None, Some(' ')) => range.start..range.end + 1,
        (Some(' '), Some(c)) if c.is_ascii_punctuation() => range.start - 1..range.end,
        _ => range,
    }
}

pub fn smart_insert(text: &str, range: &Range<usize>, insert: &str) -> String {
    let before = text[..range.start].chars().next_back();
    let after = text[range.end..].chars().next();
    let lead = before.is_some_and(|c| !c.is_whitespace())
        && insert.chars().next().is_some_and(|c| !c.is_whitespace());
    let trail = after.is_some_and(|c| !c.is_whitespace() && !c.is_ascii_punctuation())
        && insert
            .chars()
            .next_back()
            .is_some_and(|c| !c.is_whitespace());
    let mut out = String::with_capacity(insert.len() + 2);
    if lead {
        out.push(' ');
    }
    out.push_str(insert);
    if trail {
        out.push(' ');
    }
    out
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Substitutions {
    pub quotes: bool,
    pub dashes: bool,
    pub replacement: bool,
    pub smart_insert: bool,
    pub links: bool,
    pub data: bool,
}

impl Default for Substitutions {
    fn default() -> Self {
        Substitutions {
            quotes: false,
            dashes: false,
            replacement: false,
            smart_insert: true,
            links: false,
            data: false,
        }
    }
}

fn opens_quote(before: Option<char>) -> bool {
    match before {
        None => true,
        Some(c) => c.is_whitespace() || "([{<\u{201C}\u{2018}-\u{2013}\u{2014}".contains(c),
    }
}

pub fn smart_quote(typed: &str, before: Option<char>) -> Option<&'static str> {
    let open = opens_quote(before);
    match typed {
        "\"" => Some(if open { "\u{201C}" } else { "\u{201D}" }),
        "'" => Some(if open { "\u{2018}" } else { "\u{2019}" }),
        _ => None,
    }
}

pub fn smart_quotes_in(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut before = None;
    for c in text.chars() {
        let typed = c.to_string();
        match smart_quote(&typed, before) {
            Some(quote) => out.push_str(quote),
            None => out.push(c),
        }
        before = Some(c);
    }
    out
}

pub fn smart_dashes_in(text: &str) -> String {
    text.replace("--", "\u{2014}")
}

pub fn ends_word(typed: &str) -> bool {
    let mut chars = typed.chars();
    matches!(
        (chars.next(), chars.next()),
        (Some(c), None) if c.is_whitespace() || (c.is_ascii_punctuation() && c != '\'' && c != '-')
    )
}

pub fn word_before(text: &str, caret: usize) -> Option<Range<usize>> {
    let head = text.get(..caret)?;
    let start = head
        .char_indices()
        .rev()
        .take_while(|(_, c)| !c.is_whitespace())
        .last()
        .map(|(index, _)| index)?;
    (start < caret).then_some(start..caret)
}

pub fn replace_words(text: &str, replacements: &[(String, String)]) -> String {
    if replacements.is_empty() {
        return text.to_owned();
    }
    text.split_word_bounds()
        .map(|piece| {
            replacements
                .iter()
                .find(|(from, _)| from == piece)
                .map_or_else(|| piece.to_owned(), |(_, to)| to.clone())
        })
        .collect()
}

#[derive(Default)]
pub struct KillBuffer {
    text: String,
    appending: bool,
}

impl Global for KillBuffer {}

impl KillBuffer {
    pub fn kill(text: &str, cx: &mut App) {
        let buffer = cx.default_global::<KillBuffer>();
        if buffer.appending {
            buffer.text.push_str(text);
        } else {
            buffer.text = text.to_owned();
        }
        buffer.appending = true;
    }

    pub fn end_run(cx: &mut App) {
        if let Some(buffer) = cx.try_global::<KillBuffer>()
            && buffer.appending
        {
            cx.default_global::<KillBuffer>().appending = false;
        }
    }

    pub fn yank(cx: &mut App) -> Option<String> {
        let buffer = cx.default_global::<KillBuffer>();
        buffer.appending = false;
        (!buffer.text.is_empty()).then(|| buffer.text.clone())
    }
}

#[derive(Default)]
pub struct SmartPasteMemory {
    text: Option<String>,
}

impl Global for SmartPasteMemory {}

impl SmartPasteMemory {
    pub fn remember(text: Option<String>, cx: &mut App) {
        cx.default_global::<SmartPasteMemory>().text = text;
    }

    pub fn was_word(text: &str, cx: &App) -> bool {
        cx.try_global::<SmartPasteMemory>()
            .and_then(|memory| memory.text.as_deref())
            == Some(text)
    }
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct FieldEditState {
    pub owner: u64,
    pub window: u64,
    pub can_undo: bool,
    pub can_redo: bool,
    pub has_selection: bool,
    pub has_text: bool,
    pub secure: bool,
    pub checks_spelling: bool,
    pub substitutions: Substitutions,
    pub selected_text: String,
    pub text: String,
}

static FOCUSED_FIELD: Mutex<Option<FieldEditState>> = Mutex::new(None);

pub fn publish_focused_field(state: Option<FieldEditState>) {
    *FOCUSED_FIELD.lock() = state;
}

pub fn focused_field_owner() -> Option<u64> {
    FOCUSED_FIELD.lock().as_ref().map(|state| state.owner)
}

pub fn withdraw_focused_field(owner: u64) {
    let mut focused = FOCUSED_FIELD.lock();
    if focused.as_ref().is_some_and(|state| state.owner == owner) {
        *focused = None;
    }
}

pub fn focused_field() -> Option<FieldEditState> {
    FOCUSED_FIELD.lock().clone()
}

#[derive(Clone, Debug, PartialEq)]
pub struct LookUp {
    pub text: String,
    pub baseline_origin: Point<Pixels>,
    pub font_size: f32,
}

pub trait TextFieldServices: Send + Sync {
    fn show_menu(
        &self,
        items: Vec<NativeMenuItem>,
    ) -> Option<futures::channel::oneshot::Receiver<Option<String>>>;
    fn can_paste(&self) -> bool;
    fn misspelled_ranges(&self, text: &str) -> Vec<Range<usize>>;
    fn guesses(&self, text: &str, word: Range<usize>) -> Vec<String>;
    fn ignore_word(&self, word: &str);
    fn learn_word(&self, word: &str);
    fn look_up(&self, request: LookUp);
    fn search_web(&self, text: &str);
    fn speak(&self, text: &str);
    fn stop_speaking(&self);
    fn is_speaking(&self) -> bool;
    fn set_secure_input(&self, on: bool);
    fn substitution_defaults(&self) -> Substitutions {
        Substitutions::default()
    }
    fn text_replacements(&self) -> Vec<(String, String)> {
        Vec::new()
    }
    fn show_spelling_panel(&self) {}
    fn update_spelling_panel(&self, word: &str) {
        let _ = word;
    }
    fn show_substitutions_panel(&self) {}
    fn share(&self, text: &str, anchor: gpui::Bounds<Pixels>) {
        let _ = (text, anchor);
    }
}

#[derive(Clone)]
pub struct TextServices(pub Arc<dyn TextFieldServices>);

impl Global for TextServices {}

impl TextServices {
    pub fn install(services: Arc<dyn TextFieldServices>, cx: &mut App) {
        cx.set_global(TextServices(services));
    }

    pub fn get(cx: &App) -> Option<Arc<dyn TextFieldServices>> {
        cx.try_global::<TextServices>()
            .map(|services| services.0.clone())
    }
}

pub struct SecureInputClaim {
    services: Arc<dyn TextFieldServices>,
}

impl SecureInputClaim {
    pub fn claim(cx: &App) -> Option<Self> {
        let services = TextServices::get(cx)?;
        services.set_secure_input(true);
        Some(SecureInputClaim { services })
    }
}

impl Drop for SecureInputClaim {
    fn drop(&mut self) {
        self.services.set_secure_input(false);
    }
}

pub mod menu_ids {
    pub const GUESS_PREFIX: &str = "spelling.guess:";
    pub const IGNORE_SPELLING: &str = "spelling.ignore";
    pub const LEARN_SPELLING: &str = "spelling.learn";
    pub const LOOK_UP: &str = "lookUp";
    pub const SEARCH_WEB: &str = "searchWithGoogle";
    pub const CUT: &str = "cut";
    pub const COPY: &str = "copy";
    pub const PASTE: &str = "paste";
    pub const PASTE_AND_MATCH_STYLE: &str = "pasteAndMatchStyle";
    pub const DELETE: &str = "delete";
    pub const SELECT_ALL: &str = "selectAll";
    pub const CHECK_DOCUMENT: &str = "spelling.checkNow";
    pub const CHECK_WHILE_TYPING: &str = "spelling.whileTyping";
    pub const UPPERCASE: &str = "transform.upper";
    pub const LOWERCASE: &str = "transform.lower";
    pub const CAPITALIZE: &str = "transform.capitalize";
    pub const START_SPEAKING: &str = "speech.start";
    pub const STOP_SPEAKING: &str = "speech.stop";
    pub const SHARE: &str = "share";
    pub const SHOW_SPELLING_PANEL: &str = "spelling.showPanel";
    pub const REPLACE_QUOTES: &str = "substitutions.replaceQuotes";
    pub const REPLACE_DASHES: &str = "substitutions.replaceDashes";
    pub const REPLACE_TEXT: &str = "substitutions.replaceText";
    pub const SHOW_SUBSTITUTIONS: &str = "substitutions.showPanel";
    pub const SMART_INSERT: &str = "substitutions.smartInsert";
    pub const SMART_QUOTES: &str = "substitutions.quotes";
    pub const SMART_DASHES: &str = "substitutions.dashes";
    pub const SMART_LINKS: &str = "substitutions.links";
    pub const DATA_DETECTORS: &str = "substitutions.data";
    pub const TEXT_REPLACEMENT: &str = "substitutions.replacement";
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct TextMenuContext {
    pub secure: bool,
    pub has_selection: bool,
    pub has_text: bool,
    pub can_paste: bool,
    pub editable: bool,
    pub word: Option<String>,
    pub guesses: Vec<String>,
    pub misspelled: bool,
    pub checks_while_typing: bool,
    pub speaking: bool,
    pub substitutions: Substitutions,
}

fn quoted(word: &str) -> String {
    let short: String = word.chars().take(24).collect();
    let ellipsis = if short.len() < word.len() {
        "\u{2026}"
    } else {
        ""
    };
    format!("\u{201C}{short}{ellipsis}\u{201D}")
}

pub fn text_menu_items(context: &TextMenuContext) -> Vec<NativeMenuItem> {
    use menu_ids::*;
    if context.secure {
        return vec![
            NativeMenuItem::new(CUT, "Cut", "").enabled(false),
            NativeMenuItem::new(COPY, "Copy", "").enabled(false),
            NativeMenuItem::new(PASTE, "Paste", "").enabled(context.editable && context.can_paste),
            NativeMenuItem::new(DELETE, "Delete", "")
                .enabled(context.editable && context.has_selection),
            NativeMenuItem::new(SELECT_ALL, "Select All", "").enabled(context.has_text),
        ];
    }
    let mut items = Vec::new();
    if context.misspelled {
        if context.guesses.is_empty() {
            items.push(
                NativeMenuItem::new("spelling.noGuesses", "No Guesses Found", "").enabled(false),
            );
        }
        for (index, guess) in context.guesses.iter().enumerate() {
            items.push(
                NativeMenuItem::new(&format!("{GUESS_PREFIX}{index}"), guess.clone(), "")
                    .enabled(context.editable),
            );
        }
        items.push(NativeMenuItem::separator());
        items.push(NativeMenuItem::new(IGNORE_SPELLING, "Ignore Spelling", ""));
        items.push(NativeMenuItem::new(LEARN_SPELLING, "Learn Spelling", ""));
        items.push(NativeMenuItem::separator());
    }
    if let Some(word) = context.word.as_deref().filter(|w| !w.trim().is_empty()) {
        items.push(NativeMenuItem::new(
            LOOK_UP,
            format!("Look Up {}", quoted(word)),
            "",
        ));
        items.push(NativeMenuItem::separator());
        items.push(NativeMenuItem::new(SEARCH_WEB, "Search With Google", ""));
        items.push(NativeMenuItem::separator());
    }
    items.extend([
        NativeMenuItem::new(CUT, "Cut", "").enabled(context.editable && context.has_selection),
        NativeMenuItem::new(COPY, "Copy", "").enabled(context.has_selection),
        NativeMenuItem::new(PASTE, "Paste", "").enabled(context.editable && context.can_paste),
        NativeMenuItem::new(PASTE_AND_MATCH_STYLE, "Paste and Match Style", "")
            .enabled(context.editable && context.can_paste),
        NativeMenuItem::separator(),
        NativeMenuItem::new(SHARE, "Share\u{2026}", "")
            .enabled(context.has_selection && !context.secure),
        NativeMenuItem::separator(),
        NativeMenuItem::new("spellingAndGrammar", "Spelling and Grammar", "").children(vec![
            NativeMenuItem::new(SHOW_SPELLING_PANEL, "Show Spelling and Grammar", ""),
            NativeMenuItem::new(CHECK_DOCUMENT, "Check Document Now", "").enabled(context.has_text),
            NativeMenuItem::separator(),
            NativeMenuItem::new(CHECK_WHILE_TYPING, "Check Spelling While Typing", "")
                .checked(context.checks_while_typing),
        ]),
        NativeMenuItem::new("substitutions", "Substitutions", "").children({
            let subs = context.substitutions;
            let edits = context.editable && context.has_selection;
            vec![
                NativeMenuItem::new(REPLACE_QUOTES, "Replace Quotes", "").enabled(edits),
                NativeMenuItem::new(REPLACE_DASHES, "Replace Dashes", "").enabled(edits),
                NativeMenuItem::new(REPLACE_TEXT, "Replace Text", "").enabled(edits),
                NativeMenuItem::separator(),
                NativeMenuItem::new(SHOW_SUBSTITUTIONS, "Show Substitutions", ""),
                NativeMenuItem::separator(),
                NativeMenuItem::new(SMART_INSERT, "Smart Copy/Paste", "")
                    .checked(subs.smart_insert),
                NativeMenuItem::new(SMART_QUOTES, "Smart Quotes", "").checked(subs.quotes),
                NativeMenuItem::new(SMART_DASHES, "Smart Dashes", "").checked(subs.dashes),
                NativeMenuItem::new(SMART_LINKS, "Smart Links", "").checked(subs.links),
                NativeMenuItem::new(DATA_DETECTORS, "Data Detectors", "").checked(subs.data),
                NativeMenuItem::new(TEXT_REPLACEMENT, "Text Replacement", "")
                    .checked(subs.replacement),
            ]
        }),
        NativeMenuItem::new("transformations", "Transformations", "").children(vec![
            NativeMenuItem::new(UPPERCASE, "Make Upper Case", "")
                .enabled(context.editable && context.has_text),
            NativeMenuItem::new(LOWERCASE, "Make Lower Case", "")
                .enabled(context.editable && context.has_text),
            NativeMenuItem::new(CAPITALIZE, "Capitalize", "")
                .enabled(context.editable && context.has_text),
        ]),
        NativeMenuItem::new("speech", "Speech", "").children(vec![
            NativeMenuItem::new(START_SPEAKING, "Start Speaking", "").enabled(context.has_text),
            NativeMenuItem::new(STOP_SPEAKING, "Stop Speaking", "").enabled(context.speaking),
        ]),
    ]);
    items
}

#[cfg(test)]
mod tests {
    use super::*;

    fn state(text: &str, caret: usize) -> TextState {
        TextState {
            text: text.to_owned(),
            selection: caret..caret,
        }
    }

    #[test]
    fn typing_coalesces_until_the_run_breaks() {
        let mut history = UndoHistory::default();
        history.record(state("", 0), EditKind::Typing);
        history.record(state("a", 1), EditKind::Typing);
        history.record(state("ab", 2), EditKind::Typing);
        history.break_typing();
        history.record(state("abc", 3), EditKind::Typing);
        assert_eq!(history.undo(state("abcd", 4)), Some(state("abc", 3)));
        assert_eq!(history.undo(state("abc", 3)), Some(state("", 0)));
        assert_eq!(history.undo(state("", 0)), None);
        assert_eq!(history.redo(state("", 0)), Some(state("abc", 3)));
        assert_eq!(history.redo(state("abc", 3)), Some(state("abcd", 4)));
        assert!(!history.can_redo());
    }

    #[test]
    fn switching_between_typing_and_deleting_starts_a_new_step() {
        let mut history = UndoHistory::default();
        history.record(state("", 0), EditKind::Typing);
        history.record(state("a", 1), EditKind::Typing);
        history.record(state("ab", 2), EditKind::Deleting);
        history.record(state("a", 1), EditKind::Deleting);
        assert_eq!(history.undo(state("", 0)), Some(state("ab", 2)));
        assert_eq!(history.undo(state("ab", 2)), Some(state("", 0)));
    }

    #[test]
    fn a_discrete_edit_is_its_own_step_and_drops_redo() {
        let mut history = UndoHistory::default();
        history.record(state("", 0), EditKind::Typing);
        history.record(state("hi", 2), EditKind::Discrete);
        history.record(state("hi there", 8), EditKind::Typing);
        assert_eq!(
            history.undo(state("hi there!", 9)),
            Some(state("hi there", 8))
        );
        history.record(state("hi there", 8), EditKind::Discrete);
        assert!(!history.can_redo());
        assert_eq!(history.undo(state("x", 1)), Some(state("hi there", 8)));
        assert_eq!(history.undo(state("hi there", 8)), Some(state("hi", 2)));
        assert_eq!(history.undo(state("hi", 2)), Some(state("", 0)));
    }

    #[test]
    fn the_history_is_bounded() {
        let mut history = UndoHistory::default();
        for step in 0..UNDO_LIMIT + 20 {
            history.record(state(&step.to_string(), 0), EditKind::Discrete);
        }
        let mut count = 0;
        while history.undo(state("", 0)).is_some() {
            count += 1;
        }
        assert_eq!(count, UNDO_LIMIT);
    }

    #[test]
    fn pasted_line_breaks_fold_like_the_omnibox() {
        assert_eq!(fold_pasted_lines(""), "");
        assert_eq!(fold_pasted_lines(" \n\t "), " ");
        assert_eq!(
            fold_pasted_lines("  https://exa\nmple.com/path\r\n?q=1  "),
            "https://example.com/path?q=1"
        );
        assert_eq!(
            fold_pasted_lines("the quick\nbrown fox\n\njumps"),
            "the quick brown fox jumps"
        );
        assert_eq!(fold_pasted_lines("a\u{2028}b c"), "a b c");
        assert_eq!(fold_pasted_lines("one  two"), "one  two");
    }

    #[test]
    fn transpose_swaps_around_the_caret_and_at_the_end() {
        assert_eq!(transpose_at("abcd", 2), Some((1..3, "cb".to_owned(), 3)));
        assert_eq!(transpose_at("abcd", 4), Some((2..4, "dc".to_owned(), 4)));
        assert_eq!(transpose_at("abcd", 0), Some((0..2, "ba".to_owned(), 2)));
        assert_eq!(transpose_at("a", 1), None);
        assert_eq!(
            transpose_at("a\u{1F44D}\u{1F3FD}b", 1),
            Some((0..9, "\u{1F44D}\u{1F3FD}a".to_owned(), 9))
        );
    }

    #[test]
    fn case_changes_follow_appkit_transformations() {
        assert_eq!(change_case("hello World", CaseChange::Upper), "HELLO WORLD");
        assert_eq!(change_case("HeLLo", CaseChange::Lower), "hello");
        assert_eq!(
            change_case("hello wORLD, it's me", CaseChange::Capitalize),
            "Hello World, It's Me"
        );
    }

    #[test]
    fn the_word_under_the_caret_or_after_it_is_found() {
        assert_eq!(word_range_at("open the door", 6), 5..8);
        assert_eq!(word_range_at("open the door", 4), 0..4);
        assert_eq!(word_range_at("open  door", 5), 6..10);
        assert_eq!(word_range_at("", 0), 0..0);
    }

    #[test]
    fn smart_delete_and_insert_keep_single_spaces() {
        assert_eq!(smart_delete_range("one two three", 4..7), 4..8);
        assert_eq!(smart_delete_range("one two", 4..7), 3..7);
        assert_eq!(smart_delete_range("one two.", 4..7), 3..7);
        assert_eq!(smart_delete_range("onetwo", 3..6), 3..6);
        assert_eq!(smart_insert("one three", &(4..4), "two"), "two ");
        assert_eq!(smart_insert("onethree", &(3..3), "two"), " two ");
        assert_eq!(smart_insert("one ", &(4..4), "two"), "two");
        assert_eq!(smart_insert("one.", &(3..3), "two"), " two");
    }

    #[test]
    fn the_text_menu_matches_the_field_editor_menu() {
        let context = TextMenuContext {
            has_selection: true,
            has_text: true,
            can_paste: true,
            editable: true,
            word: Some("wrold".into()),
            guesses: vec!["world".into(), "wold".into()],
            misspelled: true,
            ..TextMenuContext::default()
        };
        let titles: Vec<String> = text_menu_items(&context)
            .iter()
            .map(|item| {
                if item.separator {
                    "-".to_owned()
                } else {
                    item.title.clone()
                }
            })
            .collect();
        assert_eq!(
            titles,
            [
                "world",
                "wold",
                "-",
                "Ignore Spelling",
                "Learn Spelling",
                "-",
                "Look Up \u{201C}wrold\u{201D}",
                "-",
                "Search With Google",
                "-",
                "Cut",
                "Copy",
                "Paste",
                "Paste and Match Style",
                "-",
                "Share\u{2026}",
                "-",
                "Spelling and Grammar",
                "Substitutions",
                "Transformations",
                "Speech",
            ]
        );
    }

    #[test]
    fn smart_quotes_open_after_space_and_close_after_letters() {
        assert_eq!(smart_quote("\"", None), Some("\u{201C}"));
        assert_eq!(smart_quote("\"", Some('a')), Some("\u{201D}"));
        assert_eq!(smart_quote("'", Some('n')), Some("\u{2019}"));
        assert_eq!(smart_quote("'", Some(' ')), Some("\u{2018}"));
        assert_eq!(smart_quote("x", None), None);
        assert_eq!(
            smart_quotes_in("say \"don't\""),
            "say \u{201C}don\u{2019}t\u{201D}"
        );
        assert_eq!(smart_dashes_in("a--b"), "a\u{2014}b");
    }

    #[test]
    fn text_replacement_swaps_whole_words() {
        let table = vec![("omw".to_owned(), "On my way!".to_owned())];
        assert_eq!(
            replace_words("omw now, omwx", &table),
            "On my way! now, omwx"
        );
        assert_eq!(word_before("go omw", 6), Some(3..6));
        assert_eq!(word_before("go ", 3), None);
        assert!(ends_word(" "));
        assert!(ends_word("."));
        assert!(!ends_word("a"));
        assert!(!ends_word("'"));
    }

    #[test]
    fn a_secure_field_menu_never_offers_cut_or_copy() {
        let items = text_menu_items(&TextMenuContext {
            secure: true,
            has_selection: true,
            has_text: true,
            can_paste: true,
            editable: true,
            ..TextMenuContext::default()
        });
        let titles: Vec<(&str, bool)> = items
            .iter()
            .map(|item| (item.title.as_str(), item.enabled))
            .collect();
        assert_eq!(
            titles,
            [
                ("Cut", false),
                ("Copy", false),
                ("Paste", true),
                ("Delete", true),
                ("Select All", true)
            ]
        );
    }
}
