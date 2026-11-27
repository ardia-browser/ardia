use crate::actions::{Action, ActionError, ChangeSet, Outcome, Topics};
use crate::ids::{IdGen, TabId, WindowId};
use crate::model::Millis;
use crate::persistence::DataDir;
use crate::persistence::documents;
use crate::persistence::session::{self, LoadOptions, LoadReport, SessionFiles};
use crate::state::BrowserState;
use parking_lot::{Condvar, Mutex, RwLock};
use std::collections::VecDeque;
use std::panic::{AssertUnwindSafe, catch_unwind};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Weak};
use std::thread::JoinHandle;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

pub const SAVE_DELAY: Duration = Duration::from_millis(800);
pub const COSMETIC_SAVE_DELAY: Duration = Duration::from_secs(10);
pub const RETRY_DELAY: Duration = Duration::from_secs(5);

pub fn now_ms() -> Millis {
    SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |d| {
        Millis::try_from(d.as_millis()).unwrap_or(Millis::MAX)
    })
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Interest {
    Topics(Topics),
    Tab(TabId),
    Window(WindowId),
}

impl Interest {
    pub fn wants(&self, changes: &ChangeSet) -> bool {
        match self {
            Interest::Topics(topics) => changes.topics.intersects(*topics),
            Interest::Tab(id) => changes.touches_tab(id.as_str()),
            Interest::Window(id) => changes.touches_window(id.as_str()),
        }
    }
}

#[derive(Clone, Debug)]
pub struct Update {
    pub revision: u64,
    pub changes: Arc<ChangeSet>,
    pub state: Arc<BrowserState>,
}

type Listener = Arc<dyn Fn(&Update) + Send + Sync>;

#[derive(Default)]
struct Listeners {
    next: u64,
    entries: Vec<(u64, Interest, Listener)>,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
struct Dirty {
    session: bool,
    downloads: bool,
    bookmarks: bool,
    air_traffic: bool,
}

impl Dirty {
    fn of(changes: &ChangeSet) -> Dirty {
        Dirty {
            session: changes.persists_session(),
            downloads: changes.topics.intersects(Topics::DOWNLOADS),
            bookmarks: changes.topics.intersects(Topics::BOOKMARKS),
            air_traffic: changes.topics.intersects(Topics::AIR_TRAFFIC),
        }
    }

    fn any(self) -> bool {
        self.session || self.downloads || self.bookmarks || self.air_traffic
    }

