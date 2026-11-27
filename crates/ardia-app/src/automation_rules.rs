use std::path::{Path, PathBuf};
use std::time::SystemTime;

use ardia_state::automation_rules::{
    APPROVALS_DOC, ApprovalRule, Approvals, HOOKS_FILE, HookSpec, approval_for,
    launch_action_approval, link_hook_rows, parse_hooks_text, provider_rule,
};
use ardia_state::omnibox::providers::{QUERY_SLOT, provider_configs};
use ardia_ui::host_data::HostTopics;
use ardia_ui::settings::automations::AutomationRulesView;
use parking_lot::Mutex;
use serde_json::Value;

use crate::coordinator::AppCoordinator;

const MAX_HOOKS_BYTES: u64 = 1 << 20;
const OMNIBOX_PROVIDER_PREFIX: &str = "omniboxProvider:";

type Stamp = Option<(SystemTime, u64)>;

#[derive(Default)]
struct Loaded {
    hooks_stamp: Stamp,
    hooks: Vec<HookSpec>,
    problems: Vec<String>,
    approvals_stamp: Stamp,
    approvals: Approvals,
    read: bool,
}

static LOADED: Mutex<Option<Loaded>> = Mutex::new(None);

fn stamp_of(path: &Path) -> Stamp {
    let meta = std::fs::metadata(path).ok()?;
    Some((meta.modified().ok()?, meta.len()))
}

fn read_approvals(path: &Path) -> Approvals {
    std::fs::read(path)
        .ok()
        .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok())
        .map(|doc| Approvals::from_value(&doc))
        .unwrap_or_default()
}

fn refresh(loaded: &mut Loaded, config_dir: &Path, data_dir: &Path) {
    let hooks_path = config_dir.join(HOOKS_FILE);
    let hooks_stamp = stamp_of(&hooks_path);
    if !loaded.read || hooks_stamp != loaded.hooks_stamp {
        loaded.hooks_stamp = hooks_stamp;
        match hooks_stamp {
            None => {
                loaded.hooks.clear();
                loaded.problems.clear();
            }
            Some((_, len)) if len > MAX_HOOKS_BYTES => {
                loaded.problems = vec![format!("{HOOKS_FILE} can't be read (tooLarge)")];
            }
            Some(_) => match std::fs::read_to_string(&hooks_path) {
                Ok(text) => {
                    let parsed = parse_hooks_text(&text);
                    if parsed.problems.is_empty() {
                        loaded.hooks = parsed.hooks;
                        loaded.problems.clear();
                    } else {
                        log::warn!(
                            "[automation] {HOOKS_FILE}: {}; keeping the hooks loaded before",
                            parsed.problems.join("; ")
                        );
                        loaded.problems = parsed.problems;
                    }
                }
                Err(problem) => {
                    loaded.problems = vec![format!("{HOOKS_FILE} can't be read ({problem})")];
                }
            },
        }
    }
    let approvals_path = data_dir.join(APPROVALS_DOC);
    let approvals_stamp = stamp_of(&approvals_path);
    if !loaded.read || approvals_stamp != loaded.approvals_stamp {
        loaded.approvals_stamp = approvals_stamp;
        loaded.approvals = read_approvals(&approvals_path);
    }
    loaded.read = true;
}

fn endpoint_of(suggest: &str) -> Option<String> {
    url::Url::parse(&suggest.replace(QUERY_SLOT, "q"))
        .ok()
        .and_then(|u| u.host_str().map(str::to_owned))
}

pub fn provider_rules(providers: &Value, approvals: &Approvals) -> Vec<ApprovalRule> {
    provider_configs(providers)
        .into_iter()
        .filter(|config| config.needs_approval())
        .map(|config| {
            provider_rule(
                &config.approval_key,
                &config.title,
                config.keyword.as_deref(),
                config.global,
                config.suggest.as_deref().and_then(endpoint_of).as_deref(),
            )
        })
        .filter(|rule| !approvals.is_approved(&rule.key))
        .collect()
}

pub fn offered(
    hooks: &[HookSpec],
    launch_actions: &[String],
    providers: &[ApprovalRule],
) -> Vec<ApprovalRule> {
    hooks
        .iter()
        .filter_map(approval_for)
        .chain(
            launch_actions
                .iter()
                .filter_map(|e| launch_action_approval(e)),
        )
        .chain(providers.iter().cloned())
        .collect()
}

pub fn is_key_approved(approvals: &Approvals, key: &str) -> bool {
    approvals.is_approved(key)
        || (!key.starts_with(OMNIBOX_PROVIDER_PREFIX)
            && approvals.is_approved(&format!("{OMNIBOX_PROVIDER_PREFIX}{key}")))
}

fn now_ms() -> f64 {
    SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .map_or(0.0, |d| d.as_millis() as f64)
}

impl AppCoordinator {
    fn rule_dirs(&self) -> Option<(PathBuf, PathBuf)> {
        let data = self.config.data_dir.clone()?;
        let home = std::env::var_os("HOME").map(PathBuf::from);
        let config =
            crate::plugins::folders::config_dir_for(&data, self.config.scratch, home.as_deref());
        Some((config, data))
    }

