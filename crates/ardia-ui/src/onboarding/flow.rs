use ardia_state::BrowserState;
use ardia_state::model::TabLayout;
use ardia_state::settings::Settings;
use serde_json::{Map, Value, json};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Step {
    Intro,
    Source,
    Layout,
    Tabs,
    Look,
    SearchPrivacy,
    Pins,
    Home,
    Plugins,
    Outro,
}

impl Step {
    pub const ALL: [Step; 10] = [
        Step::Intro,
        Step::Source,
        Step::Layout,
        Step::Tabs,
        Step::Look,
        Step::SearchPrivacy,
        Step::Pins,
        Step::Home,
        Step::Plugins,
        Step::Outro,
    ];

    pub const fn key(self) -> &'static str {
        match self {
            Step::Intro => "intro",
            Step::Source => "source",
            Step::Layout => "layout",
            Step::Tabs => "tabs",
            Step::Look => "look",
            Step::SearchPrivacy => "searchPrivacy",
            Step::Pins => "pins",
            Step::Home => "home",
            Step::Plugins => "plugins",
            Step::Outro => "outro",
        }
    }

    pub fn from_key(key: &str) -> Option<Step> {
        Step::ALL.into_iter().find(|step| step.key() == key)
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum QuestionId {
    Source,
    Tabs,
    Color,
    Style,
    Address,
    Cmdl,
    NewTab,
    NewTabPosition,
    CtrlTab,
    Tidy,
    Quit,
    Windows,
    TabsMore,
    Appearance,
    Frame,
    SiteColor,
    LookMore,
    Engine,
    Crash,
    Pins,
    Default,
    Links,
    Plugins,
    Outro,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Question {
    pub id: QuestionId,
    pub keys: &'static [&'static str],
    pub asked_with_preset: bool,
}

const fn ask(id: QuestionId, keys: &'static [&'static str]) -> Question {
    Question {
        id,
        keys,
        asked_with_preset: false,
    }
}

const fn always(id: QuestionId, keys: &'static [&'static str]) -> Question {
    Question {
        id,
        keys,
        asked_with_preset: true,
    }
}

const SOURCE_QUESTIONS: &[Question] = &[ask(QuestionId::Source, &[])];
const LAYOUT_QUESTIONS: &[Question] = &[
    ask(QuestionId::Tabs, &["tabLayout"]),
    ask(QuestionId::Color, &[]),
    always(
        QuestionId::Style,
        &["interfaceStyle", "glassTintWithTheme", "glassTintAmount"],
    ),
    ask(QuestionId::Address, &["addressBar"]),
    ask(QuestionId::Cmdl, &["commandBarPlacement"]),
];
const TABS_QUESTIONS: &[Question] = &[
    ask(QuestionId::NewTab, &["newTabOpens"]),
    ask(
        QuestionId::NewTabPosition,
        &["newTabPosition", "newTabButtonPosition"],
    ),
    always(
        QuestionId::CtrlTab,
        &["tabSwitcherOrder", "tabSwitcherView"],
    ),
    ask(QuestionId::Tidy, &["cleanUpInactiveTabsAfterMinutes"]),
    ask(QuestionId::Quit, &["restoreSession"]),
    ask(QuestionId::Windows, &["shareTabsAcrossWindows"]),
    ask(
        QuestionId::TabsMore,
        &[
            "balancedTopApps",
            "peekModifier",
            "undoReopensClosedTab",
            "cmdClickCreatesTabGroup",
        ],
    ),
];
const LOOK_QUESTIONS: &[Question] = &[
    ask(QuestionId::Appearance, &["appearance"]),
    always(QuestionId::Frame, &["pageFrame", "borderlessMode"]),
    ask(QuestionId::SiteColor, &["extendWebsiteColor"]),
    ask(
        QuestionId::LookMore,
        &["hideToolbarWhileScrolling", "bookmarksBar"],
    ),
];
const SEARCH_QUESTIONS: &[Question] = &[
    ask(QuestionId::Engine, &["searchEngine"]),
    ask(QuestionId::Crash, &[]),
];
const PINS_QUESTIONS: &[Question] = &[ask(QuestionId::Pins, &[])];
const HOME_QUESTIONS: &[Question] = &[
    ask(QuestionId::Default, &[]),
    ask(QuestionId::Links, &["openLinksInLittleArdia"]),
];
const PLUGINS_QUESTIONS: &[Question] = &[ask(QuestionId::Plugins, &[])];
const OUTRO_QUESTIONS: &[Question] = &[ask(QuestionId::Outro, &[])];

