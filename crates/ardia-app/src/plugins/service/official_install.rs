use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

use ardia_ui::host::{OfficialInstallPhase, OfficialPlugin, OfficialPluginState};
use ardia_ui::plugins::model::ConsentOwner;
use futures::channel::oneshot;

use super::super::folders::Listing;
use super::super::official::{self, Download, FetchCode, HttpDownload, Store};
use super::super::records::approval_hash;
use super::PluginService;

pub const ALREADY_ASKING: &str =
    "Ardia is already asking about a plugin. Answer that first, then try again.";
pub const CONFIRM_REFUSED: &str = "Can't install it right now.";
pub const UNSAVED: &str = "plugins.json couldn't be saved. Try again.";
pub const NOT_OFFICIAL: &str = "Not an official plugin.";

pub type InstallReply = oneshot::Receiver<Result<(), String>>;

pub struct OfficialInstall {
    cancel: Arc<AtomicBool>,
    waiters: Vec<oneshot::Sender<Result<(), String>>>,
    asking: bool,
    phase: OfficialInstallPhase,
}

fn answered(result: Result<(), String>) -> InstallReply {
    let (answer, reply) = oneshot::channel();
    let _ = answer.send(result);
    reply
}

impl PluginService {
    pub fn set_official_source(&self, folder: Option<PathBuf>) {
        self.state.lock().official_source = folder;
    }

    pub fn set_official_download(&self, download: Arc<dyn Download>) {
        self.state.lock().official_download = Some(download);
    }

    pub fn official_store(&self) -> Store {
        Store::new(self.folders.official_root())
    }

    pub fn official_install_progress(&self, name: &str) -> Option<OfficialInstallPhase> {
        self.state.lock().installs.get(name).map(|run| run.phase)
    }

    pub(super) fn mark_installing(&self, name: &str) {
        if let Some(run) = self.state.lock().installs.get_mut(name) {
            run.phase = OfficialInstallPhase::Installing;
        }
        self.env.notify();
    }

    pub fn official_plugins(&self) -> Vec<OfficialPlugin> {
        let mut out = self.pinned_plugins();
        for soon in super::super::folders::bundled_coming_soon() {
            if !super::super::folders::experiment_on(&soon.experiment)
                || out.iter().any(|p| p.name == soon.name)
            {
                continue;
            }
            out.push(OfficialPlugin {
                name: soon.name,
                title: soon.title,
                blurb: soon.blurb,
                icon: soon.icon,
                state: OfficialPluginState::ComingSoon,
                version: None,
                update: None,
                example: None,
            });
        }
        out
    }

    fn pinned_plugins(&self) -> Vec<OfficialPlugin> {
        let state = self.state.lock();
        self.folders
            .pin
            .iter()
            .map(|entry| {
                let listing = state.listings.get(&entry.name).filter(|l| l.official);
                let manifest = listing.and_then(|l| l.read.manifest.as_ref()).or_else(|| {
                    state
                        .candidates
                        .get(&entry.name)
                        .and_then(|c| c.read.manifest.as_ref())
                });
                let installed = listing.is_some() && state.active(&entry.name).is_some();
                let candidate = state.candidates.get(&entry.name);
                let update = listing
                    .zip(candidate)
                    .filter(|(listing, candidate)| {
                        candidate.read.manifest.is_some() && candidate.hash != listing.hash
                    })
                    .and_then(|(_, candidate)| {
                        candidate
                            .read
                            .manifest
                            .as_ref()
                            .and_then(|m| m.version.clone())
                    })
                    .filter(|_| installed);
                let offered = entry.url.is_some();
                let example = manifest
                    .and_then(|m| {
                        m.contributes
                            .programs
                            .iter()
                            .find_map(|p| p.example.clone())
                    })
                    .or_else(|| entry.example.clone().filter(|_| offered));
                let shown = if entry.url.is_none() {
                    OfficialPluginState::Unsupported
                } else if installed {
                    OfficialPluginState::Installed
                } else {
                    OfficialPluginState::Available
                };
                OfficialPlugin {
                    name: entry.name.clone(),
                    title: manifest.map_or_else(|| entry.title.clone(), |m| m.title.clone()),
                    blurb: manifest
                        .map(|m| m.description.clone())
                        .filter(|d| !d.is_empty())
                        .unwrap_or_else(|| entry.blurb.clone()),
                    icon: manifest
                        .and_then(|m| {
                            m.icon
                                .clone()
                                .or_else(|| m.page.as_ref().map(|p| p.icon.clone()))
                        })
                        .unwrap_or_else(|| entry.icon.clone()),
                    state: shown,
                    version: manifest
                        .and_then(|m| m.version.clone())
                        .or_else(|| Some(entry.version.clone()).filter(|v| !v.is_empty())),
                    update,
                    example,
                }
            })
            .collect()
    }

