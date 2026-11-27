use std::sync::Arc;

use ardia_state::WindowId;
use gpui::{AppContext as _, TestAppContext, VisualTestContext};
use parking_lot::Mutex;
use serde_json::{Map, Value, json};

use super::model::{
    PanelContent, PluginHost, PluginNode, QuickPickItem, QuickPickOptions, QuickPickRequest,
    SidePanelCard, SidePanelState, SurfaceKind, SurfaceMount,
};
use super::nodes::check_plugin_node;
use super::quick_pick::QuickPickView;
use super::surface::{PluginSurfaceView, SurfaceSpec};
use crate::host::UiHost;
use crate::look::Look;
use crate::mock::MockUiHost;

#[derive(Clone, Debug, PartialEq)]
enum Call {
    Mount(String),
    Unmount(String),
    Fire(String, Vec<Value>),
    Open(String),
    Pick(u64, Option<Vec<String>>),
}

#[derive(Default)]
struct FakePlugins {
    tree: Mutex<Option<PluginNode>>,
    calls: Mutex<Vec<Call>>,
    pick: Mutex<Option<QuickPickRequest>>,
    panel: Mutex<SidePanelState>,
}

impl FakePlugins {
    fn calls(&self) -> Vec<Call> {
        self.calls.lock().clone()
    }
}

impl PluginHost for FakePlugins {
    fn window_eligible(&self, _: &WindowId) -> bool {
        true
    }

    fn surface_tree(&self, _: &str, _: &str) -> Option<PluginNode> {
        self.tree.lock().clone()
    }

    fn mount_surface(&self, mount: SurfaceMount) {
        self.calls.lock().push(Call::Mount(mount.view));
    }

    fn unmount_surface(&self, _: &str, instance: &str, _: &WindowId) {
        self.calls.lock().push(Call::Unmount(instance.to_owned()));
    }

    fn fire(
        &self,
        _: &str,
        _: &str,
        _: &WindowId,
        handler: &str,
        args: Vec<Value>,
        _: bool,
    ) -> bool {
        self.calls.lock().push(Call::Fire(handler.to_owned(), args));
        true
    }

    fn open_url(&self, _: &WindowId, url: &str) {
        self.calls.lock().push(Call::Open(url.to_owned()));
    }

    fn resolve_quick_pick(&self, id: u64, picked: Option<Vec<String>>) {
        self.calls.lock().push(Call::Pick(id, picked));
        *self.pick.lock() = None;
    }

    fn quick_pick(&self) -> Option<QuickPickRequest> {
        self.pick.lock().clone()
    }

    fn side_panel(&self, _: &WindowId) -> SidePanelState {
        self.panel.lock().clone()
    }
}

fn palette() -> crate::look::Palette {
    let state = crate::mock::fresh_state();
    Look::new(&state, "w", gpui::WindowAppearance::Light).p
}

fn open_surface(
    cx: &mut TestAppContext,
    tree: Value,
) -> (
    Arc<FakePlugins>,
    gpui::Entity<PluginSurfaceView>,
    VisualTestContext,
) {
    cx.update(crate::bind_global_keybindings);
    let fake = Arc::new(FakePlugins::default());
    *fake.tree.lock() = Some(check_plugin_node(&tree).expect("a valid tree"));
    let host = MockUiHost::fresh();
    let shared: Arc<dyn UiHost> = host;
    let plugins: Arc<dyn PluginHost> = fake.clone();
    let (view, cx) = cx.add_window_view(|window, cx| {
        PluginSurfaceView::new(
            shared,
            plugins,
            SurfaceSpec {
                plugin: "notes".into(),
                view: "main".into(),
                kind: SurfaceKind::Command,
                window: WindowId::new("w"),
                context: Map::new(),
            },
            palette(),
            window,
            cx,
        )
    });
    cx.run_until_parked();
    let visual = cx.clone();
    (fake, view, visual)
}

