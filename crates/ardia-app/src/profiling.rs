use std::path::Path;
use std::sync::Arc;

use gpui::App;
use serde_json::{Map, Value};

pub fn start(data_dir: &Path) {
    let mode = ardia_profile::Mode::from_env(std::env::var(ardia_profile::ENV).ok().as_deref());
    if !ardia_profile::start(mode, Some(data_dir)) {
        return;
    }
    ardia_profile::set_telemetry(
        Arc::new(|| ardia_telemetry::consent_now().is_some()),
        Arc::new(submit),
    );
}

fn submit(event: &'static str, mut fields: Map<String, Value>) {
    match event {
        "app_freeze" => crate::telemetry_events::freeze_context(&mut fields),
        "perf_omnibox" => fields.extend(crate::telemetry_events::take_search_suggests()),
        _ => {}
    }
    if let Some(consent) = ardia_telemetry::consent_now() {
        ardia_telemetry::capture_for(event, fields, Some(&consent));
    }
}

pub fn observe_keys(cx: &mut App) {
    if !ardia_profile::ENABLED {
        return;
    }
    cx.intercept_keystrokes(|_, window, _| {
        ardia_profile::keystroke_began();
        ardia_profile::note_window_input(window.window_handle().window_id().as_u64());
    })
    .detach();
    cx.observe_keystrokes(|event, _, _| {
        ardia_profile::keystroke_handled(event.action.as_ref().map(|action| action.name()));
    })
    .detach();
}

pub fn stop() {
    ardia_profile::stop();
}
