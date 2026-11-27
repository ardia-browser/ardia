use serde_json::Value;

use crate::events::EngineEvent;
use crate::types::*;

fn id<T>(event: &Value, field: &str, make: fn(u64) -> Option<T>) -> Option<T> {
    event.get(field).and_then(Value::as_u64).and_then(make)
}

fn text(event: &Value, field: &str) -> String {
    event
        .get(field)
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_owned()
}

fn optional_text(event: &Value, field: &str) -> Option<String> {
    event
        .get(field)
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
}

fn flag(event: &Value, field: &str) -> bool {
    match event.get(field) {
        Some(Value::Bool(value)) => *value,
        Some(Value::Number(number)) => number.as_f64().is_some_and(|n| n != 0.0),
        _ => false,
    }
}

fn number(event: &Value, field: &str) -> f64 {
    event
        .get(field)
        .and_then(Value::as_f64)
        .filter(|n| n.is_finite())
        .unwrap_or(0.0)
}

fn integer(event: &Value, field: &str) -> i32 {
    event
        .get(field)
        .and_then(Value::as_i64)
        .map_or(0, |n| n.clamp(i32::MIN.into(), i32::MAX.into()) as i32)
}

fn object(event: &Value, field: &str) -> Value {
    event
        .get(field)
        .cloned()
        .filter(Value::is_object)
        .unwrap_or_else(|| Value::Object(Default::default()))
}

fn list(event: &Value, field: &str) -> Vec<Value> {
    event
        .get(field)
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
}

fn url_sender(event: &Value) -> Option<crate::events::UrlSender> {
    let text = |field: &str| {
        event
            .get(field)
            .and_then(Value::as_str)
            .filter(|t| !t.is_empty())
            .map(str::to_owned)
    };
    let sender = crate::events::UrlSender {
        bundle_id: text("bundleId"),
        app_name: text("appName"),
    };
    (sender.bundle_id.is_some() || sender.app_name.is_some()).then_some(sender)
}

fn view(event: &Value) -> Option<ViewToken> {
    ViewToken::from_raw(event.get("view").and_then(Value::as_u64)?)
}

fn typed<T: for<'de> serde::Deserialize<'de> + Default>(event: &Value, field: &str) -> T {
    decode(event.get(field))
}

