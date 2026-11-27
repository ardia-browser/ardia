use std::ops::Range;
use std::time::{Duration, Instant};

use crate::look::{Look, Palette};
use crate::primitives::controls::multiline_field_box;
use crate::primitives::text_editing::{
    self as editing, CaseChange, EditKind, FieldEditState, KillBuffer, LookUp, SecureInputClaim,
    SmartPasteMemory, Substitutions, TextMenuContext, TextServices, TextState, UndoHistory,
    menu_ids,
};
use crate::primitives::tokens::{line_height, type_size};
use crate::scale::px;
use ardia_theme::FieldSurface;
use gpui::{
    A11ySubtreeBuilder, App, Bounds, ClipboardItem, Context, CursorStyle, Element, ElementId,
    ElementInputHandler, Entity, EntityInputHandler, EventEmitter, ExternalItems, FocusHandle,
    Focusable, FontWeight, GlobalElementId, Hsla, InspectorElementId, IntoElement, KeyBinding,
    LayoutId, MouseButton, MouseDownEvent, MouseMoveEvent, MouseUpEvent, PaintQuad, Pixels, Point,
    Render, Role, ScrollEvent, ShapedLine, SharedString, Style, TextAlign, TextRun, UTF16Selection,
    UnderlineStyle, Window, WrappedLine, accesskit, actions, div, fill, hsla, point, prelude::*,
    relative, size,
};
use unicode_segmentation::UnicodeSegmentation;

actions!(
    ardia_input,
    [
        Backspace,
        Delete,
        DeleteWordLeft,
        DeleteToStart,
        Left,
        Right,
        WordLeft,
        WordRight,
        SelectLeft,
        SelectRight,
        SelectWordLeft,
        SelectWordRight,
        Home,
        End,
        SelectHome,
        SelectEnd,
        SelectAll,
        Copy,
        Cut,
        Paste,
        Submit,
        SubmitAlternate,
        SubmitShift,
        Cancel,
        MoveUp,
        MoveDown,
        AcceptCompletion,
        ShowCharacterPalette,
        SelectUp,
        SelectDown,
        DocumentStart,
        DocumentEnd,
        SelectDocumentStart,
        SelectDocumentEnd,
        Undo,
        Redo,
        PasteAndMatchStyle,
        DeleteWordRight,
        DeleteToEnd,
        KillToEnd,
        Yank,
        Transpose,
        OpenLine,
        PreviousLine,
        NextLine,
        CheckSpelling,
        ToggleSpellChecking,
        UppercaseWord,
        LowercaseWord,
        CapitalizeWord,
        StartSpeaking,
        StopSpeaking,
        DeleteSelection,
        ScrollToStart,
        ScrollToEnd,
        SelectToStart,
        SelectToEnd,
        ShowSpellingPanel,
        RefreshSpelling,
        ShowSubstitutions,
        ToggleSmartInsert,
        ToggleSmartQuotes,
        ToggleSmartDashes,
        ToggleSmartLinks,
        ToggleDataDetectors,
        ToggleTextReplacement,
        ReplaceQuotes,
        ReplaceDashes,
        ReplaceText,
        ShareSelection,
    ]
);

pub const CONTEXT: &str = "TextInput";

#[derive(Clone, Debug, PartialEq, Eq, gpui::Action)]
#[action(namespace = ardia_input, no_json)]
pub struct ReplaceSelection {
    pub text: String,
}

pub const FIELD_SELECTORS: &[&str] = &[
    "undo:",
    "redo:",
    "cut:",
    "copy:",
    "paste:",
    "pasteAsPlainText:",
    "delete:",
    "selectAll:",
    "checkSpelling:",
    "toggleContinuousSpellChecking:",
    "uppercaseWord:",
    "lowercaseWord:",
    "capitalizeWord:",
    "startSpeaking:",
    "stopSpeaking:",
    "showGuessPanel:",
    "changeSpelling:",
    "ignoreSpelling:",
    "orderFrontSubstitutionsPanel:",
    "toggleSmartInsertDelete:",
    "toggleAutomaticQuoteSubstitution:",
    "toggleAutomaticDashSubstitution:",
    "toggleAutomaticLinkDetection:",
    "toggleAutomaticDataDetection:",
    "toggleAutomaticTextReplacement:",
    "replaceQuotesInSelection:",
    "replaceDashesInSelection:",
    "replaceTextInSelection:",
];

pub fn action_for_selector(selector: &str) -> Option<Box<dyn gpui::Action>> {
    Some(match selector {
        "undo:" => Box::new(Undo),
        "redo:" => Box::new(Redo),
        "cut:" => Box::new(Cut),
        "copy:" => Box::new(Copy),
        "paste:" => Box::new(Paste),
        "pasteAsPlainText:" => Box::new(PasteAndMatchStyle),
        "delete:" => Box::new(DeleteSelection),
        "selectAll:" => Box::new(SelectAll),
        "checkSpelling:" => Box::new(CheckSpelling),
        "toggleContinuousSpellChecking:" => Box::new(ToggleSpellChecking),
        "uppercaseWord:" => Box::new(UppercaseWord),
        "lowercaseWord:" => Box::new(LowercaseWord),
        "capitalizeWord:" => Box::new(CapitalizeWord),
        "startSpeaking:" => Box::new(StartSpeaking),
        "stopSpeaking:" => Box::new(StopSpeaking),
        "showGuessPanel:" => Box::new(ShowSpellingPanel),
        "ignoreSpelling:" | "changeSpelling:" => Box::new(RefreshSpelling),
        "orderFrontSubstitutionsPanel:" => Box::new(ShowSubstitutions),
        "toggleSmartInsertDelete:" => Box::new(ToggleSmartInsert),
        "toggleAutomaticQuoteSubstitution:" => Box::new(ToggleSmartQuotes),
        "toggleAutomaticDashSubstitution:" => Box::new(ToggleSmartDashes),
        "toggleAutomaticLinkDetection:" => Box::new(ToggleSmartLinks),
        "toggleAutomaticDataDetection:" => Box::new(ToggleDataDetectors),
        "toggleAutomaticTextReplacement:" => Box::new(ToggleTextReplacement),
        "replaceQuotesInSelection:" => Box::new(ReplaceQuotes),
        "replaceDashesInSelection:" => Box::new(ReplaceDashes),
        "replaceTextInSelection:" => Box::new(ReplaceText),
        _ => return None,
    })
}

pub fn selector_checked(selector: &str, field: &FieldEditState) -> Option<bool> {
    let subs = field.substitutions;
    Some(match selector {
        "toggleContinuousSpellChecking:" => field.checks_spelling,
        "toggleSmartInsertDelete:" => subs.smart_insert,
        "toggleAutomaticQuoteSubstitution:" => subs.quotes,
        "toggleAutomaticDashSubstitution:" => subs.dashes,
        "toggleAutomaticLinkDetection:" => subs.links,
        "toggleAutomaticDataDetection:" => subs.data,
        "toggleAutomaticTextReplacement:" => subs.replacement,
        _ => return None,
    })
}

pub fn selector_enabled(
    selector: &str,
    field: &FieldEditState,
    can_paste: bool,
    speaking: bool,
) -> bool {
    let readable = !field.secure;
    match selector {
        "undo:" => field.can_undo,
        "redo:" => field.can_redo,
        "cut:" | "copy:" => readable && field.has_selection,
        "paste:" | "pasteAsPlainText:" => can_paste,
        "delete:" => field.has_selection,
        "selectAll:" => field.has_text,
        "checkSpelling:" | "uppercaseWord:" | "lowercaseWord:" | "capitalizeWord:"
        | "startSpeaking:" => readable && field.has_text,
        "toggleContinuousSpellChecking:" | "showGuessPanel:" | "orderFrontSubstitutionsPanel:" => {
            readable
        }
        "changeSpelling:" | "ignoreSpelling:" => readable && field.has_text,
        "toggleSmartInsertDelete:"
        | "toggleAutomaticQuoteSubstitution:"
        | "toggleAutomaticDashSubstitution:"
        | "toggleAutomaticLinkDetection:"
        | "toggleAutomaticDataDetection:"
        | "toggleAutomaticTextReplacement:" => readable,
        "replaceQuotesInSelection:" | "replaceDashesInSelection:" | "replaceTextInSelection:" => {
            readable && field.has_selection
        }
        "stopSpeaking:" => speaking,
        _ => false,
    }
}

pub fn focus_input(input: &Entity<TextInput>, window: &mut Window, cx: &mut App) {
    let handle = input.read(cx).focus.clone();
    window.focus(&handle, cx);
}
const DOUBLE_CLICK: Duration = Duration::from_millis(450);

