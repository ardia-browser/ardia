use std::sync::Arc;

use ardia_state::{Action, ProfileId, ProfilePatch, WindowId};
use ardia_theme::ProfileColor;
use ardia_theme::tokens::{radius, space};
use gpui::{
    AnyElement, Context, Entity, FontWeight, IntoElement, MouseButton, ParentElement, Render,
    SharedString, Styled, Subscription, Window, deferred, div, prelude::*,
};

use crate::host::UiHost;
use crate::icon_picker::{
    Anchor, IconPickerEvent, IconPickerView, PickerAction, PickerSetup, Room, near_anchor,
    tokens as picker,
};
use crate::look::{Look, Palette};
use crate::primitives::controls::{ButtonKind, PushButton, Toggle};
use crate::primitives::text_input::{InputEvent, TextInput, focus_input};
use crate::profiles::create::{
    self, CreateForm, SHEET_WIDTH, SUBTITLE, SWATCH_GAP, TITLE, chosen_name, selected_group,
    share_description, share_title,
};
use crate::profiles::{PROFILE_SYMBOLS, tokens, unused_profile_color};
use crate::scale::px;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ProfilePlace {
    Sidebar,
    Settings,
}

#[derive(Clone, Debug, PartialEq)]
pub enum PeopleMsg {
    CreateProfile,
    Rename(ProfileId),
    OpenIconPicker {
        profile: ProfileId,
        place: ProfilePlace,
    },
    AnchorAt(Option<Anchor>),
    RenameLiveFolder(String),
    OpenLiveIconPicker(String),
}

struct CreateSheet {
    input: Entity<TextInput>,
    form: CreateForm,
    _input: Subscription,
}

struct RenameSheet {
    profile: ProfileId,
    live_folder: Option<String>,
    input: Entity<TextInput>,
    _input: Subscription,
}

struct Picker {
    profile: ProfileId,
    live_folder: Option<String>,
    view: Entity<IconPickerView>,
    _events: Subscription,
}

pub struct PeopleLayer {
    host: Arc<dyn UiHost>,
    window_id: WindowId,
    anchor: Option<Anchor>,
    create: Option<CreateSheet>,
    rename: Option<RenameSheet>,
    picker: Option<Picker>,
}

pub fn picker_actions(place: ProfilePlace, current: Option<&str>) -> Vec<PickerAction> {
    vec![PickerAction {
        title: SharedString::new_static("No Icon"),
        icon: Some(match place {
            ProfilePlace::Sidebar => "circle.fill",
            ProfilePlace::Settings => "textformat",
        }),
        primary: current.is_none(),
        choice: None,
    }]
}

impl PeopleLayer {
    pub fn new(host: Arc<dyn UiHost>, window_id: WindowId) -> Self {
        PeopleLayer {
            host,
            window_id,
            anchor: None,
            create: None,
            rename: None,
            picker: None,
        }
    }

    pub fn is_open(&self) -> bool {
        self.create.is_some() || self.rename.is_some() || self.picker.is_some()
    }

    pub fn creating(&self) -> bool {
        self.create.is_some()
    }

    pub fn renaming(&self) -> Option<&ProfileId> {
        self.rename.as_ref().map(|r| &r.profile)
    }

    pub fn picking_for(&self) -> Option<&ProfileId> {
        self.picker.as_ref().map(|p| &p.profile)
    }

    pub fn picker_view(&self) -> Option<&Entity<IconPickerView>> {
        self.picker.as_ref().map(|p| &p.view)
    }

    fn look(&self, window: &Window) -> Look {
        let state = self.host.store().snapshot();
        Look::new(&state, self.window_id.as_str(), window.appearance())
    }

    pub fn handle(&mut self, msg: PeopleMsg, window: &mut Window, cx: &mut Context<Self>) {
        match msg {
            PeopleMsg::CreateProfile => self.open_create(window, cx),
            PeopleMsg::Rename(profile) => self.open_rename(profile, window, cx),
            PeopleMsg::OpenIconPicker { profile, place } => {
                self.open_picker(profile, place, window, cx)
            }
            PeopleMsg::AnchorAt(anchor) => self.anchor = anchor,
            PeopleMsg::RenameLiveFolder(folder) => self.open_live_rename(folder, window, cx),
            PeopleMsg::OpenLiveIconPicker(folder) => self.open_live_picker(folder, window, cx),
        }
        cx.notify();
    }