pub fn decode_bridge_event(json: &str) -> Option<EngineEvent> {
    let event: Value = serde_json::from_str(json).ok()?;
    let name = event.get("event")?.as_str()?;
    let tab = id(&event, "tab", EngineTabId::from_raw);
    let window = id(&event, "window", EngineWindowId::from_raw);
    let profile = id(&event, "profile", EngineProfileId::from_raw);
    let in_window = || Some((window?, tab?));
    Some(match name {
        "started" => EngineEvent::Started,
        "willShutDown" => EngineEvent::WillShutDown,
        "quitCancelled" => EngineEvent::QuitCancelled,
        "permissionRequest" => EngineEvent::PermissionRequested {
            tab,
            request: typed(&event, "request"),
        },
        "permissionDismissed" => EngineEvent::PermissionDismissed {
            request_id: text(&event, "requestId"),
        },
        "extensionSidePanel" => EngineEvent::ExtensionSidePanel {
            tab,
            panel: object(&event, "panel"),
        },
        "extensionActionPopup" => EngineEvent::ExtensionActionPopup {
            tab,
            popup: object(&event, "popup"),
        },
        "extensionActionShortcut" => EngineEvent::ExtensionActionShortcut {
            tab,
            shortcut: object(&event, "shortcut"),
        },
        "extensionInstallPrompt" => EngineEvent::ExtensionInstallPrompt {
            profile,
            tab,
            prompt: typed(&event, "prompt"),
        },
        "extensionInstallFailed" => EngineEvent::ExtensionInstallFailed {
            tab,
            message: text(&event, "message"),
        },
        "deviceChooser" => EngineEvent::DeviceChooser {
            tab,
            chooser: typed(&event, "chooser"),
        },
        "castDialog" => EngineEvent::CastDialog {
            tab,
            dialog: typed(&event, "dialog"),
        },
        "castRoutes" => EngineEvent::CastRoutes {
            profile,
            routes: list(&event, "routes")
                .iter()
                .filter_map(|route| serde_json::from_value(route.clone()).ok())
                .collect(),
        },
        "windowCreatedByEngine" => EngineEvent::WindowCreatedByEngine {
            window: window?,
            profile,
            kind: NewBrowserKind::parse(&text(&event, "kind")),
        },
        "tabInserted" => {
            let (window, tab) = in_window()?;
            EngineEvent::TabInserted {
                window,
                tab,
                opener: id(&event, "opener", EngineTabId::from_raw),
                disposition: text(&event, "disposition"),
            }
        }
        "tabRemoved" => {
            let (window, tab) = in_window()?;
            EngineEvent::TabRemoved { window, tab }
        }
        "tabActivated" => {
            let (window, tab) = in_window()?;
            EngineEvent::TabActivated { window, tab }
        }
        "devToolsChanged" => {
            let (window, tab) = in_window()?;
            EngineEvent::DevToolsChanged {
                window,
                tab,
                open: flag(&event, "open"),
            }
        }
        "fullscreen" => {
            let (window, tab) = in_window()?;
            EngineEvent::FullscreenChanged {
                window,
                tab,
                fullscreen: flag(&event, "fullscreen"),
            }
        }
        "passwordPrompt" => {
            let (window, tab) = in_window()?;
            EngineEvent::PasswordPrompt {
                window,
                tab,
                prompt: typed(&event, "prompt"),
            }
        }
        "autofillPrompt" => {
            let (window, tab) = in_window()?;
            EngineEvent::AutofillPrompt {
                window,
                tab,
                prompt: typed(&event, "prompt"),
            }
        }
        "showRequested" => EngineEvent::ShowRequested {
            window: window?,
            active: flag(&event, "active"),
        },
        "closeCancelled" => EngineEvent::WindowCloseCancelled { window: window? },
        "canTakeTabs" => EngineEvent::WindowCanTakeTabs { window: window? },
        "confirmCloseWithDownloads" => EngineEvent::ConfirmCloseWithDownloads {
            window: window?,
            count: integer(&event, "count"),
            request: event.get("request").and_then(Value::as_u64)?,
        },
        "windowClosed" => EngineEvent::WindowClosed { window: window? },
        "openUrls" => EngineEvent::OpenUrls {
            urls: list(&event, "urls")
                .iter()
                .filter_map(|url| url.as_str().map(str::to_owned))
                .collect(),
            sender: url_sender(&event),
        },
        "reopen" => EngineEvent::DockReopen {
            has_visible_windows: flag(&event, "visible"),
        },
        "menuCommand" => EngineEvent::MenuCommand {
            command: text(&event, "command"),
            arg: optional_text(&event, "arg"),
        },
        "scrollAck" => EngineEvent::PageScroll {
            view: view(&event)?,
            ack: PageScrollAck::from_raw(event.get("ack").and_then(Value::as_i64).unwrap_or(1)),
            consumed: flag(&event, "consumed"),
        },
        "overscroll" => EngineEvent::PageOverscroll {
            view: view(&event)?,
            allows_horizontal: flag(&event, "allowed"),
        },
        tab_event => return decode_tab_event(tab_event, tab?, &event),
    })
}

fn title_of(event: &Value) -> String {
    match event.get("url").and_then(Value::as_str) {
        Some(url) => shown_title(&text(event, "title"), url, flag(event, "loading")),
        None => text(event, "title"),
    }
}