#[gpui::test]
fn surfaces_mount_render_and_run_actions_and_shortcuts(cx: &mut TestAppContext) {
    let (fake, view, mut cx) = open_surface(
        cx,
        json!({
            "type": "Detail",
            "props": {
                "markdown": "# Hi",
                "actions": {"type": "ActionPanel", "children": [
                    {"type": "Action", "props": {"title": "Open", "url": "https://a.test/", "shortcut": "cmd+shift+o"}},
                    {"type": "Action", "props": {"title": "Copy", "copy": "text", "onAction": {"__handler": "h1"}}}
                ]}
            },
            "children": [{"type": "Button", "props": {"title": "Go", "onPress": {"__handler": "h2"}}}]
        }),
    );
    assert_eq!(fake.calls()[0], Call::Mount("main".into()));
    let ran = view.update(&mut cx, |view, _| {
        assert!(view.has_shortcuts());
        view.run_action(None)
    });
    assert!(!ran);
    let focus = view.read_with(&cx, |view, _| view.focus_handle().clone());
    cx.update(|window, cx| window.focus(&focus, cx));
    cx.simulate_keystrokes("cmd-shift-o");
    assert!(fake.calls().contains(&Call::Open("https://a.test/".into())));
    let copy = check_plugin_node(
        &json!({"type": "Action", "props": {"copy": "text", "onAction": {"__handler": "h1"}}}),
    )
    .unwrap();
    view.update(&mut cx, |view, _| {
        assert!(view.run_action(Some(&copy)));
        assert_eq!(view.copied().as_deref(), Some("text"));
    });
    let calls = fake.calls();
    assert!(calls.contains(&Call::Fire("h1".into(), Vec::new())));
    drop(view);
    cx.update(|window, _| window.remove_window());
    cx.run_until_parked();
    assert!(
        fake.calls()
            .iter()
            .any(|c| matches!(c, Call::Unmount(id) if id.starts_with("main#")))
    );
}

#[gpui::test]
fn forms_submit_their_values(cx: &mut TestAppContext) {
    let (fake, view, mut cx) = open_surface(
        cx,
        json!({
            "type": "Form",
            "props": {"onSubmit": {"__handler": "submit"}},
            "children": [
                {"type": "TextField", "props": {"id": "name", "defaultValue": "Ann"}},
                {"type": "Toggle", "props": {"id": "on"}}
            ]
        }),
    );
    view.update(&mut cx, |view, _| view.submit("root"));
    assert!(fake.calls().contains(&Call::Fire(
        "submit".into(),
        vec![json!({"name": "Ann", "on": false})]
    )));
}

#[gpui::test]
fn quick_pick_resolves_on_enter_and_escape(cx: &mut TestAppContext) {
    cx.update(crate::bind_global_keybindings);
    let fake = Arc::new(FakePlugins::default());
    let plugins: Arc<dyn PluginHost> = fake.clone();
    let request = QuickPickRequest {
        id: 3,
        plugin: "notes".into(),
        plugin_title: None,
        window: WindowId::new("w"),
        items: vec![
            QuickPickItem {
                id: "a".into(),
                title: "Alpha".into(),
                subtitle: None,
                icon: None,
                badge: None,
                keywords: Vec::new(),
                picked: false,
            },
            QuickPickItem {
                id: "b".into(),
                title: "Beta".into(),
                subtitle: None,
                icon: Some("star".into()),
                badge: Some("new".into()),
                keywords: Vec::new(),
                picked: false,
            },
        ],
        options: QuickPickOptions::default(),
    };
    let (_, cx) = cx
        .add_window_view(|window, cx| QuickPickView::new(plugins, request, palette(), window, cx));
    cx.simulate_keystrokes("down enter");
    assert_eq!(fake.calls(), vec![Call::Pick(3, Some(vec!["b".into()]))]);
    cx.simulate_keystrokes("escape");
    assert_eq!(fake.calls().len(), 1);
}

#[gpui::test]
fn no_plugin_host_means_no_layer(cx: &mut TestAppContext) {
    let host = MockUiHost::fresh();
    let shared: Arc<dyn UiHost> = host.clone();
    let window = cx.add_empty_window();
    let layer = window.update(|window, cx| {
        super::plugin_layer(
            &shared,
            &WindowId::new("w"),
            super::LayerFrame::default(),
            palette(),
            window,
            cx,
        )
        .is_some()
    });
    assert!(!layer);
    let fake: Arc<dyn PluginHost> = Arc::new(FakePlugins::default());
    host.set_plugins(Some(fake));
    let _ = cx.new(|_| ());
}

