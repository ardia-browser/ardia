use std::collections::{HashMap, HashSet};
use std::sync::Arc;

use ardia_state::WindowId;
use ardia_theme::tokens::{TypeSize, radius, space};
use gpui::{
    AnyElement, App, Context, Entity, FocusHandle, FontWeight, Hsla, IntoElement, KeyDownEvent,
    MouseButton, ParentElement, Pixels, Point, Render, SharedString, Styled, Subscription, Window,
    deferred, div, prelude::*, relative,
};
use serde_json::{Map, Value};

use super::form::{
    FormValue, controlled_value_of, field_nodes, form_values, initial_of, select_options,
    shown_select_value, values_json,
};
use super::markdown::{Block, Span, parse_markdown};
use super::model::{Child, PluginHost, PluginNode, SurfaceKind, SurfaceMount};
use super::nodes::{
    FuzzyQuery, actions_in, bool_prop, flatten_node_refs, handler_of, is_web_url, node_key,
    node_of_value, num_prop, plugin_file_url, records_of, str_of, str_prop, strings_of, text_of,
};
use super::shortcuts::{
    Binding, PluginShortcut, bindings_of, gpui_key_press, merge_bindings, pressed_binding,
    shortcut_text,
};
use super::tokens::{
    LIST_ROW_PAD, LIST_ROW_RADIUS, ROW_HEIGHT, Role, fill_tone_of, icon_named, size_of, space_of,
    surface, symbol, tone_of,
};
use crate::host::UiHost;
use crate::host_data::{HostLink, HostTopics};
use crate::look::Palette;
use crate::primitives::controls::{
    ButtonKind, MenuRow, PopUp, PushButton, Toggle, popover, progress_bar, spinner,
};
use crate::primitives::icons::{Icon, icon};
use crate::primitives::pop_up_menu::{self, PopUpChoice};
use crate::primitives::text_input::{InputEvent, InputStyle, TextInput};
use crate::primitives::virtual_list::{self, Align, VirtualItem, virtual_list};
use crate::scale::px;

pub fn plugin_host(host: &Arc<dyn UiHost>) -> Option<Arc<dyn PluginHost>> {
    host.plugins()
}

pub fn held_by_ardia(host: &Arc<dyn UiHost>, shortcut: &PluginShortcut) -> bool {
    let platform = ardia_state::shortcuts::Platform::current();
    let Some(parsed) =
        ardia_state::shortcuts::Shortcut::parse_combo(&shortcut_text(shortcut), platform)
    else {
        return false;
    };
    !host
        .store()
        .snapshot()
        .shortcut_map(platform)
        .holders(&parsed)
        .is_empty()
}

pub fn shortcut_label(shortcut: &PluginShortcut) -> String {
    let platform = ardia_state::shortcuts::Platform::current();
    ardia_state::shortcuts::Shortcut::parse_combo(&shortcut_text(shortcut), platform)
        .map(|parsed| parsed.format(platform))
        .unwrap_or_else(|| super::shortcuts::shortcut_hint(shortcut))
}

pub fn panel_shortcuts(
    host: &Arc<dyn UiHost>,
    actions: &[PluginNode],
) -> Vec<(PluginNode, PluginShortcut)> {
    let bindings = bindings_of(
        actions
            .iter()
            .filter_map(|a| a.prop("shortcut").map(|raw| (raw, a.clone()))),
    );
    merge_bindings(&[(0, 0, bindings)], |s| held_by_ardia(host, s))
        .into_iter()
        .map(|b| (b.action, b.shortcut))
        .collect()
}

fn hint_for(shortcuts: &[(PluginNode, PluginShortcut)], action: &PluginNode) -> Option<String> {
    shortcuts
        .iter()
        .find(|(known, _)| known == action)
        .map(|(_, s)| shortcut_label(s))
}

#[derive(Clone, Debug, Default)]
struct ListState {
    query: String,
    selected: Option<String>,
    notified: Option<Option<String>>,
    user_picked: bool,
    seen_search_text: Option<String>,
    seen_selected: Option<String>,
    revealed: Option<Option<String>>,
}

#[derive(Clone, Debug, PartialEq)]
enum Entry {
    Section {
        key: String,
        title: Option<String>,
        subtitle: Option<String>,
    },
    Item {
        id: String,
        node: Arc<PluginNode>,
    },
}

fn item_entry(node: &PluginNode, fallback: String, scope: &str) -> Entry {
    let id = str_prop(node, "id").unwrap_or_else(|| match &node.key {
        Some(key) => format!("{scope}k:{key}"),
        None => fallback,
    });
    Entry::Item {
        id,
        node: Arc::new(node.clone()),
    }
}

fn item_matches(node: &PluginNode, query: Option<&FuzzyQuery>) -> bool {
    let Some(query) = query else {
        return true;
    };
    let title = str_prop(node, "title");
    let subtitle = str_prop(node, "subtitle");
    let keywords = strings_of(node.prop("keywords"));
    let mut fields = vec![title.as_deref(), subtitle.as_deref()];
    fields.extend(keywords.iter().map(|k| Some(k.as_str())));
    query.score(&fields) > 0
}

fn list_entries(list: &PluginNode, query: &str, filtering: bool) -> Vec<Entry> {
    let mut out = Vec::new();
    let keep = |n: &PluginNode| n.kind == "ListItem" || n.kind == "ListSection";
    let fuzzy = if filtering {
        FuzzyQuery::new(query)
    } else {
        None
    };
    let matches = |node: &PluginNode| item_matches(node, fuzzy.as_ref());
    for (section_index, node) in flatten_node_refs(&list.children, &keep)
        .into_iter()
        .enumerate()
    {
        if node.kind == "ListItem" {
            if matches(node) {
                out.push(item_entry(node, format!("i{section_index}"), ""));
            }
            continue;
        }
        let scope = format!("s{section_index}");
        let items: Vec<Entry> = flatten_node_refs(&node.children, &|n| n.kind == "ListItem")
            .into_iter()
            .enumerate()
            .filter(|(_, item)| matches(item))
            .map(|(index, item)| item_entry(item, format!("{scope}i{index}"), &scope))
            .collect();
        if items.is_empty() {
            continue;
        }
        out.push(Entry::Section {
            key: scope,
            title: str_prop(node, "title"),
            subtitle: str_prop(node, "subtitle"),
        });
        out.extend(items);
    }
    out
}

pub fn list_items(list: &PluginNode, query: &str) -> Vec<(String, PluginNode)> {
    list_entries(
        list,
        query,
        list.prop("filtering") != Some(&Value::Bool(false)),
    )
    .into_iter()
    .filter_map(|entry| match entry {
        Entry::Item { id, node } => Some((id, (*node).clone())),
        Entry::Section { .. } => None,
    })
    .collect()
}

fn list_filtering(list: &PluginNode) -> bool {
    list.prop("filtering") != Some(&Value::Bool(false))
}

const SECTION_DIVIDER_HEIGHT: f32 = 0.5 + 2.0 * space::XS;

fn section_height(title: &Option<String>, subtitle: &Option<String>) -> f32 {
    if title.is_none() && subtitle.is_none() {
        SECTION_DIVIDER_HEIGHT
    } else {
        TypeSize::Caption.line_height() + 2.0 * space::XS
    }
}

struct ListEntries {
    entries: Vec<Entry>,
    rows: Vec<VirtualItem>,
    first_index_of: HashMap<String, usize>,
    first_item: Option<usize>,
}

impl ListEntries {
    fn new(entries: Vec<Entry>) -> Self {
        let mut first_index_of = HashMap::new();
        let mut used = HashSet::new();
        let mut first_item = None;
        let rows = entries
            .iter()
            .enumerate()
            .map(|(index, entry)| match entry {
                Entry::Section {
                    key,
                    title,
                    subtitle,
                } => VirtualItem::new(format!("s\u{0}{key}"), section_height(title, subtitle)),
                Entry::Item { id, .. } => {
                    first_item.get_or_insert(index);
                    first_index_of.entry(id.clone()).or_insert(index);
                    let key = if used.insert(id.clone()) {
                        format!("i\u{0}{id}")
                    } else {
                        format!("i\u{0}{id}\u{0}{index}")
                    };
                    VirtualItem::new(key, surface::ITEM_HEIGHT)
                }
            })
            .collect();
        ListEntries {
            entries,
            rows,
            first_index_of,
            first_item,
        }
    }

    fn item_at(&self, index: usize) -> Option<(&String, &Arc<PluginNode>)> {
        match self.entries.get(index)? {
            Entry::Item { id, node } => Some((id, node)),
            Entry::Section { .. } => None,
        }
    }

    fn effective_index(&self, selected: Option<&String>) -> Option<usize> {
        selected
            .and_then(|id| self.first_index_of.get(id).copied())
            .or(self.first_item)
    }

    fn effective(&self, selected: Option<&String>) -> Option<(String, PluginNode)> {
        let index = self.effective_index(selected)?;
        self.item_at(index)
            .map(|(id, node)| (id.clone(), (**node).clone()))
    }

    fn item_ids(&self) -> Vec<String> {
        self.entries
            .iter()
            .filter_map(|entry| match entry {
                Entry::Item { id, .. } => Some(id.clone()),
                Entry::Section { .. } => None,
            })
            .collect()
    }
}

struct ListCache {
    children: Vec<Child>,
    query: String,
    filtering: bool,
    entries: Arc<ListEntries>,
}

pub fn stepped(items: &[String], current: Option<&str>, by: i32) -> Option<String> {
    if items.is_empty() {
        return None;
    }
    let count = items.len() as i32;
    let at = current
        .and_then(|c| items.iter().position(|i| i == c))
        .unwrap_or(0) as i32;
    Some(items[(at + by + count).rem_euclid(count) as usize].clone())
}

struct Menu {
    actions: Vec<PluginNode>,
    at: Point<Pixels>,
}