    fn with_rules<R>(&self, read: impl FnOnce(&Loaded) -> R) -> Option<R> {
        let (config, data) = self.rule_dirs()?;
        let mut guard = LOADED.lock();
        let loaded = guard.get_or_insert_with(Loaded::default);
        refresh(loaded, &config, &data);
        Some(read(loaded))
    }

    fn offered_rules(&self, loaded: &Loaded) -> Vec<ApprovalRule> {
        let state = self.store.snapshot();
        let providers = provider_rules(&state.settings.omnibox_providers, &loaded.approvals);
        offered(&loaded.hooks, &state.settings.launch_actions, &providers)
    }

    pub(crate) fn automation_rules_view(&self) -> AutomationRulesView {
        self.with_rules(|loaded| AutomationRulesView {
            pending: loaded.approvals.pending(&self.offered_rules(loaded)),
            approved: loaded.approvals.approved_rules(),
            link_hooks: link_hook_rows(&loaded.hooks, &loaded.approvals),
        })
        .unwrap_or_default()
    }

    pub(crate) fn is_automation_approved(&self, key: &str) -> bool {
        self.with_rules(|loaded| is_key_approved(&loaded.approvals, key))
            .unwrap_or(false)
    }

    fn change_approvals(&self, change: impl FnOnce(&mut Approvals, &[ApprovalRule])) {
        let Some((config, data)) = self.rule_dirs() else {
            return;
        };
        let next = {
            let mut guard = LOADED.lock();
            let loaded = guard.get_or_insert_with(Loaded::default);
            refresh(loaded, &config, &data);
            let offered = self.offered_rules(loaded);
            change(&mut loaded.approvals, &offered);
            loaded.approvals.to_value()
        };
        let path = data.join(APPROVALS_DOC);
        let written = serde_json::to_vec(&next)
            .map_err(|e| e.to_string())
            .and_then(|bytes| std::fs::write(&path, bytes).map_err(|e| e.to_string()));
        if let Err(problem) = written {
            log::warn!("[automation] couldn't save the approvals: {problem}");
        }
        if let Some(loaded) = LOADED.lock().as_mut() {
            loaded.approvals_stamp = stamp_of(&path);
        }
        self.signal.emit(HostTopics::PEOPLE);
    }

    pub(crate) fn approve_rule(&self, key: &str) {
        self.change_approvals(|approvals, offered| {
            if let Some(rule) = offered.iter().find(|r| r.key == key) {
                approvals.approve(rule.clone(), now_ms());
            }
        });
    }

    pub(crate) fn revoke_approved_rule(&self, key: &str) {
        self.change_approvals(|approvals, _| approvals.remove(key));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn hooks_reload_when_the_file_changes_and_keep_the_last_good_set() {
        let dir = tempfile::tempdir().expect("dir");
        let config = dir.path().join("config");
        std::fs::create_dir_all(&config).expect("config");
        let mut loaded = Loaded::default();
        refresh(&mut loaded, &config, dir.path());
        assert!(loaded.hooks.is_empty());
        std::fs::write(
            config.join(HOOKS_FILE),
            r#"{"hooks": [{"name": "Work", "on": "link.opening", "route": {"profile": "Work"}}]}"#,
        )
        .expect("write");
        refresh(&mut loaded, &config, dir.path());
        assert_eq!(loaded.hooks.len(), 1);
        std::fs::write(config.join(HOOKS_FILE), r#"{"hooks": [{"name": "x"}, 1]}"#).expect("write");
        loaded.hooks_stamp = None;
        refresh(&mut loaded, &config, dir.path());
        assert_eq!(loaded.hooks.len(), 1);
        assert!(!loaded.problems.is_empty());
    }

    #[test]
    fn offered_rules_list_hooks_launch_actions_and_providers() {
        let parsed = parse_hooks_text(
            r#"{"hooks": [{"name": "Work", "on": "link.opening", "route": {"profile": "Work"}}]}"#,
        );
        let approvals = Approvals::default();
        let providers = provider_rules(
            &json!([{"title": "Links", "keyword": "l", "url": "https://links.example.com/?q={query}", "suggest": "https://api.example.com/s?q={query}"}]),
            &approvals,
        );
        let rules = offered(
            &parsed.hooks,
            &["newTab".into(), "openSettings".into()],
            &providers,
        );
        let kinds: Vec<&str> = rules.iter().map(|r| r.kind.as_str()).collect();
        assert_eq!(kinds, ["route", "launchAction", "omniboxProvider"]);
        assert_eq!(
            rules[2].summary,
            "Sends what you type after \u{201c}l\u{201d} to api.example.com"
        );
        let mut approved = Approvals::default();
        approved.approve(rules[2].clone(), 1.0);
        let key = rules[2].key.trim_start_matches(OMNIBOX_PROVIDER_PREFIX);
        assert!(is_key_approved(&approved, key));
        assert!(is_key_approved(&approved, &rules[2].key));
        assert!(!is_key_approved(&approved, "route:x"));
    }
}