    pub fn close(&mut self, cx: &mut Context<Self>) {
        self.create = None;
        self.rename = None;
        self.picker = None;
        cx.notify();
    }

    fn open_create(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let state = self.host.store().snapshot();
        let p = self.look(window).p;
        let input = cx.new(|cx| TextInput::new("Profile name", cx));
        input.update(cx, |input, cx| input.set_style(field_style(&p), cx));
        let subscription =
            cx.subscribe_in(&input, window, |layer, _, event, window, cx| match event {
                InputEvent::Submit(_) => layer.submit_create(window, cx),
                InputEvent::Cancel => layer.close(cx),
                _ => {}
            });
        focus_input(&input, window, cx);
        let current = state
            .window(self.window_id.as_str())
            .map(|w| w.profile_id.clone())
            .or_else(|| Some(ProfileId::from(state.settings.default_profile_id.clone())));
        self.create = Some(CreateSheet {
            input,
            form: CreateForm {
                color: unused_profile_color(&state),
                share: false,
                share_with: current,
            },
            _input: subscription,
        });
    }

    pub fn set_share(&mut self, on: bool, cx: &mut Context<Self>) {
        if let Some(sheet) = self.create.as_mut() {
            sheet.form.share = on;
            cx.notify();
        }
    }

    pub fn submit_create(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(sheet) = self.create.take() else {
            return;
        };
        let typed = sheet.input.read(cx).text().to_owned();
        let state = self.host.store().snapshot();
        let name = chosen_name(&typed, state.profile_order.len());
        self.host.dispatch(Action::CreateProfile {
            name,
            color: Some(sheet.form.color),
            icon: None,
        });
        let after = self.host.store().snapshot();
        if let Some(created) = after
            .profile_order
            .iter()
            .find(|id| !state.profile_order.contains(id))
            .cloned()
        {
            if sheet.form.share {
                let groups = create::groups(&state);
                if let Some(with) = selected_group(&groups, sheet.form.share_with.as_ref())
                    .and_then(|g| g.profile_ids.first().cloned())
                {
                    self.host.dispatch(Action::ShareProfileData {
                        profile: created.clone(),
                        with,
                    });
                }
            }
            if after.window(self.window_id.as_str()).is_some() {
                self.host.dispatch(Action::SwitchProfile {
                    window: self.window_id.clone(),
                    profile: created,
                });
            }
        }
        let _ = window;
        cx.notify();
    }

    fn open_rename(&mut self, profile: ProfileId, window: &mut Window, cx: &mut Context<Self>) {
        let state = self.host.store().snapshot();
        let Some(found) = state.profile(profile.as_str()) else {
            return;
        };
        let p = self.look(window).p;
        let name = found.name.clone();
        let input = cx.new(|cx| TextInput::new("Profile name", cx));
        input.update(cx, |input, cx| {
            input.set_style(field_style(&p), cx);
            input.set_text(name, true, cx);
        });
        let subscription = cx.subscribe_in(&input, window, |layer, _, event, _, cx| match event {
            InputEvent::Submit(_) => layer.submit_rename(cx),
            InputEvent::Cancel => layer.close(cx),
            _ => {}
        });
        focus_input(&input, window, cx);
        self.rename = Some(RenameSheet {
            profile,
            live_folder: None,
            input,
            _input: subscription,
        });
    }

    pub fn submit_rename(&mut self, cx: &mut Context<Self>) {
        let Some(sheet) = self.rename.take() else {
            return;
        };
        let name = sheet.input.read(cx).text().trim().to_owned();
        if let Some(folder) = sheet.live_folder {
            if !name.is_empty() {
                self.host
                    .live_command(ardia_state::live::LiveCommand::Rename { folder, name });
            }
            cx.notify();
            return;
        }
        let state = self.host.store().snapshot();
        let changed = state
            .profile(sheet.profile.as_str())
            .is_some_and(|p| !name.is_empty() && p.name != name);
        if changed {
            self.host.dispatch(Action::UpdateProfile {
                profile: sheet.profile,
                patch: ProfilePatch {
                    name: Some(name),
                    ..ProfilePatch::default()
                },
            });
        }
        cx.notify();
    }

