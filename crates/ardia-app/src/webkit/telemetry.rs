use std::collections::BTreeMap;
use std::sync::atomic::{AtomicBool, Ordering};

use ardia_state::model::PageEngine;
use parking_lot::Mutex;
use serde_json::{Map, Value};

static TALLY: Mutex<BTreeMap<&'static str, u64>> = Mutex::new(BTreeMap::new());
static FAULTS: Mutex<BTreeMap<String, u64>> = Mutex::new(BTreeMap::new());
static ALLOWED: AtomicBool = AtomicBool::new(false);

pub const WEBKIT_COUNTS: &[(&str, &str)] = &[
    ("autofillFill", "webkit_autofill_fills"),
    ("autofillSaveOffer", "webkit_autofill_save_offers"),
    ("autofillSave", "webkit_autofill_saves"),
    ("notification", "webkit_notifications"),
    ("autofillUpdateOffer", "webkit_autofill_update_offers"),
    ("autofillUpdate", "webkit_autofill_updates"),
    ("autofillNever", "webkit_autofill_nevers"),
    ("passwordsLeftToManager", "webkit_passwords_left_to_manager"),
    ("cookieReplaced", "webkit_cookies_replaced"),
    ("workerNotification", "webkit_worker_notifications"),
    (
        "workerShownNotification",
        "webkit_worker_shown_notifications",
    ),
    ("workerClick", "webkit_worker_clicks"),
    ("translation", "webkit_translations"),
    ("siteSettingApplied", "webkit_site_settings_applied"),
    ("uploadFiltered", "webkit_uploads_filtered"),
    ("screenShareRequest", "webkit_screen_share_requests"),
    ("screenShareAllowed", "webkit_screen_share_allowed"),
    ("devTools", "webkit_devtools_opened"),
    ("viewSource", "webkit_view_sources"),
    ("savePage", "webkit_pages_saved"),
    ("savePageFailure", "webkit_save_page_failures"),
    ("quarantineFailure", "webkit_quarantine_failures"),
    ("contextMenu", "webkit_context_menus"),
    ("linkPeek", "webkit_link_peeks"),
    ("linkSplit", "webkit_link_splits"),
    ("littleArdiaLink", "webkit_little_ardia_links"),
    ("scrollZoom", "webkit_scroll_zooms"),
    ("sampledTint", "webkit_sampled_tints"),
    ("authPrompt", "webkit_auth_prompts"),
    ("authPromptBlocked", "webkit_auth_prompts_blocked"),
    (
        "dialogSuppressedWhileHidden",
        "webkit_dialogs_suppressed_while_hidden",
    ),
    (
        "scriptDialogsSuppressed",
        "webkit_script_dialogs_suppressed",
    ),
    ("dialogHeldWhileHidden", "webkit_dialogs_held_while_hidden"),
    (
        "certificateInterstitial",
        "webkit_certificate_interstitials",
    ),
    ("certificateProceed", "webkit_certificate_proceeds"),
    ("popupBlocked", "webkit_popups_blocked"),
    ("blockedPopupOpened", "webkit_blocked_popups_opened"),
    ("errorPageRetry", "webkit_error_page_retries"),
    ("nativeFind", "webkit_native_finds"),
    ("fallbackFind", "webkit_fallback_finds"),
    ("selectionShown", "webkit_selection_popovers"),
    ("appBadge", "webkit_app_badges"),
    ("faviconChanged", "webkit_favicon_changes"),
    ("linkDrop", "webkit_link_drops"),
    ("pageMute", "webkit_page_mutes"),
    ("soundRuleMuted", "webkit_sound_rule_mutes"),
    ("webAudioAudible", "webkit_web_audio_audible"),
    ("pageMuteFallback", "webkit_page_mute_fallbacks"),
    ("fullscreen", "webkit_fullscreens"),
    ("discard", "webkit_discards"),
    ("discardWake", "webkit_discard_wakes"),
    ("backdropHidden", "webkit_backdrops_hidden"),
    ("historyRestored", "webkit_history_restores"),
    ("unresponsive", "webkit_unresponsive"),
    ("unresponsiveEnded", "webkit_unresponsive_ended"),
    ("downloadSkipped", "webkit_downloads_skipped"),
    ("fullscreenFrameKept", "webkit_fullscreen_frames_kept"),
];