    fn union(self, other: Dirty) -> Dirty {
        Dirty {
            session: self.session || other.session,
            downloads: self.downloads || other.downloads,
            bookmarks: self.bookmarks || other.bookmarks,
            air_traffic: self.air_traffic || other.air_traffic,
        }
    }
}

#[derive(Default)]
struct SaveQueue {
    dirty: Dirty,
    saving: bool,
    stopped: bool,
    due: Option<Instant>,
    flush_requested: u64,
    flush_done: u64,
    shutdown: bool,
    saves: u64,
}

struct Shared {
    state: ardia_profile::strict::RwLock<Arc<BrowserState>>,
    revision: AtomicU64,
    ids: IdGen,
    listeners: RwLock<Listeners>,
    pending: Mutex<VecDeque<Update>>,
    delivering: Mutex<()>,
    queue: Mutex<SaveQueue>,
    wake: Condvar,
    saved: Condvar,
    last_error: Mutex<Option<String>>,
    persists: bool,
}

pub struct BrowserStore {
    shared: Arc<Shared>,
    persister: Option<JoinHandle<()>>,
}

#[must_use = "the listener is removed when the subscription is dropped"]
pub struct Subscription {
    shared: Weak<Shared>,
    id: u64,
}

impl Drop for Subscription {
    fn drop(&mut self) {
        let Some(shared) = self.shared.upgrade() else {
            return;
        };
        let removed: Vec<(u64, Interest, Listener)> = {
            let mut listeners = shared.listeners.write();
            let (gone, kept) = std::mem::take(&mut listeners.entries)
                .into_iter()
                .partition(|(id, _, _)| *id == self.id);
            listeners.entries = kept;
            gone
        };
        drop(removed);
    }
}

pub fn load_state(
    dir: &DataDir,
    options: LoadOptions,
    now: Millis,
) -> (BrowserState, LoadReport, SessionFiles) {
    let loaded = session::load(dir, options, now, |data| BrowserState::hydrate(data, now));
    let mut state = loaded.value;
    let (downloads, refused) = documents::load_downloads(dir);
    state.downloads = Arc::new(downloads);
    state.air_traffic = Arc::new(documents::load_air_traffic(dir));
    state.bookmarks = Arc::new(
        documents::load_bookmarks(dir, now)
            .into_iter()
            .map(|(k, t)| (k, Arc::new(t)))
            .collect(),
    );
    let mut files = loaded.files;
    files.downloads_aside = refused;
    (state, loaded.report, files)
}

impl BrowserStore {
    fn with_shared(state: BrowserState, ids: IdGen, persists: bool) -> Arc<Shared> {
        Arc::new(Shared {
            state: ardia_profile::strict::RwLock::new(Arc::new(state)),
            revision: AtomicU64::new(0),
            ids,
            listeners: RwLock::new(Listeners::default()),
            pending: Mutex::new(VecDeque::new()),
            delivering: Mutex::new(()),
            queue: Mutex::new(SaveQueue::default()),
            wake: Condvar::new(),
            saved: Condvar::new(),
            last_error: Mutex::new(None),
            persists,
        })
    }

    pub fn in_memory(state: BrowserState, ids: IdGen) -> Self {
        BrowserStore {
            shared: Self::with_shared(state, ids, false),
            persister: None,
        }
    }

    pub fn open(dir: DataDir, options: LoadOptions) -> std::io::Result<(BrowserStore, LoadReport)> {
        let now = now_ms();
        let (state, report, files) = load_state(&dir, options, now);
        let shared = Self::with_shared(state, IdGen::new(now), true);
        let worker = Arc::clone(&shared);
        let persister = std::thread::Builder::new()
            .name("ardia-state-save".into())
            .spawn(move || persist_loop(&worker, files))?;
        Ok((
            BrowserStore {
                shared,
                persister: Some(persister),
            },
            report,
        ))
    }

    pub fn ids(&self) -> &IdGen {
        &self.shared.ids
    }

    pub fn snapshot(&self) -> Arc<BrowserState> {
        Arc::clone(&self.shared.state.read())
    }

    pub fn read<R>(&self, f: impl FnOnce(&BrowserState) -> R) -> R {
        f(&self.snapshot())
    }

    pub fn revision(&self) -> u64 {
        self.shared.revision.load(Ordering::Acquire)
    }

    pub fn subscribe(
        &self,
        interest: Interest,
        listener: impl Fn(&Update) + Send + Sync + 'static,
    ) -> Subscription {
        let mut listeners = self.shared.listeners.write();
        listeners.next += 1;
        let id = listeners.next;
        listeners.entries.push((id, interest, Arc::new(listener)));
        Subscription {
            shared: Arc::downgrade(&self.shared),
            id,
        }
    }

    pub fn dispatch(&self, action: Action) -> Result<Outcome, ActionError> {
        self.dispatch_at(action, now_ms())
    }

    pub fn dispatch_at(&self, action: Action, now: Millis) -> Result<Outcome, ActionError> {
        let outcome = {
            let mut state = self.shared.state.write();
            let (next, outcome) = state.reduce(action, now, &self.shared.ids)?;
            if outcome.changes.is_empty() {
                return Ok(outcome);
            }
            let next = Arc::new(next);
            *state = Arc::clone(&next);
            self.schedule_save(&outcome.changes);
            let revision = self.shared.revision.fetch_add(1, Ordering::AcqRel) + 1;
            self.shared.pending.lock().push_back(Update {
                revision,
                changes: Arc::new(outcome.changes.clone()),
                state: next,
            });
            outcome
        };
        self.deliver();
        Ok(outcome)
    }