    fn open_picker(
        &mut self,
        profile: ProfileId,
        place: ProfilePlace,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let state = self.host.store().snapshot();
        let Some(found) = state.profile(profile.as_str()) else {
            return;
        };
        let current = found.icon.clone();
        let p = self.look(window).p;
        let viewport = window.viewport_size();
        let room = Room {
            width: crate::scale::points(viewport.width),
            height: crate::scale::points(viewport.height),
        };
        let height = picker::height(true);
        let place_at = near_anchor(self.anchor.take(), height, room);
        let actions = picker_actions(place, current.as_deref());
        let host = Arc::clone(&self.host);
        let view = cx.new(|cx| {
            IconPickerView::new(
                host,
                PickerSetup {
                    current,
                    symbols: PROFILE_SYMBOLS,
                    actions,
                    place: place_at,
                    p,
                },
                window,
                cx,
            )
        });
        let chosen_for = profile.clone();
        let events = cx.subscribe(&view, move |layer, _, event, cx| match event {
            IconPickerEvent::Choose(icon) => layer.choose_icon(&chosen_for, icon.clone(), cx),
            IconPickerEvent::Close => {
                layer.picker = None;
                cx.notify();
            }
        });
        self.picker = Some(Picker {
            profile,
            live_folder: None,
            view,
            _events: events,
        });
    }

    fn open_live_rename(&mut self, folder: String, window: &mut Window, cx: &mut Context<Self>) {
        let Some(name) = self
            .host
            .live()
            .and_then(|l| l.folders.get(&folder).map(|f| f.name.clone()))
        else {
            return;
        };
        let p = self.look(window).p;
        let input = cx.new(|cx| TextInput::new("Live folder name", cx));
        input.update(cx, |input, cx| {
            input.set_style(field_style(&p), cx);
            input.set_text(name, true, cx);
        });
        let subscription = cx.subscribe_in(&input, window, |layer, _, event, _, cx| match event {
            InputEvent::Submit(_) => layer.submit_rename(cx),
            InputEvent::Cancel => layer.close(cx),
            _ => {}
        });
        focus_input(&input, window, cx);
        self.rename = Some(RenameSheet {
            profile: ProfileId::default_profile(),
            live_folder: Some(folder),
            input,
            _input: subscription,
        });
    }

    fn open_live_picker(&mut self, folder: String, window: &mut Window, cx: &mut Context<Self>) {
        let Some(current) = self
            .host
            .live()
            .and_then(|l| l.folders.get(&folder).map(|f| f.icon.clone()))
        else {
            return;
        };
        let p = self.look(window).p;
        let viewport = window.viewport_size();
        let room = Room {
            width: crate::scale::points(viewport.width),
            height: crate::scale::points(viewport.height),
        };
        let actions = crate::sidebar::icon_picker::actions(false, current.as_deref());
        let place_at = near_anchor(
            self.anchor.take(),
            picker::height(!actions.is_empty()),
            room,
        );
        let host = Arc::clone(&self.host);
        let view = cx.new(|cx| {
            IconPickerView::new(
                host,
                PickerSetup {
                    current,
                    symbols: crate::sidebar::icon_picker::SIDEBAR_SYMBOLS,
                    actions,
                    place: place_at,
                    p,
                },
                window,
                cx,
            )
        });
        let target = folder.clone();
        let events = cx.subscribe(&view, move |layer, _, event, cx| match event {
            IconPickerEvent::Choose(icon) => {
                layer
                    .host
                    .live_command(ardia_state::live::LiveCommand::SetIcon {
                        folder: target.clone(),
                        icon: icon.clone(),
                    });
                layer.picker = None;
                cx.notify();
            }
            IconPickerEvent::Close => {
                layer.picker = None;
                cx.notify();
            }
        });
        self.picker = Some(Picker {
            profile: ProfileId::default_profile(),
            live_folder: Some(folder),
            view,
            _events: events,
        });
    }

    pub fn choose_icon(
        &mut self,
        profile: &ProfileId,
        icon: Option<String>,
        cx: &mut Context<Self>,
    ) {
        self.host.dispatch(Action::UpdateProfile {
            profile: profile.clone(),
            patch: ProfilePatch {
                icon: Some(icon),
                ..ProfilePatch::default()
            },
        });
        self.picker = None;
        cx.notify();
    }

