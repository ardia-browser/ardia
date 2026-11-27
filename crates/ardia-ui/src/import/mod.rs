pub mod steps;

use std::sync::Arc;
use std::time::{Duration, Instant};

use crate::scale::px;
use ardia_state::{BrowserState, Interest, ProfileId, Topics};
use ardia_theme::layout::lights;
use gpui::{
    App, Context, FocusHandle, Focusable, FontWeight, IntoElement, MouseButton, ParentElement,
    PathPromptOptions, Render, SharedString, Styled, Window, div, prelude::*,
};

use crate::host::UiHost;
use crate::host_data::{
    HostLink, HostTopics, ImportBrowser, ImportPlan, ImportProgress, ImportStage, StageState,
};
use crate::keybindings::{Dismiss, RunCommand, RunReservedCommand};
use crate::look::{Look, UI_FONT};
use crate::msg::{Emit, Msg};
use crate::primitives::controls::{
    ButtonKind, Checkbox, MenuRow, PopUp, PushButton, popover, spinner,
};
use crate::primitives::icons::{Icon, icon};
use crate::primitives::pop_up_menu::{self, PopUpChoice};
use crate::primitives::theme_bridge::traffic_light_origin;
use crate::store_link::StoreLink;
use crate::window::backdrop::BackdropDriver;
use ardia_theme::tokens::{TypeSize, radius, space};

pub const IMPORT_SIZE: [f32; 2] = [600.0, 520.0];
pub const BROWSER_ROW: f32 = 52.0;
pub const AVATAR: f32 = 28.0;
pub const LOADING_TOP: f32 = 80.0;
pub const CHOOSE_TITLE: &str = "Import from Another Browser";
pub const CHOOSE_SUBTITLE: &str = "Import once and stay in your flow. Your tabs, passwords, bookmarks and history come with you, and you stay signed in.";
pub const PROFILES_TITLE: &str = "Unlock your data for import";
pub const PROFILES_SUBTITLE: &str = "Select the profiles you want to import.";
pub const PROFILES_NOTE: &str = "Customize which profiles to bring over to Ardia. The first goes into your selected profile; the others become new profiles.";