    pub fn replace(&self, state: BrowserState) {
        {
            let mut current = self.shared.state.write();
            let next = Arc::new(state);
            *current = Arc::clone(&next);
            self.mark_dirty(
                Dirty {
                    session: true,
                    downloads: true,
                    bookmarks: true,
                    air_traffic: true,
                },
                SAVE_DELAY,
            );
            let revision = self.shared.revision.fetch_add(1, Ordering::AcqRel) + 1;
            let changes = ChangeSet {
                topics: Topics::ALL,
                cosmetic_only: false,
                ..ChangeSet::default()
            };
            self.shared.pending.lock().push_back(Update {
                revision,
                changes: Arc::new(changes),
                state: next,
            });
        }
        self.deliver();
    }

    fn schedule_save(&self, changes: &ChangeSet) {
        let dirty = Dirty::of(changes);
        let delay = if dirty.session
            && changes.cosmetic_only
            && !dirty.downloads
            && !dirty.bookmarks
            && !dirty.air_traffic
        {
            COSMETIC_SAVE_DELAY
        } else {
            SAVE_DELAY
        };
        self.mark_dirty(dirty, delay);
    }

    fn mark_dirty(&self, dirty: Dirty, delay: Duration) {
        if !self.shared.persists || !dirty.any() {
            return;
        }
        let mut queue = self.shared.queue.lock();
        queue.dirty = queue.dirty.union(dirty);
        let due = Instant::now() + delay;
        queue.due = Some(queue.due.map_or(due, |d| d.min(due)));
        drop(queue);
        self.shared.wake.notify_one();
    }

    fn deliver(&self) {
        let shared = &self.shared;
        loop {
            let Some(guard) = shared.delivering.try_lock() else {
                return;
            };
            loop {
                let next = shared.pending.lock().pop_front();
                let Some(update) = next else { break };
                let listeners: Vec<Listener> = shared
                    .listeners
                    .read()
                    .entries
                    .iter()
                    .filter(|(_, interest, _)| interest.wants(&update.changes))
                    .map(|(_, _, l)| Arc::clone(l))
                    .collect();
                for listener in listeners {
                    let _ = catch_unwind(AssertUnwindSafe(|| listener(&update)));
                }
            }
            drop(guard);
            if shared.pending.lock().is_empty() {
                return;
            }
        }
    }

    pub fn has_unsaved_changes(&self) -> bool {
        let queue = self.shared.queue.lock();
        self.shared.persists && (queue.dirty.any() || queue.saving)
    }

    pub fn saves(&self) -> u64 {
        self.shared.queue.lock().saves
    }

    pub fn last_save_error(&self) -> Option<String> {
        self.shared.last_error.lock().clone()
    }