    fn render_create(
        &self,
        sheet: &CreateSheet,
        p: &Palette,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let state = self.host.store().snapshot();
        let groups = create::groups(&state);
        let single = groups.len() == 1;
        let form = sheet.form.clone();
        let selected = selected_group(&groups, form.share_with.as_ref()).map(|g| g.data_id.clone());
        let swatches = div().flex().flex_wrap().gap(px(SWATCH_GAP)).children(
            ProfileColor::ALL.into_iter().map(|color| {
                create::swatch(color, form.color == color)
                    .id(SharedString::from(format!("create-color:{}", color.key())))
                    .debug_selector(move || format!("create-color:{}", color.key()))
                    .on_click(cx.listener(move |layer, _, _, cx| {
                        if let Some(sheet) = layer.create.as_mut() {
                            sheet.form.color = color;
                            cx.notify();
                        }
                    }))
            }),
        );
        let toggle = Toggle::new("create-share", form.share, p).on_toggle({
            let weak = cx.entity().downgrade();
            move |on, _, cx| {
                let _ = weak.update(cx, |layer, cx| {
                    if let Some(sheet) = layer.create.as_mut() {
                        sheet.form.share = on;
                        cx.notify();
                    }
                });
            }
        });
        let share_row = div()
            .min_h(px(40.))
            .px(px(space::L))
            .py(px(space::M))
            .flex()
            .items_center()
            .gap(px(space::L))
            .child(
                div()
                    .flex_1()
                    .flex()
                    .flex_col()
                    .child(
                        div()
                            .text_size(px(13.))
                            .text_color(p.text)
                            .child(share_title(single)),
                    )
                    .when(form.share, |this| {
                        this.child(
                            div()
                                .mt(px(space::XXS))
                                .text_size(px(11.))
                                .line_height(px(14.))
                                .text_color(p.text_secondary)
                                .child(share_description(single)),
                        )
                    }),
            )
            .child(toggle);
        let group_list = (form.share && !single).then(|| {
            div().p(px(space::L)).child(
                div()
                    .rounded(px(radius::TILE))
                    .bg(p.field)
                    .border(px(1.))
                    .border_color(p.field_border)
                    .overflow_hidden()
                    .children(groups.iter().enumerate().map(|(i, group)| {
                        let first = group.profile_ids.first().cloned();
                        let on = selected.as_deref() == Some(group.data_id.as_str());
                        div()
                            .id(SharedString::from(format!(
                                "create-share:{}",
                                group.data_id
                            )))
                            .when(i > 0, |this| this.border_t(px(1.)).border_color(p.divider))
                            .h(px(tokens::SHARE_ROW_HEIGHT))
                            .px(px(space::ML))
                            .flex()
                            .items_center()
                            .gap(px(space::ML))
                            .on_click(cx.listener(move |layer, _, _, cx| {
                                if let Some(sheet) = layer.create.as_mut() {
                                    sheet.form.share_with = first.clone();
                                    cx.notify();
                                }
                            }))
                            .child(create::radio(on, p))
                            .child(create::color_stack(
                                &create::group_swatches(&state, group),
                                p.dark,
                            ))
                            .child(
                                div()
                                    .flex_1()
                                    .min_w_0()
                                    .truncate()
                                    .text_size(px(13.))
                                    .text_color(p.text)
                                    .child(create::group_label(&state, group)),
                            )
                    })),
            )
        });
        let group = div()
            .rounded(px(radius::PANEL))
            .bg(p.group_box)
            .border(px(1.))
            .border_color(p.group_stroke)
            .overflow_hidden()
            .child(share_row)
            .children(group_list);
        sheet_frame(
            "create-profile",
            p,
            cx,
            vec![
                div()
                    .flex()
                    .flex_col()
                    .gap(px(space::XL))
                    .child(create::title_block(TITLE, Some(SUBTITLE), p))
                    .child(
                        div()
                            .flex()
                            .flex_col()
                            .gap(px(space::L))
                            .child(create::field(&sheet.input, p))
                            .child(swatches),
                    )
                    .child(group)
                    .into_any_element(),
                actions(
                    p,
                    ("create-cancel", "Cancel"),
                    ("create-confirm", "Create Profile"),
                    cx.listener(|layer, _, _, cx| layer.close(cx)),
                    cx.listener(|layer, _, window, cx| layer.submit_create(window, cx)),
                ),
            ],
        )
    }

    fn render_rename(
        &self,
        sheet: &RenameSheet,
        p: &Palette,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        sheet_frame(
            "rename-profile",
            p,
            cx,
            vec![
                div()
                    .flex()
                    .flex_col()
                    .gap(px(space::L))
                    .child(create::title_block(
                        if sheet.live_folder.is_some() {
                            "Rename Live Folder"
                        } else {
                            "Rename Profile"
                        },
                        None,
                        p,
                    ))
                    .child(create::field(&sheet.input, p))
                    .into_any_element(),
                actions(
                    p,
                    ("rename-cancel", "Cancel"),
                    ("rename-confirm", "Rename"),
                    cx.listener(|layer, _, _, cx| layer.close(cx)),
                    cx.listener(|layer, _, _, cx| layer.submit_rename(cx)),
                ),
            ],
        )
    }
}