    pub fn install_official(&self, name: &str) -> InstallReply {
        let shown = self
            .official_plugins()
            .into_iter()
            .find(|p| p.name == name)
            .map(|p| (p.state, p.update.is_some()));
        match shown {
            Some((OfficialPluginState::Available, _)) => {}
            Some((OfficialPluginState::Installed, false)) => return answered(Ok(())),
            Some((OfficialPluginState::Installed, true)) => {
                if let Some(outcome) = self.promote_approved_update(name) {
                    return answered(outcome);
                }
            }
            _ => return answered(Err(NOT_OFFICIAL.to_owned())),
        }
        let (answer, reply) = oneshot::channel();
        let cancel = {
            let mut state = self.state.lock();
            if let Some(run) = state.installs.get_mut(name) {
                run.waiters.push(answer);
                return reply;
            }
            if state.consent.is_some() {
                return answered(Err(ALREADY_ASKING.to_owned()));
            }
            let cancel = Arc::new(AtomicBool::new(false));
            state.installs.insert(
                name.to_owned(),
                OfficialInstall {
                    cancel: cancel.clone(),
                    waiters: vec![answer],
                    asking: false,
                    phase: OfficialInstallPhase::Downloading {
                        received: 0,
                        total: 0,
                    },
                },
            );
            cancel
        };
        self.env.notify();
        let me = self.me.clone();
        let name = name.to_owned();
        std::thread::spawn(move || {
            if let Some(service) = me.upgrade() {
                service.run_official_install(&name, &cancel);
            }
        });
        reply
    }