pub struct PluginSurfaceView {
    host: Arc<dyn UiHost>,
    plugins: Arc<dyn PluginHost>,
    pub plugin: String,
    pub instance: String,
    kind: SurfaceKind,
    window_id: WindowId,
    lists: HashMap<String, ListState>,
    forms: HashMap<String, HashMap<String, FormValue>>,
    own: HashMap<String, FormValue>,
    pending: HashMap<String, (PluginNode, FormValue)>,
    inputs: HashMap<String, Entity<TextInput>>,
    latest: HashMap<String, PluginNode>,
    list_cache: HashMap<String, ListCache>,
    markdown_cache: HashMap<String, (String, Arc<Vec<Block>>)>,
    touched: HashSet<String>,
    list_keys: HashSet<SharedString>,
    form_of_field: HashMap<String, String>,
    collapsed: HashMap<String, bool>,
    closed_items: HashMap<String, bool>,
    registrations: Vec<(usize, usize, Vec<Binding<PluginNode>>)>,
    bindings: Vec<Binding<PluginNode>>,
    menu: Option<Menu>,
    select_menu: Option<SelectMenu>,
    pending_input_text: Vec<(Entity<TextInput>, String)>,
    pending_copy: std::cell::RefCell<Option<String>>,
    focus: FocusHandle,
    p: Palette,
    _subscriptions: Vec<Subscription>,
    files: super::file_view::FileViews,
    _link: HostLink,
}

static NEXT_INSTANCE: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);

pub fn next_instance_id(view: &str) -> String {
    let n = NEXT_INSTANCE.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    format!("{view}#{n}")
}

pub struct SurfaceSpec {
    pub plugin: String,
    pub view: String,
    pub kind: SurfaceKind,
    pub window: WindowId,
    pub context: Map<String, Value>,
}