fn field_style(p: &Palette) -> crate::primitives::text_input::InputStyle {
    crate::primitives::text_input::InputStyle {
        text: p.text,
        placeholder: p.placeholder,
        caret: p.caret,
        selection: p.selection,
        font_size: 13.0,
        weight: FontWeight::NORMAL,
    }
}

type ClickHandler = Box<dyn Fn(&gpui::ClickEvent, &mut Window, &mut gpui::App) + 'static>;

fn actions(
    p: &Palette,
    cancel: (&'static str, &'static str),
    confirm: (&'static str, &'static str),
    on_cancel: impl Fn(&gpui::ClickEvent, &mut Window, &mut gpui::App) + 'static,
    on_confirm: impl Fn(&gpui::ClickEvent, &mut Window, &mut gpui::App) + 'static,
) -> AnyElement {
    let on_cancel: ClickHandler = Box::new(on_cancel);
    let on_confirm: ClickHandler = Box::new(on_confirm);
    div()
        .mt(px(space::XL))
        .flex()
        .items_center()
        .gap(px(space::M))
        .child(div().flex_1())
        .child(PushButton::new(cancel.0, cancel.1, p).on_click(on_cancel))
        .child(
            PushButton::new(confirm.0, confirm.1, p)
                .kind(ButtonKind::Primary)
                .on_click(on_confirm),
        )
        .into_any_element()
}

fn sheet_frame(
    id: &'static str,
    p: &Palette,
    cx: &mut Context<PeopleLayer>,
    body: Vec<AnyElement>,
) -> AnyElement {
    div()
        .id(SharedString::new_static(id))
        .absolute()
        .inset_0()
        .bg(p.scrim)
        .flex()
        .items_center()
        .justify_center()
        .occlude()
        .on_click(cx.listener(|layer, _, _, cx| layer.close(cx)))
        .child(
            crate::primitives::sheets::panel_surface(
                p,
                radius::SHEET,
                crate::primitives::tokens::shadow::DIALOG,
            )
            .id(SharedString::from(format!("{id}-sheet")))
            .debug_selector(move || id.into())
            .w(px(SHEET_WIDTH))
            .max_h(gpui::relative(0.9))
            .p(px(space::XXL))
            .on_click(|_, _, cx| cx.stop_propagation())
            .children(body),
        )
        .into_any_element()
}

impl Render for PeopleLayer {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        if !self.is_open() {
            return div().into_any_element();
        }
        let state = self.host.store().snapshot();
        if let Some(picker) = &self.picker
            && picker.live_folder.is_none()
            && state.profile(picker.profile.as_str()).is_none()
        {
            self.picker = None;
        }
        if let Some(rename) = &self.rename
            && rename.live_folder.is_none()
            && state.profile(rename.profile.as_str()).is_none()
        {
            self.rename = None;
        }
        let p = self.look(window).p;
        if let Some(picker) = &self.picker {
            picker.view.update(cx, |view, cx| view.set_palette(p, cx));
        }
        let create = self
            .create
            .as_ref()
            .map(|sheet| self.render_create(sheet, &p, cx));
        let rename = self
            .rename
            .as_ref()
            .map(|sheet| self.render_rename(sheet, &p, cx));
        let picker = self.picker.as_ref().map(|picker| {
            div()
                .id("icon-picker-layer")
                .absolute()
                .inset_0()
                .occlude()
                .on_mouse_down(
                    MouseButton::Left,
                    cx.listener(|layer, _, _, cx| {
                        layer.picker = None;
                        cx.notify();
                    }),
                )
                .child(picker.view.clone())
        });
        deferred(
            div()
                .id("people-layer")
                .absolute()
                .inset_0()
                .children(create)
                .children(rename)
                .children(picker),
        )
        .with_priority(3)
        .into_any_element()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn no_icon_action_matches_place() {
        let sidebar = picker_actions(ProfilePlace::Sidebar, None);
        assert_eq!(sidebar[0].icon, Some("circle.fill"));
        assert!(sidebar[0].primary);
        let settings = picker_actions(ProfilePlace::Settings, Some("🏠"));
        assert_eq!(settings[0].icon, Some("textformat"));
        assert!(!settings[0].primary);
        assert_eq!(settings[0].choice, None);
    }
}
