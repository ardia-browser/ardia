use std::collections::BTreeSet;

use ardia_ui::plugins::model::{PluginPrograms, ProgramsStatus};

use super::super::programs::{self, Places, Program};
use super::PluginService;

pub const NO_PLACES: &str = "this copy of Ardia doesn't put programs on PATH";
pub const NO_PROGRAMS: &str = "This plugin has no programs.";
pub const LINKING_NOW: &str = "Its programs are being put on PATH now.";

pub type ProgramJob = Box<dyn FnOnce() + Send>;
type Offered = (String, String, Vec<Program>, String, Option<String>);

#[derive(Clone, Debug)]
pub struct ProgramsEntry {
    pub hash: String,
    pub request: u64,
    pub status: ProgramsStatus,
}

struct LinkJob {
    name: String,
    listing: super::super::folders::Listing,
    hash: String,
    version: Option<String>,
    programs: Vec<Program>,
    request: u64,
    places: Places,
}

impl PluginService {
    pub fn set_program_places(&self, places: Result<Places, String>) {
        self.state.lock().program_places = Some(places);
    }

    fn queue_program_job(&self, job: ProgramJob) {
        let mut state = self.state.lock();
        let queue = state.program_jobs.get_or_insert_with(|| {
            let (send, jobs) = std::sync::mpsc::channel::<ProgramJob>();
            std::thread::Builder::new()
                .name("plugin-programs".into())
                .spawn(move || {
                    for job in jobs {
                        job();
                    }
                })
                .ok();
            send
        });
        if let Err(std::sync::mpsc::SendError(job)) = queue.send(job) {
            state.program_jobs = None;
            drop(state);
            std::thread::spawn(job);
        }
    }

    fn places(&self) -> Result<Places, String> {
        self.state
            .lock()
            .program_places
            .clone()
            .unwrap_or_else(|| Err(NO_PLACES.to_owned()))
    }

    fn with_programs(&self) -> Vec<Offered> {
        let state = self.state.lock();
        state
            .active_names()
            .into_iter()
            .filter_map(|name| {
                let manifest = state.active(&name)?;
                if manifest.contributes.programs.is_empty() {
                    return None;
                }
                let hash = state.listings.get(&name)?.hash.clone()?;
                let programs = manifest
                    .contributes
                    .programs
                    .iter()
                    .map(|p| Program {
                        name: p.name.clone(),
                        path: p.path.clone(),
                    })
                    .collect();
                Some((
                    name,
                    manifest.title.clone(),
                    programs,
                    hash,
                    manifest.version.clone(),
                ))
            })
            .collect()
    }

    pub(super) fn reconcile_programs(&self) {
        let active = self.with_programs();
        let names: BTreeSet<String> = active.iter().map(|(n, ..)| n.clone()).collect();
        let places = self.places();
        let official: BTreeSet<String> = self.folders.pin.iter().map(|e| e.name.clone()).collect();
        let (withdrawn, sweep) = {
            let mut state = self.state.lock();
            let withdrawn: Vec<String> = state
                .programs
                .keys()
                .filter(|n| !names.contains(*n))
                .cloned()
                .collect();
            for name in &withdrawn {
                state.programs.remove(name);
            }
            let sweep = places.is_ok() && !state.programs_swept;
            if sweep {
                state.programs_swept = true;
            }
            (withdrawn, sweep)
        };
        if let Ok(places) = &places {
            let places = places.clone();
            let keep_names = names;
            self.queue_program_job(Box::new(move || {
                if sweep {
                    programs::withdraw_all_but(&keep_names, &places, &official);
                }
                for name in withdrawn {
                    programs::withdraw(&name, &places, official.contains(&name));
                }
            }));
        }
        for (name, _, programs, hash, version) in active {
            let stale = self
                .state
                .lock()
                .programs
                .get(&name)
                .is_none_or(|entry| entry.hash != hash);
            if stale {
                self.link_programs(&name, programs, hash, version);
            }
        }
    }