impl PluginSurfaceView {
    pub fn new(
        host: Arc<dyn UiHost>,
        plugins: Arc<dyn PluginHost>,
        spec: SurfaceSpec,
        p: Palette,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Self {
        let instance = next_instance_id(&spec.view);
        plugins.mount_surface(SurfaceMount {
            plugin: spec.plugin.clone(),
            instance: instance.clone(),
            view: spec.view,
            kind: spec.kind,
            window: spec.window.clone(),
            context: spec.context,
        });
        let link = HostLink::new(
            host.host_signal(),
            HostTopics::PLUGINS,
            window,
            cx,
            |_, _, _, cx| cx.notify(),
        );
        PluginSurfaceView {
            host,
            plugins,
            plugin: spec.plugin,
            instance,
            kind: spec.kind,
            window_id: spec.window,
            lists: HashMap::new(),
            forms: HashMap::new(),
            own: HashMap::new(),
            pending: HashMap::new(),
            inputs: HashMap::new(),
            latest: HashMap::new(),
            list_cache: HashMap::new(),
            markdown_cache: HashMap::new(),
            touched: HashSet::new(),
            list_keys: HashSet::new(),
            form_of_field: HashMap::new(),
            collapsed: HashMap::new(),
            closed_items: HashMap::new(),
            registrations: Vec::new(),
            bindings: Vec::new(),
            menu: None,
            select_menu: None,
            pending_input_text: Vec::new(),
            pending_copy: std::cell::RefCell::new(None),
            focus: cx.focus_handle(),
            p,
            _subscriptions: Vec::new(),
            files: super::file_view::FileViews::default(),
            _link: link,
        }
    }

    pub fn kind(&self) -> SurfaceKind {
        self.kind
    }

    pub fn set_palette(&mut self, p: Palette) {
        self.p = p;
    }

    pub fn focus_handle(&self) -> &FocusHandle {
        &self.focus
    }

    pub fn copied(&self) -> Option<String> {
        self.pending_copy.borrow().clone()
    }

    pub fn has_shortcuts(&self) -> bool {
        !self.bindings.is_empty()
    }

    fn fire(&self, handler: Option<&Value>, args: Vec<Value>, gesture: bool) -> bool {
        let Some(handler) = handler_of(handler) else {
            return false;
        };
        self.plugins.fire(
            &self.plugin,
            &self.instance,
            &self.window_id,
            handler,
            args,
            gesture,
        )
    }

    pub fn run_action(&self, action: Option<&PluginNode>) -> bool {
        let Some(action) = action else {
            return false;
        };
        let mut ran = false;
        if let Some(url) = is_web_url(action.prop("url")) {
            self.plugins.open_url(&self.window_id, url);
            ran = true;
        } else if let Some(Value::String(copy)) = action.prop("copy") {
            self.pending_copy.replace(Some(copy.clone()));
            ran = true;
        }
        if handler_of(action.prop("onAction")).is_some() {
            return self.fire(action.prop("onAction"), Vec::new(), true) || ran;
        }
        ran
    }

    pub fn press(&mut self, event: &KeyDownEvent, cx: &mut Context<Self>) -> bool {
        let press = gpui_key_press(&event.keystroke);
        let Some(hit) = pressed_binding(&self.bindings, &press).cloned() else {
            return false;
        };
        if held_by_ardia(&self.host, &hit.shortcut) {
            return false;
        }
        self.run_action(Some(&hit.action));
        cx.notify();
        true
    }

    fn register(&mut self, depth: usize, actions: &[PluginNode]) {
        let bindings = bindings_of(
            actions
                .iter()
                .filter_map(|a| a.prop("shortcut").map(|raw| (raw, a.clone()))),
        );
        if bindings.is_empty() {
            return;
        }
        let seq = self.registrations.len();
        self.registrations.push((depth, seq, bindings));
    }

    fn input(
        &mut self,
        path: &str,
        placeholder: &str,
        initial: &str,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Entity<TextInput> {
        if let Some(input) = self.inputs.get(path) {
            let input = input.clone();
            input.update(cx, |input, cx| {
                input.set_placeholder(placeholder.to_owned(), cx)
            });
            return input;
        }
        let p = self.p;
        let style = InputStyle {
            text: p.text,
            placeholder: p.placeholder,
            caret: p.caret,
            selection: p.selection,
            font_size: TypeSize::Body.points(),
            weight: FontWeight::NORMAL,
        };
        let text = initial.to_owned();
        let placeholder = placeholder.to_owned();
        let input = cx.new(|cx| {
            let mut input = TextInput::new(placeholder, cx);
            input.set_style(style, cx);
            if !text.is_empty() {
                input.set_text(text, false, cx);
            }
            input
        });
        let key = path.to_owned();
        let subscription = cx.subscribe_in(
            &input,
            window,
            move |view, input, event: &InputEvent, window, cx| {
                let text = input.read(cx).text().to_owned();
                view.on_input(&key, text, event, window, cx);
            },
        );
        self._subscriptions.push(subscription);
        self.inputs.insert(path.to_owned(), input.clone());
        input
    }

    fn on_input(
        &mut self,
        path: &str,
        text: String,
        event: &InputEvent,
        _window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let Some(node) = self.latest.get(path).cloned() else {
            return;
        };
        if node.kind == "List" {
            match event {
                InputEvent::Changed { .. } => {
                    self.lists.entry(path.to_owned()).or_default().query = text.clone();
                    self.fire(
                        node.prop("onSearchTextChange"),
                        vec![Value::String(text)],
                        true,
                    );
                }
                InputEvent::Up => self.step_list(path, &node, -1),
                InputEvent::Down => self.step_list(path, &node, 1),
                InputEvent::Submit(_) => {
                    let current = self.current_item(path, &node);
                    self.activate(path, &node, current);
                }
                _ => {}
            }
            cx.notify();
            return;
        }
        match event {
            InputEvent::Changed { .. } => {
                if !bool_prop(&node, "disabled") {
                    self.set_field(path, &node, FormValue::Text(text));
                }
            }
            InputEvent::Submit(_) if !bool_prop(&node, "disabled") => {
                if let Some(form) = self.form_of_field.get(path).cloned() {
                    self.submit(&form);
                }
            }
            _ => {}
        }
        cx.notify();
    }

    fn set_field(&mut self, path: &str, node: &PluginNode, value: FormValue) {
        let id = str_prop(node, "id").unwrap_or_default();
        if controlled_value_of(node).is_some() {
            self.pending
                .insert(path.to_owned(), (node.clone(), value.clone()));
        } else if let (Some(form), false) = (self.form_of_field.get(path), id.is_empty()) {
            self.forms
                .entry(form.clone())
                .or_default()
                .insert(id, value.clone());
        } else {
            self.own.insert(path.to_owned(), value.clone());
        }
        self.fire(node.prop("onChange"), vec![value.to_json()], true);
    }

    fn field_value(&self, path: &str, node: &PluginNode) -> FormValue {
        if let Some(controlled) = controlled_value_of(node) {
            return match self.pending.get(path) {
                Some((typed_for, value)) if typed_for == node => value.clone(),
                _ => controlled,
            };
        }
        let id = str_prop(node, "id").unwrap_or_default();
        if let (Some(form), false) = (self.form_of_field.get(path), id.is_empty()) {
            return self
                .forms
                .get(form)
                .and_then(|edits| edits.get(&id))
                .cloned()
                .unwrap_or_else(|| initial_of(node));
        }
        self.own
            .get(path)
            .cloned()
            .unwrap_or_else(|| initial_of(node))
    }

    pub fn submit(&mut self, form_path: &str) {
        let Some(form) = self.latest.get(form_path).cloned() else {
            return;
        };
        if bool_prop(&form, "isLoading") || handler_of(form.prop("onSubmit")).is_none() {
            return;
        }
        let edits = self.forms.get(form_path).cloned().unwrap_or_default();
        let values = form_values(&field_nodes(&form), &edits);
        self.fire(form.prop("onSubmit"), vec![values_json(&values)], true);
    }

    fn list_entries_of(&mut self, path: &str, node: &PluginNode, query: &str) -> Arc<ListEntries> {
        let filtering = list_filtering(node);
        if let Some(cache) = self.list_cache.get(path)
            && cache.filtering == filtering
            && cache.query == query
            && cache.children == node.children
        {
            return Arc::clone(&cache.entries);
        }
        let entries = Arc::new(ListEntries::new(list_entries(node, query, filtering)));
        self.list_cache.insert(
            path.to_owned(),
            ListCache {
                children: node.children.clone(),
                query: query.to_owned(),
                filtering,
                entries: Arc::clone(&entries),
            },
        );
        entries
    }

    fn current_item(&mut self, path: &str, node: &PluginNode) -> Option<(String, PluginNode)> {
        let state = self.lists.entry(path.to_owned()).or_default();
        let (query, selected) = (state.query.clone(), state.selected.clone());
        self.list_entries_of(path, node, &query)
            .effective(selected.as_ref())
    }

    fn step_list(&mut self, path: &str, node: &PluginNode, by: i32) {
        let query = self.lists.entry(path.to_owned()).or_default().query.clone();
        let ids = self.list_entries_of(path, node, &query).item_ids();
        let current = self.current_item(path, node).map(|(id, _)| id);
        if let Some(next) = stepped(&ids, current.as_deref(), by) {
            self.choose(path, node, next);
        }
    }

    fn choose(&mut self, path: &str, node: &PluginNode, id: String) {
        let effective = self.current_item(path, node).map(|(id, _)| id);
        let state = self.lists.entry(path.to_owned()).or_default();
        if Some(&id) != effective.as_ref() {
            state.user_picked = true;
        }
        state.selected = Some(id);
    }

    fn activate(&mut self, path: &str, list: &PluginNode, item: Option<(String, PluginNode)>) {
        let Some((id, node)) = item else {
            return;
        };
        self.choose(path, list, id);
        if handler_of(node.prop("onSelect")).is_some() {
            self.fire(node.prop("onSelect"), Vec::new(), true);
        } else {
            let first = actions_in(node.prop("actions"))
                .into_iter()
                .next()
                .or_else(|| actions_in(list.prop("actions")).into_iter().next());
            self.run_action(first.as_ref());
        }
    }

    fn sync_list(
        &mut self,
        path: &str,
        node: &PluginNode,
    ) -> (Arc<ListEntries>, Option<usize>, Option<String>) {
        let search_text = node
            .prop("searchText")
            .and_then(Value::as_str)
            .map(str::to_owned);
        let selected_prop = node
            .prop("selectedItemId")
            .and_then(Value::as_str)
            .map(str::to_owned);
        let mut push_query = None;
        {
            let state = self
                .lists
                .entry(path.to_owned())
                .or_insert_with(|| ListState {
                    query: search_text.clone().unwrap_or_default(),
                    selected: selected_prop.clone(),
                    notified: None,
                    ..ListState::default()
                });
            if search_text.is_some() && state.seen_search_text != search_text {
                state.seen_search_text = search_text.clone();
                if let Some(text) = &search_text
                    && *text != state.query
                {
                    state.query = text.clone();
                    push_query = Some(text.clone());
                }
            }
            if selected_prop.is_some() && state.seen_selected != selected_prop {
                state.seen_selected = selected_prop.clone();
                state.selected = selected_prop.clone();
            }
        }
        if let (Some(text), Some(input)) = (push_query, self.inputs.get(path)) {
            let input = input.clone();
            self.pending_input_text.push((input, text));
        }
        let (query, selected, notified, user_picked) = match self.lists.get(path) {
            Some(state) => (
                state.query.clone(),
                state.selected.clone(),
                state.notified.clone(),
                state.user_picked,
            ),
            None => Default::default(),
        };
        let entries = self.list_entries_of(path, node, &query);
        let effective_index = entries.effective_index(selected.as_ref());
        let effective = effective_index
            .and_then(|index| entries.item_at(index))
            .map(|(id, _)| id.clone());
        let notify = notified.as_ref() != Some(&effective);
        if notify {
            let gesture = user_picked;
            if let Some(state) = self.lists.get_mut(path) {
                let first_time = state.notified.is_none();
                state.notified = Some(effective.clone());
                state.user_picked = false;
                if !first_time {
                    let arg = effective.clone().map_or(Value::Null, Value::String);
                    self.fire(node.prop("onSelectionChange"), vec![arg], gesture);
                }
            }
        }
        (entries, effective_index, effective)
    }

    fn render_node(
        &mut self,
        node: &PluginNode,
        path: &str,
        depth: usize,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        if matches!(
            node.kind.as_str(),
            "List" | "Form" | "TextField" | "PasswordField"
        ) && self.latest.get(path) != Some(node)
        {
            self.latest.insert(path.to_owned(), node.clone());
        }
        match node.kind.as_str() {
            "Box" => self.box_node(node, path, depth, window, cx),
            "Text" => self.text_node(node, path, depth, window, cx),
            "Markdown" => {
                let source = str_prop(node, "markdown").unwrap_or_else(|| text_of(&node.children));
                if source.is_empty() {
                    div().into_any_element()
                } else {
                    self.markdown(&source, path, cx)
                }
            }
            "Badge" => self.badge_node(node),
            "Button" => self.button_node(node, path, cx),
            "Divider" => self.divider_node(node),
            "EmptyState" => self.empty_state_node(node, path, depth, window, cx),
            "Progress" => self.progress_node(node),
            "List" => self.list_node(node, path, depth, window, cx),
            "Detail" => self.detail_node(node, path, depth, window, cx),
            "Form" => self.form_node(node, path, depth, window, cx),
            "TextField" | "PasswordField" => self.text_field_node(node, path, window, cx),
            "Toggle" => self.toggle_node(node, path, cx),
            "Select" => self.select_node(node, path, cx),
            "SidebarView" => self.sidebar_view_node(node, path, depth, window, cx),
            "SidebarSection" => self.sidebar_section_node(node, path, depth, window, cx),
            "SidebarItem" => self.sidebar_item_node(node, path, depth, 0, window, cx),
            "Popover" => self.popover_node(node, path, depth, window, cx),
            "ActionPanel" => {
                self.action_buttons(&actions_in(Some(&node_json(node))), true, depth, path, cx)
            }
            "Action" => self.action_node(node, path, depth, cx),
            "WebView" => self.web_view_node(node, path, window, cx),
            _ => self.children(node, path, depth, window, cx),
        }
    }

    fn render_child(
        &mut self,
        child: &Child,
        index: usize,
        path: &str,
        depth: usize,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        match child {
            Child::Text(text) => div()
                .child(SharedString::from(text.clone()))
                .into_any_element(),
            Child::Node(node) => {
                let path = format!("{path}/{}", node_key(child, index));
                self.render_node(node, &path, depth, window, cx)
            }
        }
    }

    fn children_of(
        &mut self,
        node: &PluginNode,
        path: &str,
        depth: usize,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Vec<AnyElement> {
        node.children
            .iter()
            .enumerate()
            .map(|(index, child)| self.render_child(child, index, path, depth, window, cx))
            .collect()
    }

    fn children(
        &mut self,
        node: &PluginNode,
        path: &str,
        depth: usize,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        div()
            .flex()
            .flex_col()
            .children(self.children_of(node, path, depth, window, cx))
            .into_any_element()
    }

    fn box_node(
        &mut self,
        node: &PluginNode,
        path: &str,
        depth: usize,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let p = self.p;
        let prop = |name: &str| node.prop(name).and_then(Value::as_str);
        let row = prop("direction") == Some("row");
        let radius_space = space_of(prop("radius"));
        let fill = match prop("background") {
            Some("subtle") => Some(p.chip_fill),
            Some("raised") => Some(p.popover_fill),
            Some("accent") => Some(p.accent),
            _ => None,
        };
        let pad = space_of(prop("padding"));
        let pad_x = space_of(prop("paddingX"));
        let pad_y = space_of(prop("paddingY"));
        let children = self.children_of(node, path, depth, window, cx);
        let mut element = div()
            .id(SharedString::from(format!("plugin-box:{path}")))
            .flex();
        element = if row {
            element.flex_row()
        } else {
            element.flex_col()
        };
        element = element
            .when_some(space_of(prop("gap")), |this, gap| this.gap(px(gap)))
            .when_some(pad, |this, pad| this.p(px(pad)))
            .when_some(pad_x, |this, pad| this.px(px(pad)))
            .when_some(pad_y, |this, pad| this.py(px(pad)))
            .when_some(fill, |this, fill| this.bg(fill))
            .when_some(radius_space, |this, r| {
                this.rounded(px(r)).overflow_hidden()
            })
            .when(bool_prop(node, "wrap"), |this| this.flex_wrap())
            .when(bool_prop(node, "grow"), |this| this.flex_grow(1.0));
        element = match prop("align") {
            Some("start") => element.items_start(),
            Some("center") => element.items_center(),
            Some("end") => element.items_end(),
            _ => element,
        };
        element = match prop("justify") {
            Some("start") => element.justify_start(),
            Some("center") => element.justify_center(),
            Some("end") => element.justify_end(),
            Some("between") => element.justify_between(),
            _ => element,
        };
        if handler_of(node.prop("onPress")).is_some() {
            let handler = node.prop("onPress").cloned();
            element = element
                .cursor_pointer()
                .on_click(cx.listener(move |view, _, _, _| {
                    view.fire(handler.as_ref(), Vec::new(), true);
                }));
        }
        element.children(children).into_any_element()
    }

    fn text_node(
        &mut self,
        node: &PluginNode,
        path: &str,
        depth: usize,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let p = self.p;
        let size = size_of(node.prop("size").and_then(Value::as_str));
        let tone = tone_of(node.prop("tone").and_then(Value::as_str), Role::Text);
        let weight = match node.prop("weight").and_then(Value::as_str) {
            Some("medium") => Some(FontWeight::MEDIUM),
            Some("semibold") => Some(FontWeight::SEMIBOLD),
            Some("bold") => Some(FontWeight::BOLD),
            Some("regular") => Some(FontWeight::NORMAL),
            _ => None,
        };
        let lines = num_prop(node, "lines").map(|n| n.max(1.0) as usize);
        let align = node.prop("align").and_then(Value::as_str);
        let mono = bool_prop(node, "monospace");
        let children = self.children_of(node, path, depth, window, cx);
        div()
            .flex()
            .flex_wrap()
            .text_size(px(size.points()))
            .line_height(px(size.line_height()))
            .text_color(tone.color(&p))
            .when_some(weight, |this, w| this.font_weight(w))
            .when_some(lines, |this, lines| this.line_clamp(lines))
            .when(align == Some("center"), |this| {
                this.text_center().justify_center()
            })
            .when(align == Some("end"), |this| this.text_right().justify_end())
            .when(mono, |this| this.font_family("Menlo"))
            .children(children)
            .into_any_element()
    }

    fn badge_node(&mut self, node: &PluginNode) -> AnyElement {
        let p = self.p;
        let text = {
            let inner = text_of(&node.children);
            if inner.is_empty() {
                str_prop(node, "text").unwrap_or_default()
            } else {
                inner
            }
        };
        if text.is_empty() {
            return div().into_any_element();
        }
        let tone = node.prop("tone").and_then(Value::as_str);
        let (fill, ink) = match fill_tone_of(tone) {
            Some(role) => (role.color(&p), p.on_accent),
            None if tone == Some("accent") => (p.accent, p.on_accent),
            None => (p.chip_fill, p.chip_text),
        };
        badge(text, fill, ink, false)
    }

    fn button_node(&mut self, node: &PluginNode, path: &str, cx: &mut Context<Self>) -> AnyElement {
        let p = self.p;
        let loading = bool_prop(node, "loading");
        let kind = if node.prop("tone").and_then(Value::as_str) == Some("destructive") {
            ButtonKind::Destructive
        } else if node.prop("variant").and_then(Value::as_str) == Some("primary") {
            ButtonKind::Primary
        } else {
            ButtonKind::Plain
        };
        let title = str_prop(node, "title").unwrap_or_else(|| text_of(&node.children));
        let handler = node.prop("onPress").cloned();
        let glyph = str_prop(node, "icon").map(|name| icon_named(&name));
        div()
            .flex()
            .items_center()
            .gap(px(space::XS))
            .when(loading, |this| {
                this.child(spinner(surface::SPINNER, p.text_secondary))
            })
            .child(
                PushButton::new(
                    SharedString::from(format!("plugin-button:{path}")),
                    title,
                    &p,
                )
                .kind(kind)
                .when_some(glyph, |b, g| b.icon(g))
                .disabled(bool_prop(node, "disabled") || loading)
                .on_click(cx.listener(move |view, _, _, _| {
                    view.fire(handler.as_ref(), Vec::new(), true);
                })),
            )
            .into_any_element()
    }

    fn divider_node(&mut self, node: &PluginNode) -> AnyElement {
        let p = self.p;
        let gap = space_of(node.prop("spacing").and_then(Value::as_str)).unwrap_or(space::S);
        let line = || div().h(px(0.5)).bg(p.divider);
        match str_prop(node, "label") {
            None => div().py(px(gap)).child(line()).into_any_element(),
            Some(label) => div()
                .py(px(gap))
                .flex()
                .items_center()
                .gap(px(space::M))
                .child(line().flex_1())
                .child(caption(label, p.text_tertiary))
                .child(line().flex_1())
                .into_any_element(),
        }
    }

    fn empty_state_node(
        &mut self,
        node: &PluginNode,
        path: &str,
        depth: usize,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let p = self.p;
        let actions = node_of_value(node.prop("actions")).map(|actions| {
            self.render_node(&actions, &format!("{path}/actions"), depth, window, cx)
        });
        div()
            .flex()
            .flex_col()
            .items_center()
            .gap(px(space::M))
            .p(px(space::L))
            .child(empty_state(
                &str_prop(node, "icon").unwrap_or_else(|| "archivebox".into()),
                &str_prop(node, "title").unwrap_or_default(),
                str_prop(node, "description"),
                &p,
            ))
            .children(actions)
            .into_any_element()
    }

    fn progress_node(&mut self, node: &PluginNode) -> AnyElement {
        let p = self.p;
        let total = num_prop(node, "total").unwrap_or(1.0);
        let value = num_prop(node, "value").unwrap_or(0.0);
        let fraction = if total > 0.0 { value / total } else { 0.0 };
        let role = fill_tone_of(node.prop("tone").and_then(Value::as_str)).unwrap_or(Role::Accent);
        div()
            .flex()
            .flex_col()
            .gap(px(space::XS))
            .when_some(str_prop(node, "label"), |this, label| {
                this.child(
                    div()
                        .flex()
                        .justify_between()
                        .child(small(label, p.text_secondary))
                        .child(small(
                            format!("{}%", (fraction * 100.0).round() as i64),
                            p.text_tertiary,
                        )),
                )
            })
            .child(div().h(px(4.)).child(progress_bar(
                fraction as f32,
                p.progress_track,
                role.color(&p),
            )))
            .into_any_element()
    }

    fn popover_node(
        &mut self,
        node: &PluginNode,
        path: &str,
        depth: usize,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let p = self.p;
        let height = num_prop(node, "height");
        let children = self.children_of(node, path, depth, window, cx);
        div()
            .flex()
            .flex_col()
            .gap(px(space::S))
            .p(px(space::M))
            .when_some(height, |this, h| this.max_h(px(h as f32)).overflow_hidden())
            .when_some(str_prop(node, "title"), |this, title| {
                this.child(body(title, p.text).font_weight(FontWeight::SEMIBOLD))
            })
            .children(children)
            .into_any_element()
    }

    fn web_view_node(
        &mut self,
        node: &PluginNode,
        path: &str,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let p = self.p;
        let url = plugin_file_url(&self.plugin, str_prop(node, "src").as_deref());
        let height = num_prop(node, "height").map_or(surface::LIST_MAX_HEIGHT, |h| h as f32);
        match url {
            None => small(
                "This view points at a file the plugin doesn't have.".to_owned(),
                p.text_tertiary,
            )
            .into_any_element(),
            Some(url) => {
                let host = Arc::clone(&self.host);
                let window_id = self.window_id.clone();
                let plugin = self.plugin.clone();
                let key = format!("webview:{}:{path}", self.instance);
                let view = self.files.element(
                    &host,
                    super::file_view::FileSpec {
                        window: &window_id,
                        plugin: &plugin,
                        url: &url,
                        key: &key,
                        context: None,
                    },
                    window,
                    cx,
                );
                div()
                    .h(px(height))
                    .overflow_hidden()
                    .child(view)
                    .into_any_element()
            }
        }
    }

    fn action_node(
        &mut self,
        node: &PluginNode,
        path: &str,
        depth: usize,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let p = self.p;
        let actions = vec![node.clone()];
        self.register(depth, &actions);
        let hint = hint_for(&panel_shortcuts(&self.host, &actions), node);
        let action = node.clone();
        let glyph = str_prop(node, "icon").map(|name| icon_named(&name));
        let button = PushButton::new(
            SharedString::from(format!("plugin-action:{path}")),
            str_prop(node, "title").unwrap_or_else(|| "Action".into()),
            &p,
        )
        .kind(if bool_prop(node, "destructive") {
            ButtonKind::Destructive
        } else {
            ButtonKind::Plain
        })
        .when_some(glyph, |b, g| b.icon(g))
        .on_click(cx.listener(move |view, _, _, _| {
            view.run_action(Some(&action));
        }));
        with_hint(hint, button.into_any_element(), path, &p)
    }

    fn action_buttons(
        &mut self,
        actions: &[PluginNode],
        primary_first: bool,
        depth: usize,
        path: &str,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let p = self.p;
        self.register(depth, actions);
        if actions.is_empty() {
            return div().into_any_element();
        }
        let shortcuts = panel_shortcuts(&self.host, actions);
        div()
            .flex()
            .flex_wrap()
            .justify_end()
            .gap(px(space::S))
            .children(actions.iter().enumerate().map(|(index, action)| {
                let title = str_prop(action, "title").unwrap_or_else(|| "Action".into());
                let destructive = bool_prop(action, "destructive")
                    || action.prop("tone").and_then(Value::as_str) == Some("destructive");
                let kind = if destructive {
                    ButtonKind::Destructive
                } else if primary_first && index == 0 {
                    ButtonKind::Primary
                } else {
                    ButtonKind::Plain
                };
                let run = action.clone();
                let glyph = str_prop(action, "icon").map(|name| icon_named(&name));
                let id = format!("{path}:action:{index}:{title}");
                let button = PushButton::new(SharedString::from(id.clone()), title, &p)
                    .kind(kind)
                    .when_some(glyph, |b, g| b.icon(g))
                    .on_click(cx.listener(move |view, _, _, _| {
                        view.run_action(Some(&run));
                    }))
                    .into_any_element();
                with_hint(hint_for(&shortcuts, action), button, &id, &p)
            }))
            .into_any_element()
    }

    fn open_menu(&mut self, panel: Option<&Value>, at: Point<Pixels>, cx: &mut Context<Self>) {
        let actions = actions_in(panel);
        if actions.is_empty() {
            return;
        }
        self.menu = Some(Menu { actions, at });
        cx.notify();
    }

    fn menu_button(
        &mut self,
        panel: Option<&Value>,
        path: &str,
        cx: &mut Context<Self>,
    ) -> Option<AnyElement> {
        let p = self.p;
        if actions_in(panel).is_empty() {
            return None;
        }
        let panel = panel.cloned();
        Some(
            crate::primitives::controls::IconButton::new(
                SharedString::from(format!("plugin-actions:{path}")),
                Icon::Ellipsis,
                &p,
            )
            .square(22., radius::CONTROL)
            .glyph(12.)
            .tooltip("Actions", &p)
            .on_click(cx.listener(move |view, event: &gpui::ClickEvent, _, cx| {
                view.open_menu(panel.as_ref(), event.position(), cx);
            }))
            .into_any_element(),
        )
    }

    fn list_node(
        &mut self,
        node: &PluginNode,
        path: &str,
        depth: usize,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let p = self.p;
        self.touched.insert(path.to_owned());
        let (entries, effective_index, effective) = self.sync_list(path, node);
        let current = effective_index
            .and_then(|index| entries.item_at(index))
            .map(|(_, node)| Arc::clone(node));
        let mut active_actions = current
            .as_ref()
            .map(|c| actions_in(c.prop("actions")))
            .unwrap_or_default();
        active_actions.extend(actions_in(node.prop("actions")));
        self.register(depth, &active_actions);
        let placeholder = str_prop(node, "searchBarPlaceholder").unwrap_or_else(|| "Search".into());
        let query = self
            .lists
            .get(path)
            .map(|s| s.query.clone())
            .unwrap_or_default();
        let search = self.input(path, &placeholder, &query, window, cx);
        let detail = current
            .as_ref()
            .filter(|_| bool_prop(node, "isShowingDetail"))
            .and_then(|c| node_of_value(c.prop("detail")));
        let menu = self.menu_button(node.prop("actions"), path, cx);
        let list_key = SharedString::from(format!("plugin-list:{}:{path}", self.instance));
        let scroll = virtual_list::scroll_handle(list_key.clone());
        if !self.list_keys.contains(&list_key) {
            self.list_keys.insert(list_key.clone());
        }
        let selected_key = effective_index.map(|index| entries.rows[index].key.clone());
        let list_body = if !entries.entries.is_empty() {
            let body = virtual_list(list_key.clone(), &scroll)
                .items(entries.rows.iter().cloned())
                .keep(selected_key.clone())
                .render(|index, _| match &entries.entries[index] {
                    Entry::Section {
                        key,
                        title,
                        subtitle,
                    } => div()
                        .flex()
                        .flex_col()
                        .flex_none()
                        .child(section_header(key, title.clone(), subtitle.clone(), &p))
                        .into_any_element(),
                    Entry::Item { id, node: item } => {
                        let selected = Some(index) == effective_index;
                        self.item_row(path, id, item, selected, cx)
                    }
                });
            self.reveal(path, &list_key, &effective, selected_key.as_deref());
            body
        } else if let Some(empty) = node_of_value(node.prop("emptyView")) {
            self.render_node(&empty, &format!("{path}/empty"), depth + 1, window, cx)
        } else {
            empty_state(
                "magnifyingglass",
                if query.is_empty() {
                    "Nothing here yet"
                } else {
                    "No results"
                },
                None,
                &p,
            )
        };
        let detail_body =
            detail.map(|d| self.render_node(&d, &format!("{path}/detail"), depth + 1, window, cx));
        div()
            .flex()
            .flex_col()
            .flex_1()
            .gap(px(space::S))
            .child(
                div()
                    .flex()
                    .items_center()
                    .gap(px(space::S))
                    .child(search_field(search, &p))
                    .when(bool_prop(node, "isLoading"), |this| {
                        this.child(spinner(surface::SPINNER, p.text_secondary))
                    })
                    .children(menu),
            )
            .child(
                div()
                    .flex()
                    .flex_1()
                    .gap(px(space::S))
                    .child(
                        div()
                            .id(SharedString::from(format!("plugin-list:{path}")))
                            .overflow_y_scroll()
                            .track_scroll(&scroll)
                            .pb(px(surface::ICON_BOX))
                            .when(detail_body.is_some(), |this| {
                                this.w(relative(1.0 - surface::DETAIL_WIDTH))
                            })
                            .when(detail_body.is_none(), |this| this.flex_1())
                            .child(list_body),
                    )
                    .when_some(detail_body, |this, detail| {
                        this.child(div().w(px(0.5)).bg(p.divider)).child(
                            div()
                                .id(SharedString::from(format!("plugin-detail:{path}")))
                                .flex_1()
                                .overflow_y_scroll()
                                .child(detail),
                        )
                    }),
            )
            .into_any_element()
    }

    fn reveal(
        &mut self,
        path: &str,
        list_key: &str,
        effective: &Option<String>,
        selected_key: Option<&str>,
    ) {
        let Some(state) = self.lists.get_mut(path) else {
            return;
        };
        if state.revealed.as_ref() == Some(effective) {
            return;
        }
        if state.revealed.is_some()
            && let Some(key) = selected_key
        {
            virtual_list::scroll_to(list_key, key, Align::Nearest);
        }
        state.revealed = Some(effective.clone());
    }

    fn item_row(
        &self,
        list_path: &str,
        id: &str,
        item: &Arc<PluginNode>,
        selected: bool,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let p = self.p;
        let key = list_path.to_owned();
        let clicked_id = id.to_owned();
        let clicked = Arc::clone(item);
        let menu_item = Arc::clone(item);
        let subtitle = str_prop(item, "subtitle");
        list_row(
            SharedString::from(format!("plugin-item:{list_path}:{id}")),
            selected,
            surface::ITEM_HEIGHT,
            &p,
        )
        .on_click(cx.listener(move |view, _, _, cx| {
            let Some(list) = view.latest.get(&key).cloned() else {
                return;
            };
            let entry = (clicked_id.clone(), (*clicked).clone());
            view.activate(&key, &list, Some(entry));
            cx.notify();
        }))
        .on_mouse_down(
            MouseButton::Right,
            cx.listener(move |view, event: &gpui::MouseDownEvent, _, cx| {
                view.open_menu(menu_item.prop("actions"), event.position, cx);
            }),
        )
        .children(surface_icon(
            str_prop(item, "icon"),
            None,
            surface::ICON,
            &p,
        ))
        .child(
            div()
                .flex_1()
                .min_w_0()
                .flex()
                .items_center()
                .gap(px(space::S))
                .child(body(str_prop(item, "title").unwrap_or_default(), p.text).truncate())
                .when_some(subtitle, |this, subtitle| {
                    this.child(small(subtitle, p.text_secondary).truncate())
                }),
        )
        .child(accessories(
            &records_of(item.prop("accessories")),
            str_prop(item, "badge"),
            &p,
        ))
        .into_any_element()
    }

    fn detail_node(
        &mut self,
        node: &PluginNode,
        path: &str,
        depth: usize,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let p = self.p;
        let markdown = str_prop(node, "markdown").map(|m| self.markdown(&m, path, cx));
        let children = self.children_of(node, path, depth + 1, window, cx);
        let metadata = records_of(node.prop("metadata"));
        let rows: Vec<AnyElement> = metadata
            .iter()
            .enumerate()
            .map(|(index, row)| self.metadata_row(row, index, path, cx))
            .collect();
        let actions = self.action_buttons(&actions_in(node.prop("actions")), true, depth, path, cx);
        div()
            .id(SharedString::from(format!("plugin-detail-scroll:{path}")))
            .overflow_y_scroll()
            .child(
                div()
                    .flex()
                    .flex_col()
                    .gap(px(space::L))
                    .p(px(space::M))
                    .when(bool_prop(node, "isLoading"), |this| {
                        this.child(spinner(surface::SPINNER, p.text_secondary))
                    })
                    .children(markdown)
                    .children(children)
                    .when(!rows.is_empty(), |this| {
                        this.child(
                            div()
                                .flex()
                                .flex_col()
                                .gap(px(space::S))
                                .child(div().h(px(0.5)).bg(p.divider))
                                .children(rows),
                        )
                    })
                    .child(actions),
            )
            .into_any_element()
    }

    fn metadata_row(
        &mut self,
        row: &Map<String, Value>,
        index: usize,
        path: &str,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let p = self.p;
        let url = is_web_url(row.get("url")).map(str::to_owned);
        let tone = row.get("tone").and_then(Value::as_str);
        let text = str_of(row.get("text"))
            .or_else(|| url.clone())
            .unwrap_or_default();
        let color = if url.is_some() {
            p.accent
        } else {
            tone_of(tone, Role::Text).color(&p)
        };
        let value = div()
            .id(SharedString::from(format!("plugin-meta:{path}:{index}")))
            .flex_1()
            .flex()
            .items_center()
            .gap(px(space::XS))
            .children(surface_icon(
                str_of(row.get("icon")),
                tone,
                surface::SMALL_ICON,
                &p,
            ))
            .child(small(text, color).line_clamp(2))
            .when_some(url, |this, url| {
                this.cursor_pointer()
                    .on_click(cx.listener(move |view, _, _, _| {
                        view.plugins.open_url(&view.window_id, &url);
                    }))
            });
        div()
            .flex()
            .items_start()
            .gap(px(space::M))
            .child(
                small(
                    str_of(row.get("label")).unwrap_or_default(),
                    p.text_secondary,
                )
                .w(px(surface::META_LABEL))
                .flex_none(),
            )
            .child(value)
            .into_any_element()
    }

    fn form_node(
        &mut self,
        node: &PluginNode,
        path: &str,
        depth: usize,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let p = self.p;
        register_fields(node, path, &mut self.form_of_field);
        let children = self.children_of(node, path, depth + 1, window, cx);
        let loading = bool_prop(node, "isLoading");
        let actions =
            self.action_buttons(&actions_in(node.prop("actions")), false, depth, path, cx);
        let form = path.to_owned();
        let submit = handler_of(node.prop("onSubmit")).map(|_| {
            PushButton::new(
                SharedString::from(format!("plugin-submit:{path}")),
                str_prop(node, "submitTitle").unwrap_or_else(|| "Submit".into()),
                &p,
            )
            .kind(ButtonKind::Primary)
            .disabled(loading)
            .on_click(cx.listener(move |view, _, _, _| view.submit(&form)))
        });
        div()
            .id(SharedString::from(format!("plugin-form:{path}")))
            .overflow_y_scroll()
            .child(
                div()
                    .flex()
                    .flex_col()
                    .gap(px(space::L))
                    .p(px(space::M))
                    .children(children)
                    .child(
                        div()
                            .flex()
                            .justify_end()
                            .items_center()
                            .gap(px(space::S))
                            .when(loading, |this| {
                                this.child(spinner(surface::SPINNER, p.text_secondary))
                            })
                            .child(actions)
                            .children(submit),
                    ),
            )
            .into_any_element()
    }

    fn text_field_node(
        &mut self,
        node: &PluginNode,
        path: &str,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let p = self.p;
        let value = self.field_value(path, node);
        let placeholder = str_prop(node, "placeholder").unwrap_or_default();
        let input = self.input(path, &placeholder, value.text(), window, cx);
        let secure = node.kind == "PasswordField";
        input.update(cx, |input, cx| input.set_secure(secure, cx));
        let shown = input.read(cx).text().to_owned();
        if shown != value.text() {
            self.pending_input_text
                .push((input.clone(), value.text().to_owned()));
        }
        let invalid = str_prop(node, "error").is_some();
        let disabled = bool_prop(node, "disabled");
        let field = div()
            .min_h(px(28.))
            .px(px(space::M))
            .py(px(space::XS))
            .rounded(px(radius::CONTROL + 2.))
            .bg(p.field)
            .border(px(1.))
            .border_color(if invalid {
                p.destructive
            } else {
                p.field_border
            })
            .flex()
            .items_center()
            .when(disabled, |this| this.opacity(0.5))
            .child(input);
        field_frame(node, field.into_any_element(), &p)
    }

    fn toggle_node(&mut self, node: &PluginNode, path: &str, cx: &mut Context<Self>) -> AnyElement {
        let p = self.p;
        let value = self.field_value(path, node);
        let label = str_prop(node, "label")
            .or_else(|| str_prop(node, "title"))
            .unwrap_or_default();
        let key = path.to_owned();
        let field = node.clone();
        let view = cx.entity().downgrade();
        div()
            .flex()
            .items_center()
            .gap(px(space::M))
            .child(
                div()
                    .flex_1()
                    .flex()
                    .flex_col()
                    .gap(px(space::XXS))
                    .child(body(label, p.text))
                    .when_some(str_prop(node, "info"), |this, info| {
                        this.child(caption(info, p.text_tertiary))
                    }),
            )
            .child(
                Toggle::new(
                    SharedString::from(format!("plugin-toggle:{path}")),
                    value == FormValue::Flag(true),
                    &p,
                )
                .disabled(bool_prop(node, "disabled"))
                .on_toggle(move |on, _, cx| {
                    let _ = view.update(cx, |view, cx| {
                        view.set_field(&key, &field, FormValue::Flag(on));
                        cx.notify();
                    });
                }),
            )
            .into_any_element()
    }

    fn select_node(&mut self, node: &PluginNode, path: &str, cx: &mut Context<Self>) -> AnyElement {
        let p = self.p;
        let options = select_options(node);
        if options.is_empty() {
            return div().into_any_element();
        }
        let value = shown_select_value(node, &self.field_value(path, node));
        let title = options
            .iter()
            .find(|(v, _)| *v == value)
            .map(|(_, t)| t.clone())
            .unwrap_or_default();
        let disabled = bool_prop(node, "disabled");
        let key = path.to_owned();
        let field = node.clone();
        let host = Arc::clone(&self.host);
        let picker = PopUp::new(
            SharedString::from(format!("plugin-select:{path}")),
            title,
            &p,
        )
        .disabled(disabled)
        .on_click(
            cx.listener(move |view, event: &gpui::ClickEvent, window, cx| {
                let choices = select_options(&field);
                let current = shown_select_value(&field, &view.field_value(&key, &field));
                let rows: Vec<PopUpChoice> = choices
                    .iter()
                    .map(|(value, title)| {
                        PopUpChoice::new(title.clone(), *value == current, Vec::new())
                            .value(value.clone())
                    })
                    .collect();
                let this = cx.entity().downgrade();
                let picked_key = key.clone();
                let picked_field = field.clone();
                let values: Vec<String> = choices.iter().map(|(value, _)| value.clone()).collect();
                let shown =
                    pop_up_menu::show_native(&host, &rows, window, cx, move |index, _, cx| {
                        let Some(value) = values.get(index).cloned() else {
                            return;
                        };
                        let _ = this.update(cx, |view, cx| {
                            view.set_field(&picked_key, &picked_field, FormValue::Text(value));
                            cx.notify();
                        });
                    });
                if shown {
                    return;
                }
                view.select_menu = Some(SelectMenu {
                    path: key.clone(),
                    field: field.clone(),
                    choices,
                    at: event.position(),
                });
                cx.notify();
            }),
        );
        field_frame(node, picker.into_any_element(), &p)
    }

    fn sidebar_view_node(
        &mut self,
        node: &PluginNode,
        path: &str,
        depth: usize,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let p = self.p;
        let title = str_prop(node, "title");
        let loading = bool_prop(node, "isLoading");
        let has_actions = !actions_in(node.prop("actions")).is_empty();
        let menu = self.menu_button(node.prop("actions"), path, cx);
        let children = self.children_of(node, path, depth, window, cx);
        div()
            .flex()
            .flex_col()
            .gap(px(space::XXS))
            .when(title.is_some() || loading || has_actions, |this| {
                this.child(
                    div()
                        .flex()
                        .items_center()
                        .gap(px(space::S))
                        .px(px(space::M))
                        .min_h(px(surface::ROW_HEIGHT))
                        .child(div().flex_1().min_w_0().children(title.map(|t| {
                            small(t, p.text_secondary)
                                .font_weight(FontWeight::SEMIBOLD)
                                .truncate()
                        })))
                        .when(loading, |this| {
                            this.child(spinner(surface::SPINNER, p.text_secondary))
                        })
                        .children(menu),
                )
            })
            .children(children)
            .into_any_element()
    }

    fn sidebar_section_node(
        &mut self,
        node: &PluginNode,
        path: &str,
        depth: usize,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let p = self.p;
        let title = str_prop(node, "title");
        let collapsible = node.prop("collapsible") != Some(&Value::Bool(false)) && title.is_some();
        let collapsed = *self
            .collapsed
            .entry(path.to_owned())
            .or_insert_with(|| bool_prop(node, "defaultCollapsed"));
        let menu = self.menu_button(node.prop("actions"), path, cx);
        let key = path.to_owned();
        let children = if collapsed {
            Vec::new()
        } else {
            self.children_of(node, path, depth, window, cx)
        };
        div()
            .flex()
            .flex_col()
            .gap(px(space::XXS))
            .when_some(title, |this, title| {
                this.child(
                    div()
                        .flex()
                        .items_center()
                        .gap(px(space::XS))
                        .px(px(space::M))
                        .min_h(px(surface::ROW_HEIGHT))
                        .child(
                            div()
                                .id(SharedString::from(format!("plugin-section:{path}")))
                                .flex_1()
                                .flex()
                                .items_center()
                                .gap(px(surface::CHEVRON / 2.0))
                                .when(collapsible, |this| {
                                    this.cursor_pointer()
                                        .on_click(cx.listener(move |view, _, _, cx| {
                                            let now =
                                                view.collapsed.entry(key.clone()).or_default();
                                            *now = !*now;
                                            cx.notify();
                                        }))
                                        .child(chevron(!collapsed, &p))
                                })
                                .child(
                                    small(title, p.text_secondary)
                                        .font_weight(FontWeight::SEMIBOLD)
                                        .truncate(),
                                ),
                        )
                        .children(menu),
                )
            })
            .children(children)
            .into_any_element()
    }

    fn sidebar_item_node(
        &mut self,
        node: &PluginNode,
        path: &str,
        depth: usize,
        level: usize,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let p = self.p;
        let nested: Vec<(usize, PluginNode)> = node
            .children
            .iter()
            .enumerate()
            .filter_map(|(i, c)| match c {
                Child::Node(n) if n.kind == "SidebarItem" => Some((i, n.clone())),
                _ => None,
            })
            .collect();
        let others: Vec<(usize, Child)> = node
            .children
            .iter()
            .enumerate()
            .filter(|(_, c)| !matches!(c, Child::Node(n) if n.kind == "SidebarItem"))
            .map(|(i, c)| (i, c.clone()))
            .collect();
        let open = !self.closed_items.get(path).copied().unwrap_or(false);
        let role = fill_tone_of(node.prop("tone").and_then(Value::as_str));
        let tone = node.prop("tone").and_then(Value::as_str);
        let has_nested = !nested.is_empty();
        let handler = node.prop("onPress").cloned();
        let actions = node.prop("actions").cloned();
        let has_actions = !actions_in(actions.as_ref()).is_empty();
        let key = path.to_owned();
        let toggle_key = path.to_owned();
        let title_color = if role.is_some() {
            tone_of(tone, Role::Text).color(&p)
        } else {
            p.text
        };
        let row = list_row(
            SharedString::from(format!("plugin-sidebar-item:{path}")),
            bool_prop(node, "selected"),
            ROW_HEIGHT,
            &p,
        )
        .on_click(cx.listener(move |view, _, _, cx| {
            if handler_of(handler.as_ref()).is_some() {
                view.fire(handler.as_ref(), Vec::new(), true);
            } else if has_nested {
                let closed = view.closed_items.entry(key.clone()).or_default();
                *closed = !*closed;
                cx.notify();
            }
        }))
        .when(has_actions, |this| {
            this.on_mouse_down(
                MouseButton::Right,
                cx.listener(move |view, event: &gpui::MouseDownEvent, _, cx| {
                    view.open_menu(actions.as_ref(), event.position, cx);
                }),
            )
        })
        .child(div().w(px(level as f32 * surface::INDENT)).flex_none())
        .when(has_nested, |this| {
            this.child(
                div()
                    .id(SharedString::from(format!("plugin-sidebar-chevron:{path}")))
                    .on_click(cx.listener(move |view, _, _, cx| {
                        cx.stop_propagation();
                        let closed = view.closed_items.entry(toggle_key.clone()).or_default();
                        *closed = !*closed;
                        cx.notify();
                    }))
                    .child(chevron(open, &p)),
            )
        })
        .children(surface_icon(
            str_prop(node, "icon"),
            tone,
            surface::ICON,
            &p,
        ))
        .child(
            div()
                .flex_1()
                .min_w_0()
                .flex()
                .items_center()
                .gap(px(space::S))
                .child(body(str_prop(node, "title").unwrap_or_default(), title_color).truncate())
                .when_some(str_prop(node, "subtitle"), |this, subtitle| {
                    this.child(small(subtitle, p.text_tertiary).truncate())
                }),
        )
        .when_some(str_prop(node, "badge"), |this, text| {
            let (fill, ink) = match role {
                Some(role) => (role.color(&p), p.on_accent),
                None => (p.chip_fill, p.chip_text),
            };
            this.child(badge(text, fill, ink, true))
        });
        let other_elements: Vec<AnyElement> = others
            .iter()
            .map(|(index, child)| self.render_child(child, *index, path, depth, window, cx))
            .collect();
        let nested_elements: Vec<AnyElement> = if open {
            nested
                .iter()
                .map(|(index, child)| {
                    let child_path = format!(
                        "{path}/{}",
                        child.key.clone().unwrap_or_else(|| index.to_string())
                    );
                    self.sidebar_item_node(child, &child_path, depth, level + 1, window, cx)
                })
                .collect()
        } else {
            Vec::new()
        };
        div()
            .flex()
            .flex_col()
            .child(row)
            .when(!other_elements.is_empty(), |this| {
                this.child(
                    div()
                        .pl(px((level + 1) as f32 * surface::INDENT))
                        .children(other_elements),
                )
            })
            .children(nested_elements)
            .into_any_element()
    }

    fn markdown(&mut self, source: &str, path: &str, cx: &mut Context<Self>) -> AnyElement {
        self.touched.insert(path.to_owned());
        let blocks = match self.markdown_cache.get(path) {
            Some((cached, blocks)) if cached == source => Arc::clone(blocks),
            _ => {
                let blocks = Arc::new(parse_markdown(source));
                self.markdown_cache
                    .insert(path.to_owned(), (source.to_owned(), Arc::clone(&blocks)));
                blocks
            }
        };
        self.blocks(&blocks, path, cx)
    }

    fn blocks(&mut self, blocks: &[Block], path: &str, cx: &mut Context<Self>) -> AnyElement {
        let p = self.p;
        div()
            .flex()
            .flex_col()
            .gap(px(space::M))
            .children(blocks.iter().enumerate().map(|(index, block)| {
                let at = format!("{path}/md{index}");
                match block {
                    Block::Heading { level, spans } => {
                        let size = match level {
                            1 => TypeSize::Large,
                            2 => TypeSize::Title,
                            _ => TypeSize::Body,
                        };
                        self.spans(spans, size, &at, cx)
                            .font_weight(if *level == 3 {
                                FontWeight::SEMIBOLD
                            } else {
                                FontWeight::BOLD
                            })
                            .into_any_element()
                    }
                    Block::Paragraph(spans) => self
                        .spans(spans, TypeSize::Body, &at, cx)
                        .into_any_element(),
                    Block::Code { text, .. } => {
                        div()
                            .id(SharedString::from(format!("plugin-code:{at}")))
                            .bg(p.chip_fill)
                            .rounded(px(radius::CONTROL))
                            .overflow_x_scroll()
                            .child(
                                div()
                                    .p(px(space::S))
                                    .font_family("Menlo")
                                    .text_size(px(TypeSize::Small.points()))
                                    .line_height(px(TypeSize::Small.line_height()))
                                    .text_color(p.text)
                                    .whitespace_nowrap()
                                    .flex()
                                    .flex_col()
                                    .children(text.split('\n').map(|line| {
                                        div().child(SharedString::from(line.to_owned()))
                                    })),
                            )
                            .into_any_element()
                    }
                    Block::List { items, .. } => div()
                        .flex()
                        .flex_col()
                        .gap(px(space::XS))
                        .children(items.iter().enumerate().map(|(item_index, item)| {
                            div()
                                .flex()
                                .gap(px(space::XS))
                                .pl(px(item.depth as f32 * surface::INDENT))
                                .child(
                                    body(item.marker.clone(), p.text_secondary)
                                        .min_w(px(surface::INDENT)),
                                )
                                .child(
                                    self.spans(
                                        &item.spans,
                                        TypeSize::Body,
                                        &format!("{at}/{item_index}"),
                                        cx,
                                    )
                                    .flex_1(),
                                )
                        }))
                        .into_any_element(),
                    Block::Quote(inner) => div()
                        .flex()
                        .gap(px(space::S))
                        .child(
                            div()
                                .w(px(space::XXS))
                                .rounded(px(space::XXS))
                                .bg(p.divider)
                                .flex_none(),
                        )
                        .child(div().flex_1().child(self.blocks(inner, &at, cx)))
                        .into_any_element(),
                    Block::Rule => div().h(px(0.5)).bg(p.divider).into_any_element(),
                }
            }))
            .into_any_element()
    }

    fn spans(
        &mut self,
        spans: &[Span],
        size: TypeSize,
        path: &str,
        cx: &mut Context<Self>,
    ) -> gpui::Div {
        let p = self.p;
        div()
            .flex()
            .flex_wrap()
            .text_size(px(size.points()))
            .line_height(px(size.line_height()))
            .text_color(p.text)
            .children(spans.iter().enumerate().map(|(index, span)| {
                let mut piece = div()
                    .id(SharedString::from(format!("plugin-span:{path}:{index}")))
                    .child(SharedString::from(span.text.clone()));
                if span.bold {
                    piece = piece.font_weight(FontWeight::BOLD);
                }
                if span.italic {
                    piece = piece.italic();
                }
                if span.code {
                    piece = piece.bg(p.chip_fill).font_family("Menlo");
                }
                if let Some(url) = span.url.clone() {
                    piece = piece
                        .text_color(p.accent)
                        .underline()
                        .cursor_pointer()
                        .on_click(cx.listener(move |view, _, _, _| {
                            view.plugins.open_url(&view.window_id, &url);
                        }));
                }
                piece
            }))
    }

    fn render_menu(&mut self, cx: &mut Context<Self>) -> Option<AnyElement> {
        let p = self.p;
        let menu = self.menu.as_ref()?;
        let shortcuts = panel_shortcuts(&self.host, &menu.actions);
        let at = menu.at;
        let rows: Vec<AnyElement> = menu
            .actions
            .iter()
            .enumerate()
            .map(|(index, action)| {
                let run = action.clone();
                let mut row = MenuRow::new(
                    SharedString::from(format!("plugin-menu:{index}")),
                    str_prop(action, "title").unwrap_or_else(|| "Action".into()),
                    &p,
                )
                .on_click(cx.listener(move |view, _, _, cx| {
                    view.menu = None;
                    view.run_action(Some(&run));
                    cx.notify();
                }));
                if let Some(name) = str_prop(action, "icon") {
                    row = row.icon(icon_named(&name));
                }
                if let Some(hint) = hint_for(&shortcuts, action) {
                    row = row.trailing(hint);
                }
                row.into_any_element()
            })
            .collect();
        Some(
            deferred(
                div()
                    .id("plugin-menu-catcher")
                    .absolute()
                    .inset_0()
                    .occlude()
                    .on_mouse_down(
                        MouseButton::Left,
                        cx.listener(|view, _, _, cx| {
                            view.menu = None;
                            cx.notify();
                        }),
                    )
                    .child(
                        popover("plugin-action-menu", false, 220., &p)
                            .absolute()
                            .left(at.x)
                            .top(at.y)
                            .children(rows),
                    ),
            )
            .with_priority(4)
            .into_any_element(),
        )
    }

    fn render_select_menu(&mut self, cx: &mut Context<Self>) -> Option<AnyElement> {
        let p = self.p;
        let menu = self.select_menu.as_ref()?;
        let at = menu.at;
        let current = shown_select_value(&menu.field, &self.field_value(&menu.path, &menu.field));
        let rows: Vec<AnyElement> = menu
            .choices
            .iter()
            .enumerate()
            .map(|(index, (value, title))| {
                let chosen = value.clone();
                MenuRow::new(
                    SharedString::from(format!("plugin-select-option:{index}")),
                    title.clone(),
                    &p,
                )
                .checked(*value == current)
                .on_click(cx.listener(move |view, _, _, cx| {
                    if let Some(menu) = view.select_menu.take() {
                        view.set_field(&menu.path, &menu.field, FormValue::Text(chosen.clone()));
                    }
                    cx.notify();
                }))
                .into_any_element()
            })
            .collect();
        Some(
            deferred(
                div()
                    .id("plugin-select-catcher")
                    .absolute()
                    .inset_0()
                    .occlude()
                    .on_mouse_down(
                        MouseButton::Left,
                        cx.listener(|view, _, _, cx| {
                            view.select_menu = None;
                            cx.notify();
                        }),
                    )
                    .child(
                        popover("plugin-select-menu", false, 200., &p)
                            .absolute()
                            .left(at.x)
                            .top(at.y)
                            .children(rows),
                    ),
            )
            .with_priority(4)
            .into_any_element(),
        )
    }
}

struct SelectMenu {
    path: String,
    field: PluginNode,
    choices: Vec<(String, String)>,
    at: Point<Pixels>,
}

impl Drop for PluginSurfaceView {
    fn drop(&mut self) {
        let host = Arc::clone(&self.host);
        self.files.release_all(&host);
        for key in &self.list_keys {
            virtual_list::forget(key);
        }
        self.plugins
            .unmount_surface(&self.plugin, &self.instance, &self.window_id);
    }
}

impl Render for PluginSurfaceView {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        self.registrations.clear();
        self.form_of_field.clear();
        self.files.begin();
        let tree = self.plugins.surface_tree(&self.plugin, &self.instance);
        let p = self.p;
        self.touched.clear();
        let content = match tree {
            Some(tree) => self.render_node(&tree, "root", 0, window, cx),
            None => div()
                .flex()
                .items_center()
                .justify_center()
                .gap(px(space::S))
                .p(px(space::M))
                .child(spinner(surface::SPINNER, p.text_tertiary))
                .child(small("Loading…".to_owned(), p.text_tertiary))
                .into_any_element(),
        };
        let touched = &self.touched;
        self.list_cache.retain(|path, _| touched.contains(path));
        self.markdown_cache.retain(|path, _| touched.contains(path));
        let host = Arc::clone(&self.host);
        self.bindings = merge_bindings(&self.registrations, |s| held_by_ardia(&host, s));
        if let Some(text) = self.pending_copy.take() {
            cx.write_to_clipboard(gpui::ClipboardItem::new_string(text));
        }
        for (input, text) in std::mem::take(&mut self.pending_input_text) {
            input.update(cx, |input, cx| {
                if input.text() != text {
                    input.set_text(text, false, cx);
                }
            });
        }
        let host = Arc::clone(&self.host);
        self.files.finish(&host, window, cx);
        let menu = self.render_menu(cx);
        let select = self.render_select_menu(cx);
        div()
            .id(SharedString::from(format!(
                "plugin-surface:{}",
                self.instance
            )))
            .debug_selector(|| "plugin-surface".into())
            .track_focus(&self.focus)
            .relative()
            .flex()
            .flex_col()
            .w_full()
            .when(
                matches!(self.kind, SurfaceKind::Panel | SurfaceKind::Command),
                |this| this.size_full(),
            )
            .on_key_down(cx.listener(|view, event: &KeyDownEvent, _, cx| {
                if view.press(event, cx) {
                    cx.stop_propagation();
                }
            }))
            .child(content)
            .children(menu)
            .children(select)
    }
}

fn node_json(node: &PluginNode) -> Value {
    fn child_json(child: &Child) -> Value {
        match child {
            Child::Text(text) => Value::String(text.clone()),
            Child::Node(node) => node_json(node),
        }
    }
    let mut fields = Map::new();
    fields.insert("type".into(), Value::String(node.kind.clone()));
    if let Some(key) = &node.key {
        fields.insert("key".into(), Value::String(key.clone()));
    }
    fields.insert("props".into(), Value::Object(node.props.clone()));
    fields.insert(
        "children".into(),
        Value::Array(node.children.iter().map(child_json).collect()),
    );
    Value::Object(fields)
}

fn register_fields(node: &PluginNode, path: &str, out: &mut HashMap<String, String>) {
    fn walk(node: &PluginNode, path: &str, form: &str, out: &mut HashMap<String, String>) {
        for (index, child) in node.children.iter().enumerate() {
            let Child::Node(inner) = child else {
                continue;
            };
            let child_path = format!("{path}/{}", node_key(child, index));
            if matches!(
                inner.kind.as_str(),
                "TextField" | "PasswordField" | "Toggle" | "Select"
            ) {
                out.insert(child_path, form.to_owned());
            } else {
                walk(inner, &child_path, form, out);
            }
        }
    }
    walk(node, path, path, out);
}

pub fn body(text: impl Into<SharedString>, color: Hsla) -> gpui::Div {
    div()
        .text_size(px(TypeSize::Body.points()))
        .line_height(px(TypeSize::Body.line_height()))
        .text_color(color)
        .child(text.into())
}

pub fn small(text: impl Into<SharedString>, color: Hsla) -> gpui::Div {
    div()
        .text_size(px(TypeSize::Small.points()))
        .line_height(px(TypeSize::Small.line_height()))
        .text_color(color)
        .child(text.into())
}

pub fn caption(text: impl Into<SharedString>, color: Hsla) -> gpui::Div {
    div()
        .text_size(px(TypeSize::Caption.points()))
        .line_height(px(TypeSize::Caption.line_height()))
        .text_color(color)
        .child(text.into())
}

pub fn badge(text: impl Into<SharedString>, fill: Hsla, ink: Hsla, small_size: bool) -> AnyElement {
    let height = if small_size { 14. } else { 16. };
    div()
        .flex_none()
        .min_w(px(height))
        .h(px(height))
        .px(px(if small_size { 4. } else { 5. }))
        .rounded_full()
        .bg(fill)
        .flex()
        .items_center()
        .justify_center()
        .text_size(px(
            TypeSize::Badge.points() + if small_size { 0. } else { 1. }
        ))
        .font_weight(FontWeight::SEMIBOLD)
        .text_color(ink)
        .child(text.into())
        .into_any_element()
}

pub fn chevron(open: bool, p: &Palette) -> AnyElement {
    div()
        .w(px(surface::ICON_BOX / 1.5))
        .h(px(surface::ICON_BOX))
        .flex_none()
        .flex()
        .items_center()
        .justify_center()
        .child(icon(
            if open {
                Icon::ChevronDown
            } else {
                Icon::ChevronRight
            },
            surface::CHEVRON,
            p.text_tertiary,
        ))
        .into_any_element()
}

pub fn surface_icon(
    name: Option<String>,
    tone: Option<&str>,
    size: f32,
    p: &Palette,
) -> Option<AnyElement> {
    let name = name?;
    Some(
        div()
            .size(px(surface::ICON_BOX))
            .flex_none()
            .flex()
            .items_center()
            .justify_center()
            .child(symbol(&name, size, tone_of(tone, Role::Icon).color(p)))
            .into_any_element(),
    )
}

pub fn list_row(
    id: SharedString,
    selected: bool,
    height: f32,
    p: &Palette,
) -> gpui::Stateful<gpui::Div> {
    let hover = p.row_hover;
    div()
        .id(id)
        .flex_none()
        .h(px(height))
        .px(px(LIST_ROW_PAD))
        .rounded(px(LIST_ROW_RADIUS))
        .flex()
        .items_center()
        .gap(px(space::M))
        .cursor_pointer()
        .when(selected, |this| this.bg(p.row_selected))
        .when(!selected, |this| this.hover(move |s| s.bg(hover)))
}

pub fn search_field(input: Entity<TextInput>, p: &Palette) -> AnyElement {
    div()
        .flex_1()
        .h(px(28.))
        .px(px(space::M))
        .rounded(px(radius::TILE))
        .bg(p.field)
        .border(px(0.5))
        .border_color(p.field_border)
        .flex()
        .items_center()
        .gap(px(space::S))
        .child(icon(Icon::Search, 12., p.text_tertiary))
        .child(div().flex_1().child(input))
        .into_any_element()
}

pub fn empty_state(
    symbol_name: &str,
    title: &str,
    subtitle: Option<String>,
    p: &Palette,
) -> AnyElement {
    div()
        .flex()
        .flex_col()
        .items_center()
        .justify_center()
        .gap(px(space::M))
        .child(
            div()
                .size(px(40.))
                .flex()
                .items_center()
                .justify_center()
                .child(symbol(symbol_name, 30., p.text_tertiary)),
        )
        .child(
            div()
                .text_size(px(TypeSize::Title.points()))
                .line_height(px(TypeSize::Title.line_height()))
                .font_weight(FontWeight::MEDIUM)
                .text_color(p.text_secondary)
                .child(SharedString::from(title.to_owned())),
        )
        .when_some(subtitle, |this, subtitle| {
            this.child(
                body(subtitle, p.text_tertiary)
                    .text_center()
                    .max_w(px(360.)),
            )
        })
        .into_any_element()
}

fn section_header(
    key: &str,
    title: Option<String>,
    subtitle: Option<String>,
    p: &Palette,
) -> AnyElement {
    if title.is_none() && subtitle.is_none() {
        return div()
            .id(SharedString::from(format!("plugin-section-divider:{key}")))
            .mx(px(space::S))
            .my(px(space::XS))
            .h(px(0.5))
            .bg(p.divider)
            .into_any_element();
    }
    div()
        .flex()
        .items_center()
        .gap(px(space::S))
        .px(px(space::M))
        .py(px(space::XS))
        .children(title.map(|t| caption(t, p.text_secondary).font_weight(FontWeight::SEMIBOLD)))
        .children(subtitle.map(|s| caption(s, p.text_tertiary)))
        .into_any_element()
}

fn accessories(
    values: &[Map<String, Value>],
    badge_text: Option<String>,
    p: &Palette,
) -> AnyElement {
    div()
        .flex()
        .items_center()
        .gap(px(space::S))
        .children(values.iter().map(|accessory| {
            let tone = accessory.get("tone").and_then(Value::as_str);
            let tag = str_of(accessory.get("tag"));
            let text = str_of(accessory.get("text"));
            let (fill, ink) = match fill_tone_of(tone) {
                Some(role) => (role.color(p), p.on_accent),
                None => (p.chip_fill, p.chip_text),
            };
            div()
                .flex()
                .items_center()
                .children(surface_icon(
                    str_of(accessory.get("icon")),
                    tone,
                    surface::ICON,
                    p,
                ))
                .children(tag.map(|tag| badge(tag, fill, ink, false)))
                .children(text.map(|text| small(text, p.text_tertiary)))
        }))
        .children(badge_text.map(|text| badge(text, p.chip_fill, p.chip_text, false)))
        .into_any_element()
}

fn field_frame(node: &PluginNode, control: AnyElement, p: &Palette) -> AnyElement {
    let error = str_prop(node, "error");
    let info = str_prop(node, "info");
    div()
        .flex()
        .flex_col()
        .gap(px(space::XS))
        .when_some(str_prop(node, "title"), |this, title| {
            this.child(small(title, p.text_secondary).font_weight(FontWeight::MEDIUM))
        })
        .child(control)
        .when_some(error.clone(), |this, error| {
            this.child(caption(error, p.destructive))
        })
        .when(error.is_none(), |this| {
            this.when_some(info, |this, info| {
                this.child(caption(info, p.text_tertiary))
            })
        })
        .into_any_element()
}

fn with_hint(hint: Option<String>, element: AnyElement, id: &str, p: &Palette) -> AnyElement {
    match hint {
        None => element,
        Some(hint) => {
            let p = *p;
            div()
                .id(SharedString::from(format!("plugin-hint:{id}")))
                .tooltip(move |window, cx| {
                    crate::primitives::controls::tooltip(hint.clone().into(), &p)(window, cx)
                })
                .child(element)
                .into_any_element()
        }
    }
}

pub fn surface_entity(
    host: &Arc<dyn UiHost>,
    spec: SurfaceSpec,
    p: Palette,
    window: &mut Window,
    cx: &mut App,
) -> Option<Entity<PluginSurfaceView>> {
    let plugins = plugin_host(host)?;
    let host = Arc::clone(host);
    Some(cx.new(|cx| PluginSurfaceView::new(host, plugins, spec, p, window, cx)))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::plugins::nodes::check_plugin_node;
    use serde_json::json;

    #[test]
    fn list_entries_filter_and_section() {
        let list = check_plugin_node(&json!({
            "type": "List",
            "children": [
                {"type": "ListItem", "props": {"title": "Alpha"}},
                {"type": "ListSection", "props": {"title": "More"}, "children": [
                    {"type": "ListItem", "key": "b", "props": {"title": "Beta", "keywords": ["second"]}},
                    {"type": "ListItem", "props": {"id": "g", "title": "Gamma"}}
                ]},
                {"type": "ListSection", "props": {"title": "Empty"}, "children": [
                    {"type": "ListItem", "props": {"title": "Zed"}}
                ]}
            ]
        }))
        .unwrap();
        let all = list_items(&list, "");
        assert_eq!(
            all.iter().map(|(id, _)| id.as_str()).collect::<Vec<_>>(),
            vec!["i0", "s1k:b", "g", "s2i0"]
        );
        let shown = list_entries(&list, "second", true);
        assert_eq!(shown.len(), 2);
        assert!(matches!(&shown[0], Entry::Section { title: Some(t), .. } if t == "More"));
        assert_eq!(list_entries(&list, "second", false).len(), 6);
        let ids: Vec<String> = all.into_iter().map(|(id, _)| id).collect();
        assert_eq!(stepped(&ids, Some("i0"), -1).as_deref(), Some("s2i0"));
        assert_eq!(stepped(&ids, Some("g"), 1).as_deref(), Some("s2i0"));
        assert_eq!(stepped(&ids, None, 1).as_deref(), Some("s1k:b"));
        assert_eq!(stepped(&[], None, 1), None);
    }
}