pub fn no_browsers_note() -> &'static str {
    if cfg!(target_os = "macos") {
        "No other browsers with data to import were found on this Mac."
    } else {
        "No other browsers with data to import were found on this computer."
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Stage {
    Choosing,
    Profiles,
    Safari {
        error: Option<String>,
    },
    Unlock {
        error: Option<String>,
    },
    Started {
        source: String,
        at: Instant,
        after_run: Option<u64>,
    },
}

pub struct ImportWindowView {
    pub(crate) host: Arc<dyn UiHost>,
    pub(crate) state: Arc<BrowserState>,
    pub(crate) look: Look,
    pub(crate) emit: Emit,
    pub(crate) browsers: Option<Vec<ImportBrowser>>,
    pub(crate) source: Option<String>,
    pub(crate) source_profiles: Vec<String>,
    pub(crate) kinds: Vec<String>,
    pub(crate) target: Option<ProfileId>,
    pub(crate) target_menu: bool,
    pub(crate) stage: Stage,
    pub(crate) progress: Option<ImportProgress>,
    pub(crate) done_pending: bool,
    pub(crate) done_ready: bool,
    pub(crate) safari_cookies: bool,
    pub(crate) unlocking: bool,
    pub(crate) plan_source: Option<String>,
    focus: FocusHandle,
    backdrop: BackdropDriver,
    _store: StoreLink,
    _host: HostLink,
}

impl Focusable for ImportWindowView {
    fn focus_handle(&self, _: &App) -> FocusHandle {
        self.focus.clone()
    }
}

impl ImportWindowView {
    pub fn new(host: Arc<dyn UiHost>, window: &mut Window, cx: &mut Context<Self>) -> Self {
        let state = host.store().snapshot();
        crate::scale::sync(&state, cx);
        let look = Look::new(&state, "", window.appearance());
        let store = StoreLink::new(
            host.store(),
            Interest::Topics(Topics::PROFILES | Topics::SETTINGS),
            window,
            cx,
            Self::sync,
        );
        let host_link = HostLink::new(
            host.host_signal(),
            HostTopics::IMPORT,
            window,
            cx,
            Self::on_progress,
        );
        host.refresh_import_browsers();
        let target = Some(state.last_active_profile());
        let mut view = ImportWindowView {
            emit: Emit::new(cx.weak_entity(), Self::handle),
            host,
            state,
            look,
            browsers: None,
            source: None,
            source_profiles: Vec::new(),
            kinds: Vec::new(),
            target,
            target_menu: false,
            stage: Stage::Choosing,
            progress: None,
            done_pending: false,
            done_ready: false,
            safari_cookies: true,
            unlocking: false,
            plan_source: None,
            focus: cx.focus_handle(),
            backdrop: BackdropDriver::default(),
            _store: store,
            _host: host_link,
        };
        view.take_browsers();
        view.backdrop.aim(
            view.look.backdrop(crate::window::looks_active(window)),
            false,
            Instant::now(),
        );
        view.backdrop.apply(window, Instant::now());
        view.backdrop
            .place_lights(traffic_light_origin(lights::SETTINGS_CENTER), window);
        window.focus(&view.focus, cx);
        view
    }

    pub fn stage(&self) -> &Stage {
        &self.stage
    }

    pub fn progress(&self) -> Option<&ImportProgress> {
        self.progress.as_ref()
    }

    pub fn showing_done(&self) -> bool {
        self.done_ready
    }

    pub fn chosen(&self) -> Option<&ImportBrowser> {
        let id = self.source.as_ref()?;
        self.browsers
            .as_ref()?
            .iter()
            .find(|browser| &browser.id == id)
    }

    fn take_browsers(&mut self) {
        let fresh = self.host.import_browsers();
        if fresh == self.browsers {
            return;
        }
        self.browsers = fresh;
        if self.chosen().is_none()
            && let Some(first) = self
                .browsers
                .as_ref()
                .and_then(|list| list.first())
                .cloned()
        {
            self.choose(&first);
        }
    }

    fn choose(&mut self, browser: &ImportBrowser) {
        self.source = Some(browser.id.clone());
        self.source_profiles = browser.default_profiles();
        self.kinds = browser.kinds.clone();
    }

    fn on_progress(&mut self, _: HostTopics, _: &mut Window, cx: &mut Context<Self>) {
        self.take_browsers();
        self.refresh_progress();
        if let Some(error) = self.safari_failure() {
            self.stage = Stage::Safari { error: Some(error) };
            self.progress = None;
            cx.notify();
            return;
        }
        let finished = self.progress.as_ref().is_some_and(|p| p.finished);
        if finished && !self.done_pending {
            self.done_pending = true;
            cx.spawn(async move |view, cx| {
                cx.background_executor().timer(DONE_DELAY).await;
                let _ = view.update(cx, |view, cx| {
                    view.done_ready = true;
                    cx.notify();
                });
            })
            .detach();
        }
        cx.notify();
    }

    fn refresh_progress(&mut self) {
        let Stage::Started { after_run, .. } = &self.stage else {
            self.progress = None;
            return;
        };
        let after_run = *after_run;
        self.progress = self
            .host
            .import_progress()
            .filter(|progress| Some(progress.run) != after_run);
    }

    fn sync(&mut self, _: Topics, window: &mut Window, cx: &mut Context<Self>) {
        self.state = self.host.store().snapshot();
        crate::scale::sync(&self.state, cx);
        self.look.refresh(&self.state, "", window.appearance());
        if self
            .target
            .as_ref()
            .is_some_and(|p| self.state.profile(p.as_str()).is_none())
        {
            self.target = Some(self.state.last_active_profile());
        }
        cx.notify();
    }

    fn safari_failure(&self) -> Option<String> {
        let progress = self.progress.as_ref()?;
        let problem = progress.error.as_deref()?;
        match self.plan_source.as_deref()? {
            SAFARI_EXPORT => Some(
                if problem == "Not a zip file"
                    || problem.contains("doesn't look like a Safari export")
                {
                    "Please select a folder or zip file.".to_owned()
                } else {
                    "The selected file is invalid. Please try again.".to_owned()
                },
            ),
            SAFARI => Some(if problem.contains("Full Disk Access") {
                "Ardia still doesn't have Full Disk Access. Grant it above, or use the export file below.".to_owned()
            } else {
                "Couldn't read Safari's data. Try the export file below.".to_owned()
            }),
            _ => None,
        }
    }

    fn unlock(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(browser) = self.chosen().cloned() else {
            return;
        };
        if self.unlocking {
            return;
        }
        self.unlocking = true;
        self.stage = Stage::Unlock { error: None };
        let answer = self.host.unlock_import(browser.id.clone(), browser.name);
        cx.spawn_in(window, async move |view, cx| {
            let outcome = answer.await.unwrap_or_else(|_| Err("cancelled".into()));
            let _ = view.update(cx, |view, cx| {
                view.unlocking = false;
                if !matches!(view.stage, Stage::Unlock { .. }) {
                    return;
                }
                match outcome {
                    Ok(()) => {
                        if let Some(plan) = view.plan() {
                            view.start(plan);
                        }
                    }
                    Err(error) => view.stage = Stage::Unlock { error: Some(error) },
                }
                cx.notify();
            });
        })
        .detach();
    }

    fn start(&mut self, plan: ImportPlan) {
        self.plan_source = Some(plan.source_id.clone());
        let after_run = self.host.import_progress().map(|progress| progress.run);
        self.stage = Stage::Started {
            source: plan.source_name.clone(),
            at: Instant::now(),
            after_run,
        };
        self.target_menu = false;
        self.host.run_import(plan);
        self.refresh_progress();
    }

    fn plan(&self) -> Option<ImportPlan> {
        let browser = self.chosen()?;
        Some(ImportPlan {
            source_id: browser.id.clone(),
            source_name: browser.name.clone(),
            profiles: browser
                .profiles
                .iter()
                .filter(|profile| self.source_profiles.contains(&profile.id))
                .cloned()
                .collect(),
            kinds: KIND_ORDER
                .iter()
                .filter(|kind| self.kinds.iter().any(|picked| picked == *kind))
                .map(|kind| (*kind).to_owned())
                .collect(),
            target: self.target.clone(),
            file: None,
        })
    }

    fn continue_import(&mut self) {
        let Some(browser) = self.chosen().cloned() else {
            return;
        };
        if self.stage == Stage::Choosing && browser.id == SAFARI {
            self.stage = Stage::Safari { error: None };
            return;
        }
        if self.stage == Stage::Choosing && browser.profiles.len() > 1 {
            self.stage = Stage::Profiles;
            return;
        }
        if !matches!(self.stage, Stage::Unlock { .. }) && steps::needs_unlock(&self.kinds) {
            self.stage = Stage::Unlock { error: None };
            return;
        }
        if let Some(plan) = self.plan() {
            self.start(plan);
        }
    }

    fn skip_encrypted(&mut self) {
        self.kinds
            .retain(|kind| !steps::ENCRYPTED_KINDS.contains(&kind.as_str()));
        match self.plan() {
            Some(plan) if !plan.kinds.is_empty() => self.start(plan),
            _ => self.stage = Stage::Choosing,
        }
    }

    fn back_from_unlock(&mut self) {
        let many = self
            .chosen()
            .is_some_and(|browser| browser.profiles.len() > 1);
        self.stage = if many {
            Stage::Profiles
        } else {
            Stage::Choosing
        };
    }

    fn import_safari_direct(&mut self) {
        let Some(browser) = self.chosen().cloned() else {
            return;
        };
        self.start(ImportPlan {
            source_id: SAFARI.into(),
            source_name: browser.name,
            profiles: Vec::new(),
            kinds: browser
                .kinds
                .iter()
                .cloned()
                .chain(self.safari_cookies.then(|| "cookies".to_owned()))
                .collect(),
            target: self.target.clone(),
            file: None,
        });
    }

    fn import_safari_export(&mut self, path: String) {
        if !path.to_lowercase().ends_with(".zip") && !std::path::Path::new(&path).is_dir() {
            self.stage = Stage::Safari {
                error: Some(
                    "This doesn't look like a Safari export. Choose the .zip file Safari saved."
                        .into(),
                ),
            };
            return;
        }
        self.start(ImportPlan {
            source_id: SAFARI_EXPORT.into(),
            source_name: "Safari".into(),
            profiles: Vec::new(),
            kinds: vec![
                "bookmarks".into(),
                "history".into(),
                "passwords".into(),
                "cards".into(),
            ],
            target: self.target.clone(),
            file: Some(path),
        });
    }

    fn choose_safari_zip(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let paths = cx.prompt_for_paths(PathPromptOptions {
            files: true,
            directories: false,
            multiple: false,
            prompt: None,
        });
        cx.spawn_in(window, async move |view, cx| {
            let Ok(Ok(Some(paths))) = paths.await else {
                return;
            };
            let Some(path) = paths.into_iter().next() else {
                return;
            };
            let _ = view.update(cx, |view, cx| {
                view.import_safari_export(path.to_string_lossy().into_owned());
                cx.notify();
            });
        })
        .detach();
    }

    fn choose_file(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let paths = cx.prompt_for_paths(PathPromptOptions {
            files: true,
            directories: false,
            multiple: false,
            prompt: None,
        });
        let target = self.target.clone();
        cx.spawn_in(window, async move |view, cx| {
            let Ok(Ok(Some(paths))) = paths.await else {
                return;
            };
            let Some(path) = paths.into_iter().next() else {
                return;
            };
            let name = path
                .file_name()
                .map(|name| name.to_string_lossy().into_owned())
                .unwrap_or_else(|| "file".to_owned());
            let _ = view.update(cx, |view, cx| {
                view.start(ImportPlan {
                    source_id: "html".into(),
                    source_name: name,
                    profiles: Vec::new(),
                    kinds: vec!["bookmarks".into()],
                    target,
                    file: Some(path.to_string_lossy().into_owned()),
                });
                cx.notify();
            });
        })
        .detach();
    }

    pub fn handle_command(&mut self, command: &str, window: &mut Window, cx: &mut Context<Self>) {
        self.handle(
            Msg::Command(SharedString::from(command.to_owned())),
            window,
            cx,
        );
    }

    fn handle(&mut self, msg: Msg, window: &mut Window, cx: &mut Context<Self>) {
        let Some(msg) = msg.deliver(&*self.host, None, cx) else {
            self.sync(Topics::ALL, window, cx);
            return;
        };
        if let Msg::Command(id) = msg {
            match id.as_ref() {
                "import:start" => {
                    if matches!(self.stage, Stage::Unlock { .. }) {
                        self.unlock(window, cx);
                    } else {
                        self.continue_import();
                    }
                }
                "import:safariCookies" => self.safari_cookies = !self.safari_cookies,
                "import:file" => self.choose_file(window, cx),
                "import:back" => {
                    if matches!(self.stage, Stage::Unlock { .. }) {
                        self.back_from_unlock();
                    } else {
                        self.stage = Stage::Choosing;
                    }
                }
                "import:skipEncrypted" => self.skip_encrypted(),
                "import:safariDirect" => self.import_safari_direct(),
                "import:safariZip" => self.choose_safari_zip(window, cx),
                "import:openAccess" => self.host.open_full_disk_access_settings(),
                "import:recheck" => {}
                "import:targetMenu" => self.target_menu = !self.target_menu,
                "import:again" => {
                    self.stage = Stage::Choosing;
                    self.progress = None;
                    self.done_pending = false;
                    self.done_ready = false;
                }
                "import:cancel" => {
                    if matches!(self.stage, Stage::Started { .. }) && !self.done_ready {
                        self.host.cancel_import();
                    }
                    window.remove_window()
                }
                "std:closeWindow:" | "closeTab" | "import:done" => window.remove_window(),
                other => {
                    if let Some(id) = other.strip_prefix("import:source:") {
                        let found = self
                            .browsers
                            .as_ref()
                            .and_then(|list| list.iter().find(|b| b.id == id))
                            .cloned();
                        if let Some(browser) = found {
                            self.choose(&browser);
                        }
                    } else if let Some(path) = other.strip_prefix("import:safariFile:") {
                        self.import_safari_export(path.to_owned());
                    } else if let Some(kind) = other.strip_prefix("import:kind:") {
                        toggle(&mut self.kinds, kind);
                    } else if let Some(profile) = other.strip_prefix("import:profile:") {
                        toggle(&mut self.source_profiles, profile);
                    } else if let Some(target) = other.strip_prefix("import:target:") {
                        self.target = Some(ProfileId::new(target));
                        self.target_menu = false;
                    }
                }
            }
            cx.notify();
        }
    }

    fn on_run_command(&mut self, action: &RunCommand, window: &mut Window, cx: &mut Context<Self>) {
        self.handle(Msg::Command(action.id.clone()), window, cx);
    }

    fn on_reserved(
        &mut self,
        action: &RunReservedCommand,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.handle(Msg::Command(action.id.clone()), window, cx);
    }

    fn on_dismiss(&mut self, _: &Dismiss, window: &mut Window, _: &mut Context<Self>) {
        window.remove_window();
    }
}

pub const KIND_ORDER: [&str; 6] = [
    "bookmarks",
    "history",
    "passwords",
    "cookies",
    "tabs",
    "extensions",
];
pub const SAFARI: &str = "safari";
pub const SAFARI_EXPORT: &str = "safari-export";

fn toggle(list: &mut Vec<String>, id: &str) {
    if let Some(at) = list.iter().position(|known| known == id) {
        list.remove(at);
    } else {
        list.push(id.to_owned());
    }
}

fn command(text: String) -> Msg {
    Msg::Command(SharedString::from(text))
}

fn radio(on: bool, p: &crate::look::Palette) -> gpui::AnyElement {
    div()
        .flex_none()
        .size(px(16.))
        .rounded_full()
        .border(px(if on { 5.0 } else { 1.0 }))
        .border_color(if on { p.form_accent } else { p.control_border })
        .bg(if on { gpui::white() } else { p.control })
        .into_any_element()
}

fn selectable(selected: bool, p: &crate::look::Palette) -> gpui::Div {
    let selected_fill = p.form_accent.opacity(0x26 as f32 / 255.0);
    div()
        .rounded(px(radius::PANEL))
        .border(px(if selected { 2.0 } else { 1.0 }))
        .border_color(if selected {
            p.form_accent
        } else {
            p.group_stroke
        })
        .bg(if selected { selected_fill } else { p.group_box })
}

fn browser_row(view: &ImportWindowView, browser: &ImportBrowser) -> gpui::AnyElement {
    let p = view.look.p;
    let selected = view.source.as_deref() == Some(browser.id.as_str());
    let detail = browser.detail();
    let key = browser.id.clone();
    let hover = p.row_hover;
    selectable(selected, &p)
        .id(SharedString::from(format!("import-source:{}", browser.id)))
        .debug_selector(move || format!("import-source:{key}"))
        .h(px(BROWSER_ROW))
        .px(px(space::L))
        .flex()
        .items_center()
        .gap(px(space::L))
        .cursor_pointer()
        .when(!selected, |this| this.hover(move |style| style.bg(hover)))
        .on_click(
            view.emit
                .click(command(format!("import:source:{}", browser.id))),
        )
        .child(radio(selected, &p))
        .child(
            div()
                .size(px(32.))
                .flex()
                .items_center()
                .justify_center()
                .child(match view.host.browser_icon(&browser.id, 32.) {
                    Some(image) => gpui::img(image)
                        .size(px(32.))
                        .object_fit(gpui::ObjectFit::Contain)
                        .into_any_element(),
                    None => icon(Icon::Globe, 22., p.icon).into_any_element(),
                }),
        )
        .child(
            div()
                .flex_1()
                .text_size(px(TypeSize::Title.points()))
                .font_weight(FontWeight::MEDIUM)
                .child(SharedString::from(browser.name.clone())),
        )
        .when(!detail.is_empty(), |this| {
            this.child(
                div()
                    .text_size(px(TypeSize::Small.points()))
                    .text_color(p.text_secondary)
                    .child(SharedString::from(detail)),
            )
        })
        .into_any_element()
}

fn choose_body(view: &ImportWindowView) -> gpui::AnyElement {
    let p = view.look.p;
    let Some(browsers) = view.browsers.as_ref() else {
        return div()
            .mt(px(LOADING_TOP))
            .flex()
            .justify_center()
            .child(spinner(16., p.text_secondary))
            .into_any_element();
    };
    let chosen = view.chosen();
    div()
        .child(title_block(
            CHOOSE_TITLE.to_owned(),
            Some(CHOOSE_SUBTITLE),
            false,
            &p,
        ))
        .child(if browsers.is_empty() {
            div()
                .mt(px(space::XXL))
                .text_center()
                .text_size(px(TypeSize::Body.points()))
                .text_color(p.text_secondary)
                .child(no_browsers_note())
                .into_any_element()
        } else {
            div()
                .flex()
                .flex_col()
                .gap(px(space::S))
                .children(browsers.iter().map(|browser| browser_row(view, browser)))
                .into_any_element()
        })
        .when_some(chosen, |this, browser| {
            this.child(
                div()
                    .mt(px(space::XXL))
                    .child(
                        div()
                            .mb(px(space::M))
                            .text_size(px(TypeSize::Body.points()))
                            .font_weight(FontWeight::SEMIBOLD)
                            .child("What to import"),
                    )
                    .child(
                        div().flex().flex_wrap().gap(px(space::XL)).children(
                            KIND_ORDER
                                .iter()
                                .filter(|kind| browser.kinds.iter().any(|known| known == *kind))
                                .map(|kind| {
                                    let on = view.kinds.iter().any(|picked| picked == kind);
                                    let emit = view.emit.clone();
                                    let toggle = command(format!("import:kind:{kind}"));
                                    div()
                                        .debug_selector(move || format!("import-data:{kind}"))
                                        .child(
                                            Checkbox::new(
                                                SharedString::from(format!("import-data:{kind}")),
                                                on,
                                                kind_look(kind).0,
                                                &p,
                                            )
                                            .on_toggle(move |_, window, cx| {
                                                emit.send(toggle.clone(), window, cx)
                                            }),
                                        )
                                }),
                        ),
                    ),
            )
        })
        .into_any_element()
}

fn monogram(name: &str, p: &crate::look::Palette) -> gpui::AnyElement {
    let letter = name
        .trim()
        .chars()
        .next()
        .map_or_else(|| "?".to_owned(), |c| c.to_uppercase().collect());
    let _ = p;
    div()
        .flex_none()
        .size(px(AVATAR))
        .rounded_full()
        .bg(gpui::rgb(0x8E8E93))
        .flex()
        .items_center()
        .justify_center()
        .text_size(px(TypeSize::Body.points()))
        .font_weight(FontWeight::SEMIBOLD)
        .text_color(gpui::white())
        .child(letter)
        .into_any_element()
}

fn profiles_body(view: &ImportWindowView) -> gpui::AnyElement {
    let p = view.look.p;
    let Some(browser) = view.chosen() else {
        return div().into_any_element();
    };
    div()
        .child(title_block(
            PROFILES_TITLE.to_owned(),
            Some(PROFILES_SUBTITLE),
            false,
            &p,
        ))
        .child(
            div()
                .mb(px(space::ML))
                .text_size(px(TypeSize::Small.points()))
                .text_color(p.text_secondary)
                .child(PROFILES_NOTE),
        )
        .child(
            div()
                .rounded(px(10.))
                .bg(p.group_box)
                .border(px(0.5))
                .border_color(p.group_stroke)
                .overflow_hidden()
                .children(browser.profiles.iter().map(|profile| {
                    let on = view.source_profiles.contains(&profile.id);
                    let key = profile.id.clone();
                    let subtitle = profile
                        .email
                        .clone()
                        .or_else(|| profile.is_default.then(|| "Default profile".to_owned()));
                    let emit = view.emit.clone();
                    let toggle = command(format!("import:profile:{}", profile.id));
                    div()
                        .id(SharedString::from(format!("import-profile:{}", profile.id)))
                        .debug_selector(move || format!("import-profile:{key}"))
                        .min_h(px(46.))
                        .px(px(14.))
                        .py(px(8.))
                        .flex()
                        .items_center()
                        .gap(px(space::ML))
                        .border_b(px(0.5))
                        .border_color(p.divider)
                        .cursor_pointer()
                        .on_click(view.emit.click(toggle.clone()))
                        .child(
                            Checkbox::new(
                                SharedString::from(format!("import-profile-box:{}", profile.id)),
                                on,
                                "",
                                &p,
                            )
                            .on_toggle(move |_, window, cx| emit.send(toggle.clone(), window, cx)),
                        )
                        .child(monogram(&profile.name, &p))
                        .child(
                            div()
                                .flex_1()
                                .flex()
                                .flex_col()
                                .child(
                                    div()
                                        .text_size(px(TypeSize::Body.points()))
                                        .child(SharedString::from(profile.name.clone())),
                                )
                                .when_some(subtitle, |this, subtitle| {
                                    this.child(
                                        div()
                                            .text_size(px(TypeSize::Caption.points()))
                                            .text_color(p.text_secondary)
                                            .child(SharedString::from(subtitle)),
                                    )
                                }),
                        )
                })),
        )
        .into_any_element()
}

fn target_picker(view: &ImportWindowView) -> gpui::AnyElement {
    let p = view.look.p;
    let profiles: Vec<(ProfileId, String)> = view
        .state
        .profile_order
        .iter()
        .filter_map(|id| Some((id.clone(), view.state.profile(id.as_str())?.name.clone())))
        .collect();
    if profiles.len() < 2 {
        return div().into_any_element();
    }
    let current = view
        .target
        .as_ref()
        .and_then(|target| profiles.iter().find(|(id, _)| id == target))
        .map(|(_, name)| name.clone())
        .unwrap_or_default();
    let choices: Vec<PopUpChoice> = profiles
        .iter()
        .map(|(id, name)| {
            PopUpChoice::new(
                name.clone(),
                view.target.as_ref() == Some(id),
                vec![command(format!("import:target:{id}"))],
            )
            .value(id.to_string())
        })
        .collect();
    div()
        .relative()
        .flex()
        .items_center()
        .gap(px(space::M))
        .child(
            div()
                .text_size(px(TypeSize::Small.points()))
                .text_color(p.text_secondary)
                .child("Import into"),
        )
        .child(
            div().debug_selector(|| "import-target".into()).child(
                PopUp::new("import-target", SharedString::from(current), &p)
                    .min_width(130.)
                    .on_click(pop_up_menu::opener(
                        &view.host,
                        &view.emit,
                        choices,
                        command("import:targetMenu".into()),
                    )),
            ),
        )
        .when(view.target_menu, |this| {
            this.child(
                gpui::deferred(
                    popover("import-target-menu", false, 180., &p)
                        .absolute()
                        .bottom(px(26.))
                        .right_0()
                        .children(profiles.iter().map(|(id, name)| {
                            MenuRow::new(
                                SharedString::from(format!("import-target:{id}")),
                                name.clone(),
                                &p,
                            )
                            .checked(view.target.as_ref() == Some(id))
                            .on_click(view.emit.click(command(format!("import:target:{id}"))))
                        })),
                )
                .with_priority(2),
            )
        })
        .into_any_element()
}

pub const DONE_DELAY: Duration = Duration::from_millis(700);
pub const PAD_X: f32 = 32.0;
pub const PAD_TOP: f32 = 46.0;
pub const DRAG_REGION: f32 = 40.0;
pub const CATEGORY_ROW: f32 = 44.0;
pub const FOOTER_HEIGHT: f32 = 56.0;
pub const DISPLAY_TITLE: f32 = 22.0;
pub const DONE_TOP: f32 = 40.0;

pub fn kind_look(key: &str) -> (&'static str, Icon) {
    match key {
        "bookmarks" => ("Bookmarks", Icon::Bookmark),
        "history" => ("History", Icon::Clock),
        "passwords" => ("Passwords", Icon::Key),
        "cookies" => ("Cookies", Icon::Lock),
        "cards" => ("Payment Cards", Icon::CreditCard),
        "tabs" => ("Tabs", Icon::Tabs),
        _ => ("Extensions", Icon::PuzzleExtension),
    }
}

pub fn plural(n: usize, word: &str) -> String {
    format!("{n} {word}{}", if n == 1 { "" } else { "s" })
}

pub fn summary(progress: &ImportProgress) -> Vec<String> {
    let counted = |key: &str, word: &str| {
        progress
            .stage(key)
            .filter(|stage| stage.state == StageState::Done && stage.done > 0)
            .map(|stage| plural(stage.done, word))
    };
    [
        counted("bookmarks", "bookmark"),
        counted("history", "history item"),
        counted("passwords", "password"),
        counted("cookies", "cookie"),
        counted("cards", "card"),
        counted("tabs", "tab"),
    ]
    .into_iter()
    .flatten()
    .collect()
}

pub fn failures(progress: &ImportProgress) -> Vec<String> {
    progress
        .stages
        .iter()
        .filter(|stage| matches!(stage.state, StageState::Failed(_)))
        .map(|stage| format!("{} import failed", kind_look(&stage.key).0))
        .collect()
}

fn window_fill(dark: bool) -> gpui::Hsla {
    if dark {
        gpui::rgb(0x1E1E1E).into()
    } else {
        gpui::rgb(0xF4F4F4).into()
    }
}

pub(crate) fn title_block(
    title: String,
    subtitle: Option<&str>,
    spinning: bool,
    p: &crate::look::Palette,
) -> gpui::AnyElement {
    div()
        .mb(px(space::XXL))
        .child(
            div()
                .debug_selector(|| "import-title".into())
                .text_size(px(DISPLAY_TITLE))
                .font_weight(FontWeight::BOLD)
                .child(SharedString::from(title)),
        )
        .when_some(subtitle, |this, subtitle| {
            this.child(
                div()
                    .mt(px(space::S))
                    .flex()
                    .items_center()
                    .gap(px(space::M))
                    .when(spinning, |this| this.child(spinner(16., p.text_secondary)))
                    .child(
                        div()
                            .flex_1()
                            .text_size(px(TypeSize::Body.points()))
                            .text_color(p.text_secondary)
                            .child(SharedString::from(subtitle.to_owned())),
                    ),
            )
        })
        .into_any_element()
}

fn category_row(stage: &ImportStage, p: &crate::look::Palette) -> gpui::AnyElement {
    let (title, glyph) = kind_look(&stage.key);
    let pending = stage.state == StageState::Waiting;
    let active = stage.state == StageState::Running;
    let key = stage.key.clone();
    let selected_fill = p.form_accent.opacity(0x26 as f32 / 255.0);
    div()
        .debug_selector(move || format!("import-stage:{key}"))
        .h(px(CATEGORY_ROW))
        .px(px(space::L))
        .flex()
        .items_center()
        .gap(px(space::L))
        .rounded(px(radius::PANEL))
        .border(px(if active { 2.0 } else { 1.0 }))
        .border_color(if active {
            p.form_accent
        } else {
            p.group_stroke
        })
        .bg(if active { selected_fill } else { p.group_box })
        .child(
            div()
                .size(px(20.))
                .flex()
                .items_center()
                .justify_center()
                .child(icon(
                    glyph,
                    13.,
                    if pending { p.text_tertiary } else { p.icon },
                )),
        )
        .child(
            div()
                .flex_1()
                .text_size(px(TypeSize::Body.points()))
                .text_color(if pending { p.text_secondary } else { p.text })
                .child(title),
        )
        .child(match &stage.state {
            StageState::Running => spinner(16., p.text_secondary).into_any_element(),
            StageState::Waiting => div().into_any_element(),
            StageState::Done => div()
                .size(px(20.))
                .flex()
                .items_center()
                .justify_center()
                .child(icon(Icon::CheckCircleFill, 15., p.success))
                .into_any_element(),
            StageState::Failed(_) => div()
                .size(px(20.))
                .flex()
                .items_center()
                .justify_center()
                .child(icon(Icon::WarningFill, 15., p.warning))
                .into_any_element(),
        })
        .into_any_element()
}

fn progress_body(
    view: &ImportWindowView,
    source: &str,
    p: &crate::look::Palette,
) -> gpui::AnyElement {
    let stages: Vec<ImportStage> = view
        .progress
        .as_ref()
        .map(|progress| progress.stages.clone())
        .unwrap_or_default();
    div()
        .child(title_block(
            format!("Importing from {source}"),
            Some(if view.progress.as_ref().is_some_and(|p| p.preparing > 1) {
                "Preparing several profiles"
            } else {
                "Preparing your profile"
            }),
            true,
            p,
        ))
        .child(
            div()
                .mb(px(space::L))
                .text_size(px(TypeSize::Small.points()))
                .text_color(p.text_secondary)
                .child("Hold on while we fetch your data..."),
        )
        .child(
            div()
                .flex()
                .flex_col()
                .gap(px(space::S))
                .children(stages.iter().map(|stage| category_row(stage, p))),
        )
        .into_any_element()
}

fn done_body(
    view: &ImportWindowView,
    progress: &ImportProgress,
    p: &crate::look::Palette,
) -> gpui::AnyElement {
    let summary = summary(progress);
    let failed = failures(progress);
    if !failed.is_empty() {
        return div()
            .child(title_block(
                if summary.is_empty() {
                    "Import failed".to_owned()
                } else {
                    "Partially imported".to_owned()
                },
                Some("Only some of your data imported. Please try again!"),
                false,
                p,
            ))
            .child(
                div()
                    .mb(px(space::S))
                    .font_weight(FontWeight::SEMIBOLD)
                    .text_size(px(TypeSize::Body.points()))
                    .child("Some import steps failed:"),
            )
            .children(failed.into_iter().map(|line| {
                div()
                    .mb(px(space::XS))
                    .text_size(px(TypeSize::Body.points()))
                    .text_color(p.text_secondary)
                    .child(line)
            }))
            .when(!summary.is_empty(), |this| {
                this.child(
                    div()
                        .mt(px(space::L))
                        .text_size(px(TypeSize::Small.points()))
                        .text_color(p.text_secondary)
                        .child(format!("Imported {}.", summary.join(", "))),
                )
            })
            .child(
                div()
                    .mt(px(space::L))
                    .text_size(px(TypeSize::Small.points()))
                    .text_color(p.text_tertiary)
                    .child("You can retry the import later from the app menu."),
            )
            .into_any_element();
    }
    div()
        .debug_selector(|| "import-done".into())
        .mt(px(DONE_TOP))
        .flex()
        .flex_col()
        .items_center()
        .gap(px(space::L))
        .child(
            div()
                .size(px(60.))
                .flex()
                .items_center()
                .justify_center()
                .child(icon(Icon::CheckCircleFill, 46., p.success)),
        )
        .child(
            div()
                .text_size(px(DISPLAY_TITLE))
                .font_weight(FontWeight::SEMIBOLD)
                .child("You're all set"),
        )
        .child(
            div()
                .text_size(px(TypeSize::Body.points()))
                .text_color(p.text_secondary)
                .text_center()
                .child(if summary.is_empty() {
                    "There was nothing new to import.".to_owned()
                } else {
                    format!("Imported {}.", summary.join(", "))
                }),
        )
        .when_some(progress.extensions.as_ref(), |this, listing| {
            this.child(steps::listing_body(view, listing))
        })
        .into_any_element()
}

fn footer_button(
    id: &'static str,
    title: &'static str,
    primary: bool,
    disabled: bool,
    command: &'static str,
    view: &ImportWindowView,
) -> gpui::AnyElement {
    let p = view.look.p;
    div()
        .debug_selector(move || id.into())
        .child(
            PushButton::new(id, title, &p)
                .kind(if primary {
                    ButtonKind::Primary
                } else {
                    ButtonKind::Plain
                })
                .disabled(disabled)
                .on_click(
                    view.emit
                        .click(Msg::Command(SharedString::new_static(command))),
                ),
        )
        .into_any_element()
}

impl Render for ImportWindowView {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        self.backdrop.apply(window, Instant::now());
        let p = self.look.p;
        let done = self
            .progress
            .clone()
            .filter(|progress| progress.finished && self.showing_done());
        let failed = done
            .as_ref()
            .is_some_and(|progress| !failures(progress).is_empty());
        let footer: Vec<gpui::AnyElement> = match (&self.stage, &done) {
            (Stage::Choosing, _) => {
                let ready = self.chosen().is_some() && !self.kinds.is_empty();
                vec![
                    footer_button(
                        "import-file",
                        "Bookmarks HTML File…",
                        false,
                        false,
                        "import:file",
                        self,
                    ),
                    div().flex_1().into_any_element(),
                    target_picker(self),
                    footer_button("import-cancel", "Cancel", false, false, "import:done", self),
                    footer_button(
                        "import-start",
                        "Continue",
                        true,
                        !ready,
                        "import:start",
                        self,
                    ),
                ]
            }
            (Stage::Profiles, _) => vec![
                footer_button("import-back", "Back", false, false, "import:back", self),
                div().flex_1().into_any_element(),
                target_picker(self),
                footer_button(
                    "import-start",
                    "Continue",
                    true,
                    self.source_profiles.is_empty(),
                    "import:start",
                    self,
                ),
            ],
            (Stage::Safari { .. }, _) => vec![
                footer_button("import-back", "Back", false, false, "import:back", self),
                div().flex_1().into_any_element(),
                target_picker(self),
                footer_button("import-cancel", "Cancel", false, false, "import:done", self),
            ],
            (Stage::Unlock { .. }, _) => vec![
                footer_button("import-back", "Back", false, false, "import:back", self),
                div().flex_1().into_any_element(),
                footer_button(
                    "import-skip-encrypted",
                    "Skip Encrypted Data",
                    false,
                    false,
                    "import:skipEncrypted",
                    self,
                ),
                footer_button(
                    "import-unlock",
                    if self.unlocking {
                        "Waiting for password..."
                    } else {
                        "Continue"
                    },
                    true,
                    self.unlocking,
                    "import:start",
                    self,
                ),
            ],
            (Stage::Started { .. }, None) => vec![
                div().flex_1().into_any_element(),
                footer_button(
                    "import-cancel",
                    "Cancel",
                    false,
                    false,
                    "import:cancel",
                    self,
                ),
            ],
            (Stage::Started { .. }, Some(_)) => {
                let mut buttons = vec![div().flex_1().into_any_element()];
                if failed {
                    buttons.push(footer_button(
                        "import-again",
                        "Try Again",
                        false,
                        false,
                        "import:again",
                        self,
                    ));
                }
                buttons.push(footer_button(
                    "import-done",
                    if failed {
                        "Continue"
                    } else {
                        "Finish importing"
                    },
                    true,
                    false,
                    "import:done",
                    self,
                ));
                buttons
            }
        };
        let body = match &self.stage {
            Stage::Started { source, .. } => match &done {
                Some(progress) => done_body(self, progress, &p),
                None => progress_body(self, source, &p),
            },
            Stage::Profiles => profiles_body(self),
            Stage::Choosing => choose_body(self),
            Stage::Safari { error } => {
                steps::safari_body(self, self.host.safari_access(), error.as_deref())
            }
            Stage::Unlock { error } => {
                let (id, name, many) = self
                    .chosen()
                    .map(|b| (b.id.clone(), b.name.clone(), self.source_profiles.len() > 1))
                    .unwrap_or_default();
                steps::unlock_body(self, &id, &name, many, error.as_deref())
            }
        };
        div()
            .id("import-window")
            .key_context("ArdiaWindow ImportWindow")
            .track_focus(&self.focus)
            .size_full()
            .flex()
            .flex_col()
            .relative()
            .font_family(UI_FONT)
            .text_color(p.text)
            .on_action(cx.listener(Self::on_run_command))
            .on_action(cx.listener(Self::on_reserved))
            .on_action(cx.listener(Self::on_dismiss))
            .bg(window_fill(self.look.dark))
            .child(
                div()
                    .absolute()
                    .top_0()
                    .left_0()
                    .right_0()
                    .h(px(DRAG_REGION))
                    .on_mouse_down(MouseButton::Left, |_, window, _| window.start_window_move()),
            )
            .child(
                div()
                    .id("import-body")
                    .flex_1()
                    .min_h_0()
                    .overflow_y_scroll()
                    .px(px(PAD_X))
                    .pt(px(PAD_TOP))
                    .pb(px(space::XXL))
                    .child(body),
            )
            .child(
                div()
                    .h(px(FOOTER_HEIGHT))
                    .flex_none()
                    .flex()
                    .items_center()
                    .px(px(space::XXL))
                    .gap(px(space::M))
                    .border_t(px(1.))
                    .border_color(p.divider)
                    .children(footer),
            )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_done_step_reads_like_the_old_one() {
        let mut progress = ImportProgress::new(
            1,
            "Chrome",
            vec![
                ImportStage::new("bookmarks", "Bookmarks"),
                ImportStage::new("history", "History"),
            ],
        );
        progress.stages[0].state = StageState::Done;
        progress.stages[0].done = 1;
        progress.stages[1].state = StageState::Failed("Not available yet".into());
        assert_eq!(summary(&progress), vec!["1 bookmark".to_owned()]);
        assert_eq!(
            failures(&progress),
            vec!["History import failed".to_owned()]
        );
        progress.stages[0].done = 12;
        assert_eq!(summary(&progress), vec!["12 bookmarks".to_owned()]);
        assert_eq!(kind_look("tabs").0, "Tabs");
    }

    #[test]
    fn browsers_preselect_their_default_profiles() {
        let browser = ImportBrowser {
            id: "chrome".into(),
            name: "Chrome".into(),
            profiles: vec![
                crate::host_data::ImportBrowserProfile {
                    id: "Profile 1".into(),
                    ..Default::default()
                },
                crate::host_data::ImportBrowserProfile {
                    id: "Default".into(),
                    is_default: true,
                    ..Default::default()
                },
            ],
            kinds: vec!["bookmarks".into()],
        };
        assert_eq!(browser.default_profiles(), vec!["Default".to_owned()]);
        assert_eq!(browser.detail(), "2 profiles");
    }
}