    fn link_programs(
        &self,
        name: &str,
        programs: Vec<Program>,
        hash: String,
        version: Option<String>,
    ) {
        let claims = programs::registry_claims(&self.folders.pin);
        let (request, listing) = {
            let mut state = self.state.lock();
            state.next_program_request += 1;
            let request = state.next_program_request;
            state.programs.insert(
                name.to_owned(),
                ProgramsEntry {
                    hash: hash.clone(),
                    request,
                    status: ProgramsStatus::Linking,
                },
            );
            (request, state.listings.get(name).cloned())
        };
        let Some(listing) = listing else {
            return self.finish_link(name, request, Err("it changed while linking".into()));
        };
        let built_in = listing.official && !listing.legacy;
        if let Some(reason) = programs
            .iter()
            .find_map(|p| programs::registry_refusal(&claims, &p.name, name, built_in))
        {
            return self.finish_link(name, request, Err(reason));
        }
        let places = match self.places() {
            Ok(places) => places,
            Err(reason) => return self.finish_link(name, request, Err(reason)),
        };
        let job = LinkJob {
            name: name.to_owned(),
            listing,
            hash,
            version,
            programs,
            request,
            places,
        };
        let me = self.me.clone();
        self.queue_program_job(Box::new(move || {
            let Some(service) = me.upgrade() else {
                return;
            };
            let outcome = service
                .folders
                .approved_folder(&job.listing, &job.hash)
                .and_then(|folder| {
                    programs::install(
                        &job.name,
                        &folder,
                        &job.listing.folder_id,
                        &job.hash,
                        job.version.as_deref(),
                        &job.programs,
                        &job.places,
                    )
                })
                .map(|linked| ProgramsStatus::Linked {
                    linked: linked.linked,
                    refused: linked
                        .refused
                        .into_iter()
                        .map(|(program, refusal)| (program, refusal.reason))
                        .collect(),
                    bin_dir: job.places.bin_dir.display().to_string(),
                });
            service.finish_link(&job.name, job.request, outcome);
        }));
    }

    fn finish_link(&self, name: &str, request: u64, outcome: Result<ProgramsStatus, String>) {
        {
            let mut state = self.state.lock();
            let Some(entry) = state
                .programs
                .get_mut(name)
                .filter(|e| e.request == request)
            else {
                return;
            };
            match &outcome {
                Ok(ProgramsStatus::Linked { refused, .. }) if !refused.is_empty() => {
                    ardia_telemetry::counts::count("program_link_failures");
                    ardia_telemetry::counts::add("program_link_cause_other", refused.len() as u64);
                }
                Ok(_) => ardia_telemetry::counts::count("program_links"),
                Err(_) => {
                    ardia_telemetry::counts::count("program_link_failures");
                    ardia_telemetry::counts::count("program_link_cause_other");
                }
            }
            entry.status = outcome.unwrap_or_else(|reason| ProgramsStatus::Failed { reason });
        }
        self.env.notify();
    }

    pub(super) fn programs_view(&self) -> Vec<PluginPrograms> {
        let active = self.with_programs();
        let state = self.state.lock();
        active
            .into_iter()
            .map(|(name, title, programs, hash, _)| PluginPrograms {
                status: state
                    .programs
                    .get(&name)
                    .filter(|e| e.hash == hash)
                    .map_or(ProgramsStatus::Linking, |e| e.status.clone()),
                plugin: name,
                title,
                programs: programs.into_iter().map(|p| p.name).collect(),
            })
            .collect()
    }

    pub(super) fn relink_plugin_programs(&self, plugin: &str) -> Result<(), String> {
        {
            let mut state = self.state.lock();
            let has_programs = state
                .active(plugin)
                .is_some_and(|m| !m.contributes.programs.is_empty());
            if !has_programs {
                return Err(NO_PROGRAMS.to_owned());
            }
            if state
                .programs
                .get(plugin)
                .is_some_and(|e| e.status == ProgramsStatus::Linking)
            {
                return Err(LINKING_NOW.to_owned());
            }
            state.programs.remove(plugin);
        }
        self.reconcile_programs();
        self.env.notify();
        Ok(())
    }

    pub fn linked_programs(&self, plugin: &str) -> Vec<ardia_ui::host::LinkedProgram> {
        let Some((_, _, _, hash, version)) = self
            .with_programs()
            .into_iter()
            .find(|(name, ..)| name == plugin)
        else {
            return Vec::new();
        };
        let state = self.state.lock();
        match state.programs.get(plugin).filter(|e| e.hash == hash) {
            Some(ProgramsEntry {
                status: ProgramsStatus::Linked { linked, .. },
                ..
            }) => linked
                .iter()
                .map(|program| ardia_ui::host::LinkedProgram {
                    program: program.clone(),
                    version: version.clone(),
                })
                .collect(),
            _ => Vec::new(),
        }
    }

    pub fn remove_plugin_programs(&self, plugin: &str) -> bool {
        if self.state.lock().programs.remove(plugin).is_some() {
            ardia_telemetry::counts::count("program_unlinks");
        }
        self.places()
            .map(|places| programs::remove(plugin, &places))
            .unwrap_or(true)
    }
}
