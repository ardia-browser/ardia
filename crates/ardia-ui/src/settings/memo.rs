use std::cell::{OnceCell, RefCell};
use std::rc::Rc;
use std::sync::Arc;

use gpui::{
    AnyElement, IntoElement, ParentElement, ScrollHandle, SharedString, Styled, div, prelude::*,
};
use serde_json::Value;

use crate::host::UiHost;
use crate::look::Palette;
use crate::primitives::list::{divider, group};
use crate::primitives::tokens::{THICK_HAIRLINE, radius, space};
use crate::primitives::virtual_list::{VirtualItem, virtual_list};
use crate::scale::px;
use crate::settings::data::SettingsQuery;

pub(crate) const ROW_ESTIMATE: f32 = 35.0;
pub(crate) const DESCRIBED_ROW_ESTIMATE: f32 = 49.0;

pub(crate) struct Memo<K, V>(RefCell<Option<(K, Rc<V>)>>);

impl<K, V> Default for Memo<K, V> {
    fn default() -> Self {
        Memo(RefCell::new(None))
    }
}

impl<K: PartialEq, V> Memo<K, V> {
    pub(crate) fn get(&self, key: K, build: impl FnOnce(&K) -> V) -> Rc<V> {
        if let Some((cached, value)) = self.0.borrow().as_ref()
            && *cached == key
        {
            return value.clone();
        }
        let value = Rc::new(build(&key));
        *self.0.borrow_mut() = Some((key, value.clone()));
        value
    }
}

struct ValueEntry<V> {
    query: SettingsQuery,
    revision: Option<u64>,
    value: Option<Value>,
    built: Rc<V>,
}

pub(crate) struct ValueMemo<V>(RefCell<Option<ValueEntry<V>>>);

impl<V> Default for ValueMemo<V> {
    fn default() -> Self {
        ValueMemo(RefCell::new(None))
    }
}

impl<V> ValueMemo<V> {
    pub(crate) fn get(
        &self,
        host: &dyn UiHost,
        query: SettingsQuery,
        build: impl FnOnce(&Option<Value>) -> V,
    ) -> Rc<V> {
        let revision = host.settings_revision(&query);
        if let Some(entry) = self.0.borrow().as_ref()
            && entry.query == query
            && revision.is_some()
            && entry.revision == revision
        {
            return entry.built.clone();
        }
        let value = host.settings_value(&query);
        let mut slot = self.0.borrow_mut();
        if let Some(entry) = slot.as_mut()
            && entry.query == query
            && entry.value == value
        {
            entry.revision = revision;
            return entry.built.clone();
        }
        let built = Rc::new(build(&value));
        *slot = Some(ValueEntry {
            query,
            revision,
            value,
            built: built.clone(),
        });
        built
    }
}

pub(crate) struct Same<T>(pub Rc<T>);

impl<T> PartialEq for Same<T> {
    fn eq(&self, other: &Self) -> bool {
        Rc::ptr_eq(&self.0, &other.0)
    }
}

pub(crate) struct SameArc<T>(pub Arc<T>);

impl<T> PartialEq for SameArc<T> {
    fn eq(&self, other: &Self) -> bool {
        Arc::ptr_eq(&self.0, &other.0)
    }
}

pub(crate) struct Listed<T> {
    pub rows: Vec<T>,
    pub items: Vec<VirtualItem>,
}

impl<T> Listed<T> {
    pub(crate) fn new(
        rows: Vec<T>,
        key: impl Fn(&T) -> String,
        height: impl Fn(&T) -> f32,
    ) -> Self {
        let items = rows
            .iter()
            .map(|row| VirtualItem::new(key(row), height(row)))
            .collect();
        Listed { rows, items }
    }
}

#[derive(Default)]
pub(crate) struct FrameCache {
    pub(crate) blocker: OnceCell<Option<crate::site::model::ContentBlockerView>>,
}

type PasswordRows = Option<Vec<crate::settings::subpages::PasswordRow>>;
type ShortcutInputs = (SameArc<Settings>, SameArc<Vec<ardia_state::ProfileId>>);
type Settings = ardia_state::settings::Settings;
type ShortcutRows = Vec<crate::settings::panes::ResolvedShortcut>;

#[derive(Default)]
pub(crate) struct Memos {
    pub(crate) frame: FrameCache,
    pub(crate) passwords: ValueMemo<PasswordRows>,
    pub(crate) passwords_shown: Memo<(Same<PasswordRows>, String), Listed<usize>>,
    pub(crate) never_saved: ValueMemo<Listed<String>>,
    pub(crate) origins: ValueMemo<Option<Listed<String>>>,
    pub(crate) zooms: ValueMemo<Listed<(String, f64)>>,
    pub(crate) extensions: ValueMemo<Option<Listed<crate::settings::subpages::ExtensionRow>>>,
    pub(crate) hidden: ValueMemo<Listed<crate::settings::general_subpages::HiddenHost>>,
    pub(crate) whats_sent: Memo<(), Listed<crate::settings::general_subpages::SentPiece>>,
    pub(crate) shortcuts: Memo<ShortcutInputs, ShortcutRows>,
    pub(crate) shortcuts_shown: Memo<
        (
            Same<ShortcutRows>,
            String,
            crate::settings::panes::ShortcutFilter,
        ),
        crate::settings::panes::ShortcutSections,
    >,
    pub(crate) results: Memo<
        (String, SameArc<Settings>, crate::settings::rows::System),
        Listed<&'static crate::settings::rows::Row>,
    >,
    pub(crate) key_hits: Memo<(String, ShortcutInputs), Listed<crate::settings::panes::KeyHit>>,
}

impl Memos {
    pub(crate) fn shortcut_inputs(state: &ardia_state::BrowserState) -> ShortcutInputs {
        (
            SameArc(state.settings.clone()),
            SameArc(state.profile_order.clone()),
        )
    }
}

pub(crate) fn divided(p: &Palette, divide: bool, row: AnyElement) -> AnyElement {
    div()
        .flex_none()
        .flex()
        .flex_col()
        .when(divide, |this| this.child(divider(p, true, space::L)))
        .child(row)
        .into_any_element()
}

pub(crate) fn grouped_list(
    p: &Palette,
    key: impl Into<SharedString>,
    scroll: &ScrollHandle,
    items: Vec<VirtualItem>,
    mut row: impl FnMut(usize) -> AnyElement,
) -> AnyElement {
    let list = virtual_list(key, scroll)
        .items(items)
        .render(|index, _| divided(p, index > 0, row(index)));
    group(p, [list]).into_any_element()
}

pub(crate) fn group_piece(p: &Palette, first: bool, last: bool, row: AnyElement) -> AnyElement {
    div()
        .flex_none()
        .flex()
        .flex_col()
        .bg(p.group_fill)
        .border_color(p.group_border)
        .border_l(px(THICK_HAIRLINE))
        .border_r(px(THICK_HAIRLINE))
        .overflow_hidden()
        .when(first, |this| {
            this.border_t(px(THICK_HAIRLINE))
                .rounded_t(px(radius::PANEL))
        })
        .when(last, |this| {
            this.border_b(px(THICK_HAIRLINE))
                .rounded_b(px(radius::PANEL))
        })
        .when(!first, |this| this.child(divider(p, true, space::L)))
        .child(row)
        .into_any_element()
}

pub(crate) fn wrapped(element: impl IntoElement) -> AnyElement {
    div()
        .flex_none()
        .flex()
        .flex_col()
        .child(element)
        .into_any_element()
}