#[gpui::test]
fn the_window_layer_shows_quick_picks_and_side_panels_from_the_host(cx: &mut TestAppContext) {
    let browser = crate::tests::support::Browser::open(cx);
    assert!(browser.bounds(cx, "plugin-layer").is_none());
    let card_before = browser.bounds(cx, "plugin-side-panel");
    assert!(card_before.is_none());
    let fake = Arc::new(FakePlugins::default());
    *fake.pick.lock() = Some(QuickPickRequest {
        id: 9,
        plugin: "notes".into(),
        plugin_title: Some("Notes".into()),
        window: browser.window.clone(),
        items: vec![QuickPickItem {
            id: "a".into(),
            title: "Alpha".into(),
            subtitle: None,
            icon: None,
            badge: None,
            keywords: Vec::new(),
            picked: false,
        }],
        options: QuickPickOptions::default(),
    });
    *fake.panel.lock() = SidePanelState {
        shown: Some(SidePanelCard {
            plugin: "notes".into(),
            panel: "main".into(),
            generation: 1,
            title: "Notes".into(),
            icon: "star".into(),
            content: PanelContent::Missing,
        }),
        retained: Vec::new(),
    };
    let plugins: Arc<dyn PluginHost> = fake.clone();
    browser.host.set_plugins(Some(plugins));
    browser.redraw(cx);
    assert!(browser.bounds(cx, "plugin-quick-pick").is_some());
    std::thread::sleep(std::time::Duration::from_millis(200));
    browser.redraw(cx);
    let panel = browser
        .bounds(cx, "plugin-side-panel")
        .expect("the side panel");
    assert!(f32::from(panel.size.width) > 300.0);
    let mut visual = VisualTestContext::from_window(browser.handle.into(), cx);
    visual.simulate_keystrokes("enter");
    visual.run_until_parked();
    assert!(
        fake.calls()
            .contains(&Call::Pick(9, Some(vec!["a".into()])))
    );
    browser.redraw(cx);
    assert!(browser.bounds(cx, "plugin-quick-pick").is_none());
}

#[gpui::test]
fn long_consent_lines_wrap_inside_the_sheet(cx: &mut TestAppContext) {
    use super::consent::ConsentView;
    use super::model::{ConsentLine, ConsentOwner, ConsentRequest, ConsentVerb};
    cx.update(crate::bind_global_keybindings);
    let plugins: Arc<dyn PluginHost> = Arc::new(FakePlugins::default());
    let long = "While control is on in Settings, any program you run can fully control Ardia: every tab and page, your signed-in sites and their cookies, and uploads and downloads of any file on this Mac. ".repeat(3);
    let request = ConsentRequest {
        id: 1,
        name: "cli".into(),
        hash: "h".into(),
        owner: ConsentOwner::Settings,
        title: Some("Command Line".into()),
        icon: None,
        description: None,
        verb: ConsentVerb::Install,
        changed: false,
        lines: vec![
            ConsentLine {
                icon: "hand.raised".into(),
                text: long.trim_end().to_owned(),
            },
            ConsentLine {
                icon: "terminal.fill".into(),
                text: "Adds ardia to your PATH".into(),
            },
        ],
    };
    let (_, cx) =
        cx.add_window_view(|window, cx| ConsentView::new(plugins, request, palette(), window, cx));
    cx.run_until_parked();
    let column = cx
        .debug_bounds("plugin-consent-lines")
        .expect("lines shown");
    let first = cx
        .debug_bounds("plugin-consent-line-0")
        .expect("a long line");
    let second = cx
        .debug_bounds("plugin-consent-line-1")
        .expect("a short line");
    assert!(
        first.right() <= column.right() + gpui::px(0.5),
        "{first:?} runs past {column:?}"
    );
    assert!(
        first.size.height >= second.size.height * 3.0,
        "{first:?} didn't wrap; one line is {second:?}"
    );
    assert!(second.top() >= first.bottom());
}