pub fn all_questions(step: Step) -> &'static [Question] {
    match step {
        Step::Intro => &[],
        Step::Source => SOURCE_QUESTIONS,
        Step::Layout => LAYOUT_QUESTIONS,
        Step::Tabs => TABS_QUESTIONS,
        Step::Look => LOOK_QUESTIONS,
        Step::SearchPrivacy => SEARCH_QUESTIONS,
        Step::Pins => PINS_QUESTIONS,
        Step::Home => HOME_QUESTIONS,
        Step::Plugins => PLUGINS_QUESTIONS,
        Step::Outro => OUTRO_QUESTIONS,
    }
}

pub const QUESTION_ORDER: [QuestionId; 24] = [
    QuestionId::Source,
    QuestionId::Tabs,
    QuestionId::Color,
    QuestionId::Style,
    QuestionId::Address,
    QuestionId::Cmdl,
    QuestionId::NewTab,
    QuestionId::NewTabPosition,
    QuestionId::CtrlTab,
    QuestionId::Tidy,
    QuestionId::Quit,
    QuestionId::Windows,
    QuestionId::TabsMore,
    QuestionId::Appearance,
    QuestionId::Frame,
    QuestionId::SiteColor,
    QuestionId::LookMore,
    QuestionId::Engine,
    QuestionId::Crash,
    QuestionId::Pins,
    QuestionId::Default,
    QuestionId::Links,
    QuestionId::Plugins,
    QuestionId::Outro,
];