fn shown_title(title: &str, url: &str, loading: bool) -> String {
    if title == "about:blank" && !url.is_empty() && url != "about:blank" {
        return String::new();
    }
    if !loading || title.is_empty() {
        return title.to_owned();
    }
    let Some((scheme, rest)) = url.split_once("://") else {
        return title.to_owned();
    };
    if !scheme.eq_ignore_ascii_case("http") && !scheme.eq_ignore_ascii_case("https") {
        return title.to_owned();
    }
    let mut shown = rest;
    if shown
        .get(..4)
        .is_some_and(|lead| lead.eq_ignore_ascii_case("www."))
    {
        shown = &shown[4..];
    }
    let bare_root =
        !shown.contains(['?', '#']) && shown.find('/') == Some(shown.len().wrapping_sub(1));
    if bare_root {
        shown = &shown[..shown.len() - 1];
    }
    if title == shown.replace("%20", " ") {
        String::new()
    } else {
        title.to_owned()
    }
}

fn decode_tab_event(name: &str, tab: EngineTabId, event: &Value) -> Option<EngineEvent> {
    Some(match name {
        "title" => EngineEvent::TitleChanged {
            tab,
            title: title_of(event),
        },
        "shownTitle" => EngineEvent::ShownTitleChanged {
            tab,
            title: title_of(event),
            url: text(event, "url"),
        },
        "url" => EngineEvent::UrlChanged {
            tab,
            url: text(event, "url"),
        },
        "loading" => EngineEvent::LoadingChanged {
            tab,
            loading: flag(event, "loading"),
        },
        "progress" => EngineEvent::ProgressChanged {
            tab,
            progress: number(event, "progress").clamp(0.0, 1.0),
        },
        "favicon" => EngineEvent::FaviconChanged {
            tab,
            url: optional_text(event, "url"),
        },
        "navigationState" => EngineEvent::NavigationStateChanged {
            tab,
            can_go_back: flag(event, "canGoBack"),
            can_go_forward: flag(event, "canGoForward"),
        },
        "findMatches" => EngineEvent::FindMatches {
            tab,
            matches: FindMatches {
                count: integer(event, "count"),
                active: integer(event, "active"),
                final_update: flag(event, "final"),
            },
        },
        "pageMessage" => EngineEvent::PageMessage {
            tab,
            message: PageMessage {
                kind: text(event, "kind"),
                json: text(event, "json"),
                frame_id: text(event, "frame"),
                main_frame: flag(event, "main"),
                origin: optional_text(event, "origin"),
            },
        },
        "willClose" => EngineEvent::TabWillClose { tab },
        "rendererGone" => EngineEvent::RendererGone {
            tab,
            status: text(event, "status"),
            code: integer(event, "code"),
        },
        "failLoad" => EngineEvent::LoadFailed {
            tab,
            url: text(event, "url"),
            code: integer(event, "code"),
            description: text(event, "description"),
        },
        "statusText" => EngineEvent::StatusText {
            tab,
            text: text(event, "text"),
        },
        "appUrl" => EngineEvent::AppUrlRequested {
            tab,
            url: text(event, "url"),
            user_gesture: flag(event, "userGesture"),
        },
        "themeColor" => EngineEvent::ThemeColorChanged {
            tab,
            color: optional_text(event, "color"),
        },
        "committed" => EngineEvent::DocumentCommitted { tab },
        "focus" => EngineEvent::FocusGained { tab },
        "audio" => EngineEvent::AudioChanged {
            tab,
            audible: flag(event, "audible"),
            muted: flag(event, "muted"),
        },
        "security" => EngineEvent::SecurityChanged { tab },
        "zoom" => EngineEvent::ZoomChanged {
            tab,
            zoom: number(event, "zoom"),
        },
        "popupBlocked" => EngineEvent::PopupBlocked {
            tab,
            popup: typed(event, "popup"),
        },
        "preferredSize" => EngineEvent::PreferredSizeChanged {
            tab,
            size: Size {
                width: number(event, "width"),
                height: number(event, "height"),
            },
        },
        "externalApp" => EngineEvent::ExternalAppRequest {
            tab,
            request: object(event, "request"),
        },
        "activation" => EngineEvent::ActivationRequested {
            tab,
            reason: text(event, "reason"),
            from_other_app: flag(event, "fromOtherApp"),
        },
        "pipActivity" => EngineEvent::PipActivity {
            tab,
            name: text(event, "name"),
            payload: object(event, "payload"),
        },
        "pip" => EngineEvent::PipChanged {
            tab,
            state: typed(event, "state"),
        },
        "autofillSuggestions" => EngineEvent::AutofillSuggestionsShown {
            tab,
            items: list(event, "items"),
        },
        "blockedRequests" => EngineEvent::RequestsBlocked {
            tab,
            count: integer(event, "count"),
            last_url: text(event, "url"),
        },
        "contextMenuCommand" => EngineEvent::ContextMenuCommand {
            tab,
            item: text(event, "item"),
            text: text(event, "text"),
            modifiers: object(event, "modifiers"),
        },
        "shareFromContextMenu" => EngineEvent::ShareFromContextMenu {
            tab,
            share: object(event, "share"),
        },
        "contextMenuShown" => EngineEvent::ContextMenuShown {
            tab,
            items: list(event, "items"),
        },
        "becameDownload" => EngineEvent::NavigationBecameDownload {
            tab,
            url: text(event, "url"),
        },
        "discarded" => EngineEvent::DiscardedChanged {
            tab,
            discarded: flag(event, "discarded"),
            reason: optional_text(event, "reason"),
        },
        "unresponsive" => EngineEvent::Unresponsive { tab },
        "responsive" => EngineEvent::Responsive { tab },
        "mediaAccess" => EngineEvent::MediaAccessChanged {
            tab,
            access: typed(event, "access"),
        },
        _ => return None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn tab(raw: u64) -> EngineTabId {
        EngineTabId::from_raw(raw).unwrap()
    }

    fn window(raw: u64) -> EngineWindowId {
        EngineWindowId::from_raw(raw).unwrap()
    }

    fn decoded(value: Value) -> Option<EngineEvent> {
        decode_bridge_event(&value.to_string())
    }

    #[test]
    fn titles_follow_the_old_reported_title_rules() {
        assert_eq!(
            shown_title(
                "127.0.0.1:9418/b.html",
                "http://127.0.0.1:9418/b.html",
                false
            ),
            "127.0.0.1:9418/b.html"
        );
        assert_eq!(
            shown_title(
                "127.0.0.1:9418/b.html",
                "http://127.0.0.1:9418/b.html",
                true
            ),
            ""
        );
        assert_eq!(
            shown_title("example.com", "https://www.example.com/", true),
            ""
        );
        assert_eq!(
            shown_title("example.com/a b", "https://example.com/a%20b", true),
            ""
        );
        assert_eq!(shown_title("Docs", "https://example.com/", true), "Docs");
        assert_eq!(
            shown_title("example.com/", "https://example.com/?q", true),
            "example.com/"
        );
        assert_eq!(shown_title("file", "file:///tmp/file", true), "file");
        assert_eq!(
            shown_title("about:blank", "https://example.com/", false),
            ""
        );
        assert_eq!(
            shown_title("about:blank", "about:blank", false),
            "about:blank"
        );
        assert_eq!(shown_title("", "https://example.com/", false), "");
    }

    #[test]
    fn a_title_sent_with_its_url_hides_the_address_while_loading() {
        assert_eq!(
            decoded(
                json!({"event": "title", "tab": 1, "title": "a.com/x", "url": "https://a.com/x", "loading": true})
            ),
            Some(EngineEvent::TitleChanged {
                tab: tab(1),
                title: String::new()
            })
        );
        assert_eq!(
            decoded(
                json!({"event": "title", "tab": 1, "title": "a.com/x", "url": "https://a.com/x", "loading": false})
            ),
            Some(EngineEvent::TitleChanged {
                tab: tab(1),
                title: "a.com/x".into()
            })
        );
    }

    #[test]
    fn window_events_need_both_ids() {
        assert_eq!(
            decoded(
                json!({"event": "tabInserted", "window": 2, "tab": 5, "opener": 3, "disposition": "foreground"})
            ),
            Some(EngineEvent::TabInserted {
                window: window(2),
                tab: tab(5),
                opener: Some(tab(3)),
                disposition: "foreground".into()
            })
        );
        assert_eq!(
            decoded(
                json!({"event": "tabInserted", "window": 2, "tab": 5, "opener": 0, "disposition": ""})
            ),
            Some(EngineEvent::TabInserted {
                window: window(2),
                tab: tab(5),
                opener: None,
                disposition: String::new()
            })
        );
        assert_eq!(
            decoded(json!({"event": "tabRemoved", "window": 0, "tab": 5})),
            None
        );
        assert_eq!(decoded(json!({"event": "tabRemoved", "window": 1})), None);
        assert_eq!(
            decoded(json!({"event": "windowClosed", "window": 4})),
            Some(EngineEvent::WindowClosed { window: window(4) })
        );
    }

    #[test]
    fn tab_events_decode_every_delegate_callback() {
        let cases = [
            (
                json!({"event": "title", "tab": 1, "title": "Hi"}),
                EngineEvent::TitleChanged {
                    tab: tab(1),
                    title: "Hi".into(),
                },
            ),
            (
                json!({"event": "progress", "tab": 1, "progress": 3.0}),
                EngineEvent::ProgressChanged {
                    tab: tab(1),
                    progress: 1.0,
                },
            ),
            (
                json!({"event": "favicon", "tab": 1, "url": null}),
                EngineEvent::FaviconChanged {
                    tab: tab(1),
                    url: None,
                },
            ),
            (
                json!({"event": "findMatches", "tab": 1, "count": 4, "active": 2, "final": true}),
                EngineEvent::FindMatches {
                    tab: tab(1),
                    matches: FindMatches {
                        count: 4,
                        active: 2,
                        final_update: true,
                    },
                },
            ),
            (
                json!({"event": "failLoad", "tab": 1, "url": "https://x", "code": -105, "description": "NAME_NOT_RESOLVED"}),
                EngineEvent::LoadFailed {
                    tab: tab(1),
                    url: "https://x".into(),
                    code: -105,
                    description: "NAME_NOT_RESOLVED".into(),
                },
            ),
            (
                json!({"event": "audio", "tab": 1, "audible": 1, "muted": false}),
                EngineEvent::AudioChanged {
                    tab: tab(1),
                    audible: true,
                    muted: false,
                },
            ),
            (
                json!({"event": "blockedRequests", "tab": 1, "count": 7, "url": "https://ads"}),
                EngineEvent::RequestsBlocked {
                    tab: tab(1),
                    count: 7,
                    last_url: "https://ads".into(),
                },
            ),
            (
                json!({"event": "discarded", "tab": 1, "discarded": true, "reason": null}),
                EngineEvent::DiscardedChanged {
                    tab: tab(1),
                    discarded: true,
                    reason: None,
                },
            ),
            (
                json!({"event": "mediaAccess", "tab": 1, "access": {"camera": 1, "microphone": 0, "screen": 0}}),
                EngineEvent::MediaAccessChanged {
                    tab: tab(1),
                    access: MediaAccess {
                        camera: true,
                        microphone: false,
                        screen: false,
                    },
                },
            ),
            (
                json!({"event": "willClose", "tab": 9}),
                EngineEvent::TabWillClose { tab: tab(9) },
            ),
        ];
        for (input, expected) in cases {
            assert_eq!(decoded(input.clone()), Some(expected), "{input}");
        }
        assert_eq!(decoded(json!({"event": "title", "title": "no tab"})), None);
        assert_eq!(decoded(json!({"event": "nonsense", "tab": 1})), None);
        assert_eq!(decode_bridge_event("not json"), None);
        assert_eq!(decoded(json!({"tab": 1})), None);
    }

    #[test]
    fn page_messages_stay_opaque_until_read() {
        let event = decoded(json!({
            "event": "pageMessage", "tab": 3, "kind": "hello", "json": "{\"url\":\"https://a\"}", "frame": "F1", "main": true, "origin": ""
        }))
        .unwrap();
        match event {
            EngineEvent::PageMessage { tab: t, message } => {
                assert_eq!(t, tab(3));
                assert_eq!(message.kind, "hello");
                assert_eq!(message.frame_id, "F1");
                assert!(message.main_frame);
                assert_eq!(message.origin, None);
                assert_eq!(message.data().unwrap()["url"], json!("https://a"));
            }
            other => panic!("unexpected {other:?}"),
        }
    }

    #[test]
    fn engine_payloads_decode_into_types() {
        match decoded(
            json!({"event": "permissionRequest", "tab": 2, "request": {"id": "p1", "origin": "https://a", "permissions": ["camera"]}}),
        ) {
            Some(EngineEvent::PermissionRequested {
                tab: Some(t),
                request,
            }) => {
                assert_eq!(t, tab(2));
                assert_eq!(request.permissions, vec!["camera"]);
            }
            other => panic!("unexpected {other:?}"),
        }
        match decoded(json!({"event": "permissionRequest", "tab": 0, "request": {}})) {
            Some(EngineEvent::PermissionRequested { tab: None, .. }) => {}
            other => panic!("unexpected {other:?}"),
        }
        match decoded(
            json!({"event": "castRoutes", "profile": 1, "routes": [{"id": "r", "sink": "s", "source": "x", "description": "TV"}, 5]}),
        ) {
            Some(EngineEvent::CastRoutes { routes, .. }) => assert_eq!(routes.len(), 1),
            other => panic!("unexpected {other:?}"),
        }
        assert_eq!(
            decoded(
                json!({"event": "confirmCloseWithDownloads", "window": 1, "count": 2, "request": 11})
            ),
            Some(EngineEvent::ConfirmCloseWithDownloads {
                window: window(1),
                count: 2,
                request: 11
            })
        );
        assert_eq!(
            decoded(
                json!({"event": "windowCreatedByEngine", "window": 3, "profile": 1, "kind": "popup"})
            ),
            Some(EngineEvent::WindowCreatedByEngine {
                window: window(3),
                profile: EngineProfileId::from_raw(1),
                kind: NewBrowserKind::Popup
            })
        );
    }

    #[test]
    fn page_view_events_carry_the_view_identity() {
        assert_eq!(
            decoded(json!({"event": "scrollAck", "view": 4096, "ack": 0, "consumed": true})),
            Some(EngineEvent::PageScroll {
                view: ViewToken::from_raw(4096).unwrap(),
                ack: PageScrollAck::Begin,
                consumed: true
            })
        );
        assert_eq!(
            decoded(json!({"event": "overscroll", "view": 0, "allowed": true})),
            None
        );
        assert_eq!(
            decoded(json!({"event": "menuCommand", "command": "newTab", "arg": null})),
            Some(EngineEvent::MenuCommand {
                command: "newTab".into(),
                arg: None
            })
        );
        assert_eq!(
            decoded(json!({"event": "openUrls", "urls": ["https://a", 3]})),
            Some(EngineEvent::OpenUrls {
                urls: vec!["https://a".into()],
                sender: None
            })
        );
        assert_eq!(
            decoded(
                json!({"event": "openUrls", "urls": ["https://b"], "bundleId": "com.hnc.Discord", "appName": "Discord"})
            ),
            Some(EngineEvent::OpenUrls {
                urls: vec!["https://b".into()],
                sender: Some(crate::events::UrlSender {
                    bundle_id: Some("com.hnc.Discord".into()),
                    app_name: Some("Discord".into())
                })
            })
        );
    }
}
