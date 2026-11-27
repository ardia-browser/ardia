use ardia_engine::EngineEvent;
use ardia_telemetry::counts;
use serde_json::{Map, Value, json};

use crate::coordinator::AppCoordinator;

pub fn release_field(outcome: &str) -> Option<&'static str> {
    Some(match outcome {
        "corner" => "pip_releases_to_corner",
        "flickTuck" => "pip_releases_flicked_into_tuck",
        "tuck" => "pip_releases_tucked",
        "pullOut" => "pip_releases_pulled_out_of_tuck",
        "cornerPull" => "pip_releases_pulled_into_corner",
        "placed" => "pip_releases_placed",
        _ => return None,
    })
}

pub fn kept_field(reason: &str) -> Option<&'static str> {
    Some(match reason {
        "onScreen" => "auto_pip_kept_visible",
        "appSwitch" => "auto_pip_stayed_on_app_switch",
        "nothingPlaying" => "auto_pip_nothing_playing",
        "missedTabSwitch" => "auto_pip_not_shown_tab_switch",
        "missedAppSwitch" => "auto_pip_not_shown_app_switch",
        "missedSpaceSwitch" => "auto_pip_not_shown_space_switch",
        "missedOther" => "auto_pip_not_shown_other",
        "missedSiteAsked" => "auto_pip_not_shown_site_asked",
        "leftOnSpaceSwitch" => "pip_left_on_space_switch",
        "leftOnSpaceSwitchJoining" => "pip_left_on_space_switch_joining",
        _ => return None,
    })
}

pub fn close_field(closed_by: &str, automatic: bool) -> Option<&'static str> {
    Some(match (closed_by, automatic) {
        ("app", true) => "pip_closed_auto_by_app",
        ("chrome", true) => "pip_closed_auto_by_chrome",
        ("app", false) => "pip_closed_manual_by_app",
        ("chrome", false) => "pip_closed_manual_by_chrome",
        _ => return None,
    })
}

fn flag(payload: &Value, field: &str) -> bool {
    match payload.get(field) {
        Some(Value::Bool(value)) => *value,
        Some(Value::Number(number)) => number.as_f64().is_some_and(|n| n != 0.0),
        _ => false,
    }
}

pub fn activity_fields(name: &str, payload: &Value) -> Vec<&'static str> {
    let mut fields = Vec::new();
    match name {
        "pictureInPictureSkip" => {
            let seconds = payload
                .get("seconds")
                .and_then(Value::as_f64)
                .unwrap_or(0.0);
            if seconds < 0.0 {
                fields.push("pip_click_skips_back");
            } else if seconds > 0.0 {
                fields.push("pip_click_skips_ahead");
            }
        }
        "pictureInPictureResized" => {
            fields.push("pip_resizes");
            if flag(payload, "inside") && !flag(payload, "cursorShown") {
                fields.push("pip_resizes_without_cursor");
            }
        }
        "pictureInPictureReleased" => {
            if let Some(field) = payload
                .get("outcome")
                .and_then(Value::as_str)
                .and_then(release_field)
            {
                fields.push(field);
            }
        }
        "pictureInPictureUnstashed" => fields.push("pip_handle_unstashes"),
        "pictureInPictureDragged" => {
            fields.push("pip_drags");
            if flag(payload, "offCursor") {
                fields.push("pip_drags_off_cursor");
            }
            if flag(payload, "slowMove") {
                fields.push("pip_drags_slow_move");
            }
        }
        "pictureInPictureStandIn" => {
            let pinch = flag(payload, "pinch");
            if pinch {
                fields.push("pip_pinches");
            }
            if flag(payload, "timedOut") {
                fields.push("pip_stand_in_timeouts");
            }
            if pinch && flag(payload, "unfocused") {
                fields.push("pip_pinches_unfocused");
            }
            if pinch && flag(payload, "fromOtherApp") {
                fields.push("pip_pinches_from_other_app");
            }
        }
        "pictureInPictureActivated" => {
            fields.push("pip_activations");
            if !flag(payload, "activated") {
                fields.push("pip_activation_failures");
            }
        }
        "autoPictureInPictureKept" => {
            let reason = match payload.get("reason").and_then(Value::as_str) {
                Some(reason) => Some(reason),
                None => payload.get("appSwitch").map(|_| {
                    if flag(payload, "appSwitch") {
                        "appSwitch"
                    } else {
                        "onScreen"
                    }
                }),
            };
            if let Some(field) = reason.and_then(kept_field) {
                fields.push(field);
            }
        }
        _ => {}
    }
    fields
}