pub fn question_keys(id: QuestionId) -> &'static [&'static str] {
    Step::ALL
        .into_iter()
        .flat_map(all_questions)
        .find(|q| q.id == id)
        .map_or(&[], |q| q.keys)
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Source {
    Arc,
    Dia,
    Chrome,
    Safari,
    Firefox,
    Zen,
    Brave,
    Edge,
    Helium,
    Chromium,
    Vivaldi,
    Opera,
    Fresh,
}

impl Source {
    pub const ALL: [Source; 13] = [
        Source::Arc,
        Source::Dia,
        Source::Chrome,
        Source::Safari,
        Source::Firefox,
        Source::Zen,
        Source::Brave,
        Source::Edge,
        Source::Helium,
        Source::Chromium,
        Source::Vivaldi,
        Source::Opera,
        Source::Fresh,
    ];

    pub const fn key(self) -> &'static str {
        match self {
            Source::Arc => "arc",
            Source::Dia => "dia",
            Source::Chrome => "chrome",
            Source::Safari => "safari",
            Source::Firefox => "firefox",
            Source::Zen => "zen",
            Source::Brave => "brave",
            Source::Edge => "edge",
            Source::Helium => "helium",
            Source::Chromium => "chromium",
            Source::Vivaldi => "vivaldi",
            Source::Opera => "opera",
            Source::Fresh => "fresh",
        }
    }

    pub const fn name(self) -> &'static str {
        match self {
            Source::Arc => "Arc",
            Source::Dia => "Dia",
            Source::Chrome => "Chrome",
            Source::Safari => "Safari",
            Source::Firefox => "Firefox",
            Source::Zen => "Zen",
            Source::Brave => "Brave",
            Source::Edge => "Edge",
            Source::Helium => "Helium",
            Source::Chromium => "Chromium",
            Source::Vivaldi => "Vivaldi",
            Source::Opera => "Opera",
            Source::Fresh => "Ardia",
        }
    }

    pub fn from_key(key: &str) -> Option<Source> {
        Source::ALL.into_iter().find(|source| source.key() == key)
    }

    pub fn sets_up_like_browser(source: Option<Source>) -> bool {
        source.is_some_and(|s| s != Source::Fresh)
    }

    pub fn preset(self) -> Map<String, Value> {
        let mut values = match self {
            Source::Dia => object(json!({
                "tabLayout": "sidebar",
                "addressBar": "toolbar",
                "commandBarPlacement": "field",
                "newTabOpens": "page",
                "newTabPosition": "bottom",
                "newTabButtonPosition": "bottom",
                "cleanUpInactiveTabsAfterMinutes": null,
                "restoreSession": true,
                "shareTabsAcrossWindows": false,
                "balancedTopApps": false,
                "peekModifier": "shift",
                "undoReopensClosedTab": false,
                "appearance": "auto",
                "extendWebsiteColor": true,
                "hideToolbarWhileScrolling": true,
                "bookmarksBar": "never",
                "searchEngine": "google",
                "openLinksInLittleArdia": true,
                "peekLinksToOtherSites": true,
                "newTabLinksOpenIn": "peek",
                "tabSwitcherOrder": "recent",
                "tabSwitcherView": "thumbnails",
            })),
            Source::Arc => object(json!({
                "tabLayout": "sidebar",
                "addressBar": "sidebar",
                "commandBarPlacement": "centred",
                "newTabOpens": "commandBar",
                "newTabPosition": "top",
                "newTabButtonPosition": "top",
                "cleanUpInactiveTabsAfterMinutes": 720,
                "restoreSession": true,
                "shareTabsAcrossWindows": true,
                "balancedTopApps": true,
                "peekModifier": "shift",
                "undoReopensClosedTab": true,
                "cmdClickCreatesTabGroup": false,
                "appearance": "auto",
                "extendWebsiteColor": false,
                "hideToolbarWhileScrolling": true,
                "bookmarksBar": "never",
                "searchEngine": "google",
                "openLinksInLittleArdia": true,
                "peekLinksToOtherSites": true,
                "newTabLinksOpenIn": "peek",
                "tabSwitcherOrder": "recent",
                "tabSwitcherView": "thumbnails",
            })),
            Source::Zen => object(json!({
                "tabLayout": "sidebar",
                "addressBar": "sidebar",
                "commandBarPlacement": "centred",
                "newTabOpens": "commandBar",
                "newTabPosition": "top",
                "newTabButtonPosition": "top",
                "cleanUpInactiveTabsAfterMinutes": null,
                "restoreSession": true,
                "shareTabsAcrossWindows": false,
                "balancedTopApps": true,
                "peekModifier": "alt",
                "undoReopensClosedTab": false,
                "cmdClickCreatesTabGroup": false,
                "appearance": "auto",
                "extendWebsiteColor": false,
                "hideToolbarWhileScrolling": false,
                "bookmarksBar": "never",
                "searchEngine": "google",
                "openLinksInLittleArdia": false,
                "peekLinksToOtherSites": true,
                "newTabLinksOpenIn": "peek",
                "tabSwitcherOrder": "inOrder",
                "tabSwitcherView": "none",
            })),
            Source::Fresh => object(json!({
                "addressBar": "sidebar",
                "commandBarPlacement": "centred",
                "newTabPosition": "nextToCurrent",
                "newTabButtonPosition": "bottom",
            })),
            Source::Chrome
            | Source::Firefox
            | Source::Safari
            | Source::Brave
            | Source::Edge
            | Source::Helium
            | Source::Chromium
            | Source::Vivaldi
            | Source::Opera => classic_tabs(),
        };
        match self {
            Source::Safari => {
                values.insert("extendWebsiteColor".into(), json!(true));
                values.insert("bookmarksBar".into(), json!("never"));
            }
            Source::Brave => {
                values.insert("searchEngine".into(), json!("brave"));
            }
            Source::Edge => {
                values.insert("searchEngine".into(), json!("bing"));
            }
            Source::Vivaldi | Source::Opera => {
                values.insert("tabSwitcherOrder".into(), json!("recent"));
                values.insert("tabSwitcherView".into(), json!("thumbnails"));
            }
            _ => {}
        }
        values
    }
}