    pub fn flush(&self, timeout: Duration) -> bool {
        if self.persister.is_none() {
            return true;
        }
        let deadline = Instant::now() + timeout;
        let mut queue = self.shared.queue.lock();
        if queue.stopped {
            return !queue.dirty.any() && !queue.saving;
        }
        if !queue.dirty.any() && !queue.saving {
            return true;
        }
        queue.flush_requested += 1;
        let ticket = queue.flush_requested;
        self.shared.wake.notify_one();
        while queue.flush_done < ticket {
            if self
                .shared
                .saved
                .wait_until(&mut queue, deadline)
                .timed_out()
            {
                return queue.flush_done >= ticket;
            }
        }
        !queue.dirty.any()
    }
}

impl Drop for BrowserStore {
    fn drop(&mut self) {
        let Some(persister) = self.persister.take() else {
            return;
        };
        self.shared.queue.lock().shutdown = true;
        self.shared.wake.notify_one();
        let _ = persister.join();
    }
}

fn save_dirty(
    dir: &DataDir,
    files: &mut SessionFiles,
    state: &BrowserState,
    dirty: Dirty,
    now: Millis,
) -> (Dirty, Option<String>) {
    let mut failed = Dirty::default();
    let mut error = None;
    let mut note = |ok: Result<(), String>, flag: &mut bool| {
        if let Err(e) = ok {
            *flag = true;
            error = Some(e);
        }
    };
    if dirty.session {
        note(
            files
                .save(&state.session_json(), now)
                .map_err(|e| format!("session: {e}")),
            &mut failed.session,
        );
    }
    if dirty.downloads {
        let kept = if files.downloads_aside {
            dir.keep_aside(documents::DOWNLOADS, now)
                .map(|_| files.downloads_aside = false)
        } else {
            Ok(())
        };
        note(
            kept.and_then(|_| documents::save_downloads(dir, &state.downloads).map(|_| ()))
                .map_err(|e| format!("downloads: {e}")),
            &mut failed.downloads,
        );
    }
    if dirty.bookmarks {
        note(
            documents::save_bookmarks(dir, state.bookmarks.iter().map(|(k, t)| (k, &**t)))
                .map(|_| ())
                .map_err(|e| format!("bookmarks: {e}")),
            &mut failed.bookmarks,
        );
    }
    if dirty.air_traffic {
        note(
            documents::save_air_traffic(dir, &state.air_traffic)
                .map(|_| ())
                .map_err(|e| format!("air traffic: {e}")),
            &mut failed.air_traffic,
        );
    }
    (failed, error)
}

fn persist_loop(shared: &Shared, files: SessionFiles) {
    let ended = catch_unwind(AssertUnwindSafe(|| save_until_shutdown(shared, files)));
    let mut queue = shared.queue.lock();
    queue.stopped = true;
    queue.saving = false;
    queue.flush_done = queue.flush_requested;
    drop(queue);
    if ended.is_err() {
        *shared.last_error.lock() = Some("the save thread stopped".to_owned());
    }
    shared.saved.notify_all();
}

fn save_until_shutdown(shared: &Shared, mut files: SessionFiles) {
    let dir = files.dir().clone();
    loop {
        let (dirty, ticket, stopping) = {
            let mut queue = shared.queue.lock();
            loop {
                let flushing = queue.flush_requested > queue.flush_done;
                if queue.shutdown || flushing {
                    break;
                }
                match queue.due {
                    Some(due) if Instant::now() >= due => break,
                    Some(due) => {
                        shared.wake.wait_until(&mut queue, due);
                    }
                    None => shared.wake.wait(&mut queue),
                }
            }
            queue.due = None;
            queue.saving = queue.dirty.any();
            (
                std::mem::take(&mut queue.dirty),
                queue.flush_requested,
                queue.shutdown,
            )
        };
        let failed = if dirty.any() {
            let state = Arc::clone(&shared.state.read());
            let saved = catch_unwind(AssertUnwindSafe(|| {
                let _span = ardia_profile::span(ardia_profile::Span::SessionSave);
                save_dirty(&dir, &mut files, &state, dirty, now_ms())
            }));
            let (failed, error) =
                saved.unwrap_or_else(|_| (dirty, Some("saving panicked".to_owned())));
            *shared.last_error.lock() = error;
            failed
        } else {
            Dirty::default()
        };
        let mut queue = shared.queue.lock();
        queue.saving = false;
        if dirty.any() {
            queue.saves += 1;
        }
        queue.flush_done = queue.flush_done.max(ticket);
        if failed.any() && !stopping {
            queue.dirty = queue.dirty.union(failed);
            let retry = Instant::now() + RETRY_DELAY;
            queue.due = Some(queue.due.map_or(retry, |d| d.min(retry)));
        }
        let finished = stopping && (!queue.dirty.any() || failed.any());
        drop(queue);
        shared.saved.notify_all();
        if finished {
            return;
        }
    }
}