pub const WEBKIT_AUTOFILL_COUNTS: &[(&str, &str)] = &[
    ("autofillAddressFill", "webkit_autofill_address_fills"),
    ("autofillCardFill", "webkit_autofill_card_fills"),
    (
        "autofillCardReauthRefused",
        "webkit_autofill_card_reauths_refused",
    ),
    (
        "autofillAddressSaveOffer",
        "webkit_autofill_address_save_offers",
    ),
    ("autofillAddressSave", "webkit_autofill_address_saves"),
    ("autofillCardSaveOffer", "webkit_autofill_card_save_offers"),
    ("autofillCardSave", "webkit_autofill_card_saves"),
    ("autofillSaveSuppressed", "webkit_autofill_save_suppressed"),
];

pub const WEBKIT_BLOCKER_COUNTS: &[(&str, &str)] = &[
    ("blockerStrictBlocked", "webkit_blocker_strict_blocks"),
    ("blockerStrictProceed", "webkit_blocker_strict_proceeds"),
    ("blockerCosmeticApplied", "webkit_blocker_cosmetic_pages"),
    ("blockerUserFilters", "webkit_blocker_user_filter_loads"),
    ("blockerCompileFailed", "webkit_blocker_compile_failures"),
    (
        "blockerUserFiltersFailed",
        "webkit_blocker_user_filter_failures",
    ),
    (
        "blockerUserFiltersIsolated",
        "webkit_blocker_user_filter_isolations",
    ),
];

pub const ENGINE_FIELDS: &[&str] = &[
    "engine_switches",
    "engine_switches_to_webkit",
    "engine_switches_hidden",
    "engine_switch_ms_total",
    "engine_switch_ms_max",
    "engine_switch_timeouts",
    "engine_switch_scroll_carried",
    "engine_switch_zoom_carried",
    "engine_switch_cookies_to_webkit",
    "engine_switch_cookies_to_chromium",
    "engine_site_moves",
    "engine_site_moves_opened_tabs",
    "engine_site_moves_dropped",
    "engine_site_moves_kept_for_opener",
    "engine_mode_changes",
    "engine_mode_changes_cancelled",
    "engine_mode_tabs_moved",
    "engine_mode_video_notices",
    "engine_mode_video_notice_opens",
];

pub const SITE_DATA_FIELDS: &[&str] = &[
    "site_data_carries_to_webkit",
    "site_data_carries_to_chromium",
    "site_data_cookies_to_webkit",
    "site_data_cookies_to_chromium",
    "site_data_cookies_removed",
    "site_data_storage_to_webkit",
    "site_data_storage_to_chromium",
    "site_data_conflicts",
    "site_data_gate_holds",
    "site_data_gate_fresh",
    "site_data_gate_ms_total",
    "site_data_gate_ms_max",
    "site_data_gate_timeouts",
    "site_data_blocked",
    "site_data_chromium_unreadable",
    "site_data_cookie_only_fallbacks",
    "site_data_failures",
    "site_data_untrusted_drops",
    "site_data_clear_wait_timeouts",
    "site_data_sites_unresolved",
    "site_data_storage_over_quota",
    "site_data_blocked_cookies_held",
    "site_data_chromium_reads",
    "site_data_cookie_jar_reads",
    "site_data_cookie_jar_ms_total",
    "site_data_cookie_jar_ms_max",
];

pub const PROTECTED_VIDEO_FIELDS: &[&str] = &[
    "drm_refusals",
    "drm_refusals_access",
    "drm_refusals_create_keys",
    "drm_refusals_licence",
    "drm_refusals_keystatus",
    "drm_refusals_listed_sites",
    "drm_refusals_webkit_sites",
];