fn object(value: Value) -> Map<String, Value> {
    match value {
        Value::Object(map) => map,
        _ => Map::new(),
    }
}

fn classic_tabs() -> Map<String, Value> {
    object(json!({
        "tabLayout": "top",
        "addressBar": "toolbar",
        "commandBarPlacement": "field",
        "newTabOpens": "page",
        "newTabPosition": "bottom",
        "newTabButtonPosition": "bottom",
        "cleanUpInactiveTabsAfterMinutes": null,
        "restoreSession": true,
        "shareTabsAcrossWindows": false,
        "balancedTopApps": false,
        "peekModifier": "alt",
        "undoReopensClosedTab": false,
        "cmdClickCreatesTabGroup": false,
        "appearance": "auto",
        "extendWebsiteColor": false,
        "hideToolbarWhileScrolling": false,
        "bookmarksBar": "newTab",
        "searchEngine": "google",
        "openLinksInLittleArdia": false,
        "peekLinksToOtherSites": false,
        "newTabLinksOpenIn": "tab",
        "tabSwitcherOrder": "inOrder",
        "tabSwitcherView": "none",
    }))
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct Extras {
    pub app_icon: Option<String>,
    pub color: Option<String>,
    pub share: Option<bool>,
    pub pins: Option<Vec<String>>,
    pub set_default: Option<bool>,
    pub trial: Option<bool>,
    pub dock: Option<bool>,
    pub login: Option<bool>,
}

#[derive(Clone, Debug, PartialEq)]
pub enum Effect {
    Settings {
        values: Map<String, Value>,
        from_sync: bool,
    },
    WindowLayout(TabLayout),
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct Context {
    pub settings: Map<String, Value>,
    pub chosen: Vec<String>,
    pub inferred: Vec<String>,
    pub window_layout: Option<TabLayout>,
    pub glass: bool,
    pub plugins_offered: bool,
}

impl Context {
    pub fn of(state: &BrowserState, window: Option<&str>) -> Context {
        let mut settings = match state.settings.to_value() {
            Value::Object(map) => map,
            _ => Map::new(),
        };
        let window_layout = window.map(|id| state.tab_layout(id));
        if let Some(layout) = window_layout {
            settings.insert(
                "tabLayout".into(),
                serde_json::to_value(layout).unwrap_or(Value::Null),
            );
        }
        Context {
            settings,
            chosen: state.settings_meta.chosen.clone(),
            inferred: state.settings_meta.inferred.clone(),
            window_layout,
            glass: true,
            plugins_offered: false,
        }
    }

    pub fn setting(&self, key: &str) -> Value {
        self.settings
            .get(key)
            .cloned()
            .or_else(|| Settings::default().get(key))
            .unwrap_or(Value::Null)
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct Flow {
    pub step: Step,
    pub sub: usize,
    pub source: Option<Source>,
    pub preset: Source,
    pub prefill_preset: bool,
    pub redo: bool,
    pub redo_source: Option<Source>,
    pub draft: Map<String, Value>,
    pub extras: Extras,
    pub baseline: Map<String, Value>,
    pub color_baseline: Option<String>,
    pub picked: Vec<(QuestionId, Vec<String>)>,
    pub finished: bool,
}

impl Default for Flow {
    fn default() -> Self {
        Flow::new()
    }
}

impl Flow {
    pub fn new() -> Flow {
        Flow {
            step: Step::Intro,
            sub: 0,
            source: None,
            preset: Source::Dia,
            prefill_preset: true,
            redo: false,
            redo_source: None,
            draft: Map::new(),
            extras: Extras::default(),
            baseline: Map::new(),
            color_baseline: None,
            picked: Vec::new(),
            finished: false,
        }
    }

    pub fn redo(source: Option<Source>, preset: Option<Source>) -> Flow {
        Flow {
            redo: true,
            redo_source: source,
            source,
            preset: preset.or(source).unwrap_or(Source::Dia),
            prefill_preset: false,
            ..Flow::new()
        }
    }

    pub fn resume(step: Option<Step>, source: Option<Source>, preset: Option<Source>) -> Flow {
        let step = step.filter(|s| *s != Step::Intro).unwrap_or(Step::Source);
        Flow {
            step,
            source,
            preset: preset.or(source).unwrap_or(Source::Dia),
            ..Flow::new()
        }
    }

    pub fn settle(&mut self, cx: &Context) {
        let active = self.active_steps(cx);
        if active.contains(&self.step) {
            return;
        }
        let at = Step::ALL.iter().position(|s| *s == self.step).unwrap_or(0);
        self.step = Step::ALL
            .iter()
            .skip(at)
            .find(|s| active.contains(s))
            .copied()
            .unwrap_or(Step::Outro);
        self.sub = 0;
    }

    pub fn draft_preset(&self) -> Option<Source> {
        self.prefill_preset.then_some(self.preset)
    }

    pub fn resolve(&self, key: &str, cx: &Context) -> Value {
        if let Some(value) = self.draft.get(key) {
            return value.clone();
        }
        if let Some(preset) = self.draft_preset()
            && !cx.chosen.iter().any(|k| k == key)
            && let Some(value) = preset.preset().get(key)
        {
            return value.clone();
        }
        cx.setting(key)
    }

    pub fn resolve_str(&self, key: &str, cx: &Context) -> String {
        self.resolve(key, cx)
            .as_str()
            .unwrap_or_default()
            .to_owned()
    }

    pub fn resolve_bool(&self, key: &str, cx: &Context) -> bool {
        self.resolve(key, cx).as_bool().unwrap_or(false)
    }

    pub fn resolve_f64(&self, key: &str, cx: &Context) -> Option<f64> {
        self.resolve(key, cx).as_f64()
    }

    pub fn questions_for(&self, step: Step, cx: &Context) -> Vec<Question> {
        if step == Step::Intro || (step == Step::Plugins && !cx.plugins_offered) {
            return Vec::new();
        }
        let preset = self.draft_preset();
        let answered = |q: &Question| {
            preset.is_some_and(|p| {
                let values = p.preset();
                !q.asked_with_preset
                    && !q.keys.is_empty()
                    && q.keys.iter().all(|k| values.contains_key(*k))
            })
        };
        let filter_preset = preset.is_some() && Source::sets_up_like_browser(self.source);
        let list: Vec<Question> = all_questions(step)
            .iter()
            .filter(|q| !(filter_preset && answered(q)))
            .filter(|q| cx.glass || q.id != QuestionId::Style)
            .copied()
            .collect();
        if !list.iter().any(|q| q.id == QuestionId::Address) {
            return list;
        }
        if self.resolve_str("tabLayout", cx) == "top" {
            list.into_iter()
                .filter(|q| q.id != QuestionId::Address)
                .collect()
        } else {
            list
        }
    }

    pub fn active_steps(&self, cx: &Context) -> Vec<Step> {
        Step::ALL
            .into_iter()
            .filter(|step| *step == Step::Intro || !self.questions_for(*step, cx).is_empty())
            .collect()
    }

    pub fn sections(&self, cx: &Context) -> Vec<(Step, usize, QuestionId)> {
        self.active_steps(cx)
            .into_iter()
            .flat_map(|step| {
                self.questions_for(step, cx)
                    .into_iter()
                    .enumerate()
                    .map(move |(sub, q)| (step, sub, q.id))
            })
            .collect()
    }

    pub fn section_index(&self, cx: &Context) -> usize {
        let sections = self.sections(cx);
        sections
            .iter()
            .position(|(step, sub, _)| *step == self.step && *sub == self.sub)
            .or_else(|| sections.iter().position(|(step, _, _)| *step == self.step))
            .unwrap_or(0)
    }

    pub fn current(&self, cx: &Context) -> Option<QuestionId> {
        self.questions_for(self.step, cx)
            .get(self.sub)
            .map(|q| q.id)
    }

    fn step_after(&self, step: Step, delta: isize, cx: &Context) -> Option<Step> {
        let steps = self.active_steps(cx);
        let at = steps.iter().position(|s| *s == step)? as isize + delta;
        usize::try_from(at).ok().and_then(|i| steps.get(i).copied())
    }

    pub fn go_to(&mut self, step: Step, sub: usize) {
        self.step = step;
        self.sub = sub;
    }

    pub fn next(&mut self, cx: &Context) {
        if self.sub + 1 < self.questions_for(self.step, cx).len() {
            self.sub += 1;
            return;
        }
        match self.step_after(self.step, 1, cx) {
            Some(after) => self.go_to(after, 0),
            None => self.finished = true,
        }
    }

    pub fn back(&mut self, cx: &Context) {
        if self.sub > 0 {
            self.sub -= 1;
            return;
        }
        if let Some(before) = self.step_after(self.step, -1, cx)
            && before != Step::Intro
        {
            let last = self.questions_for(before, cx).len().saturating_sub(1);
            self.go_to(before, last);
        }
    }

    pub fn is_first(&self, cx: &Context) -> bool {
        self.sub == 0 && self.step_after(self.step, -1, cx) == Some(Step::Intro)
    }

    pub fn choose_source(&mut self, source: Option<Source>) {
        self.source = source;
        self.preset = source.unwrap_or(Source::Dia);
        self.prefill_preset = !(self.redo && source == self.redo_source);
    }

    pub fn source_patch(&self, cx: &Context) -> Map<String, Value> {
        if !self.prefill_preset || !Source::sets_up_like_browser(self.source) {
            return Map::new();
        }
        let mut values = self.source.map(Source::preset).unwrap_or_default();
        if cx.inferred.iter().any(|k| k == "searchEngine")
            && values.remove("searchEngine").is_some()
        {
            ardia_telemetry::counts::count("onboarding_preset_kept_imports");
        }
        values
    }

    pub fn change(&mut self, patch: Map<String, Value>) {
        for (key, value) in patch {
            self.draft.insert(key, value);
        }
    }

    pub fn live(&mut self, patch: Map<String, Value>, cx: &Context) -> Vec<Effect> {
        for key in patch.keys() {
            if !self.baseline.contains_key(key) {
                self.baseline.insert(key.clone(), cx.setting(key));
            }
        }
        self.change(patch.clone());
        split_layout(patch, true)
    }

    pub fn note_color(&mut self, current: &str) {
        if self.color_baseline.is_none() {
            self.color_baseline = Some(current.to_owned());
        }
    }

    pub fn confirm(
        &mut self,
        question: QuestionId,
        patch: Map<String, Value>,
        picked: Vec<String>,
        cx: &Context,
    ) -> Vec<Effect> {
        for key in patch.keys() {
            self.baseline.remove(key);
        }
        if question == QuestionId::Color {
            self.color_baseline = None;
        }
        self.picked.retain(|(q, _)| *q != question);
        self.picked.push((question, picked));
        let effects = split_layout(patch, false);
        self.next(cx);
        effects
    }

    pub fn skip(&mut self, whole_step: bool, cx: &Context) -> (Vec<Effect>, Option<String>) {
        let questions = self.questions_for(self.step, cx);
        let rest: Vec<Question> = if whole_step {
            questions.iter().skip(self.sub).copied().collect()
        } else {
            questions.iter().skip(self.sub).take(1).copied().collect()
        };
        let keys: Vec<&str> = rest.iter().flat_map(|q| q.keys.iter().copied()).collect();
        let color = rest
            .iter()
            .any(|q| q.id == QuestionId::Color)
            .then(|| self.color_baseline.take())
            .flatten();
        let effects = self.revert(&keys);
        for key in &keys {
            self.draft.remove(*key);
        }
        if whole_step {
            match self.step_after(self.step, 1, cx) {
                Some(after) => self.go_to(after, 0),
                None => self.finished = true,
            }
        } else {
            self.next(cx);
        }
        (effects, color)
    }

    pub fn revert(&mut self, keys: &[&str]) -> Vec<Effect> {
        let mut restore = Map::new();
        for key in keys {
            if let Some(value) = self.baseline.remove(*key) {
                restore.insert((*key).to_owned(), value);
            }
        }
        split_layout(restore, true)
    }

    pub fn revert_all(&mut self) -> (Vec<Effect>, Option<String>) {
        let keys: Vec<String> = self.baseline.keys().cloned().collect();
        let keys: Vec<&str> = keys.iter().map(String::as_str).collect();
        (self.revert(&keys), self.color_baseline.take())
    }

    pub fn picked_lines(&self) -> Vec<String> {
        QUESTION_ORDER
            .iter()
            .flat_map(|q| {
                self.picked
                    .iter()
                    .filter(move |(id, _)| id == q)
                    .flat_map(|(_, lines)| lines.iter().cloned())
            })
            .collect()
    }
}

fn split_layout(mut patch: Map<String, Value>, from_sync: bool) -> Vec<Effect> {
    let mut effects = Vec::new();
    if let Some(layout) = patch
        .get("tabLayout")
        .and_then(|v| serde_json::from_value::<TabLayout>(v.clone()).ok())
    {
        effects.push(Effect::WindowLayout(layout));
        if from_sync {
            patch.remove("tabLayout");
        }
    }
    if !patch.is_empty() {
        effects.push(Effect::Settings {
            values: patch,
            from_sync,
        });
    }
    effects
}

pub fn layout_tag(flow: &Flow, cx: &Context) -> String {
    let keys: &[&str] = if flow.resolve_str("tabLayout", cx) == "top" {
        &["tabLayout", "commandBarPlacement"]
    } else {
        &["tabLayout", "addressBar", "commandBarPlacement"]
    };
    let defaults = Settings::default();
    let matches = |source: Source| {
        let preset = source.preset();
        keys.iter().all(|k| {
            let want = preset
                .get(*k)
                .cloned()
                .or_else(|| defaults.get(k))
                .unwrap_or(Value::Null);
            flow.resolve(k, cx) == want
        })
    };
    [flow.preset, Source::Arc, Source::Dia]
        .into_iter()
        .find(|s| matches(*s))
        .map_or_else(|| "Your mix".to_owned(), |s| format!("{}-style", s.name()))
}

pub fn patch(pairs: &[(&str, Value)]) -> Map<String, Value> {
    pairs
        .iter()
        .map(|(k, v)| ((*k).to_owned(), v.clone()))
        .collect()
}

pub fn pick(flow: &Flow, keys: &[&str], cx: &Context) -> Map<String, Value> {
    keys.iter()
        .map(|k| ((*k).to_owned(), flow.resolve(k, cx)))
        .collect()
}

pub fn touched_or_preset(flow: &Flow, keys: &[&str], cx: &Context) -> Map<String, Value> {
    keys.iter()
        .filter(|k| flow.draft.contains_key(**k) || flow.resolve(k, cx) != cx.setting(k))
        .map(|k| ((*k).to_owned(), flow.resolve(k, cx)))
        .collect()
}