    fn run_official_install(&self, name: &str, cancel: &Arc<AtomicBool>) {
        let Some(entry) = self.folders.pin.iter().find(|e| e.name == name).cloned() else {
            return self.settle_install(name, Err(NOT_OFFICIAL.to_owned()));
        };
        let (source, download) = {
            let state = self.state.lock();
            (
                state.official_source.clone(),
                state.official_download.clone(),
            )
        };
        let download = download.unwrap_or_else(|| Arc::new(HttpDownload));
        let store = self.official_store();
        let me = self.me.clone();
        let watched = name.to_owned();
        let mut progress = move |received: u64, total: u64| {
            if let Some(service) = me.upgrade() {
                if let Some(run) = service.state.lock().installs.get_mut(&watched) {
                    run.phase = OfficialInstallPhase::Downloading { received, total };
                }
                service.env.notify();
            }
        };
        ardia_telemetry::counts::count("official_fetches");
        let fetched = official::fetch(
            &entry,
            &self.folders.pin,
            &store,
            source.as_deref(),
            download.as_ref(),
            cancel,
            &mut progress,
        );
        let fetched = match fetched {
            Ok(fetched) => fetched,
            Err(failure) => {
                ardia_telemetry::counts::count(match failure.code {
                    FetchCode::Offline => "official_fetch_offline",
                    FetchCode::Verify => "official_verify_failures",
                    _ => "official_fetch_failures",
                });
                log::warn!(
                    "[plugins] {name} wasn't downloaded ({:?}): {}",
                    failure.code,
                    failure.detail
                );
                return self.settle_install(name, Err(failure.code.reason().to_owned()));
            }
        };
        if cancel.load(Ordering::SeqCst) {
            return self.settle_install(name, Err(FetchCode::Cancelled.reason().to_owned()));
        }
        let Some(sha) = fetched
            .copy
            .file_name()
            .and_then(|s| s.to_str())
            .filter(|s| official::is_sha(s))
            .map(str::to_owned)
        else {
            return self.settle_install(name, Err(FetchCode::Failed.reason().to_owned()));
        };
        let candidate = self.folders.candidate_listing(&entry, &sha);
        if candidate.read.manifest.is_none() || candidate.hash.is_none() {
            let reason = candidate
                .read
                .problems
                .first()
                .cloned()
                .unwrap_or_else(|| "It can't load.".to_owned());
            return self.settle_install(name, Err(reason));
        }
        {
            let mut state = self.state.lock();
            if state.consent.is_some() {
                drop(state);
                return self.settle_install(name, Err(ALREADY_ASKING.to_owned()));
            }
            state.candidates.insert(name.to_owned(), candidate);
            if let Some(run) = state.installs.get_mut(name) {
                run.asking = true;
                run.phase = OfficialInstallPhase::Asking;
            }
        }
        if !self.request_consent(name, ConsentOwner::Settings) {
            let reason = if self.state.lock().consent.is_some() {
                ALREADY_ASKING
            } else {
                CONFIRM_REFUSED
            };
            self.state.lock().candidates.remove(name);
            self.settle_install(name, Err(reason.to_owned()));
        }
    }

    pub fn cancel_official_install(&self, name: &str) {
        let asking = {
            let state = self.state.lock();
            let Some(run) = state.installs.get(name) else {
                return;
            };
            run.cancel.store(true, Ordering::SeqCst);
            run.asking
        };
        if !asking {
            return;
        }
        let ours =
            self.state.lock().consent.as_ref().is_some_and(|request| {
                request.name == name && request.owner == ConsentOwner::Settings
            });
        if ours {
            self.close_install_consent(name, Err(FetchCode::Cancelled.reason().to_owned()));
        }
    }

    pub(super) fn install_candidate(&self, name: &str, hash: &str) -> Option<Listing> {
        self.state
            .lock()
            .candidates
            .get(name)
            .filter(|c| c.hash.as_deref() == Some(hash))
            .cloned()
    }

    pub(super) fn promote_candidate(
        &self,
        candidate: &Listing,
        approved: &str,
    ) -> Result<(), String> {
        let sha = official::sha_of_folder_id(&candidate.folder_id)
            .ok_or("It isn't an official plugin this Ardia pins.")?;
        let store = self.official_store();
        let copy = store
            .copy(&candidate.name, sha)
            .ok_or("Its download is gone or changed. Try again.")?;
        let text = official::read_manifest_text(&copy).ok_or("Its download is gone. Try again.")?;
        if approval_hash(&text, &candidate.folder_id) != approved {
            return Err("It changed since you approved it. Try again.".into());
        }
        if !store.activate(&candidate.name, sha) {
            return Err("It couldn't be switched to the new copy.".into());
        }
        self.rescan();
        Ok(())
    }

    pub(super) fn close_install_consent(&self, name: &str, result: Result<(), String>) {
        {
            let mut state = self.state.lock();
            if state.consent.as_ref().is_some_and(|c| c.name == name) {
                state.consent = None;
            }
            state.candidates.remove(name);
            if !state.installs.get(name).is_some_and(|run| run.asking) {
                return;
            }
        }
        self.settle_install(name, result);
    }

    fn settle_install(&self, name: &str, result: Result<(), String>) {
        let run = self.state.lock().installs.remove(name);
        if let Some(run) = run {
            for waiter in run.waiters {
                let _ = waiter.send(result.clone());
            }
        }
        self.env.notify();
    }
}
