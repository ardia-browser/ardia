use std::path::Path;

use ardia_state::persistence::DataDir;
use ardia_state::persistence::documents::{self, Onboarding};
use ardia_state::store::now_ms;
use ardia_ui::OnboardingRecord;

pub fn read(dir: &Path) -> Option<OnboardingRecord> {
    let doc = documents::load_onboarding(&DataDir::new(dir))?;
    Some(OnboardingRecord {
        completed: doc.completed(),
        step: doc.step,
        source: doc.source,
        preset: doc.preset,
    })
}

pub fn merged(previous: Option<Onboarding>, record: &OnboardingRecord, now: i64) -> Onboarding {
    let mut doc = previous.unwrap_or_default();
    if doc.started_at.is_none() {
        doc.started_at = Some(now);
    }
    if record.completed {
        doc.completed_at = Some(now);
    }
    if record.step.is_some() {
        doc.step.clone_from(&record.step);
    }
    doc.source.clone_from(&record.source);
    if record.preset.is_some() {
        doc.preset.clone_from(&record.preset);
    }
    doc
}

pub fn write(dir: &Path, record: &OnboardingRecord) {
    let data = DataDir::new(dir);
    let doc = merged(documents::load_onboarding(&data), record, now_ms());
    if let Err(problem) = documents::save_onboarding(&data, &doc) {
        log::warn!("couldn't save onboarding progress: {problem}");
    }
}

pub fn intro_music_muted(dir: &Path) -> bool {
    documents::load_onboarding(&DataDir::new(dir))
        .and_then(|doc| doc.extra.get("introMusicMuted").and_then(serde_json::Value::as_bool))
        .unwrap_or(false)
}

pub fn save_intro_music_muted(dir: &Path, muted: bool) {
    let data = DataDir::new(dir);
    let mut doc = documents::load_onboarding(&data).unwrap_or_default();
    doc.extra.insert("introMusicMuted".into(), serde_json::json!(muted));
    if let Err(problem) = documents::save_onboarding(&data, &doc) {
        log::warn!("couldn't save the intro music choice: {problem}");
    }
}

pub fn record_trial(dir: &Path, now: i64) {
    let data = DataDir::new(dir);
    let mut doc = documents::load_onboarding(&data).unwrap_or_default();
    doc.extra
        .insert("defaultBrowserTrialStartedAt".into(), serde_json::json!(now));
    if let Err(problem) = documents::save_onboarding(&data, &doc) {
        log::warn!("couldn't record the default browser trial: {problem}");
    }
}

pub fn mark_completed_for_existing_session(dir: &Path) {
    write(
        dir,
        &OnboardingRecord {
            completed: true,
            ..OnboardingRecord::default()
        },
    );
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_trial_keeps_the_old_key_beside_progress() {
        let dir = tempfile::tempdir().expect("dir");
        write(dir.path(), &OnboardingRecord { step: Some("home".into()), ..OnboardingRecord::default() });
        record_trial(dir.path(), 42);
        let doc = documents::load_onboarding(&DataDir::new(dir.path())).expect("doc");
        assert_eq!(doc.extra.get("defaultBrowserTrialStartedAt"), Some(&serde_json::json!(42)));
        assert_eq!(doc.step.as_deref(), Some("home"));
    }

    #[test]
    fn progress_keeps_the_start_and_completion_sets_the_time() {
        let started = merged(
            None,
            &OnboardingRecord {
                step: Some("layout".into()),
                source: Some("arc".into()),
                preset: Some("arc".into()),
                ..OnboardingRecord::default()
            },
            10,
        );
        assert_eq!(started.started_at, Some(10));
        assert_eq!(started.completed_at, None);
        assert_eq!(started.step.as_deref(), Some("layout"));
        let done = merged(
            Some(started),
            &OnboardingRecord {
                completed: true,
                source: Some("arc".into()),
                ..OnboardingRecord::default()
            },
            20,
        );
        assert_eq!(done.started_at, Some(10));
        assert_eq!(done.completed_at, Some(20));
        assert_eq!(done.step.as_deref(), Some("layout"));
        assert_eq!(done.preset.as_deref(), Some("arc"));
    }

    #[test]
    fn records_round_trip_through_the_document() {
        let dir = std::env::temp_dir().join(format!("ardia-onboarding-doc-{}", std::process::id()));
        std::fs::create_dir_all(&dir).expect("dir");
        assert_eq!(read(&dir), None);
        write(
            &dir,
            &OnboardingRecord {
                step: Some("tabs".into()),
                source: Some("chrome".into()),
                preset: Some("chrome".into()),
                ..OnboardingRecord::default()
            },
        );
        let saved = read(&dir).expect("saved");
        assert!(!saved.completed);
        assert_eq!(saved.step.as_deref(), Some("tabs"));
        mark_completed_for_existing_session(&dir);
        assert!(read(&dir).expect("saved").completed);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