pub fn shown_props(payload: &Value) -> Option<Map<String, Value>> {
    if !flag(payload, "active") || payload.get("fullScreenSpaces").is_none() {
        return None;
    }
    let kind = match payload.get("kind").and_then(Value::as_str) {
        Some("document") => "document",
        _ => "video",
    };
    Some(Map::from_iter([
        ("kind".to_owned(), json!(kind)),
        (
            "full_screen_spaces".to_owned(),
            json!(flag(payload, "fullScreenSpaces")),
        ),
        ("left_app".to_owned(), json!(flag(payload, "leftApp"))),
        ("left_tab".to_owned(), json!(flag(payload, "leftTab"))),
    ]))
}

pub fn note_back_to_tab(webkit: bool, from_other_app: bool) {
    counts::count(if webkit {
        "pip_back_to_tab_webkit"
    } else {
        "pip_back_to_tab"
    });
    if from_other_app {
        counts::count("pip_back_to_tab_from_other_app");
    }
}

impl AppCoordinator {
    pub(crate) fn note_pip_event(&self, event: &EngineEvent) {
        match event {
            EngineEvent::PipActivity { name, payload, .. } => {
                if name == "pictureInPicture" {
                    if let Some(props) = shown_props(payload) {
                        ardia_telemetry::capture("pip_shown", props);
                    }
                    return;
                }
                for field in activity_fields(name, payload) {
                    counts::count(field);
                }
            }
            EngineEvent::PipChanged { state, .. } => {
                if !state.active
                    && let Some(field) = state
                        .closed_by
                        .as_deref()
                        .and_then(|by| close_field(by, state.automatic))
                {
                    counts::count(field);
                }
            }
            EngineEvent::ActivationRequested {
                reason,
                from_other_app,
                ..
            } if reason == "pictureInPicture" => note_back_to_tab(false, *from_other_app),
            _ => {}
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn native_pip_reports_map_to_the_old_field_names() {
        assert_eq!(
            activity_fields("pictureInPictureSkip", &json!({"seconds": -10})),
            ["pip_click_skips_back"]
        );
        assert_eq!(
            activity_fields(
                "pictureInPictureResized",
                &json!({"inside": true, "cursorShown": false})
            ),
            ["pip_resizes", "pip_resizes_without_cursor"]
        );
        assert_eq!(
            activity_fields("pictureInPictureReleased", &json!({"outcome": "flickTuck"})),
            ["pip_releases_flicked_into_tuck"]
        );
        assert!(
            activity_fields("pictureInPictureReleased", &json!({"outcome": "https://x"}))
                .is_empty()
        );
        assert_eq!(
            activity_fields(
                "pictureInPictureDragged",
                &json!({"offCursor": true, "slowMove": false})
            ),
            ["pip_drags", "pip_drags_off_cursor"]
        );
        assert_eq!(
            activity_fields(
                "pictureInPictureStandIn",
                &json!({"pinch": true, "timedOut": false, "unfocused": true, "fromOtherApp": true})
            ),
            [
                "pip_pinches",
                "pip_pinches_unfocused",
                "pip_pinches_from_other_app"
            ]
        );
        assert_eq!(
            activity_fields("pictureInPictureActivated", &json!({"activated": false})),
            ["pip_activations", "pip_activation_failures"]
        );
        assert_eq!(
            activity_fields(
                "autoPictureInPictureKept",
                &json!({"reason": "leftOnSpaceSwitchJoining"})
            ),
            ["pip_left_on_space_switch_joining"]
        );
        assert_eq!(
            activity_fields("autoPictureInPictureKept", &json!({"appSwitch": true})),
            ["auto_pip_stayed_on_app_switch"]
        );
        assert!(activity_fields("anythingElse", &json!({})).is_empty());
        assert_eq!(
            close_field("chrome", true),
            Some("pip_closed_auto_by_chrome")
        );
        assert_eq!(close_field("user", false), None);
    }

    #[test]
    fn pip_shown_carries_flags_and_a_fixed_kind() {
        let props = shown_props(&json!({"kind": "document", "active": true, "fullScreenSpaces": true, "leftApp": false, "leftTab": true})).expect("shown");
        assert_eq!(props["kind"], "document");
        assert_eq!(props["full_screen_spaces"], true);
        assert_eq!(props["left_tab"], true);
        assert!(
            shown_props(&json!({"kind": "evil", "active": true, "fullScreenSpaces": 0}))
                .is_some_and(|p| p["kind"] == "video")
        );
        assert!(shown_props(&json!({"active": false, "fullScreenSpaces": true})).is_none());
    }
}