pub fn bindings() -> Vec<KeyBinding> {
    let context = Some(CONTEXT);
    let mut list = vec![
        KeyBinding::new("backspace", Backspace, context),
        KeyBinding::new("shift-backspace", Backspace, context),
        KeyBinding::new("delete", Delete, context),
        KeyBinding::new("left", Left, context),
        KeyBinding::new("right", Right, context),
        KeyBinding::new("shift-left", SelectLeft, context),
        KeyBinding::new("shift-right", SelectRight, context),
        KeyBinding::new("enter", Submit, context),
        KeyBinding::new("shift-enter", SubmitShift, context),
        KeyBinding::new("escape", Cancel, context),
        KeyBinding::new("up", MoveUp, context),
        KeyBinding::new("down", MoveDown, context),
        KeyBinding::new("tab", AcceptCompletion, context),
        KeyBinding::new("shift-up", SelectUp, context),
        KeyBinding::new("shift-down", SelectDown, context),
    ];
    if cfg!(target_os = "macos") {
        list.extend([
            KeyBinding::new("alt-backspace", DeleteWordLeft, context),
            KeyBinding::new("cmd-backspace", DeleteToStart, context),
            KeyBinding::new("alt-left", WordLeft, context),
            KeyBinding::new("alt-right", WordRight, context),
            KeyBinding::new("alt-shift-left", SelectWordLeft, context),
            KeyBinding::new("alt-shift-right", SelectWordRight, context),
            KeyBinding::new("cmd-left", Home, context),
            KeyBinding::new("cmd-right", End, context),
            KeyBinding::new("cmd-shift-left", SelectHome, context),
            KeyBinding::new("cmd-shift-right", SelectEnd, context),
            KeyBinding::new("cmd-a", SelectAll, context),
            KeyBinding::new("cmd-c", Copy, context),
            KeyBinding::new("cmd-x", Cut, context),
            KeyBinding::new("cmd-v", Paste, context),
            KeyBinding::new("cmd-enter", SubmitAlternate, context),
            KeyBinding::new("ctrl-cmd-space", ShowCharacterPalette, context),
            KeyBinding::new("ctrl-a", Home, context),
            KeyBinding::new("ctrl-e", End, context),
            KeyBinding::new("cmd-up", DocumentStart, context),
            KeyBinding::new("cmd-down", DocumentEnd, context),
            KeyBinding::new("cmd-shift-up", SelectDocumentStart, context),
            KeyBinding::new("cmd-shift-down", SelectDocumentEnd, context),
            KeyBinding::new("home", ScrollToStart, context),
            KeyBinding::new("end", ScrollToEnd, context),
            KeyBinding::new("shift-home", SelectToStart, context),
            KeyBinding::new("shift-end", SelectToEnd, context),
            KeyBinding::new("cmd-z", Undo, context),
            KeyBinding::new("cmd-shift-z", Redo, context),
            KeyBinding::new("cmd-shift-v", PasteAndMatchStyle, context),
            KeyBinding::new("cmd-alt-shift-v", PasteAndMatchStyle, context),
            KeyBinding::new("cmd-;", CheckSpelling, context),
            KeyBinding::new("alt-delete", DeleteWordRight, context),
            KeyBinding::new("cmd-delete", DeleteToEnd, context),
            KeyBinding::new("ctrl-b", Left, context),
            KeyBinding::new("ctrl-f", Right, context),
            KeyBinding::new("ctrl-shift-b", SelectLeft, context),
            KeyBinding::new("ctrl-shift-f", SelectRight, context),
            KeyBinding::new("ctrl-shift-a", SelectHome, context),
            KeyBinding::new("ctrl-shift-e", SelectEnd, context),
            KeyBinding::new("ctrl-d", Delete, context),
            KeyBinding::new("ctrl-h", Backspace, context),
            KeyBinding::new("ctrl-backspace", Backspace, context),
            KeyBinding::new("ctrl-k", KillToEnd, context),
            KeyBinding::new("ctrl-y", Yank, context),
            KeyBinding::new("ctrl-t", Transpose, context),
            KeyBinding::new("ctrl-o", OpenLine, context),
            KeyBinding::new("ctrl-p", PreviousLine, context),
            KeyBinding::new("ctrl-n", NextLine, context),
            KeyBinding::new("ctrl-v", NextLine, context),
            KeyBinding::new("ctrl-shift-p", SelectUp, context),
            KeyBinding::new("ctrl-shift-n", SelectDown, context),
        ]);
    } else {
        list.extend([
            KeyBinding::new("ctrl-backspace", DeleteWordLeft, context),
            KeyBinding::new("ctrl-left", WordLeft, context),
            KeyBinding::new("ctrl-right", WordRight, context),
            KeyBinding::new("ctrl-shift-left", SelectWordLeft, context),
            KeyBinding::new("ctrl-shift-right", SelectWordRight, context),
            KeyBinding::new("ctrl-a", SelectAll, context),
            KeyBinding::new("ctrl-c", Copy, context),
            KeyBinding::new("ctrl-x", Cut, context),
            KeyBinding::new("ctrl-v", Paste, context),
            KeyBinding::new("ctrl-enter", SubmitAlternate, context),
            KeyBinding::new("ctrl-home", DocumentStart, context),
            KeyBinding::new("ctrl-end", DocumentEnd, context),
            KeyBinding::new("ctrl-shift-home", SelectDocumentStart, context),
            KeyBinding::new("ctrl-shift-end", SelectDocumentEnd, context),
            KeyBinding::new("home", Home, context),
            KeyBinding::new("end", End, context),
            KeyBinding::new("shift-home", SelectHome, context),
            KeyBinding::new("shift-end", SelectEnd, context),
            KeyBinding::new("ctrl-z", Undo, context),
            KeyBinding::new("ctrl-shift-z", Redo, context),
            KeyBinding::new("ctrl-y", Redo, context),
            KeyBinding::new("ctrl-shift-v", PasteAndMatchStyle, context),
            KeyBinding::new("ctrl-delete", DeleteWordRight, context),
        ]);
    }
    list
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SubmitKind {
    Plain,
    Alternate,
    Shift,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum InputEvent {
    Changed { deleting: bool },
    Submit(SubmitKind),
    Cancel,
    Up,
    Down,
    Tab,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct InputStyle {
    pub text: Hsla,
    pub placeholder: Hsla,
    pub caret: Hsla,
    pub selection: Hsla,
    pub font_size: f32,
    pub weight: FontWeight,
}

impl Default for InputStyle {
    fn default() -> Self {
        InputStyle {
            text: hsla(0., 0., 1., 1.),
            placeholder: hsla(0., 0., 1., 0.53),
            caret: hsla(0., 0., 1., 1.),
            selection: hsla(0.6, 0.04, 0.5, 0.7),
            font_size: 13.0,
            weight: FontWeight::NORMAL,
        }
    }
}

pub struct TextInput {
    focus: FocusHandle,
    text: String,
    selection: Range<usize>,
    reversed: bool,
    marked: Option<Range<usize>>,
    completion: bool,
    placeholder: SharedString,
    style: InputStyle,
    layout: Option<ShapedLine>,
    bounds: Option<Bounds<Pixels>>,
    scroll: Pixels,
    dragging: bool,
    last_click: Option<(Instant, usize, u8)>,
    secure: bool,
    multiline: bool,
    multiline_line_height: f32,
    wrapped: Option<WrappedText>,
    scroll_y: Pixels,
    goal_x: Option<Pixels>,
    reveal_caret: bool,
    history: UndoHistory,
    word_granular: bool,
    folds_pasted_lines: bool,
    checks_spelling: bool,
    misspelled: Vec<Range<usize>>,
    spelled_text: Option<String>,
    secure_claim: Option<SecureInputClaim>,
    was_focused: bool,
    text_drag: Option<TextDrag>,
    drop_caret: Option<usize>,
    substitutions: Substitutions,
    free_scroll: bool,
}

#[derive(Clone, Debug, PartialEq)]
struct TextDrag {
    moved: Range<usize>,
    pressed_at: Point<Pixels>,
    click_index: usize,
    dragging: bool,
}

const TEXT_DRAG_SLOP: f32 = 3.0;

pub const MULTILINE_INSET_X: f32 = 1.0;

pub fn text_field_style(look: &Look) -> InputStyle {
    let p = &look.p;
    InputStyle {
        text: p.text,
        placeholder: p.text_tertiary,
        caret: crate::primitives::theme_bridge::hsla(look.theme.caret_color(FieldSurface::Field)),
        selection: p.selection,
        font_size: type_size::BODY,
        weight: FontWeight::NORMAL,
    }
}

pub fn multiline_text_field(input: &Entity<TextInput>, p: &Palette, invalid: bool) -> gpui::Div {
    multiline_field_box(p, invalid).child(input.clone())
}

pub const SECURE_BULLET: char = '\u{2022}';

pub fn secure_display(text: &str) -> String {
    text.graphemes(true).map(|_| SECURE_BULLET).collect()
}

pub fn secure_display_offset(text: &str, offset: usize) -> usize {
    text.grapheme_indices(true)
        .take_while(|(index, _)| *index < offset)
        .count()
        * SECURE_BULLET.len_utf8()
}

pub fn secure_text_offset(text: &str, shown: usize) -> usize {
    let graphemes = shown / SECURE_BULLET.len_utf8();
    text.grapheme_indices(true)
        .nth(graphemes)
        .map_or(text.len(), |(index, _)| index)
}

impl EventEmitter<InputEvent> for TextInput {}

impl Focusable for TextInput {
    fn focus_handle(&self, _: &App) -> FocusHandle {
        self.focus.clone()
    }
}

fn previous_boundary(text: &str, offset: usize) -> usize {
    text.grapheme_indices(true)
        .rev()
        .find_map(|(index, _)| (index < offset).then_some(index))
        .unwrap_or(0)
}

fn next_boundary(text: &str, offset: usize) -> usize {
    text.grapheme_indices(true)
        .find_map(|(index, _)| (index > offset).then_some(index))
        .unwrap_or(text.len())
}

fn is_word(piece: &str) -> bool {
    piece.chars().any(char::is_alphanumeric)
}

pub fn previous_word(text: &str, offset: usize) -> usize {
    let mut found = 0;
    for (index, piece) in text.split_word_bound_indices() {
        if index >= offset {
            break;
        }
        if is_word(piece) {
            found = index;
        }
    }
    found
}

pub fn next_word(text: &str, offset: usize) -> usize {
    text.split_word_bound_indices()
        .find_map(|(index, piece)| {
            let end = index + piece.len();
            (end > offset && is_word(piece)).then_some(end)
        })
        .unwrap_or(text.len())
}

fn word_at(text: &str, offset: usize) -> Range<usize> {
    text.split_word_bound_indices()
        .map(|(index, piece)| index..index + piece.len())
        .find(|range| range.contains(&offset) || range.end == offset)
        .unwrap_or(offset..offset)
}

fn clamp_to_boundary(text: &str, offset: usize) -> usize {
    let mut offset = offset.min(text.len());
    while offset > 0 && !text.is_char_boundary(offset) {
        offset -= 1;
    }
    offset
}

fn normalize_newlines(text: &str) -> String {
    text.replace("\r\n", "\n").replace('\r', "\n")
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct TextRow {
    pub start: usize,
    pub end: usize,
    pub ends_paragraph: bool,
    paragraph: usize,
    start_x: Pixels,
}

struct Paragraph {
    base: usize,
    first_row: usize,
    line: WrappedLine,
}

pub struct WrappedText {
    text: SharedString,
    paragraphs: Vec<Paragraph>,
    rows: Vec<TextRow>,
    line_height: Pixels,
}

impl WrappedText {
    pub fn new(
        text: SharedString,
        lines: impl IntoIterator<Item = WrappedLine>,
        line_height: Pixels,
    ) -> Self {
        let mut paragraphs = Vec::new();
        let mut rows: Vec<TextRow> = Vec::new();
        let mut base = 0;
        for line in lines {
            let layout = &line.unwrapped_layout;
            let breaks: Vec<usize> = line
                .wrap_boundaries()
                .iter()
                .filter_map(|boundary| {
                    layout
                        .runs
                        .get(boundary.run_ix)
                        .and_then(|run| run.glyphs.get(boundary.glyph_ix))
                        .map(|glyph| glyph.index)
                })
                .collect();
            let paragraph = paragraphs.len();
            let first_row = rows.len();
            let len = line.len();
            let mut start = 0;
            for end in breaks.into_iter().chain([len]) {
                let end = end.clamp(start, len);
                rows.push(TextRow {
                    start: base + start,
                    end: base + end,
                    ends_paragraph: false,
                    paragraph,
                    start_x: layout.x_for_index(start),
                });
                start = end;
            }
            if let Some(last) = rows.last_mut() {
                last.ends_paragraph = true;
            }
            paragraphs.push(Paragraph {
                base,
                first_row,
                line,
            });
            base += len + 1;
        }
        WrappedText {
            text,
            paragraphs,
            rows,
            line_height,
        }
    }

    pub fn rows(&self) -> &[TextRow] {
        &self.rows
    }

    pub fn line_height(&self) -> Pixels {
        self.line_height
    }

    pub fn height(&self) -> Pixels {
        self.line_height * self.rows.len().max(1) as f32
    }

    pub fn row_for_index(&self, index: usize) -> usize {
        self.rows
            .iter()
            .position(|row| {
                index >= row.start && (index < row.end || (index == row.end && row.ends_paragraph))
            })
            .unwrap_or(self.rows.len().saturating_sub(1))
    }

    fn x_in_row(&self, row: &TextRow, index: usize) -> Pixels {
        let Some(paragraph) = self.paragraphs.get(row.paragraph) else {
            return px(0.);
        };
        let local = index
            .clamp(row.start, row.end)
            .saturating_sub(paragraph.base);
        paragraph.line.unwrapped_layout.x_for_index(local) - row.start_x
    }

    pub fn position_for_index(&self, index: usize) -> Point<Pixels> {
        let row_ix = self.row_for_index(index);
        match self.rows.get(row_ix) {
            Some(row) => point(self.x_in_row(row, index), self.line_height * row_ix as f32),
            None => point(px(0.), px(0.)),
        }
    }

    pub fn row_caret_range(&self, row_ix: usize) -> Range<usize> {
        let Some(row) = self.rows.get(row_ix) else {
            return 0..0;
        };
        let last = if row.ends_paragraph || row.end == row.start {
            row.end
        } else {
            previous_boundary(&self.text, row.end).max(row.start)
        };
        row.start..last
    }

    pub fn index_in_row(&self, row_ix: usize, x: Pixels) -> usize {
        let Some(row) = self.rows.get(row_ix) else {
            return self.text.len();
        };
        let Some(paragraph) = self.paragraphs.get(row.paragraph) else {
            return row.start;
        };
        let local = paragraph
            .line
            .unwrapped_layout
            .closest_index_for_x(x.max(px(0.)) + row.start_x);
        let range = self.row_caret_range(row_ix);
        (paragraph.base + local).clamp(range.start, range.end)
    }

    pub fn index_for_position(&self, position: Point<Pixels>) -> usize {
        if self.rows.is_empty() {
            return 0;
        }
        let row_ix = if position.y <= px(0.) {
            0
        } else {
            ((position.y / self.line_height).floor() as usize).min(self.rows.len() - 1)
        };
        self.index_in_row(row_ix, position.x)
    }

    pub fn vertical_target(&self, from: usize, goal_x: Pixels, rows: isize) -> usize {
        let target = self.row_for_index(from) as isize + rows;
        if target < 0 {
            0
        } else if target as usize >= self.rows.len() {
            self.text.len()
        } else {
            self.index_in_row(target as usize, goal_x)
        }
    }

    pub fn selection_spans(
        &self,
        selection: &Range<usize>,
    ) -> Vec<(usize, Pixels, Option<Pixels>)> {
        if selection.is_empty() {
            return Vec::new();
        }
        let last_row = self.rows.len().saturating_sub(1);
        self.rows
            .iter()
            .enumerate()
            .filter_map(|(ix, row)| {
                let extent = if row.ends_paragraph && ix < last_row {
                    row.end + 1
                } else {
                    row.end
                };
                if selection.start >= extent || selection.end <= row.start {
                    return None;
                }
                let left = self.x_in_row(row, selection.start.max(row.start));
                let right = (selection.end <= row.end).then(|| self.x_in_row(row, selection.end));
                Some((ix, left, right))
            })
            .collect()
    }
}

pub fn clamp_scroll(scroll: Pixels, viewport: Pixels, content: Pixels) -> Pixels {
    scroll.min((content - viewport).max(px(0.))).max(px(0.))
}

pub fn reveal_scroll(
    scroll: Pixels,
    caret_top: Pixels,
    line_height: Pixels,
    viewport: Pixels,
    content: Pixels,
) -> Pixels {
    let mut scroll = scroll;
    if caret_top + line_height > scroll + viewport {
        scroll = caret_top + line_height - viewport;
    }
    if caret_top < scroll {
        scroll = caret_top;
    }
    clamp_scroll(scroll, viewport, content)
}

impl TextInput {
    pub fn new(placeholder: impl Into<SharedString>, cx: &mut Context<Self>) -> Self {
        TextInput {
            focus: cx.focus_handle(),
            text: String::new(),
            selection: 0..0,
            reversed: false,
            marked: None,
            completion: false,
            placeholder: placeholder.into(),
            style: InputStyle::default(),
            layout: None,
            bounds: None,
            scroll: px(0.),
            dragging: false,
            last_click: None,
            secure: false,
            multiline: false,
            multiline_line_height: line_height::PROSE_BODY,
            wrapped: None,
            scroll_y: px(0.),
            goal_x: None,
            reveal_caret: false,
            history: UndoHistory::default(),
            word_granular: false,
            folds_pasted_lines: false,
            checks_spelling: false,
            misspelled: Vec::new(),
            spelled_text: None,
            secure_claim: None,
            was_focused: false,
            text_drag: None,
            drop_caret: None,
            substitutions: TextServices::get(cx)
                .map(|services| services.substitution_defaults())
                .unwrap_or_default(),
            free_scroll: false,
        }
    }

    pub fn substitutions(&self) -> Substitutions {
        self.substitutions
    }

    pub fn set_substitutions(&mut self, substitutions: Substitutions, cx: &mut Context<Self>) {
        self.substitutions = substitutions;
        cx.notify();
    }

    fn toggle_substitution(
        &mut self,
        change: impl FnOnce(&mut Substitutions),
        cx: &mut Context<Self>,
    ) {
        change(&mut self.substitutions);
        cx.notify();
    }

    fn scroll_to_start(&mut self, _: &ScrollToStart, _: &mut Window, cx: &mut Context<Self>) {
        self.reveal_caret = false;
        if self.wraps() {
            self.scroll_y = px(0.);
        } else {
            self.scroll = px(0.);
            self.free_scroll = true;
        }
        cx.notify();
    }

    fn scroll_to_end(&mut self, _: &ScrollToEnd, _: &mut Window, cx: &mut Context<Self>) {
        self.reveal_caret = false;
        if self.wraps() {
            self.scroll_y = px(f32::MAX / 4.);
        } else {
            self.scroll = px(f32::MAX / 4.);
            self.free_scroll = true;
        }
        cx.notify();
    }

    fn select_to_start(&mut self, _: &SelectToStart, _: &mut Window, cx: &mut Context<Self>) {
        self.select_to(0, cx);
    }

    fn select_to_end(&mut self, _: &SelectToEnd, _: &mut Window, cx: &mut Context<Self>) {
        self.select_to(self.text.len(), cx);
    }

    fn show_spelling_panel(
        &mut self,
        _: &ShowSpellingPanel,
        _: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if self.secure {
            return;
        }
        if let Some(services) = TextServices::get(cx) {
            services.show_spelling_panel();
        }
        self.select_next_misspelling(cx);
    }

    fn refresh_spelling_action(
        &mut self,
        _: &RefreshSpelling,
        _: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.spelled_text = None;
        self.refresh_spelling(cx);
        cx.notify();
    }

    fn show_substitutions(
        &mut self,
        _: &ShowSubstitutions,
        _: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if let Some(services) = TextServices::get(cx) {
            services.show_substitutions_panel();
        }
    }

    fn toggle_smart_insert(
        &mut self,
        _: &ToggleSmartInsert,
        _: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.toggle_substitution(|s| s.smart_insert = !s.smart_insert, cx);
    }

    fn toggle_smart_quotes(
        &mut self,
        _: &ToggleSmartQuotes,
        _: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.toggle_substitution(|s| s.quotes = !s.quotes, cx);
    }

    fn toggle_smart_dashes(
        &mut self,
        _: &ToggleSmartDashes,
        _: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.toggle_substitution(|s| s.dashes = !s.dashes, cx);
    }

    fn toggle_smart_links(&mut self, _: &ToggleSmartLinks, _: &mut Window, cx: &mut Context<Self>) {
        self.toggle_substitution(|s| s.links = !s.links, cx);
    }

    fn toggle_data_detectors(
        &mut self,
        _: &ToggleDataDetectors,
        _: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.toggle_substitution(|s| s.data = !s.data, cx);
    }

    fn toggle_text_replacement(
        &mut self,
        _: &ToggleTextReplacement,
        _: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.toggle_substitution(|s| s.replacement = !s.replacement, cx);
    }

    pub fn transform_selection(
        &mut self,
        change: impl FnOnce(&str) -> String,
        cx: &mut Context<Self>,
    ) {
        if self.secure || self.selection.is_empty() {
            return;
        }
        let range = self.selection.clone();
        let Some(original) = self.text.get(range.clone()) else {
            return;
        };
        let changed = change(original);
        if changed == original {
            return;
        }
        let start = range.start;
        self.edit_as(Some(EditKind::Discrete), range, &changed, false, cx);
        self.selection = start..start + changed.len();
        cx.notify();
    }

    fn replace_quotes(&mut self, _: &ReplaceQuotes, _: &mut Window, cx: &mut Context<Self>) {
        self.transform_selection(editing::smart_quotes_in, cx);
    }

    fn replace_dashes(&mut self, _: &ReplaceDashes, _: &mut Window, cx: &mut Context<Self>) {
        self.transform_selection(editing::smart_dashes_in, cx);
    }

    fn replace_text(&mut self, _: &ReplaceText, _: &mut Window, cx: &mut Context<Self>) {
        let table = TextServices::get(cx)
            .map(|services| services.text_replacements())
            .unwrap_or_default();
        self.transform_selection(|text| editing::replace_words(text, &table), cx);
    }

    fn share_selection(&mut self, _: &ShareSelection, _: &mut Window, cx: &mut Context<Self>) {
        self.share(cx);
    }

    pub fn share(&mut self, cx: &mut Context<Self>) {
        if self.secure || self.selection.is_empty() {
            return;
        }
        let Some(selected) = self.text.get(self.selection.clone()).map(str::to_owned) else {
            return;
        };
        if let Some(services) = TextServices::get(cx) {
            let request = self.look_up_request(&selected);
            let height = px(self.style.font_size * 1.3);
            let anchor = Bounds::new(
                point(
                    request.baseline_origin.x,
                    request.baseline_origin.y - height,
                ),
                size(px(1.), height),
            );
            services.share(&selected, anchor);
        }
    }

    fn typed_substitution(&self, typed: &str) -> Option<(Range<usize>, String)> {
        if self.secure || self.marked.is_some() || !self.selection.is_empty() {
            return None;
        }
        let caret = self.selection.start;
        let before = self.text[..caret].chars().next_back();
        let subs = self.substitutions;
        if subs.quotes
            && let Some(quote) = editing::smart_quote(typed, before)
        {
            return Some((caret..caret, quote.to_owned()));
        }
        if subs.dashes && typed == "-" && before == Some('-') {
            return Some((caret - 1..caret, "\u{2014}".to_owned()));
        }
        None
    }

    fn replacement_before(&self, typed: &str, cx: &App) -> Option<(Range<usize>, String)> {
        if !self.substitutions.replacement
            || self.secure
            || self.marked.is_some()
            || !self.selection.is_empty()
            || !editing::ends_word(typed)
        {
            return None;
        }
        let word = editing::word_before(&self.text, self.selection.start)?;
        let key = &self.text[word.clone()];
        let table = TextServices::get(cx)?.text_replacements();
        let (_, to) = table.iter().find(|(from, _)| from == key)?;
        Some((word, format!("{to}{typed}")))
    }

    pub fn folding_pasted_lines(mut self) -> Self {
        self.folds_pasted_lines = true;
        self
    }

    pub fn set_folds_pasted_lines(&mut self, folds: bool) {
        self.folds_pasted_lines = folds;
    }

    pub fn can_undo(&self) -> bool {
        self.history.can_undo()
    }

    pub fn can_redo(&self) -> bool {
        self.history.can_redo()
    }

    pub fn checks_spelling(&self) -> bool {
        self.checks_spelling
    }

    pub fn misspelled_ranges(&self) -> &[Range<usize>] {
        &self.misspelled
    }

    fn snapshot(&self) -> TextState {
        TextState {
            text: self.text.clone(),
            selection: self.selection.clone(),
        }
    }

    fn restore(&mut self, state: TextState, cx: &mut Context<Self>) {
        let deleting = state.text.len() < self.text.len();
        self.text = state.text;
        self.selection = clamp_to_boundary(&self.text, state.selection.start)
            ..clamp_to_boundary(&self.text, state.selection.end);
        self.reversed = false;
        self.marked = None;
        self.completion = false;
        self.word_granular = false;
        self.goal_x = None;
        self.reveal_caret = true;
        cx.emit(InputEvent::Changed { deleting });
        cx.notify();
    }

    pub fn undo(&mut self, cx: &mut Context<Self>) -> bool {
        if self.marked.is_some() {
            return false;
        }
        let current = self.snapshot();
        match self.history.undo(current) {
            Some(previous) => {
                self.restore(previous, cx);
                true
            }
            None => false,
        }
    }

    pub fn redo(&mut self, cx: &mut Context<Self>) -> bool {
        if self.marked.is_some() {
            return false;
        }
        let current = self.snapshot();
        match self.history.redo(current) {
            Some(next) => {
                self.restore(next, cx);
                true
            }
            None => false,
        }
    }

    pub fn set_checks_spelling(&mut self, checks: bool, cx: &mut Context<Self>) {
        if self.checks_spelling != checks {
            self.checks_spelling = checks;
            self.spelled_text = None;
            self.misspelled.clear();
            self.refresh_spelling(cx);
            cx.notify();
        }
    }

    fn refresh_spelling(&mut self, cx: &mut Context<Self>) {
        if !self.checks_spelling || self.secure {
            self.misspelled.clear();
            self.spelled_text = None;
            return;
        }
        if self.spelled_text.as_deref() == Some(self.text.as_str()) {
            return;
        }
        self.misspelled = TextServices::get(cx)
            .map(|services| services.misspelled_ranges(&self.text))
            .unwrap_or_default()
            .into_iter()
            .filter(|range| {
                range.start < range.end
                    && range.end <= self.text.len()
                    && self.text.is_char_boundary(range.start)
                    && self.text.is_char_boundary(range.end)
            })
            .collect();
        self.spelled_text = Some(self.text.clone());
    }

    pub fn edit_state(&self) -> FieldEditState {
        let selected = if self.secure {
            String::new()
        } else {
            self.text
                .get(self.selection.clone())
                .unwrap_or_default()
                .to_owned()
        };
        FieldEditState {
            owner: self.focus_owner(),
            window: 0,
            substitutions: self.substitutions,
            can_undo: self.history.can_undo(),
            can_redo: self.history.can_redo(),
            has_selection: !self.selection.is_empty(),
            has_text: !self.text.is_empty(),
            secure: self.secure,
            checks_spelling: self.checks_spelling,
            selected_text: selected,
            text: if self.secure {
                String::new()
            } else {
                self.text.clone()
            },
        }
    }

    fn focus_owner(&self) -> u64 {
        let pointer = &self.focus as *const FocusHandle as usize;
        pointer as u64
    }

    pub fn multiline(mut self) -> Self {
        self.multiline = true;
        self
    }

    pub fn set_multiline(&mut self, multiline: bool, cx: &mut Context<Self>) {
        if self.multiline != multiline {
            self.multiline = multiline;
            self.wrapped = None;
            self.scroll = px(0.);
            self.scroll_y = px(0.);
            self.goal_x = None;
            if !multiline {
                self.text = self.text.replace(['\n', '\r'], " ");
                self.selection = clamp_to_boundary(&self.text, self.selection.start)
                    ..clamp_to_boundary(&self.text, self.selection.end);
            }
            cx.notify();
        }
    }

    pub fn is_multiline(&self) -> bool {
        self.multiline
    }

    pub fn set_line_height(&mut self, line_height: f32, cx: &mut Context<Self>) {
        if (self.multiline_line_height - line_height).abs() > f32::EPSILON {
            self.multiline_line_height = line_height;
            cx.notify();
        }
    }

    fn wraps(&self) -> bool {
        self.multiline && !self.secure
    }

    fn normalized(&self, text: &str) -> String {
        if self.wraps() {
            normalize_newlines(text)
        } else {
            text.replace(['\n', '\r'], " ")
        }
    }

    pub fn set_secure(&mut self, secure: bool, cx: &mut Context<Self>) {
        if self.secure != secure {
            self.secure = secure;
            self.marked = None;
            self.completion = false;
            cx.notify();
        }
    }

    pub fn is_secure(&self) -> bool {
        self.secure
    }

    fn shown_offset(&self, offset: usize) -> usize {
        if self.secure {
            secure_display_offset(&self.text, offset)
        } else {
            offset
        }
    }

    fn text_offset(&self, shown: usize) -> usize {
        if self.secure {
            secure_text_offset(&self.text, shown)
        } else {
            shown
        }
    }

    pub fn text(&self) -> &str {
        &self.text
    }

    pub fn typed(&self) -> &str {
        if self.completion {
            &self.text[..self.selection.start]
        } else {
            &self.text
        }
    }

    pub fn selection(&self) -> Range<usize> {
        self.selection.clone()
    }

    pub fn has_completion(&self) -> bool {
        self.completion
    }

    pub fn is_focused(&self, window: &Window) -> bool {
        self.focus.is_focused(window)
    }

    pub fn set_placeholder(
        &mut self,
        placeholder: impl Into<SharedString>,
        cx: &mut Context<Self>,
    ) {
        self.placeholder = placeholder.into();
        cx.notify();
    }

    pub fn set_style(&mut self, style: InputStyle, cx: &mut Context<Self>) {
        if self.style != style {
            self.style = style;
            cx.notify();
        }
    }

    pub fn set_text(&mut self, text: impl Into<String>, select_all: bool, cx: &mut Context<Self>) {
        let text = self.normalized(&text.into());
        if self.marked.is_some() && text == self.text {
            return;
        }
        if self.was_focused && text != self.text {
            self.history.record(self.snapshot(), EditKind::Discrete);
        } else if !self.was_focused {
            self.history.clear();
        }
        self.word_granular = false;
        self.free_scroll = false;
        self.text = text;
        self.selection = if select_all {
            0..self.text.len()
        } else {
            self.text.len()..self.text.len()
        };
        self.reversed = false;
        self.marked = None;
        self.completion = false;
        self.scroll = px(0.);
        self.scroll_y = px(0.);
        self.goal_x = None;
        cx.notify();
    }

    pub fn set_completion(&mut self, suffix: &str, cx: &mut Context<Self>) {
        let typed_end = if self.completion {
            self.selection.start
        } else {
            self.selection.end
        };
        if self.marked.is_some() || (!self.completion && !self.selection.is_empty()) {
            return;
        }
        if typed_end != self.text.len() && !self.completion {
            return;
        }
        self.text.truncate(typed_end);
        if suffix.is_empty() {
            self.selection = typed_end..typed_end;
            self.completion = false;
        } else {
            self.text.push_str(&suffix.replace(['\n', '\r'], " "));
            self.selection = typed_end..self.text.len();
            self.completion = true;
        }
        self.reversed = false;
        cx.notify();
    }

    pub fn accept_completion(&mut self, cx: &mut Context<Self>) -> bool {
        if !self.completion {
            return false;
        }
        self.completion = false;
        self.selection = self.text.len()..self.text.len();
        cx.notify();
        true
    }

    pub fn select_all_text(&mut self, cx: &mut Context<Self>) {
        self.completion = false;
        self.selection = 0..self.text.len();
        self.reversed = false;
        cx.notify();
    }

    fn cursor(&self) -> usize {
        if self.reversed {
            self.selection.start
        } else {
            self.selection.end
        }
    }

    fn move_to(&mut self, offset: usize, cx: &mut Context<Self>) {
        let offset = clamp_to_boundary(&self.text, offset);
        self.history.break_typing();
        self.word_granular = false;
        KillBuffer::end_run(cx);
        self.selection = offset..offset;
        self.reversed = false;
        self.completion = false;
        self.goal_x = None;
        self.reveal_caret = true;
        cx.notify();
    }

    fn select_to(&mut self, offset: usize, cx: &mut Context<Self>) {
        let offset = clamp_to_boundary(&self.text, offset);
        self.history.break_typing();
        self.word_granular = false;
        KillBuffer::end_run(cx);
        self.completion = false;
        self.goal_x = None;
        self.reveal_caret = true;
        if self.reversed {
            self.selection.start = offset;
        } else {
            self.selection.end = offset;
        }
        if self.selection.end < self.selection.start {
            self.reversed = !self.reversed;
            self.selection = self.selection.end..self.selection.start;
        }
        cx.notify();
    }

    fn edit(&mut self, range: Range<usize>, insert: &str, deleting: bool, cx: &mut Context<Self>) {
        let kind = if deleting {
            EditKind::Deleting
        } else {
            EditKind::Typing
        };
        self.edit_as(Some(kind), range, insert, deleting, cx);
    }

    fn edit_as(
        &mut self,
        kind: Option<EditKind>,
        range: Range<usize>,
        insert: &str,
        deleting: bool,
        cx: &mut Context<Self>,
    ) {
        let start = clamp_to_boundary(&self.text, range.start);
        let end = clamp_to_boundary(&self.text, range.end.max(start));
        let insert = self.normalized(insert);
        if start == end && insert.is_empty() {
            return;
        }
        if let Some(kind) = kind {
            let mut before = self.snapshot();
            if let Some(marked) = self.marked.as_ref() {
                before.text.replace_range(marked.clone(), "");
                before.selection = marked.start..marked.start;
            }
            self.history.record(before, kind);
        }
        self.word_granular = false;
        self.text.replace_range(start..end, &insert);
        let cursor = start + insert.len();
        self.selection = cursor..cursor;
        self.reversed = false;
        self.marked = None;
        self.completion = false;
        self.goal_x = None;
        self.reveal_caret = true;
        cx.emit(InputEvent::Changed { deleting });
        cx.notify();
    }

    fn backspace(&mut self, _: &Backspace, _: &mut Window, cx: &mut Context<Self>) {
        let range = if self.selection.is_empty() {
            previous_boundary(&self.text, self.cursor())..self.cursor()
        } else {
            self.selection.clone()
        };
        if range.is_empty() {
            return;
        }
        self.edit(range, "", true, cx);
    }

    fn delete(&mut self, _: &Delete, _: &mut Window, cx: &mut Context<Self>) {
        let range = if self.selection.is_empty() {
            self.cursor()..next_boundary(&self.text, self.cursor())
        } else {
            self.selection.clone()
        };
        if range.is_empty() {
            return;
        }
        self.edit(range, "", true, cx);
    }

    fn delete_word_left(&mut self, _: &DeleteWordLeft, _: &mut Window, cx: &mut Context<Self>) {
        let range = if self.selection.is_empty() {
            previous_word(&self.text, self.cursor())..self.cursor()
        } else {
            self.selection.clone()
        };
        if !range.is_empty() {
            self.edit_as(Some(EditKind::Discrete), range, "", true, cx);
        }
    }

    fn delete_to_start(&mut self, _: &DeleteToStart, _: &mut Window, cx: &mut Context<Self>) {
        let end = if self.selection.is_empty() {
            self.cursor()
        } else {
            self.selection.end
        };
        let start = self
            .visual_line(self.cursor())
            .map_or(0, |line| line.start.min(end));
        if end > start {
            self.edit_as(Some(EditKind::Discrete), start..end, "", true, cx);
        }
    }

    fn paragraph_end(&self, from: usize) -> usize {
        if self.wraps() {
            self.text[from..]
                .find('\n')
                .map_or(self.text.len(), |at| from + at)
        } else {
            self.text.len()
        }
    }

    fn delete_word_right(&mut self, _: &DeleteWordRight, _: &mut Window, cx: &mut Context<Self>) {
        let range = if self.selection.is_empty() {
            self.cursor()..next_word(&self.text, self.cursor())
        } else {
            self.selection.clone()
        };
        if !range.is_empty() {
            self.edit(range, "", true, cx);
        }
    }

    fn delete_to_end(&mut self, _: &DeleteToEnd, _: &mut Window, cx: &mut Context<Self>) {
        let start = if self.selection.is_empty() {
            self.cursor()
        } else {
            self.selection.start
        };
        let end = self
            .visual_line(self.cursor())
            .map_or(self.text.len(), |line| line.end.max(start));
        if end > start {
            self.edit_as(Some(EditKind::Discrete), start..end, "", true, cx);
        }
    }

    fn kill_to_end(&mut self, _: &KillToEnd, _: &mut Window, cx: &mut Context<Self>) {
        let start = self.cursor();
        let mut end = self.paragraph_end(start);
        if end == start && end < self.text.len() {
            end = next_boundary(&self.text, end);
        }
        if end <= start {
            return;
        }
        let killed = self.text[start..end].to_owned();
        if !self.secure {
            KillBuffer::kill(&killed, cx);
        }
        self.edit_as(Some(EditKind::Discrete), start..end, "", true, cx);
        if !self.secure {
            KillBuffer::kill("", cx);
        }
    }

    fn yank(&mut self, _: &Yank, _: &mut Window, cx: &mut Context<Self>) {
        if let Some(text) = KillBuffer::yank(cx) {
            let text = if self.wraps() {
                text
            } else {
                text.replace(['\n', '\r'], " ")
            };
            self.edit_as(
                Some(EditKind::Discrete),
                self.selection.clone(),
                &text,
                false,
                cx,
            );
        }
    }

    fn transpose(&mut self, _: &Transpose, _: &mut Window, cx: &mut Context<Self>) {
        if !self.selection.is_empty() {
            return;
        }
        if let Some((range, swapped, caret)) = editing::transpose_at(&self.text, self.cursor()) {
            self.edit_as(Some(EditKind::Discrete), range, &swapped, false, cx);
            self.selection = caret..caret;
            cx.notify();
        }
    }

    fn open_line(&mut self, _: &OpenLine, _: &mut Window, cx: &mut Context<Self>) {
        if !self.wraps() {
            return;
        }
        let at = self.selection.start;
        self.edit_as(
            Some(EditKind::Typing),
            self.selection.clone(),
            "\n",
            false,
            cx,
        );
        self.selection = at..at;
        cx.notify();
    }

    fn previous_line(&mut self, _: &PreviousLine, _: &mut Window, cx: &mut Context<Self>) {
        if self.wraps() {
            self.vertical(-1, false, cx);
        } else {
            self.move_to(0, cx);
        }
    }

    fn next_line(&mut self, _: &NextLine, _: &mut Window, cx: &mut Context<Self>) {
        if self.wraps() {
            self.vertical(1, false, cx);
        } else {
            self.move_to(self.text.len(), cx);
        }
    }

    fn undo_action(&mut self, _: &Undo, _: &mut Window, cx: &mut Context<Self>) {
        self.undo(cx);
    }

    fn redo_action(&mut self, _: &Redo, _: &mut Window, cx: &mut Context<Self>) {
        self.redo(cx);
    }

    fn transform_range(&self) -> Range<usize> {
        if self.selection.is_empty() {
            editing::word_range_at(&self.text, self.cursor())
        } else {
            self.selection.clone()
        }
    }

    pub fn change_case(&mut self, change: CaseChange, cx: &mut Context<Self>) {
        if self.secure {
            return;
        }
        let range = self.transform_range();
        let Some(original) = self.text.get(range.clone()) else {
            return;
        };
        let changed = editing::change_case(original, change);
        if changed == original {
            return;
        }
        let start = range.start;
        self.edit_as(Some(EditKind::Discrete), range, &changed, false, cx);
        self.selection = start..start + changed.len();
        cx.notify();
    }

    fn uppercase_word(&mut self, _: &UppercaseWord, _: &mut Window, cx: &mut Context<Self>) {
        self.change_case(CaseChange::Upper, cx);
    }

    fn lowercase_word(&mut self, _: &LowercaseWord, _: &mut Window, cx: &mut Context<Self>) {
        self.change_case(CaseChange::Lower, cx);
    }

    fn capitalize_word(&mut self, _: &CapitalizeWord, _: &mut Window, cx: &mut Context<Self>) {
        self.change_case(CaseChange::Capitalize, cx);
    }

    fn spoken_text(&self) -> Option<String> {
        if self.secure {
            return None;
        }
        let text = if self.selection.is_empty() {
            self.text.as_str()
        } else {
            self.text.get(self.selection.clone()).unwrap_or_default()
        };
        (!text.trim().is_empty()).then(|| text.to_owned())
    }

    fn start_speaking(&mut self, _: &StartSpeaking, _: &mut Window, cx: &mut Context<Self>) {
        if let (Some(services), Some(text)) = (TextServices::get(cx), self.spoken_text()) {
            services.speak(&text);
        }
    }

    fn stop_speaking(&mut self, _: &StopSpeaking, _: &mut Window, cx: &mut Context<Self>) {
        if let Some(services) = TextServices::get(cx) {
            services.stop_speaking();
        }
    }

    fn toggle_spell_checking(
        &mut self,
        _: &ToggleSpellChecking,
        _: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let checks = !self.checks_spelling;
        self.set_checks_spelling(checks, cx);
    }

    pub fn select_next_misspelling(&mut self, cx: &mut Context<Self>) -> bool {
        if self.secure {
            return false;
        }
        let ranges = TextServices::get(cx)
            .map(|services| services.misspelled_ranges(&self.text))
            .unwrap_or_default();
        let from = self.selection.end;
        let next = ranges
            .iter()
            .find(|range| range.start >= from)
            .or_else(|| ranges.first())
            .filter(|range| range.end <= self.text.len())
            .cloned();
        match next {
            Some(range) => {
                if let Some(services) = TextServices::get(cx) {
                    services
                        .update_spelling_panel(self.text.get(range.clone()).unwrap_or_default());
                }
                self.history.break_typing();
                self.selection = range;
                self.reversed = false;
                self.completion = false;
                self.reveal_caret = true;
                cx.notify();
                true
            }
            None => {
                if let Some(services) = TextServices::get(cx) {
                    services.update_spelling_panel("");
                }
                false
            }
        }
    }

    fn check_spelling(&mut self, _: &CheckSpelling, _: &mut Window, cx: &mut Context<Self>) {
        self.select_next_misspelling(cx);
    }

    fn visual_line(&self, index: usize) -> Option<Range<usize>> {
        let wrapped = self
            .wrapped
            .as_ref()
            .filter(|_| self.wraps() && !self.text.is_empty())?;
        let range = wrapped.row_caret_range(wrapped.row_for_index(index));
        Some(range.start.min(self.text.len())..range.end.min(self.text.len()))
    }

    fn line_start(&self) -> usize {
        self.visual_line(self.cursor()).map_or(0, |line| line.start)
    }

    fn line_end(&self) -> usize {
        self.visual_line(self.cursor())
            .map_or(self.text.len(), |line| line.end)
    }

    fn vertical(&mut self, rows: isize, select: bool, cx: &mut Context<Self>) {
        let from = if select || self.selection.is_empty() {
            self.cursor()
        } else if rows < 0 {
            self.selection.start
        } else {
            self.selection.end
        };
        let edge = if rows < 0 { 0 } else { self.text.len() };
        let (target, goal) = match self.wrapped.as_ref().filter(|_| !self.text.is_empty()) {
            Some(wrapped) => {
                let goal = self
                    .goal_x
                    .unwrap_or_else(|| wrapped.position_for_index(from).x);
                (
                    wrapped
                        .vertical_target(from, goal, rows)
                        .min(self.text.len()),
                    Some(goal),
                )
            }
            None => (edge, None),
        };
        if select {
            self.select_to(target, cx);
        } else {
            self.move_to(target, cx);
        }
        self.goal_x = goal;
    }

    fn select_up(&mut self, _: &SelectUp, _: &mut Window, cx: &mut Context<Self>) {
        if self.wraps() {
            self.vertical(-1, true, cx);
        } else {
            cx.propagate();
        }
    }

    fn select_down(&mut self, _: &SelectDown, _: &mut Window, cx: &mut Context<Self>) {
        if self.wraps() {
            self.vertical(1, true, cx);
        } else {
            cx.propagate();
        }
    }

    fn document_start(&mut self, _: &DocumentStart, _: &mut Window, cx: &mut Context<Self>) {
        if self.wraps() {
            self.move_to(0, cx);
        } else {
            cx.propagate();
        }
    }

    fn document_end(&mut self, _: &DocumentEnd, _: &mut Window, cx: &mut Context<Self>) {
        if self.wraps() {
            self.move_to(self.text.len(), cx);
        } else {
            cx.propagate();
        }
    }

    fn select_document_start(
        &mut self,
        _: &SelectDocumentStart,
        _: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if self.wraps() {
            self.select_to(0, cx);
        } else {
            cx.propagate();
        }
    }

    fn select_document_end(
        &mut self,
        _: &SelectDocumentEnd,
        _: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if self.wraps() {
            self.select_to(self.text.len(), cx);
        } else {
            cx.propagate();
        }
    }

    fn left(&mut self, _: &Left, _: &mut Window, cx: &mut Context<Self>) {
        if self.selection.is_empty() {
            self.move_to(previous_boundary(&self.text, self.cursor()), cx);
        } else {
            self.move_to(self.selection.start, cx);
        }
    }

    fn right(&mut self, _: &Right, _: &mut Window, cx: &mut Context<Self>) {
        if self.selection.is_empty() {
            self.move_to(next_boundary(&self.text, self.cursor()), cx);
        } else {
            self.move_to(self.selection.end, cx);
        }
    }

    fn word_left(&mut self, _: &WordLeft, _: &mut Window, cx: &mut Context<Self>) {
        self.move_to(previous_word(&self.text, self.cursor()), cx);
    }

    fn word_right(&mut self, _: &WordRight, _: &mut Window, cx: &mut Context<Self>) {
        self.move_to(next_word(&self.text, self.cursor()), cx);
    }

    fn select_left(&mut self, _: &SelectLeft, _: &mut Window, cx: &mut Context<Self>) {
        self.select_to(previous_boundary(&self.text, self.cursor()), cx);
    }

    fn select_right(&mut self, _: &SelectRight, _: &mut Window, cx: &mut Context<Self>) {
        self.select_to(next_boundary(&self.text, self.cursor()), cx);
    }

    fn select_word_left(&mut self, _: &SelectWordLeft, _: &mut Window, cx: &mut Context<Self>) {
        self.select_to(previous_word(&self.text, self.cursor()), cx);
    }

    fn select_word_right(&mut self, _: &SelectWordRight, _: &mut Window, cx: &mut Context<Self>) {
        self.select_to(next_word(&self.text, self.cursor()), cx);
    }

    fn home(&mut self, _: &Home, _: &mut Window, cx: &mut Context<Self>) {
        self.move_to(self.line_start(), cx);
    }

    fn end(&mut self, _: &End, _: &mut Window, cx: &mut Context<Self>) {
        self.move_to(self.line_end(), cx);
    }

    fn select_home(&mut self, _: &SelectHome, _: &mut Window, cx: &mut Context<Self>) {
        self.select_to(self.line_start(), cx);
    }

    fn select_end(&mut self, _: &SelectEnd, _: &mut Window, cx: &mut Context<Self>) {
        self.select_to(self.line_end(), cx);
    }

    fn select_all(&mut self, _: &SelectAll, _: &mut Window, cx: &mut Context<Self>) {
        self.select_all_text(cx);
    }

    pub fn copy_selection(&mut self, cx: &mut Context<Self>) -> bool {
        if self.secure {
            return false;
        }
        match self
            .text
            .get(self.selection.clone())
            .filter(|s| !s.is_empty())
        {
            Some(selected) => {
                let selected = selected.to_owned();
                SmartPasteMemory::remember(self.word_granular.then(|| selected.clone()), cx);
                cx.write_to_clipboard(ClipboardItem::new_string(selected));
                true
            }
            None => false,
        }
    }

    fn copy(&mut self, _: &Copy, _: &mut Window, cx: &mut Context<Self>) {
        self.copy_selection(cx);
    }

    pub fn delete_selection(&mut self, cx: &mut Context<Self>) {
        if self.selection.is_empty() {
            return;
        }
        let range = if self.word_granular && !self.secure && self.substitutions.smart_insert {
            editing::smart_delete_range(&self.text, self.selection.clone())
        } else {
            self.selection.clone()
        };
        self.edit_as(Some(EditKind::Discrete), range, "", true, cx);
    }

    fn delete_selection_action(
        &mut self,
        _: &DeleteSelection,
        _: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.delete_selection(cx);
    }

    fn replace_selection_action(
        &mut self,
        action: &ReplaceSelection,
        _: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let start = self.selection.start;
        let text = self.normalized(&action.text);
        self.edit_as(
            Some(EditKind::Discrete),
            self.selection.clone(),
            &text,
            false,
            cx,
        );
        self.selection = start..start + text.len();
        cx.notify();
    }

    fn cut(&mut self, _: &Cut, _: &mut Window, cx: &mut Context<Self>) {
        if self.copy_selection(cx) {
            self.delete_selection(cx);
        }
    }

    fn pasted_text(&self, text: &str) -> String {
        if self.wraps() {
            text.to_owned()
        } else if self.folds_pasted_lines {
            editing::fold_pasted_lines(text)
        } else {
            text.trim_end_matches(['\n', '\r']).to_owned()
        }
    }

    pub fn insert_pasted(&mut self, text: &str, cx: &mut Context<Self>) {
        let mut pasted = self.pasted_text(text);
        if !self.secure
            && self.substitutions.smart_insert
            && self.selection.is_empty()
            && SmartPasteMemory::was_word(text, cx)
        {
            pasted = editing::smart_insert(&self.text, &self.selection, &pasted);
        }
        self.edit_as(
            Some(EditKind::Discrete),
            self.selection.clone(),
            &pasted,
            false,
            cx,
        );
    }

    fn paste(&mut self, _: &Paste, _: &mut Window, cx: &mut Context<Self>) {
        if let Some(text) = cx.read_from_clipboard().and_then(|item| item.text()) {
            self.insert_pasted(&text, cx);
        }
    }

    fn paste_and_match_style(
        &mut self,
        _: &PasteAndMatchStyle,
        _: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if let Some(text) = cx.read_from_clipboard().and_then(|item| item.text()) {
            self.insert_pasted(&text, cx);
        }
    }

    fn insert_newline(&mut self, cx: &mut Context<Self>) {
        self.edit(self.selection.clone(), "\n", false, cx);
    }

    fn submit(&mut self, _: &Submit, _: &mut Window, cx: &mut Context<Self>) {
        if self.wraps() {
            self.insert_newline(cx);
            return;
        }
        cx.emit(InputEvent::Submit(SubmitKind::Plain));
    }

    fn submit_alternate(&mut self, _: &SubmitAlternate, _: &mut Window, cx: &mut Context<Self>) {
        cx.emit(InputEvent::Submit(SubmitKind::Alternate));
    }

    fn submit_shift(&mut self, _: &SubmitShift, _: &mut Window, cx: &mut Context<Self>) {
        if self.wraps() {
            self.insert_newline(cx);
            return;
        }
        cx.emit(InputEvent::Submit(SubmitKind::Shift));
    }

    fn cancel(&mut self, _: &Cancel, _: &mut Window, cx: &mut Context<Self>) {
        cx.emit(InputEvent::Cancel);
    }

    fn move_up(&mut self, _: &MoveUp, _: &mut Window, cx: &mut Context<Self>) {
        if self.wraps() {
            self.vertical(-1, false, cx);
            return;
        }
        cx.emit(InputEvent::Up);
    }

    fn move_down(&mut self, _: &MoveDown, _: &mut Window, cx: &mut Context<Self>) {
        if self.wraps() {
            self.vertical(1, false, cx);
            return;
        }
        cx.emit(InputEvent::Down);
    }

    fn accept(&mut self, _: &AcceptCompletion, _: &mut Window, cx: &mut Context<Self>) {
        if self.accept_completion(cx) {
            return;
        }
        if self.wraps() {
            self.edit(self.selection.clone(), "\t", false, cx);
        } else {
            cx.emit(InputEvent::Tab);
        }
    }

    fn show_character_palette(
        &mut self,
        _: &ShowCharacterPalette,
        window: &mut Window,
        _: &mut Context<Self>,
    ) {
        window.show_character_palette();
    }

    fn wrapped_local(&self, position: Point<Pixels>, bounds: Bounds<Pixels>) -> Point<Pixels> {
        point(
            position.x - bounds.left() - px(MULTILINE_INSET_X),
            position.y - bounds.top() + self.scroll_y,
        )
    }

    fn index_for_position(&self, position: Point<Pixels>) -> usize {
        if self.wraps() {
            let (Some(bounds), Some(wrapped)) = (self.bounds, self.wrapped.as_ref()) else {
                return if self.text.is_empty() {
                    0
                } else {
                    self.text.len()
                };
            };
            return wrapped
                .index_for_position(self.wrapped_local(position, bounds))
                .min(self.text.len());
        }
        let (Some(bounds), Some(line)) = (self.bounds, self.layout.as_ref()) else {
            return self.text.len();
        };
        if self.text.is_empty() {
            return 0;
        }
        if position.x <= bounds.left() {
            return if self.scroll > px(0.) {
                self.text_offset(line.closest_index_for_x(self.scroll))
            } else {
                0
            };
        }
        self.text_offset(line.closest_index_for_x(position.x - bounds.left() + self.scroll))
            .min(self.text.len())
    }

    fn on_mouse_down(
        &mut self,
        event: &MouseDownEvent,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        window.focus(&self.focus, cx);
        let index = self.index_for_position(event.position);
        self.text_drag = None;
        self.drop_caret = None;
        let in_selection = !self.selection.is_empty()
            && index >= self.selection.start
            && index <= self.selection.end;
        if event.click_count <= 1
            && in_selection
            && !event.modifiers.shift
            && !self.secure
            && !self.completion
        {
            self.text_drag = Some(TextDrag {
                moved: self.selection.clone(),
                pressed_at: event.position,
                click_index: index,
                dragging: false,
            });
            self.last_click = Some((Instant::now(), index, 1));
            return;
        }
        let now = Instant::now();
        let clicks = match self.last_click {
            Some((at, previous, count))
                if now.duration_since(at) < DOUBLE_CLICK && previous == index =>
            {
                count.saturating_add(1).min(3)
            }
            _ => 1,
        };
        self.last_click = Some((now, index, clicks));
        match clicks {
            2 if self.secure => self.select_all_text(cx),
            2 => {
                let word = word_at(&self.text, index);
                self.history.break_typing();
                self.selection = word;
                self.reversed = false;
                self.completion = false;
                self.word_granular = true;
                cx.notify();
            }
            3.. => self.select_all_text(cx),
            _ => {
                self.dragging = true;
                if event.modifiers.shift {
                    self.select_to(index, cx);
                } else {
                    self.move_to(index, cx);
                }
            }
        }
    }

    fn on_mouse_up(&mut self, event: &MouseUpEvent, _: &mut Window, cx: &mut Context<Self>) {
        self.dragging = false;
        let Some(drag) = self.text_drag.take() else {
            return;
        };
        self.drop_caret = None;
        if !drag.dragging {
            self.move_to(drag.click_index, cx);
            return;
        }
        let target = self.index_for_position(event.position);
        self.finish_text_drag(drag.moved, target, event.modifiers.alt, cx);
    }

    pub fn move_text(
        &mut self,
        moved: Range<usize>,
        target: usize,
        copy: bool,
        cx: &mut Context<Self>,
    ) {
        self.finish_text_drag(moved, target, copy, cx);
    }

    fn finish_text_drag(
        &mut self,
        moved: Range<usize>,
        target: usize,
        copy: bool,
        cx: &mut Context<Self>,
    ) {
        let Some(piece) = self.text.get(moved.clone()).map(str::to_owned) else {
            return;
        };
        let target = clamp_to_boundary(&self.text, target);
        if !copy && target >= moved.start && target <= moved.end {
            self.selection = moved;
            cx.notify();
            return;
        }
        self.history.record(self.snapshot(), EditKind::Discrete);
        let insert_at = if copy {
            target
        } else {
            self.text.replace_range(moved.clone(), "");
            if target > moved.end {
                target - piece.len()
            } else {
                target
            }
        };
        self.text.insert_str(insert_at, &piece);
        self.selection = insert_at..insert_at + piece.len();
        self.reversed = false;
        self.marked = None;
        self.completion = false;
        self.word_granular = false;
        self.goal_x = None;
        self.reveal_caret = true;
        self.history.break_typing();
        cx.emit(InputEvent::Changed { deleting: false });
        cx.notify();
    }

    fn on_drop_items(
        &mut self,
        items: &ExternalItems,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if !self.focus.is_focused(window) {
            return;
        }
        let text = match items.text() {
            Some(text) if !text.is_empty() => text.to_owned(),
            _ => items
                .urls()
                .iter()
                .map(|url| url.to_string())
                .collect::<Vec<_>>()
                .join(" "),
        };
        if text.is_empty() {
            return;
        }
        let index = self.index_for_position(window.mouse_position());
        self.selection = index..index;
        self.insert_pasted(&text, cx);
        let end = self.selection.end;
        self.selection = index.min(end)..end;
        cx.notify();
    }

    fn on_right_mouse_down(
        &mut self,
        event: &MouseDownEvent,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        window.focus(&self.focus, cx);
        cx.stop_propagation();
        let index = self.index_for_position(event.position);
        let inside = !self.selection.is_empty()
            && index >= self.selection.start
            && index <= self.selection.end;
        if !inside {
            let word = if self.secure {
                index..index
            } else {
                editing::word_range_at(&self.text, index)
            };
            self.history.break_typing();
            self.selection = word;
            self.reversed = false;
            self.completion = false;
            self.word_granular = !self.selection.is_empty();
            cx.notify();
        }
        self.show_text_menu(window, cx);
    }

    pub fn text_menu_context(&self, cx: &App) -> TextMenuContext {
        let services = TextServices::get(cx);
        let selected = self
            .text
            .get(self.selection.clone())
            .unwrap_or_default()
            .to_owned();
        let single_word = !selected.is_empty()
            && !selected.chars().any(char::is_whitespace)
            && selected.chars().any(char::is_alphabetic);
        let misspelled = !self.secure
            && single_word
            && services
                .as_ref()
                .is_some_and(|services| !services.misspelled_ranges(&selected).is_empty());
        let guesses = if misspelled {
            services
                .as_ref()
                .map(|services| services.guesses(&self.text, self.selection.clone()))
                .unwrap_or_default()
        } else {
            Vec::new()
        };
        TextMenuContext {
            secure: self.secure,
            has_selection: !self.selection.is_empty(),
            has_text: !self.text.is_empty(),
            can_paste: services
                .as_ref()
                .is_none_or(|services| services.can_paste()),
            editable: true,
            word: (!self.secure && !selected.is_empty()).then_some(selected),
            guesses,
            misspelled,
            checks_while_typing: self.checks_spelling,
            speaking: services
                .as_ref()
                .is_some_and(|services| services.is_speaking()),
            substitutions: self.substitutions,
        }
    }

    pub fn show_text_menu(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(services) = TextServices::get(cx) else {
            return;
        };
        let context = self.text_menu_context(cx);
        let Some(reply) = services.show_menu(editing::text_menu_items(&context)) else {
            return;
        };
        let guesses = context.guesses;
        cx.spawn_in(window, async move |this, cx| {
            if let Ok(Some(id)) = reply.await {
                let _ = this.update_in(cx, |input, window, cx| {
                    input.run_menu_item(&id, &guesses, window, cx)
                });
            }
        })
        .detach();
    }

    pub fn run_menu_item(
        &mut self,
        id: &str,
        guesses: &[String],
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let services = TextServices::get(cx);
        if let Some(index) = id.strip_prefix(menu_ids::GUESS_PREFIX) {
            if let Some(guess) = index.parse::<usize>().ok().and_then(|i| guesses.get(i)) {
                let start = self.selection.start;
                self.edit_as(
                    Some(EditKind::Discrete),
                    self.selection.clone(),
                    guess,
                    false,
                    cx,
                );
                self.selection = start..start + guess.len();
                self.spelled_text = None;
                self.refresh_spelling(cx);
                cx.notify();
            }
            return;
        }
        let selected = self
            .text
            .get(self.selection.clone())
            .unwrap_or_default()
            .to_owned();
        match id {
            menu_ids::IGNORE_SPELLING | menu_ids::LEARN_SPELLING => {
                if let Some(services) = services {
                    if id == menu_ids::LEARN_SPELLING {
                        services.learn_word(&selected);
                    } else {
                        services.ignore_word(&selected);
                    }
                }
                self.spelled_text = None;
                self.refresh_spelling(cx);
                cx.notify();
            }
            menu_ids::LOOK_UP => {
                if let Some(services) = services {
                    services.look_up(self.look_up_request(&selected));
                }
            }
            menu_ids::SEARCH_WEB => {
                if let Some(services) = services {
                    services.search_web(&selected);
                }
            }
            menu_ids::CUT => self.cut(&Cut, window, cx),
            menu_ids::COPY => self.copy(&Copy, window, cx),
            menu_ids::PASTE => self.paste(&Paste, window, cx),
            menu_ids::PASTE_AND_MATCH_STYLE => {
                self.paste_and_match_style(&PasteAndMatchStyle, window, cx)
            }
            menu_ids::DELETE => self.delete_selection(cx),
            menu_ids::SELECT_ALL => self.select_all_text(cx),
            menu_ids::CHECK_DOCUMENT => {
                self.select_next_misspelling(cx);
            }
            menu_ids::CHECK_WHILE_TYPING => {
                let checks = !self.checks_spelling;
                self.set_checks_spelling(checks, cx);
            }
            menu_ids::UPPERCASE => self.change_case(CaseChange::Upper, cx),
            menu_ids::LOWERCASE => self.change_case(CaseChange::Lower, cx),
            menu_ids::CAPITALIZE => self.change_case(CaseChange::Capitalize, cx),
            menu_ids::SHARE => self.share(cx),
            menu_ids::SHOW_SPELLING_PANEL => {
                self.show_spelling_panel(&ShowSpellingPanel, window, cx)
            }
            menu_ids::REPLACE_QUOTES => self.replace_quotes(&ReplaceQuotes, window, cx),
            menu_ids::REPLACE_DASHES => self.replace_dashes(&ReplaceDashes, window, cx),
            menu_ids::REPLACE_TEXT => self.replace_text(&ReplaceText, window, cx),
            menu_ids::SHOW_SUBSTITUTIONS => self.show_substitutions(&ShowSubstitutions, window, cx),
            menu_ids::SMART_INSERT => self.toggle_smart_insert(&ToggleSmartInsert, window, cx),
            menu_ids::SMART_QUOTES => self.toggle_smart_quotes(&ToggleSmartQuotes, window, cx),
            menu_ids::SMART_DASHES => self.toggle_smart_dashes(&ToggleSmartDashes, window, cx),
            menu_ids::SMART_LINKS => self.toggle_smart_links(&ToggleSmartLinks, window, cx),
            menu_ids::DATA_DETECTORS => {
                self.toggle_data_detectors(&ToggleDataDetectors, window, cx)
            }
            menu_ids::TEXT_REPLACEMENT => {
                self.toggle_text_replacement(&ToggleTextReplacement, window, cx)
            }
            menu_ids::START_SPEAKING => self.start_speaking(&StartSpeaking, window, cx),
            menu_ids::STOP_SPEAKING => self.stop_speaking(&StopSpeaking, window, cx),
            _ => {}
        }
    }

    fn look_up_request(&self, text: &str) -> LookUp {
        let bounds = self.bounds.unwrap_or_default();
        let x = match (&self.layout, self.wraps()) {
            (Some(line), false) => {
                line.x_for_index(self.shown_offset(self.selection.start)) - self.scroll
            }
            _ => self.wrapped.as_ref().map_or(px(0.), |wrapped| {
                wrapped.position_for_index(self.selection.start).x
            }),
        };
        let line_height = if self.wraps() {
            px(self.multiline_line_height)
        } else {
            bounds.size.height
        };
        let row_top = match (&self.wrapped, self.wraps()) {
            (Some(wrapped), true) => {
                wrapped.position_for_index(self.selection.start).y - self.scroll_y
            }
            _ => px(0.),
        };
        let baseline = row_top + (line_height + px(self.style.font_size * 0.76)) / 2.;
        LookUp {
            text: text.to_owned(),
            baseline_origin: point(bounds.left() + x, bounds.top() + baseline),
            font_size: self.style.font_size,
        }
    }

    fn on_scroll_wheel(&mut self, event: &ScrollEvent, _: &mut Window, cx: &mut Context<Self>) {
        let (Some(bounds), Some(wrapped)) = (self.bounds, self.wrapped.as_ref()) else {
            return;
        };
        let viewport = bounds.size.height;
        let content = wrapped.height();
        if content <= viewport {
            return;
        }
        cx.stop_propagation();
        let delta = event.delta.pixel_delta(wrapped.line_height());
        let next = clamp_scroll(self.scroll_y - delta.y, viewport, content);
        if next != self.scroll_y {
            self.scroll_y = next;
            cx.notify();
        }
    }

    fn on_mouse_move(&mut self, event: &MouseMoveEvent, _: &mut Window, cx: &mut Context<Self>) {
        if event.pressed_button == Some(MouseButton::Left)
            && let Some(drag) = self.text_drag.as_mut()
        {
            let delta = event.position - drag.pressed_at;
            if !drag.dragging
                && (f32::from(delta.x).abs() > TEXT_DRAG_SLOP
                    || f32::from(delta.y).abs() > TEXT_DRAG_SLOP)
            {
                drag.dragging = true;
            }
            if drag.dragging {
                let index = self.index_for_position(event.position);
                if self.drop_caret != Some(index) {
                    self.drop_caret = Some(index);
                    cx.notify();
                }
            }
            return;
        }
        if self.dragging && event.pressed_button == Some(MouseButton::Left) {
            self.select_to(self.index_for_position(event.position), cx);
        }
    }

    fn utf16_to_offset(&self, utf16: usize) -> usize {
        let mut utf8 = 0;
        let mut count = 0;
        for c in self.text.chars() {
            if count >= utf16 {
                break;
            }
            count += c.len_utf16();
            utf8 += c.len_utf8();
        }
        utf8
    }

    fn offset_to_utf16(&self, offset: usize) -> usize {
        let mut utf16 = 0;
        let mut count = 0;
        for c in self.text.chars() {
            if count >= offset {
                break;
            }
            count += c.len_utf8();
            utf16 += c.len_utf16();
        }
        utf16
    }

    fn range_to_utf16(&self, range: &Range<usize>) -> Range<usize> {
        self.offset_to_utf16(range.start)..self.offset_to_utf16(range.end)
    }

    fn range_from_utf16(&self, range: &Range<usize>) -> Range<usize> {
        self.utf16_to_offset(range.start)..self.utf16_to_offset(range.end)
    }
}

impl EntityInputHandler for TextInput {
    fn text_for_range(
        &mut self,
        range_utf16: Range<usize>,
        actual_range: &mut Option<Range<usize>>,
        _: &mut Window,
        _: &mut Context<Self>,
    ) -> Option<String> {
        let range = self.range_from_utf16(&range_utf16);
        actual_range.replace(self.range_to_utf16(&range));
        self.text.get(range).map(str::to_owned)
    }

    fn selected_text_range(
        &mut self,
        _ignore_disabled_input: bool,
        _: &mut Window,
        _: &mut Context<Self>,
    ) -> Option<UTF16Selection> {
        Some(UTF16Selection {
            range: self.range_to_utf16(&self.selection),
            reversed: self.reversed,
        })
    }

    fn set_selected_text_range(
        &mut self,
        range_utf16: Range<usize>,
        _: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.selection = self.range_from_utf16(&range_utf16);
        self.reversed = false;
        self.completion = false;
        self.history.break_typing();
        cx.notify();
    }

    fn text_length_utf16(&mut self, _: &mut Window, _: &mut Context<Self>) -> Option<usize> {
        Some(self.text.encode_utf16().count())
    }

    fn marked_text_range(&self, _: &mut Window, _: &mut Context<Self>) -> Option<Range<usize>> {
        self.marked.as_ref().map(|range| self.range_to_utf16(range))
    }

    fn unmark_text(&mut self, _: &mut Window, cx: &mut Context<Self>) {
        self.marked = None;
        cx.notify();
    }

    fn replace_text_in_range(
        &mut self,
        range_utf16: Option<Range<usize>>,
        new_text: &str,
        _: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let range = range_utf16
            .as_ref()
            .map(|range| self.range_from_utf16(range))
            .or_else(|| self.marked.clone())
            .unwrap_or_else(|| self.selection.clone());
        let kind = if self.marked.is_some() {
            None
        } else if range_utf16.is_some() && !range.is_empty() {
            Some(EditKind::Discrete)
        } else {
            Some(EditKind::Typing)
        };
        if kind == Some(EditKind::Typing) && range_utf16.is_none() {
            if let Some((range, text)) = self.replacement_before(new_text, cx) {
                self.edit_as(Some(EditKind::Discrete), range, &text, false, cx);
                return;
            }
            if let Some((range, text)) = self.typed_substitution(new_text) {
                self.edit_as(kind, range, &text, false, cx);
                return;
            }
        }
        self.edit_as(kind, range, new_text, false, cx);
    }

    fn replace_and_mark_text_in_range(
        &mut self,
        range_utf16: Option<Range<usize>>,
        new_text: &str,
        new_selected_range_utf16: Option<Range<usize>>,
        _: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let range = range_utf16
            .as_ref()
            .map(|range| self.range_from_utf16(range))
            .or_else(|| self.marked.clone())
            .unwrap_or_else(|| self.selection.clone());
        if self.secure {
            self.edit(range, new_text, false, cx);
            return;
        }
        if self.marked.is_none() {
            self.history.record(self.snapshot(), EditKind::Typing);
        }
        let start = clamp_to_boundary(&self.text, range.start);
        let end = clamp_to_boundary(&self.text, range.end.max(start));
        let previous_len = self.text.len();
        self.text.replace_range(start..end, new_text);
        self.marked = (!new_text.is_empty()).then(|| start..start + new_text.len());
        let base = self.offset_to_utf16(start);
        let inserted = new_text.encode_utf16().count();
        self.selection = new_selected_range_utf16
            .map(|selected| {
                self.range_from_utf16(
                    &(base + selected.start.min(inserted)..base + selected.end.min(inserted)),
                )
            })
            .unwrap_or_else(|| start + new_text.len()..start + new_text.len());
        self.reversed = false;
        self.completion = false;
        self.goal_x = None;
        self.reveal_caret = true;
        cx.emit(InputEvent::Changed {
            deleting: self.text.len() < previous_len,
        });
        cx.notify();
    }

    fn bounds_for_range(
        &mut self,
        range_utf16: Range<usize>,
        bounds: Bounds<Pixels>,
        _: &mut Window,
        _: &mut Context<Self>,
    ) -> Option<Bounds<Pixels>> {
        if self.wraps() {
            let range = self.range_from_utf16(&range_utf16);
            let origin = point(
                bounds.left() + px(MULTILINE_INSET_X),
                bounds.top() - self.scroll_y,
            );
            let Some(wrapped) = self.wrapped.as_ref().filter(|_| !self.text.is_empty()) else {
                let height = px(self.multiline_line_height);
                return Some(Bounds::new(origin, size(px(0.), height)));
            };
            let start = wrapped.position_for_index(range.start);
            let end = wrapped.position_for_index(range.end);
            let right = if end.y == start.y { end.x } else { start.x };
            return Some(Bounds::from_corners(
                origin + start,
                origin + point(right, start.y + wrapped.line_height()),
            ));
        }
        let line = self.layout.as_ref()?;
        let range = self.range_from_utf16(&range_utf16);
        Some(Bounds::from_corners(
            point(
                bounds.left() + line.x_for_index(self.shown_offset(range.start)) - self.scroll,
                bounds.top(),
            ),
            point(
                bounds.left() + line.x_for_index(self.shown_offset(range.end)) - self.scroll,
                bounds.bottom(),
            ),
        ))
    }

    fn character_index_for_point(
        &mut self,
        point: Point<Pixels>,
        _: &mut Window,
        _: &mut Context<Self>,
    ) -> Option<usize> {
        let local = self.bounds?.localize(&point)?;
        if self.wraps() {
            let wrapped = self.wrapped.as_ref()?;
            let index = wrapped
                .index_for_position(gpui::point(
                    local.x - px(MULTILINE_INSET_X),
                    local.y + self.scroll_y,
                ))
                .min(self.text.len());
            return Some(self.offset_to_utf16(index));
        }
        let line = self.layout.as_ref()?;
        let shown = line.closest_index_for_x(local.x + self.scroll);
        Some(self.offset_to_utf16(self.text_offset(shown)))
    }
}

impl TextInput {
    fn a11y_role(&self) -> Role {
        if self.secure {
            Role::PasswordInput
        } else if self.wraps() {
            Role::MultilineTextInput
        } else {
            Role::TextInput
        }
    }

    fn a11y_shown_text(&self) -> String {
        if self.secure {
            secure_display(&self.text)
        } else {
            self.text.clone()
        }
    }

    fn a11y_selection(&self) -> (usize, usize) {
        let chars = |offset: usize| {
            if self.secure {
                self.text
                    .get(..offset)
                    .map_or(0, |head| head.graphemes(true).count())
            } else {
                self.text
                    .get(..offset)
                    .map_or(0, |head| head.chars().count())
            }
        };
        let anchor = if self.reversed {
            self.selection.end
        } else {
            self.selection.start
        };
        (chars(anchor), chars(self.cursor()))
    }

    fn publish_session(&mut self, focused: bool, window: &Window, cx: &mut Context<Self>) {
        let active = focused && window.is_window_active();
        if self.was_focused && !focused {
            self.history.clear();
            self.text_drag = None;
            self.drop_caret = None;
            self.word_granular = false;
            KillBuffer::end_run(cx);
        }
        self.was_focused = focused;
        let wants_secure_input = active && self.secure;
        if wants_secure_input && self.secure_claim.is_none() {
            self.secure_claim = SecureInputClaim::claim(cx);
        } else if !wants_secure_input {
            self.secure_claim = None;
        }
        let owner = self.focus_owner();
        let published = editing::focused_field_owner();
        if focused && (active || published.is_none() || published == Some(owner)) {
            let mut state = self.edit_state();
            state.window = window.window_handle().window_id().as_u64();
            editing::publish_focused_field(Some(state));
        } else if !focused {
            editing::withdraw_focused_field(owner);
        }
        self.refresh_spelling(cx);
    }
}

impl Drop for TextInput {
    fn drop(&mut self) {
        editing::withdraw_focused_field(self.focus_owner());
    }
}

pub fn a11y_text_children(
    builder: &mut A11ySubtreeBuilder,
    shown: &str,
    selection: (usize, usize),
) {
    let mut run = accesskit::Node::new(Role::TextRun);
    run.set_value(shown.to_owned());
    let lengths: Vec<u8> = shown
        .chars()
        .map(|c| u8::try_from(c.len_utf8()).unwrap_or(4))
        .collect();
    run.set_character_lengths(lengths);
    let run_id = builder.synthetic_node_id("text-run");
    builder.push_child(run_id, run);
    let position = |character_index: usize| accesskit::TextPosition {
        node: run_id,
        character_index,
    };
    builder
        .parent_node()
        .set_text_selection(accesskit::TextSelection {
            anchor: position(selection.0),
            focus: position(selection.1),
        });
}

impl Render for TextInput {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let focused = self.focus.is_focused(window);
        self.publish_session(focused, window, cx);
        let shown = self.a11y_shown_text();
        let selection = self.a11y_selection();
        let role = self.a11y_role();
        let placeholder = self.placeholder.clone();
        let wraps = self.wraps();
        let line_height = if wraps {
            self.multiline_line_height
        } else {
            (self.style.font_size * 1.3).round()
        };
        div()
            .id("text-input")
            .key_context(CONTEXT)
            .track_focus(&self.focus)
            .role(role)
            .aria_value(SharedString::from(shown.clone()))
            .when(!placeholder.is_empty(), |this| {
                this.aria_placeholder(placeholder)
            })
            .a11y_synthetic_children(move |builder| a11y_text_children(builder, &shown, selection))
            .cursor(CursorStyle::IBeam)
            .flex()
            .w_full()
            .when(wraps, |this| this.h_full().items_start())
            .when(!wraps, |this| this.items_center().h(px(line_height)))
            .overflow_hidden()
            .on_action(cx.listener(Self::backspace))
            .on_action(cx.listener(Self::delete))
            .on_action(cx.listener(Self::delete_word_left))
            .on_action(cx.listener(Self::delete_to_start))
            .on_action(cx.listener(Self::left))
            .on_action(cx.listener(Self::right))
            .on_action(cx.listener(Self::word_left))
            .on_action(cx.listener(Self::word_right))
            .on_action(cx.listener(Self::select_left))
            .on_action(cx.listener(Self::select_right))
            .on_action(cx.listener(Self::select_word_left))
            .on_action(cx.listener(Self::select_word_right))
            .on_action(cx.listener(Self::home))
            .on_action(cx.listener(Self::end))
            .on_action(cx.listener(Self::select_home))
            .on_action(cx.listener(Self::select_end))
            .on_action(cx.listener(Self::select_all))
            .on_action(cx.listener(Self::copy))
            .on_action(cx.listener(Self::cut))
            .on_action(cx.listener(Self::paste))
            .on_action(cx.listener(Self::submit))
            .on_action(cx.listener(Self::submit_alternate))
            .on_action(cx.listener(Self::submit_shift))
            .on_action(cx.listener(Self::cancel))
            .on_action(cx.listener(Self::move_up))
            .on_action(cx.listener(Self::move_down))
            .on_action(cx.listener(Self::accept))
            .on_action(cx.listener(Self::show_character_palette))
            .on_action(cx.listener(Self::select_up))
            .on_action(cx.listener(Self::select_down))
            .on_action(cx.listener(Self::document_start))
            .on_action(cx.listener(Self::document_end))
            .on_action(cx.listener(Self::select_document_start))
            .on_action(cx.listener(Self::select_document_end))
            .on_action(cx.listener(Self::undo_action))
            .on_action(cx.listener(Self::redo_action))
            .on_action(cx.listener(Self::paste_and_match_style))
            .on_action(cx.listener(Self::delete_word_right))
            .on_action(cx.listener(Self::delete_to_end))
            .on_action(cx.listener(Self::kill_to_end))
            .on_action(cx.listener(Self::yank))
            .on_action(cx.listener(Self::transpose))
            .on_action(cx.listener(Self::open_line))
            .on_action(cx.listener(Self::previous_line))
            .on_action(cx.listener(Self::next_line))
            .on_action(cx.listener(Self::check_spelling))
            .on_action(cx.listener(Self::toggle_spell_checking))
            .on_action(cx.listener(Self::uppercase_word))
            .on_action(cx.listener(Self::lowercase_word))
            .on_action(cx.listener(Self::capitalize_word))
            .on_action(cx.listener(Self::start_speaking))
            .on_action(cx.listener(Self::stop_speaking))
            .on_action(cx.listener(Self::delete_selection_action))
            .on_action(cx.listener(Self::replace_selection_action))
            .on_action(cx.listener(Self::scroll_to_start))
            .on_action(cx.listener(Self::scroll_to_end))
            .on_action(cx.listener(Self::select_to_start))
            .on_action(cx.listener(Self::select_to_end))
            .on_action(cx.listener(Self::show_spelling_panel))
            .on_action(cx.listener(Self::refresh_spelling_action))
            .on_action(cx.listener(Self::show_substitutions))
            .on_action(cx.listener(Self::toggle_smart_insert))
            .on_action(cx.listener(Self::toggle_smart_quotes))
            .on_action(cx.listener(Self::toggle_smart_dashes))
            .on_action(cx.listener(Self::toggle_smart_links))
            .on_action(cx.listener(Self::toggle_data_detectors))
            .on_action(cx.listener(Self::toggle_text_replacement))
            .on_action(cx.listener(Self::replace_quotes))
            .on_action(cx.listener(Self::replace_dashes))
            .on_action(cx.listener(Self::replace_text))
            .on_action(cx.listener(Self::share_selection))
            .on_mouse_down(MouseButton::Right, cx.listener(Self::on_right_mouse_down))
            .when(focused, |this| {
                this.drag_over::<ExternalItems>(|style, _, _, _| style)
                    .on_drop(cx.listener(Self::on_drop_items))
            })
            .on_mouse_down(MouseButton::Left, cx.listener(Self::on_mouse_down))
            .on_mouse_up(MouseButton::Left, cx.listener(Self::on_mouse_up))
            .on_mouse_up_out(MouseButton::Left, cx.listener(Self::on_mouse_up))
            .on_mouse_move(cx.listener(Self::on_mouse_move))
            .when(wraps, |this| {
                this.on_scroll(cx.listener(Self::on_scroll_wheel))
            })
            .child(InputLine {
                input: cx.entity(),
                line_height: px(line_height),
                fills_height: wraps,
            })
    }
}

pub const MISSPELLING_UNDERLINE: Hsla = Hsla {
    h: 0.0,
    s: 0.85,
    l: 0.55,
    a: 1.0,
};

pub fn styled_runs(
    base: &TextRun,
    len: usize,
    marked: Option<Range<usize>>,
    misspelled: &[Range<usize>],
) -> Vec<TextRun> {
    let mut cuts = vec![0, len];
    for range in marked.iter().chain(misspelled.iter()) {
        cuts.push(range.start.min(len));
        cuts.push(range.end.min(len));
    }
    cuts.sort_unstable();
    cuts.dedup();
    cuts.windows(2)
        .filter(|pair| pair[1] > pair[0])
        .map(|pair| {
            let (start, end) = (pair[0], pair[1]);
            let inside = |range: &Range<usize>| range.start <= start && end <= range.end;
            let underline = if marked.as_ref().is_some_and(inside) {
                Some(UnderlineStyle {
                    color: Some(base.color),
                    thickness: px(1.),
                    wavy: false,
                })
            } else if misspelled.iter().any(inside) {
                Some(UnderlineStyle {
                    color: Some(MISSPELLING_UNDERLINE),
                    thickness: px(1.),
                    wavy: true,
                })
            } else {
                None
            };
            TextRun {
                len: end - start,
                underline,
                ..base.clone()
            }
        })
        .collect()
}

struct InputLine {
    input: Entity<TextInput>,
    line_height: Pixels,
    fills_height: bool,
}

struct InputPaint {
    line: Option<ShapedLine>,
    wrapped: Option<WrappedText>,
    selection: Vec<PaintQuad>,
    caret: Option<PaintQuad>,
    scroll: Pixels,
    scroll_y: Pixels,
}

impl InputLine {
    fn prepaint_wrapped(
        &self,
        bounds: Bounds<Pixels>,
        shown: SharedString,
        runs: &[TextRun],
        window: &mut Window,
        cx: &mut App,
    ) -> InputPaint {
        let input = self.input.read(cx);
        let style = input.style;
        let focused = input.focus.is_focused(window);
        let inset = px(MULTILINE_INSET_X);
        let wrap_width = (bounds.size.width - inset * 2.).max(px(1.));
        let lines = if shown.is_empty() {
            Default::default()
        } else {
            window
                .text_system()
                .shape_text(
                    shown.clone(),
                    px(style.font_size),
                    runs,
                    Some(wrap_width),
                    None,
                )
                .unwrap_or_else(|error| {
                    log::debug!("text input failed to wrap: {error}");
                    Default::default()
                })
        };
        let wrapped = WrappedText::new(shown, lines, self.line_height);
        let has_text = !input.text.is_empty();
        let caret_at = if has_text {
            wrapped.position_for_index(input.cursor())
        } else {
            point(px(0.), px(0.))
        };
        let viewport = bounds.size.height;
        let content = if has_text {
            wrapped.height()
        } else {
            self.line_height
        };
        let scroll_y = if input.reveal_caret {
            reveal_scroll(
                input.scroll_y,
                caret_at.y,
                self.line_height,
                viewport,
                content,
            )
        } else {
            clamp_scroll(input.scroll_y, viewport, content)
        };
        let origin = point(bounds.left() + inset, bounds.top() - scroll_y);
        let right_edge = bounds.right() - inset;
        let selection = if has_text {
            wrapped
                .selection_spans(&input.selection)
                .into_iter()
                .map(|(row, left, right)| {
                    let top = origin.y + self.line_height * row as f32;
                    fill(
                        Bounds::from_corners(
                            point(origin.x + left, top),
                            point(
                                right.map_or(right_edge, |right| origin.x + right),
                                top + self.line_height,
                            ),
                        ),
                        style.selection,
                    )
                })
                .collect()
        } else {
            Vec::new()
        };
        let caret_at = match input.drop_caret.filter(|_| has_text) {
            Some(index) => Some(wrapped.position_for_index(index)),
            None => (focused && input.selection.is_empty()).then_some(caret_at),
        };
        let caret = caret_at.map(|caret_at| {
            fill(
                Bounds::new(
                    point(origin.x + caret_at.x, origin.y + caret_at.y + px(1.)),
                    size(px(1.5), self.line_height - px(2.)),
                ),
                style.caret,
            )
        });
        InputPaint {
            line: None,
            wrapped: Some(wrapped),
            selection,
            caret,
            scroll: px(0.),
            scroll_y,
        }
    }
}

impl Element for InputLine {
    type RequestLayoutState = ();
    type PrepaintState = InputPaint;

    fn id(&self) -> Option<ElementId> {
        None
    }

    fn source_location(&self) -> Option<&'static core::panic::Location<'static>> {
        None
    }

    fn request_layout(
        &mut self,
        _id: Option<&GlobalElementId>,
        _inspector_id: Option<&InspectorElementId>,
        window: &mut Window,
        cx: &mut App,
    ) -> (LayoutId, Self::RequestLayoutState) {
        let mut style = Style::default();
        style.size.width = relative(1.).into();
        style.size.height = if self.fills_height {
            relative(1.).into()
        } else {
            self.line_height.into()
        };
        (window.request_layout(style, [], cx), ())
    }

    fn prepaint(
        &mut self,
        _id: Option<&GlobalElementId>,
        _inspector_id: Option<&InspectorElementId>,
        bounds: Bounds<Pixels>,
        _request_layout: &mut Self::RequestLayoutState,
        window: &mut Window,
        cx: &mut App,
    ) -> Self::PrepaintState {
        let input = self.input.read(cx);
        let style = input.style;
        let focused = input.focus.is_focused(window);
        let (shown, color) = if input.text.is_empty() {
            (input.placeholder.clone(), style.placeholder)
        } else if input.secure {
            (SharedString::from(secure_display(&input.text)), style.text)
        } else {
            (SharedString::from(input.text.clone()), style.text)
        };
        let mut font = window.text_style().font();
        font.weight = style.weight;
        let run = TextRun {
            len: shown.len(),
            font,
            color,
            background_color: None,
            underline: None,
            strikethrough: None,
        };
        let styled = !input.text.is_empty() && !input.secure;
        let marked = input
            .marked
            .clone()
            .filter(|marked| styled && marked.end <= shown.len());
        let misspelled: &[Range<usize>] = if styled { &input.misspelled } else { &[] };
        let runs = styled_runs(&run, shown.len(), marked, misspelled);
        if input.wraps() {
            return self.prepaint_wrapped(bounds, shown, &runs, window, cx);
        }
        let line = if shown.is_empty() {
            None
        } else {
            Some(
                window
                    .text_system()
                    .shape_line(shown, px(style.font_size), &runs, None),
            )
        };
        let cursor = input.cursor();
        let caret_x = match (&line, input.text.is_empty()) {
            (Some(line), false) => line.x_for_index(input.shown_offset(cursor)),
            _ => px(0.),
        };
        let width = bounds.size.width;
        let free_scroll = input.free_scroll && !input.reveal_caret;
        let mut scroll = input.scroll;
        if !free_scroll {
            if caret_x - scroll > width - px(2.) {
                scroll = caret_x - width + px(2.);
            }
            if caret_x < scroll {
                scroll = caret_x;
            }
        }
        let text_width = line
            .as_ref()
            .filter(|_| !input.text.is_empty())
            .map_or(px(0.), |line| line.width);
        if text_width - scroll < width {
            scroll = (text_width - width + px(2.)).max(px(0.));
        }
        if free_scroll {
            scroll = scroll.max(px(0.));
        }
        let selection = (!input.selection.is_empty() && !input.text.is_empty())
            .then(|| {
                line.as_ref().map(|line| {
                    fill(
                        Bounds::from_corners(
                            point(
                                bounds.left()
                                    + line.x_for_index(input.shown_offset(input.selection.start))
                                    - scroll,
                                bounds.top(),
                            ),
                            point(
                                bounds.left()
                                    + line.x_for_index(input.shown_offset(input.selection.end))
                                    - scroll,
                                bounds.bottom(),
                            ),
                        ),
                        style.selection,
                    )
                })
            })
            .flatten();
        let drop_x = input.drop_caret.and_then(|index| {
            line.as_ref()
                .map(|line| line.x_for_index(input.shown_offset(index)))
        });
        let caret = match drop_x {
            Some(x) => Some(fill(
                Bounds::new(
                    point(bounds.left() + x - scroll, bounds.top() + px(1.)),
                    size(px(1.5), bounds.size.height - px(2.)),
                ),
                style.caret,
            )),
            None => (focused && input.selection.is_empty()).then(|| {
                fill(
                    Bounds::new(
                        point(bounds.left() + caret_x - scroll, bounds.top() + px(1.)),
                        size(px(1.5), bounds.size.height - px(2.)),
                    ),
                    style.caret,
                )
            }),
        };
        InputPaint {
            line,
            wrapped: None,
            selection: selection.into_iter().collect(),
            caret,
            scroll,
            scroll_y: px(0.),
        }
    }

    fn paint(
        &mut self,
        _id: Option<&GlobalElementId>,
        _inspector_id: Option<&InspectorElementId>,
        bounds: Bounds<Pixels>,
        _request_layout: &mut Self::RequestLayoutState,
        prepaint: &mut Self::PrepaintState,
        window: &mut Window,
        cx: &mut App,
    ) {
        let focus = self.input.read(cx).focus.clone();
        window.handle_input(
            &focus,
            ElementInputHandler::new(bounds, self.input.clone()),
            cx,
        );
        let scroll = prepaint.scroll;
        let scroll_y = prepaint.scroll_y;
        let line_height = self.line_height;
        window.with_content_mask(Some(gpui::ContentMask { bounds }), |window| {
            for selection in prepaint.selection.drain(..) {
                window.paint_quad(selection);
            }
            if let Some(line) = prepaint.line.as_ref() {
                let painted = line.paint(
                    point(bounds.left() - scroll, bounds.top()),
                    line_height,
                    TextAlign::Left,
                    None,
                    window,
                    cx,
                );
                if let Err(error) = painted {
                    log::debug!("text input failed to paint: {error}");
                }
            }
            if let Some(wrapped) = prepaint.wrapped.as_ref() {
                let left = bounds.left() + px(MULTILINE_INSET_X);
                let top = bounds.top() - scroll_y;
                for paragraph in &wrapped.paragraphs {
                    let y = top + line_height * paragraph.first_row as f32;
                    let rows = paragraph.line.wrap_boundaries().len() + 1;
                    if y > bounds.bottom() || y + line_height * (rows as f32) < bounds.top() {
                        continue;
                    }
                    let painted = paragraph.line.paint(
                        point(left, y),
                        line_height,
                        TextAlign::Left,
                        None,
                        window,
                        cx,
                    );
                    if let Err(error) = painted {
                        log::debug!("text input failed to paint: {error}");
                    }
                }
            }
            if let Some(caret) = prepaint.caret.take() {
                window.paint_quad(caret);
            }
        });
        let line = prepaint.line.take();
        let wrapped = prepaint.wrapped.take();
        self.input.update(cx, |input, _| {
            input.layout = line.filter(|_| !input.text.is_empty());
            input.wrapped = wrapped.filter(|_| !input.text.is_empty());
            input.bounds = Some(bounds);
            input.scroll = scroll;
            input.scroll_y = scroll_y;
            input.free_scroll = input.free_scroll && !input.reveal_caret;
            input.reveal_caret = false;
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use gpui::{TestAppContext, VisualTestContext};

    const CHAR: f32 = 7.8;
    const FIELD_WIDTH: f32 = 82.;
    const FIELD_HEIGHT: f32 = 54.;

    struct Field {
        input: Entity<TextInput>,
    }

    impl Render for Field {
        fn render(&mut self, _: &mut Window, _: &mut Context<Self>) -> impl IntoElement {
            div()
                .w(px(FIELD_WIDTH))
                .h(px(FIELD_HEIGHT))
                .flex()
                .child(self.input.clone())
        }
    }

    fn field(
        cx: &mut TestAppContext,
        multiline: bool,
    ) -> (Entity<TextInput>, &mut VisualTestContext) {
        cx.update(|cx| cx.bind_keys(bindings()));
        let (view, cx) = cx.add_window_view(|_, cx| {
            let input = cx.new(|cx| {
                let input = TextInput::new("", cx);
                if multiline { input.multiline() } else { input }
            });
            Field { input }
        });
        let input = view.read_with(cx, |field, _| field.input.clone());
        cx.update(|window, cx| focus_input(&input, window, cx));
        cx.run_until_parked();
        (input, cx)
    }

    fn type_text(input: &Entity<TextInput>, cx: &mut VisualTestContext, text: &str) {
        input.update(cx, |input, cx| input.set_text(text, false, cx));
        cx.run_until_parked();
    }

    fn cols(x: Pixels) -> f32 {
        (f32::from(x) / CHAR * 100.).round() / 100.
    }

    fn at(position: Point<Pixels>) -> (f32, f32) {
        (cols(position.x), f32::from(position.y))
    }

    fn spans(wrapped: &WrappedText, range: Range<usize>) -> Vec<(usize, f32, Option<f32>)> {
        wrapped
            .selection_spans(&range)
            .into_iter()
            .map(|(row, left, right)| (row, cols(left), right.map(cols)))
            .collect()
    }

    fn shaped(cx: &mut VisualTestContext, text: &str, wrap: f32) -> WrappedText {
        cx.update(|window, _| {
            let shared = SharedString::from(text.to_owned());
            let run = TextRun {
                len: text.len(),
                font: window.text_style().font(),
                color: hsla(0., 0., 0., 1.),
                background_color: None,
                underline: None,
                strikethrough: None,
            };
            let lines = window
                .text_system()
                .shape_text(shared.clone(), px(13.), &[run], Some(px(wrap)), None)
                .unwrap_or_default();
            WrappedText::new(shared, lines, px(18.))
        })
    }

    #[gpui::test]
    fn wrapped_rows_follow_word_wraps_and_newlines(cx: &mut TestAppContext) {
        let (_, cx) = field(cx, true);
        let text = "aaaa bbbb cccc\n\nxy";
        let wrapped = shaped(cx, text, CHAR * 10.5);
        let rows: Vec<(usize, usize, bool)> = wrapped
            .rows()
            .iter()
            .map(|row| (row.start, row.end, row.ends_paragraph))
            .collect();
        assert_eq!(
            rows,
            vec![
                (0, 10, false),
                (10, 14, true),
                (15, 15, true),
                (16, 18, true)
            ]
        );
        assert_eq!(wrapped.height(), px(18. * 4.));
        assert_eq!(at(wrapped.position_for_index(10)), (0., 18.));
        assert_eq!(at(wrapped.position_for_index(14)), (4., 18.));
        assert_eq!(at(wrapped.position_for_index(15)), (0., 36.));
        assert_eq!(at(wrapped.position_for_index(17)), (1., 54.));
        assert_eq!(wrapped.index_for_position(point(px(500.), px(2.))), 9);
        assert_eq!(
            wrapped.index_for_position(point(px(CHAR * 2.2), px(20.))),
            12
        );
        assert_eq!(wrapped.index_for_position(point(px(30.), px(40.))), 15);
        assert_eq!(wrapped.index_for_position(point(px(-4.), px(999.))), 16);
        assert_eq!(wrapped.index_for_position(point(px(5.), px(-9.))), 1);
        assert_eq!(wrapped.row_caret_range(0), 0..9);
        assert_eq!(wrapped.row_caret_range(1), 10..14);
    }

    #[gpui::test]
    fn selection_spans_cover_wraps_and_newlines(cx: &mut TestAppContext) {
        let (_, cx) = field(cx, true);
        let wrapped = shaped(cx, "aaaa bbbb cccc\n\nxy", CHAR * 10.5);
        assert_eq!(
            spans(&wrapped, 2..17),
            vec![
                (0, 2., None),
                (1, 0., None),
                (2, 0., None),
                (3, 0., Some(1.))
            ]
        );
        assert_eq!(spans(&wrapped, 10..12), vec![(1, 0., Some(2.))]);
        assert!(wrapped.selection_spans(&(4..4)).is_empty());
    }

    #[test]
    fn scroll_keeps_the_caret_row_inside_the_viewport() {
        let line = px(18.);
        let viewport = px(78.);
        let content = px(18. * 10.);
        assert_eq!(
            reveal_scroll(px(0.), px(0.), line, viewport, content),
            px(0.)
        );
        assert_eq!(
            reveal_scroll(px(0.), px(18. * 5.), line, viewport, content),
            px(18. * 6.) - viewport
        );
        assert_eq!(
            reveal_scroll(px(90.), px(36.), line, viewport, content),
            px(36.)
        );
        assert_eq!(
            reveal_scroll(px(500.), px(18. * 9.), line, viewport, content),
            content - viewport
        );
        assert_eq!(clamp_scroll(px(40.), viewport, px(50.)), px(0.));
        assert_eq!(clamp_scroll(px(-5.), viewport, content), px(0.));
    }

    #[gpui::test]
    fn return_inserts_a_newline_only_when_multiline(cx: &mut TestAppContext) {
        let (input, cx) = field(cx, true);
        let submits = std::rc::Rc::new(std::cell::Cell::new(0));
        let seen = submits.clone();
        cx.update(|_, cx| {
            cx.subscribe(&input, move |_, event: &InputEvent, _| {
                if matches!(event, InputEvent::Submit(_)) {
                    seen.set(seen.get() + 1);
                }
            })
            .detach()
        });
        cx.simulate_input("ab");
        cx.simulate_keystrokes("enter");
        cx.simulate_input("c");
        cx.simulate_keystrokes("shift-enter");
        cx.simulate_keystrokes("tab");
        cx.run_until_parked();
        assert_eq!(input.read_with(cx, |i, _| i.text().to_owned()), "ab\nc\n\t");
        assert_eq!(submits.get(), 0);
        input.update(cx, |i, cx| i.set_text("one\r\ntwo\rthree", false, cx));
        assert_eq!(
            input.read_with(cx, |i, _| i.text().to_owned()),
            "one\ntwo\nthree"
        );
    }

    #[gpui::test]
    fn single_line_keeps_submit_and_flattens_newlines(cx: &mut TestAppContext) {
        let (input, cx) = field(cx, false);
        let submits = std::rc::Rc::new(std::cell::Cell::new(0));
        let seen = submits.clone();
        cx.update(|_, cx| {
            cx.subscribe(&input, move |_, event: &InputEvent, _| {
                if matches!(event, InputEvent::Submit(SubmitKind::Plain)) {
                    seen.set(seen.get() + 1);
                }
            })
            .detach()
        });
        type_text(&input, cx, "a\nb");
        cx.simulate_keystrokes("enter");
        cx.simulate_keystrokes("shift-up");
        cx.run_until_parked();
        assert_eq!(input.read_with(cx, |i, _| i.text().to_owned()), "a b");
        assert_eq!(input.read_with(cx, |i, _| i.selection()), 3..3);
        assert_eq!(submits.get(), 1);
    }

    #[gpui::test]
    fn arrows_move_by_visual_line_and_keep_the_goal_x(cx: &mut TestAppContext) {
        let (input, cx) = field(cx, true);
        type_text(&input, cx, "abcdefgh\nab\nabcdefgh");
        input.update(cx, |i, cx| i.move_to(6, cx));
        cx.run_until_parked();
        cx.simulate_keystrokes("down");
        assert_eq!(input.read_with(cx, |i, _| i.selection()), 11..11);
        cx.simulate_keystrokes("down");
        assert_eq!(input.read_with(cx, |i, _| i.selection()), 18..18);
        cx.simulate_keystrokes("up up");
        assert_eq!(input.read_with(cx, |i, _| i.selection()), 6..6);
        cx.simulate_keystrokes("up");
        assert_eq!(input.read_with(cx, |i, _| i.selection()), 0..0);
        cx.simulate_keystrokes("shift-down shift-down");
        assert_eq!(input.read_with(cx, |i, _| i.selection()), 0..18);
        cx.simulate_keystrokes("cmd-down");
        assert_eq!(input.read_with(cx, |i, _| i.selection()), 20..20);
        cx.simulate_keystrokes("cmd-shift-up");
        assert_eq!(input.read_with(cx, |i, _| i.selection()), 0..20);
        cx.simulate_keystrokes("cmd-up");
        assert_eq!(input.read_with(cx, |i, _| i.selection()), 0..0);
    }

    #[gpui::test]
    fn caret_moves_scroll_the_field_and_clicks_land_on_rows(cx: &mut TestAppContext) {
        let (input, cx) = field(cx, true);
        type_text(&input, cx, "1\n2\n3\n4\n5\n6");
        input.update(cx, |i, cx| i.move_to(0, cx));
        cx.run_until_parked();
        assert_eq!(input.read_with(cx, |i, _| i.scroll_y), px(0.));
        cx.simulate_keystrokes("cmd-down");
        cx.run_until_parked();
        assert_eq!(
            input.read_with(cx, |i, _| i.scroll_y),
            px(18. * 6. - FIELD_HEIGHT)
        );
        let origin = input.read_with(cx, |i, _| i.bounds.map(|b| b.origin));
        let origin = origin.unwrap_or_default();
        cx.simulate_click(origin + point(px(1.), px(1.)), gpui::Modifiers::none());
        assert_eq!(input.read_with(cx, |i, _| i.selection()), 6..6);
    }

    #[test]
    fn word_motion_skips_spaces_and_punctuation() {
        let text = "hello, big world";
        assert_eq!(previous_word(text, text.len()), 11);
        assert_eq!(previous_word(text, 11), 7);
        assert_eq!(previous_word(text, 7), 0);
        assert_eq!(previous_word(text, 0), 0);
        assert_eq!(next_word(text, 0), 5);
        assert_eq!(next_word(text, 5), 10);
        assert_eq!(next_word(text, 10), text.len());
    }

    #[test]
    fn grapheme_boundaries_keep_emoji_whole() {
        let text = "a👍🏽b";
        let after_emoji = next_boundary(text, 1);
        assert_eq!(&text[1..after_emoji], "👍🏽");
        assert_eq!(previous_boundary(text, after_emoji), 1);
        assert_eq!(clamp_to_boundary(text, 2), 1);
    }

    #[test]
    fn secure_text_shows_one_bullet_per_character_and_maps_offsets_back() {
        let text = "pa\u{e9}ss\u{1f44d}";
        let shown = secure_display(text);
        assert_eq!(shown.chars().count(), 6);
        assert!(shown.chars().all(|c| c == SECURE_BULLET));
        assert_eq!(secure_display_offset(text, 0), 0);
        assert_eq!(secure_display_offset(text, 2), 6);
        assert_eq!(secure_display_offset(text, 4), 9);
        assert_eq!(secure_display_offset(text, text.len()), 18);
        assert_eq!(secure_text_offset(text, 9), 4);
        assert_eq!(secure_text_offset(text, 18), text.len());
        assert_eq!(secure_text_offset(text, 99), text.len());
        assert_eq!(secure_text_offset("", 3), 0);
    }

    struct FakeServices {
        menus: parking_lot::Mutex<Vec<Vec<String>>>,
        pick: parking_lot::Mutex<Option<String>>,
        secure: std::sync::atomic::AtomicIsize,
    }

    impl FakeServices {
        fn new(pick: Option<&str>) -> std::sync::Arc<Self> {
            std::sync::Arc::new(FakeServices {
                menus: parking_lot::Mutex::new(Vec::new()),
                pick: parking_lot::Mutex::new(pick.map(str::to_owned)),
                secure: std::sync::atomic::AtomicIsize::new(0),
            })
        }
    }

    impl editing::TextFieldServices for FakeServices {
        fn show_menu(
            &self,
            items: Vec<crate::host::NativeMenuItem>,
        ) -> Option<futures::channel::oneshot::Receiver<Option<String>>> {
            self.menus.lock().push(
                items
                    .iter()
                    .map(|i| {
                        if i.separator {
                            "-".into()
                        } else {
                            i.title.clone()
                        }
                    })
                    .collect(),
            );
            let (answer, reply) = futures::channel::oneshot::channel();
            let _ = answer.send(self.pick.lock().clone());
            Some(reply)
        }
        fn can_paste(&self) -> bool {
            true
        }
        fn misspelled_ranges(&self, text: &str) -> Vec<Range<usize>> {
            text.match_indices("wrold")
                .map(|(at, w)| at..at + w.len())
                .collect()
        }
        fn guesses(&self, _: &str, _: Range<usize>) -> Vec<String> {
            vec!["world".into(), "wold".into()]
        }
        fn ignore_word(&self, _: &str) {}
        fn learn_word(&self, _: &str) {}
        fn look_up(&self, _: LookUp) {}
        fn search_web(&self, _: &str) {}
        fn speak(&self, _: &str) {}
        fn stop_speaking(&self) {}
        fn is_speaking(&self) -> bool {
            false
        }
        fn text_replacements(&self) -> Vec<(String, String)> {
            vec![("omw".into(), "On my way!".into())]
        }
        fn set_secure_input(&self, on: bool) {
            self.secure
                .fetch_add(if on { 1 } else { -1 }, std::sync::atomic::Ordering::SeqCst);
        }
    }

    fn text_of(input: &Entity<TextInput>, cx: &mut VisualTestContext) -> String {
        input.read_with(cx, |i, _| i.text().to_owned())
    }

    #[gpui::test]
    fn typing_undoes_as_one_step_and_redo_brings_it_back(cx: &mut TestAppContext) {
        let (input, cx) = field(cx, false);
        cx.simulate_input("hello");
        cx.simulate_keystrokes("left");
        cx.simulate_input("X");
        cx.simulate_keystrokes("backspace backspace");
        assert_eq!(text_of(&input, cx), "helo");
        cx.simulate_keystrokes("cmd-z");
        assert_eq!(text_of(&input, cx), "hellXo");
        cx.simulate_keystrokes("cmd-z");
        assert_eq!(text_of(&input, cx), "hello");
        cx.simulate_keystrokes("cmd-z");
        assert_eq!(text_of(&input, cx), "");
        cx.simulate_keystrokes("cmd-z");
        assert_eq!(text_of(&input, cx), "");
        cx.simulate_keystrokes("cmd-shift-z cmd-shift-z");
        assert_eq!(text_of(&input, cx), "hellXo");
        assert!(input.read_with(cx, |i, _| i.can_redo()));
    }

    #[gpui::test]
    fn an_edit_session_ends_when_the_field_loses_focus(cx: &mut TestAppContext) {
        let (input, cx) = field(cx, false);
        cx.simulate_input("abc");
        assert!(input.read_with(cx, |i, _| i.can_undo()));
        cx.update(|window, cx| window.blur(cx));
        cx.run_until_parked();
        assert!(!input.read_with(cx, |i, _| i.can_undo()));
        input.update(cx, |i, cx| i.set_text("set from outside", false, cx));
        assert!(!input.read_with(cx, |i, _| i.can_undo()));
    }

    #[gpui::test]
    fn text_set_while_editing_can_be_undone(cx: &mut TestAppContext) {
        let (input, cx) = field(cx, false);
        cx.simulate_input("query");
        input.update(cx, |i, cx| i.set_text("", false, cx));
        cx.simulate_keystrokes("cmd-z");
        assert_eq!(text_of(&input, cx), "query");
    }

    #[gpui::test]
    fn emacs_keys_kill_yank_and_transpose(cx: &mut TestAppContext) {
        let (input, cx) = field(cx, false);
        cx.simulate_input("hello world");
        cx.simulate_keystrokes("ctrl-a ctrl-f ctrl-f ctrl-f ctrl-f ctrl-f ctrl-k");
        assert_eq!(text_of(&input, cx), "hello");
        cx.simulate_keystrokes("ctrl-a ctrl-y");
        assert_eq!(text_of(&input, cx), " worldhello");
        cx.simulate_keystrokes("ctrl-e ctrl-t");
        assert_eq!(text_of(&input, cx), " worldhelol");
        cx.simulate_keystrokes("ctrl-b ctrl-b ctrl-d ctrl-h");
        assert_eq!(text_of(&input, cx), " worldhel");
        cx.simulate_keystrokes("ctrl-a ctrl-shift-e");
        assert_eq!(input.read_with(cx, |i, _| i.selection()), 0..9);
        cx.simulate_keystrokes("ctrl-p");
        assert_eq!(input.read_with(cx, |i, _| i.selection()), 0..0);
        cx.simulate_keystrokes("ctrl-n alt-left alt-delete");
        assert_eq!(text_of(&input, cx), " ");
    }

    #[gpui::test]
    fn consecutive_kills_join_in_the_kill_buffer(cx: &mut TestAppContext) {
        let (input, cx) = field(cx, true);
        type_text(&input, cx, "one\ntwo");
        input.update(cx, |i, cx| i.move_to(0, cx));
        cx.simulate_keystrokes("ctrl-k ctrl-k ctrl-k");
        assert_eq!(text_of(&input, cx), "");
        cx.simulate_keystrokes("ctrl-y");
        assert_eq!(text_of(&input, cx), "one\ntwo");
    }

    #[gpui::test]
    fn the_command_bar_folds_pasted_lines(cx: &mut TestAppContext) {
        let (input, cx) = field(cx, false);
        input.update(cx, |i, _| i.set_folds_pasted_lines(true));
        cx.write_to_clipboard(ClipboardItem::new_string(
            "  https://exa\nmple.com/a\n".to_owned(),
        ));
        cx.simulate_keystrokes("cmd-v");
        assert_eq!(text_of(&input, cx), "https://example.com/a");
        cx.write_to_clipboard(ClipboardItem::new_string("two\nwords".to_owned()));
        cx.simulate_keystrokes("cmd-a cmd-shift-v");
        assert_eq!(text_of(&input, cx), "twowords");
        cx.write_to_clipboard(ClipboardItem::new_string("a b\nc".to_owned()));
        cx.simulate_keystrokes("cmd-a cmd-v");
        assert_eq!(text_of(&input, cx), "a b c");
    }

    #[gpui::test]
    fn a_secure_field_never_copies_and_holds_secure_input_while_focused(cx: &mut TestAppContext) {
        let services = FakeServices::new(None);
        cx.update(|cx| TextServices::install(services.clone(), cx));
        let (input, cx) = field(cx, false);
        input.update(cx, |i, cx| i.set_secure(true, cx));
        cx.update(|window, _| window.activate_window());
        cx.simulate_input("hunter2");
        cx.run_until_parked();
        cx.write_to_clipboard(ClipboardItem::new_string("before".to_owned()));
        cx.simulate_keystrokes("cmd-a cmd-c cmd-x");
        assert_eq!(text_of(&input, cx), "hunter2");
        assert_eq!(
            cx.read_from_clipboard().and_then(|c| c.text()).as_deref(),
            Some("before")
        );
        assert_eq!(services.secure.load(std::sync::atomic::Ordering::SeqCst), 1);
        cx.update(|window, cx| window.blur(cx));
        cx.run_until_parked();
        assert_eq!(services.secure.load(std::sync::atomic::Ordering::SeqCst), 0);
    }

    #[gpui::test]
    fn right_click_selects_the_word_and_a_guess_replaces_it(cx: &mut TestAppContext) {
        let services = FakeServices::new(Some("spelling.guess:0"));
        cx.update(|cx| TextServices::install(services.clone(), cx));
        let (input, cx) = field(cx, false);
        type_text(&input, cx, "a wrold");
        let origin = input.read_with(cx, |i, _| i.bounds.map(|b| b.origin).unwrap_or_default());
        cx.simulate_mouse_down(
            origin + point(px(CHAR * 4.), px(4.)),
            MouseButton::Right,
            gpui::Modifiers::none(),
        );
        cx.run_until_parked();
        assert_eq!(text_of(&input, cx), "a world");
        let menus = services.menus.lock().clone();
        assert_eq!(menus.len(), 1);
        assert_eq!(&menus[0][..3], &["world", "wold", "-"]);
        assert!(menus[0].contains(&"Look Up \u{201C}wrold\u{201D}".to_owned()));
        cx.simulate_keystrokes("cmd-z");
        assert_eq!(text_of(&input, cx), "a wrold");
    }

    #[gpui::test]
    fn transformations_change_the_word_or_selection(cx: &mut TestAppContext) {
        let (input, cx) = field(cx, false);
        type_text(&input, cx, "make it loud");
        input.update(cx, |i, cx| {
            i.move_to(9, cx);
            i.change_case(CaseChange::Upper, cx);
        });
        assert_eq!(text_of(&input, cx), "make it LOUD");
        input.update(cx, |i, cx| {
            i.select_all_text(cx);
            i.change_case(CaseChange::Capitalize, cx);
        });
        assert_eq!(text_of(&input, cx), "Make It Loud");
    }

    #[gpui::test]
    fn dragging_selected_text_moves_it(cx: &mut TestAppContext) {
        let (input, cx) = field(cx, false);
        type_text(&input, cx, "ab cd");
        input.update(cx, |i, cx| i.move_text(0..2, 5, false, cx));
        assert_eq!(text_of(&input, cx), " cdab");
        assert_eq!(input.read_with(cx, |i, _| i.selection()), 3..5);
        input.update(cx, |i, cx| i.move_text(3..5, 0, true, cx));
        assert_eq!(text_of(&input, cx), "ab cdab");
        cx.simulate_keystrokes("cmd-z cmd-z");
        assert_eq!(text_of(&input, cx), "ab cd");
    }

    #[gpui::test]
    fn composition_reports_changes_and_survives_an_echo(cx: &mut TestAppContext) {
        let (input, cx) = field(cx, false);
        let changes = std::rc::Rc::new(std::cell::Cell::new(0));
        let seen = changes.clone();
        cx.update(|_, cx| {
            cx.subscribe(&input, move |_, event: &InputEvent, _| {
                if matches!(event, InputEvent::Changed { .. }) {
                    seen.set(seen.get() + 1);
                }
            })
            .detach()
        });
        cx.update(|window, cx| {
            input.update(cx, |i, cx| {
                i.replace_and_mark_text_in_range(None, "\u{3042}", Some(1..1), window, cx)
            })
        });
        assert_eq!(changes.get(), 1);
        input.update(cx, |i, cx| i.set_text("\u{3042}", false, cx));
        assert!(input.read_with(cx, |i, _| i.marked.is_some()));
        cx.update(|window, cx| {
            input.update(cx, |i, cx| {
                i.replace_text_in_range(None, "\u{611B}", window, cx)
            })
        });
        assert_eq!(text_of(&input, cx), "\u{611B}");
        cx.simulate_keystrokes("cmd-z");
        assert_eq!(text_of(&input, cx), "");
    }

    #[gpui::test]
    fn home_and_end_scroll_without_moving_the_caret(cx: &mut TestAppContext) {
        let (input, cx) = field(cx, false);
        cx.simulate_input("a long line that is wider than the narrow test field");
        cx.run_until_parked();
        let end = input.read_with(cx, |i, _| i.text().len());
        assert!(input.read_with(cx, |i, _| i.scroll) > px(0.));
        cx.simulate_keystrokes("home");
        cx.run_until_parked();
        assert_eq!(input.read_with(cx, |i, _| i.selection()), end..end);
        assert_eq!(input.read_with(cx, |i, _| i.scroll), px(0.));
        cx.simulate_keystrokes("end");
        cx.run_until_parked();
        assert!(input.read_with(cx, |i, _| i.scroll) > px(0.));
        cx.simulate_keystrokes("home shift-end");
        assert_eq!(input.read_with(cx, |i, _| i.selection()), end..end);
        cx.simulate_keystrokes("shift-home");
        assert_eq!(input.read_with(cx, |i, _| i.selection()), 0..end);
        cx.simulate_keystrokes("left");
        cx.run_until_parked();
        assert_eq!(input.read_with(cx, |i, _| i.scroll), px(0.));
    }

    #[gpui::test]
    fn substitutions_apply_while_typing_when_turned_on(cx: &mut TestAppContext) {
        let services = FakeServices::new(None);
        cx.update(|cx| TextServices::install(services.clone(), cx));
        let (input, cx) = field(cx, false);
        cx.simulate_input("say \"hi\" -- it's");
        assert_eq!(text_of(&input, cx), "say \"hi\" -- it's");
        input.update(cx, |i, cx| {
            i.set_text("", false, cx);
            i.set_substitutions(
                Substitutions {
                    quotes: true,
                    dashes: true,
                    replacement: true,
                    ..Substitutions::default()
                },
                cx,
            )
        });
        cx.simulate_input("say \"hi\" -- it's omw ");
        assert_eq!(
            text_of(&input, cx),
            "say \u{201C}hi\u{201D} \u{2014} it\u{2019}s On my way! "
        );
        cx.simulate_keystrokes("cmd-z");
        assert_eq!(
            text_of(&input, cx),
            "say \u{201C}hi\u{201D} \u{2014} it\u{2019}s omw"
        );
    }

    #[gpui::test]
    fn replace_in_selection_and_smart_insert_toggle(cx: &mut TestAppContext) {
        let services = FakeServices::new(None);
        cx.update(|cx| TextServices::install(services.clone(), cx));
        let (input, cx) = field(cx, false);
        type_text(&input, cx, "\"a\"--omw");
        cx.update(|window, cx| {
            input.update(cx, |i, cx| {
                i.select_all_text(cx);
                i.replace_quotes(&ReplaceQuotes, window, cx);
                i.select_all_text(cx);
                i.replace_dashes(&ReplaceDashes, window, cx);
                i.select_all_text(cx);
                i.replace_text(&ReplaceText, window, cx);
            })
        });
        assert_eq!(text_of(&input, cx), "\u{201C}a\u{201D}\u{2014}On my way!");
        assert!(input.read_with(cx, |i, _| i.substitutions().smart_insert));
        cx.update(|window, cx| {
            input.update(cx, |i, cx| {
                i.toggle_smart_insert(&ToggleSmartInsert, window, cx)
            })
        });
        assert!(!input.read_with(cx, |i, _| i.substitutions().smart_insert));
        let state = input.read_with(cx, |i, _| i.edit_state());
        assert_eq!(
            selector_checked("toggleSmartInsertDelete:", &state),
            Some(false)
        );
        assert_eq!(selector_checked("cut:", &state), None);
    }

    #[test]
    fn menu_selectors_map_to_field_actions() {
        for selector in FIELD_SELECTORS {
            assert!(action_for_selector(selector).is_some(), "{selector}");
        }
        assert!(action_for_selector("startDictation:").is_none());
        let state = FieldEditState {
            can_undo: true,
            has_text: true,
            has_selection: true,
            secure: true,
            ..FieldEditState::default()
        };
        assert!(selector_enabled("undo:", &state, false, false));
        assert!(!selector_enabled("copy:", &state, true, false));
        assert!(!selector_enabled("cut:", &state, true, false));
        assert!(selector_enabled("paste:", &state, true, false));
        assert!(!selector_enabled("redo:", &state, true, false));
    }

    #[test]
    fn runs_mark_composition_and_misspellings() {
        let base = TextRun {
            len: 0,
            font: gpui::font("Helvetica"),
            color: hsla(0., 0., 0., 1.),
            background_color: None,
            underline: None,
            strikethrough: None,
        };
        let runs = styled_runs(&base, 14, Some(0..2), &[6..11, 12..14]);
        let shape: Vec<(usize, Option<bool>)> = runs
            .iter()
            .map(|run| (run.len, run.underline.map(|u| u.wavy)))
            .collect();
        assert_eq!(
            shape,
            vec![
                (2, Some(false)),
                (4, None),
                (5, Some(true)),
                (1, None),
                (2, Some(true))
            ]
        );
    }

    #[test]
    fn double_click_finds_the_word_under_the_pointer() {
        assert_eq!(word_at("open the door", 6), 5..8);
        assert_eq!(word_at("open", 4), 0..4);
    }
}