pub const MEDIA_FAULT_SYSTEMS: [&str; 4] = ["widevine", "playready", "fairplay", "other"];

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SiteMoveOutcome {
    Moved,
    Dropped,
    KeptForOpener,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SiteDataSkip {
    Blocked,
    ChromiumUnreadable,
    CookieOnlyFallback,
    Failure,
    UntrustedDrops,
    ClearWaitTimeout,
    SiteUnresolved,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct SiteDataCarry {
    pub cookies: u64,
    pub removed: u64,
    pub storage: u64,
    pub conflicts: u64,
}

#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct EngineSwap {
    pub ms: f64,
    pub timed_out: bool,
    pub hidden: bool,
    pub scroll: bool,
    pub zoom: bool,
}

pub fn set_allowed(allowed: bool) {
    let was = ALLOWED.swap(allowed, Ordering::Relaxed);
    if was != allowed {
        TALLY.lock().clear();
        FAULTS.lock().clear();
    }
}

pub fn allowed() -> bool {
    ALLOWED.load(Ordering::Relaxed)
}

fn counted(change: impl FnOnce(&mut BTreeMap<&'static str, u64>)) {
    if allowed() {
        change(&mut TALLY.lock());
    }
}

fn add(tally: &mut BTreeMap<&'static str, u64>, field: &'static str, by: u64) {
    *tally.entry(field).or_default() += by;
}

fn raise(tally: &mut BTreeMap<&'static str, u64>, field: &'static str, to: u64) {
    let slot = tally.entry(field).or_default();
    *slot = (*slot).max(to);
}

fn rounded(ms: f64) -> u64 {
    if ms.is_finite() {
        ms.max(0.0).round() as u64
    } else {
        0
    }
}

pub fn note_engine_swap(to: PageEngine, swap: EngineSwap) {
    counted(|t| {
        add(t, "engine_switches", 1);
        if to == PageEngine::Webkit {
            add(t, "engine_switches_to_webkit", 1);
        }
        if swap.hidden {
            add(t, "engine_switches_hidden", 1);
        }
        if swap.timed_out {
            add(t, "engine_switch_timeouts", 1);
        }
        if swap.scroll {
            add(t, "engine_switch_scroll_carried", 1);
        }
        if swap.zoom {
            add(t, "engine_switch_zoom_carried", 1);
        }
        if swap.hidden {
            return;
        }
        let ms = rounded(swap.ms);
        add(t, "engine_switch_ms_total", ms);
        raise(t, "engine_switch_ms_max", ms);
    });
}

pub fn note_site_move(outcome: SiteMoveOutcome, opened_by_page: bool) {
    counted(|t| match outcome {
        SiteMoveOutcome::Dropped => add(t, "engine_site_moves_dropped", 1),
        SiteMoveOutcome::KeptForOpener => add(t, "engine_site_moves_kept_for_opener", 1),
        SiteMoveOutcome::Moved => {
            add(t, "engine_site_moves", 1);
            if opened_by_page {
                add(t, "engine_site_moves_opened_tabs", 1);
            }
        }
    });
}

pub fn note_cookies_carried(to: PageEngine, count: u64) {
    if count == 0 {
        return;
    }
    counted(|t| {
        let field = if to == PageEngine::Webkit {
            "engine_switch_cookies_to_webkit"
        } else {
            "engine_switch_cookies_to_chromium"
        };
        add(t, field, count);
    });
}

pub fn note_engine_mode_change(cancelled: bool, moved: u64) {
    counted(|t| {
        if cancelled {
            add(t, "engine_mode_changes_cancelled", 1);
            return;
        }
        add(t, "engine_mode_changes", 1);
        add(t, "engine_mode_tabs_moved", moved);
    });
}

pub fn note_engine_mode_video_notice(opened: bool) {
    counted(|t| {
        add(
            t,
            if opened {
                "engine_mode_video_notice_opens"
            } else {
                "engine_mode_video_notices"
            },
            1,
        )
    });
}

pub fn webkit_count_field(name: &str) -> Option<&'static str> {
    WEBKIT_COUNTS
        .iter()
        .chain(WEBKIT_AUTOFILL_COUNTS)
        .chain(WEBKIT_BLOCKER_COUNTS)
        .find(|(known, _)| *known == name)
        .map(|(_, field)| *field)
}

pub fn note_webkit_count(name: &str) {
    if let Some(field) = webkit_count_field(name) {
        counted(|t| add(t, field, 1));
    }
}

pub fn note_site_data_carry(to: PageEngine, carry: SiteDataCarry) {
    if carry.cookies + carry.removed + carry.storage == 0 {
        return;
    }
    counted(|t| {
        let webkit = to == PageEngine::Webkit;
        add(
            t,
            if webkit {
                "site_data_carries_to_webkit"
            } else {
                "site_data_carries_to_chromium"
            },
            1,
        );
        add(
            t,
            if webkit {
                "site_data_cookies_to_webkit"
            } else {
                "site_data_cookies_to_chromium"
            },
            carry.cookies,
        );
        add(
            t,
            if webkit {
                "site_data_storage_to_webkit"
            } else {
                "site_data_storage_to_chromium"
            },
            carry.storage,
        );
        add(t, "site_data_cookies_removed", carry.removed);
        add(t, "site_data_conflicts", carry.conflicts);
    });
}

pub fn note_site_data_skip(reason: SiteDataSkip) {
    let field = match reason {
        SiteDataSkip::Blocked => "site_data_blocked",
        SiteDataSkip::ChromiumUnreadable => "site_data_chromium_unreadable",
        SiteDataSkip::CookieOnlyFallback => "site_data_cookie_only_fallbacks",
        SiteDataSkip::Failure => "site_data_failures",
        SiteDataSkip::UntrustedDrops => "site_data_untrusted_drops",
        SiteDataSkip::ClearWaitTimeout => "site_data_clear_wait_timeouts",
        SiteDataSkip::SiteUnresolved => "site_data_sites_unresolved",
    };
    counted(|t| add(t, field, 1));
}

pub fn note_site_data_gate(ms: f64, held: bool, timed_out: bool) {
    counted(|t| {
        if !held {
            add(t, "site_data_gate_fresh", 1);
            return;
        }
        let rounded = ms.max(0.0).round() as u64;
        add(t, "site_data_gate_holds", 1);
        add(t, "site_data_gate_ms_total", rounded);
        raise(t, "site_data_gate_ms_max", rounded);
        if timed_out {
            add(t, "site_data_gate_timeouts", 1);
        }
    });
}

pub fn note_site_data_over_quota(keys: u64) {
    if keys > 0 {
        counted(|t| add(t, "site_data_storage_over_quota", keys));
    }
}

pub fn note_site_data_blocked_cookies(cookies: u64) {
    if cookies > 0 {
        counted(|t| add(t, "site_data_blocked_cookies_held", cookies));
    }
}

pub fn note_cookie_jar_read(answered: bool, ms: f64) {
    counted(|t| {
        add(t, "site_data_chromium_reads", 1);
        if answered {
            let ms = rounded(ms);
            add(t, "site_data_cookie_jar_reads", 1);
            add(t, "site_data_cookie_jar_ms_total", ms);
            raise(t, "site_data_cookie_jar_ms_max", ms);
        }
    });
}

pub fn note_protected_video_refusal(stage: Option<&str>, listed: bool, routed_to_webkit: bool) {
    counted(|t| {
        add(t, "drm_refusals", 1);
        match stage {
            Some("access") => add(t, "drm_refusals_access", 1),
            Some("createMediaKeys") => add(t, "drm_refusals_create_keys", 1),
            Some("licence") => add(t, "drm_refusals_licence", 1),
            Some("keystatus") => add(t, "drm_refusals_keystatus", 1),
            _ => {}
        }
        if listed {
            add(t, "drm_refusals_listed_sites", 1);
        }
        if routed_to_webkit {
            add(t, "drm_refusals_webkit_sites", 1);
        }
    });
}

pub fn note_streaming_list_visit() {
    counted(|t| add(t, "streaming_list_webkit_visits", 1));
}

pub fn media_fault_reasons() -> Vec<String> {
    let answers = [
        "granted",
        "refused_not_supported",
        "refused_security",
        "refused_not_allowed",
        "refused_other",
    ];
    let mut out: Vec<String> = Vec::new();
    for system in MEDIA_FAULT_SYSTEMS {
        for answer in answers {
            out.push(format!("eme_{system}_{answer}"));
        }
    }
    for system in MEDIA_FAULT_SYSTEMS {
        for answer in ["supported", "unsupported"] {
            out.push(format!("eme_{system}_legacy_{answer}"));
        }
    }
    for code in [
        "unknown",
        "client",
        "service",
        "output",
        "hardware_change",
        "domain",
    ] {
        out.push(format!("eme_legacy_key_error_{code}"));
    }
    for reason in [
        "media_error_aborted",
        "media_error_network",
        "media_error_decode",
        "media_error_src_not_supported",
        "play_rejected_not_allowed",
        "play_rejected_not_supported",
        "play_rejected_abort",
        "play_rejected_other",
    ] {
        out.push(reason.to_owned());
    }
    out
}

pub fn note_webkit_media_fault(reason: &str, muted: bool, blocker_active: bool) {
    if !allowed() || !media_fault_reasons().iter().any(|known| known == reason) {
        return;
    }
    let mut faults = FAULTS.lock();
    *faults.entry(format!("webkit_fault_{reason}")).or_default() += 1;
    if muted {
        *faults.entry("webkit_faults_muted".into()).or_default() += 1;
    }
    if blocker_active {
        *faults
            .entry("webkit_faults_blocker_active".into())
            .or_default() += 1;
    }
}

pub fn take() -> Map<String, Value> {
    let taken = std::mem::take(&mut *TALLY.lock());
    let faults = std::mem::take(&mut *FAULTS.lock());
    let mut out = Map::new();
    let fields = ENGINE_FIELDS
        .iter()
        .chain(SITE_DATA_FIELDS)
        .chain(PROTECTED_VIDEO_FIELDS)
        .copied()
        .chain(WEBKIT_COUNTS.iter().map(|(_, field)| *field))
        .chain(WEBKIT_AUTOFILL_COUNTS.iter().map(|(_, field)| *field))
        .chain(WEBKIT_BLOCKER_COUNTS.iter().map(|(_, field)| *field));
    for field in fields {
        out.insert(
            field.to_owned(),
            Value::from(taken.get(field).copied().unwrap_or(0)),
        );
    }
    if let Some(visits) = taken
        .get("streaming_list_webkit_visits")
        .filter(|n| **n > 0)
    {
        out.insert("streaming_list_webkit_visits".into(), Value::from(*visits));
    }
    for (field, count) in faults {
        out.insert(field, Value::from(count));
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn counts_need_consent_and_reset_when_taken() {
        set_allowed(false);
        note_site_move(SiteMoveOutcome::Moved, true);
        set_allowed(true);
        let _ = take();
        note_site_move(SiteMoveOutcome::Moved, true);
        note_engine_swap(
            PageEngine::Webkit,
            EngineSwap {
                ms: 120.4,
                scroll: true,
                ..EngineSwap::default()
            },
        );
        note_engine_swap(
            PageEngine::Chromium,
            EngineSwap {
                ms: 300.0,
                ..EngineSwap::default()
            },
        );
        note_cookies_carried(PageEngine::Webkit, 4);
        note_webkit_count("errorPageRetry");
        note_webkit_count("blockerStrictBlocked");
        note_webkit_count("unknownName");
        note_protected_video_refusal(Some("licence"), true, false);
        note_webkit_media_fault("media_error_decode", true, false);
        note_webkit_media_fault("made_up", true, true);
        let taken = take();
        assert_eq!(taken["engine_site_moves"], 1);
        assert_eq!(taken["engine_site_moves_opened_tabs"], 1);
        assert_eq!(taken["engine_switches"], 2);
        assert_eq!(taken["engine_switches_to_webkit"], 1);
        assert_eq!(taken["engine_switch_ms_total"], 420);
        assert_eq!(taken["engine_switch_ms_max"], 300);
        assert_eq!(taken["engine_switch_scroll_carried"], 1);
        assert_eq!(taken["engine_switch_cookies_to_webkit"], 4);
        assert_eq!(taken["webkit_error_page_retries"], 1);
        assert_eq!(taken["webkit_blocker_strict_blocks"], 1);
        assert_eq!(taken["drm_refusals_licence"], 1);
        assert_eq!(taken["webkit_fault_media_error_decode"], 1);
        assert_eq!(taken["webkit_faults_muted"], 1);
        assert!(!taken.contains_key("webkit_faults_blocker_active"));
        assert_eq!(take()["engine_switches"], 0);
        assert_eq!(media_fault_reasons().len(), 42);
        set_allowed(false);
    }
}
