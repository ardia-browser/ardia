use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet, VecDeque};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::time::Duration;

use ardia_ui::host_data::HostTopics;
use ardia_ui::settings::data::SettingsQuery;
use parking_lot::Mutex;

use crate::control_approvals::StoredApproval;
use crate::control_peer::{ControlPeer, HALF_HOUR_SECONDS, PeerToken, Policy, Verdict, plain};
use crate::coordinator::{AppCoordinator, ShellEffect};

pub const ASK_SECONDS: f64 = 60.0;
pub const MAX_WAITING: usize = 8;
pub const QUIET_AFTER_REFUSAL: f64 = 30.0;
pub const TICK: Duration = Duration::from_secs(1);
pub const APPROVALS_RECHECK: Duration = Duration::from_secs(15);
pub const TITLE: &str = "A program wants to control Ardia";
pub const WHAT_IT_CAN_DO: &str = "It could open, read and change your tabs and pages, with your logins, as the ardia command can.";
pub const ONLY_ONCE: &str =
    "Ardia can't recognize this program next time, so it can only be allowed once.";
pub const REMEMBER_CHOICES: &[(&str, Outcome)] = &[
    ("Allow Once", Outcome::Once),
    ("Allow for 30 Minutes", Outcome::HalfHour),
    ("Always Allow", Outcome::Always),
    ("Don't Allow", Outcome::Deny),
];
pub const ONCE_CHOICES: &[(&str, Outcome)] = &[
    ("Allow Once", Outcome::Once),
    ("Don't Allow", Outcome::Deny),
];

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Outcome {
    Once,
    HalfHour,
    Always,
    Deny,
    Unshown,
    Timeout,
    Left,
    Stopped,
    Full,
    Quiet,
    Unsaved,
}

pub fn doorbell_outcome_field(outcome: Outcome) -> Option<&'static str> {
    Some(match outcome {
        Outcome::Once => "cli_socket_doorbell_once",
        Outcome::HalfHour => "cli_socket_doorbell_half_hour",
        Outcome::Always => "cli_socket_doorbell_always",
        Outcome::Deny => "cli_socket_doorbell_deny",
        Outcome::Unshown => "cli_socket_doorbell_unshown",
        Outcome::Timeout => "cli_socket_doorbell_timeout",
        Outcome::Left => "cli_socket_doorbell_left",
        Outcome::Stopped => "cli_socket_doorbell_stopped",
        Outcome::Unsaved => "cli_socket_doorbell_unsaved",
        Outcome::Full | Outcome::Quiet => return None,
    })
}

pub fn refusal(outcome: Outcome) -> &'static str {
    match outcome {
        Outcome::Deny | Outcome::Quiet => {
            "You chose Don't Allow when Ardia asked whether this program may control it."
        }
        Outcome::Timeout => {
            "Ardia asked whether this program may control it, and nobody answered in time."
        }
        Outcome::Unshown => {
            "Ardia has to ask before this program may control it, and nobody can see the question (no Ardia window is on screen, or Ardia runs in the background)."
        }
        Outcome::Full => {
            "Too many programs are connected to Ardia or waiting to be let in. Try again in a minute."
        }
        Outcome::Stopped => "Control was turned off before anyone answered.",
        _ => "Ardia didn't let this program control it.",
    }
}

pub fn refusal_line(outcome: Outcome) -> serde_json::Value {
    serde_json::json!({ "id": null, "error": { "code": "refused", "message": refusal(outcome) } })
}

const CONTROLS: &[(char, char)] = &[
    ('\u{0000}', '\u{001f}'),
    ('\u{007f}', '\u{009f}'),
    ('\u{061c}', '\u{061c}'),
    ('\u{200b}', '\u{200f}'),
    ('\u{2028}', '\u{202e}'),
    ('\u{2060}', '\u{206f}'),
    ('\u{feff}', '\u{feff}'),
];

pub fn prompt_text(text: &str, limit: usize) -> String {
    let kept: Vec<char> = text
        .chars()
        .filter(|c| !CONTROLS.iter().any(|(lo, hi)| (lo..=hi).contains(&c)))
        .collect();
    if kept.len() > limit {
        let mut cut: String = kept[..limit.saturating_sub(1)].iter().collect();
        cut.push('…');
        cut
    } else {
        kept.into_iter().collect()
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct Question {
    pub ask: u64,
    pub name: String,
    pub signed_by: String,
    pub path: String,
    pub identifier: String,
    pub remember: bool,
    pub deadline: f64,
}

impl Question {
    fn of(ask: &Ask) -> Self {
        Self {
            ask: ask.id,
            name: ask.peer.name(),
            signed_by: ask.peer.signed_by(),
            path: ask
                .peer
                .path
                .as_deref()
                .map(|p| plain(p, 300))
                .unwrap_or_default(),
            identifier: ask
                .peer
                .identifier
                .as_deref()
                .map(|i| plain(i, 120))
                .unwrap_or_default(),
            remember: ask.key.is_some(),
            deadline: ask.deadline,
        }
    }

    pub fn choices(&self) -> &'static [(&'static str, Outcome)] {
        if self.remember {
            REMEMBER_CHOICES
        } else {
            ONCE_CHOICES
        }
    }

    pub fn titles(&self) -> Vec<&'static str> {
        self.choices().iter().map(|(title, _)| *title).collect()
    }

    pub fn cancel_choice(&self) -> usize {
        self.choices().len() - 1
    }

    pub fn message(&self) -> String {
        let who = format!(
            "“{}”: {}",
            prompt_text(&self.name, 64),
            prompt_text(&self.signed_by, 120)
        );
        let path = prompt_text(&self.path, 300);
        let who = if path.is_empty() {
            who
        } else {
            format!("{who}\n{path}")
        };
        let mut lines = vec![who, WHAT_IT_CAN_DO.to_owned()];
        if !self.remember {
            lines.push(ONLY_ONCE.to_owned());
        }
        lines.join("\n\n")
    }

    pub fn answer_for(&self, result: PromptResult) -> Option<Outcome> {
        match result {
            PromptResult::Unshown => Some(Outcome::Unshown),
            PromptResult::Chose(choice) => choice
                .and_then(|i| self.choices().get(i))
                .map(|(_, outcome)| *outcome),
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PromptResult {
    Chose(Option<usize>),
    Unshown,
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct Grant {
    pub key: Option<String>,
    pub until: Option<f64>,
}

#[derive(Clone, Debug)]
struct Ask {
    id: u64,
    key: Option<String>,
    process: String,
    peer: ControlPeer,
    token: PeerToken,
    deadline: f64,
    connections: BTreeSet<u64>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Ended {
    pub ask: u64,
    pub outcome: Outcome,
    pub admit: bool,
    pub grant: Grant,
    pub connections: Vec<u64>,
}

#[derive(Clone, Debug, PartialEq)]
pub enum Ring {
    Refused(Outcome),
    Joined(u64),
    Asked(Question),
}

#[derive(Debug, Default)]
pub struct Doorbell {
    asks: BTreeMap<u64, Ask>,
    waiting: HashMap<u64, u64>,
    quiet: HashMap<String, f64>,
    next: u64,
}

impl Doorbell {
    pub fn ring(
        &mut self,
        connection: u64,
        peer: &ControlPeer,
        key: Option<String>,
        token: PeerToken,
        now: f64,
    ) -> Ring {
        self.quiet.retain(|_, until| *until > now);
        if key.as_ref().is_some_and(|key| self.quiet.contains_key(key)) {
            return Ring::Refused(Outcome::Quiet);
        }
        if self.waiting.len() >= MAX_WAITING {
            return Ring::Refused(Outcome::Full);
        }
        let process = token.process();
        if let Some(shared) = self
            .asks
            .values_mut()
            .find(|a| a.process == process && a.key == key && &a.peer == peer)
        {
            shared.connections.insert(connection);
            self.waiting.insert(connection, shared.id);
            return Ring::Joined(shared.id);
        }
        self.next += 1;
        let ask = Ask {
            id: self.next,
            key,
            process,
            peer: peer.clone(),
            token,
            deadline: now + ASK_SECONDS,
            connections: BTreeSet::from([connection]),
        };
        let question = Question::of(&ask);
        self.waiting.insert(connection, ask.id);
        self.asks.insert(ask.id, ask);
        Ring::Asked(question)
    }

    pub fn leave(&mut self, connection: u64) {
        if let Some(id) = self.waiting.remove(&connection)
            && let Some(ask) = self.asks.get_mut(&id)
        {
            ask.connections.remove(&connection);
        }
    }

    pub fn waiting_count(&self) -> usize {
        self.waiting.len()
    }

    pub fn open_asks(&self) -> Vec<u64> {
        self.asks.keys().copied().collect()
    }

    pub fn answer(
        &mut self,
        id: u64,
        outcome: Outcome,
        now: f64,
        alive: impl Fn(&PeerToken) -> bool,
        save: impl FnOnce(StoredApproval) -> bool,
    ) -> (bool, Vec<Ended>) {
        let mut out = Vec::new();
        let answerable = matches!(
            outcome,
            Outcome::Once | Outcome::HalfHour | Outcome::Always | Outcome::Deny | Outcome::Unshown
        );
        let Some(ask) = self.asks.get(&id).cloned().filter(|_| answerable) else {
            return (false, out);
        };
        if ask.connections.is_empty() || !alive(&ask.token) {
            out.extend(self.end(id, Outcome::Left, false, Grant::default()));
            return (false, out);
        }
        if ask.deadline <= now {
            out.extend(self.end(id, Outcome::Timeout, false, Grant::default()));
            self.quiet_all(ask.key.as_deref(), Outcome::Timeout, now, &mut out);
            return (false, out);
        }
        match outcome {
            Outcome::Deny => {
                out.extend(self.end(id, Outcome::Deny, false, Grant::default()));
                self.quiet_all(ask.key.as_deref(), Outcome::Deny, now, &mut out);
                return (true, out);
            }
            Outcome::Unshown => {
                out.extend(self.end(id, Outcome::Unshown, false, Grant::default()));
                return (true, out);
            }
            Outcome::Once => {
                out.extend(self.end(id, Outcome::Once, true, Grant::default()));
                return (true, out);
            }
            _ => {}
        }
        let until = (outcome == Outcome::HalfHour).then_some(now + HALF_HOUR_SECONDS);
        let saved = ask
            .key
            .as_deref()
            .filter(|key| save(ask.peer.approval(key, now, until)));
        let Some(key) = saved else {
            out.extend(self.end(id, Outcome::Unsaved, true, Grant::default()));
            return (true, out);
        };
        let grant = Grant {
            key: Some(key.to_owned()),
            until,
        };
        out.extend(self.end(id, outcome, true, grant.clone()));
        let others: Vec<u64> = self
            .asks
            .values()
            .filter(|a| a.key.as_deref() == Some(key))
            .map(|a| a.id)
            .collect();
        for other in others {
            let live = self
                .asks
                .get(&other)
                .is_some_and(|a| a.deadline > now && !a.connections.is_empty() && alive(&a.token));
            if live {
                out.extend(self.end(other, outcome, true, grant.clone()));
            } else if self.asks.get(&other).is_some_and(|a| a.deadline <= now) {
                out.extend(self.end(other, Outcome::Timeout, false, Grant::default()));
            } else {
                out.extend(self.end(other, Outcome::Left, false, Grant::default()));
            }
        }
        (true, out)
    }

    pub fn check(&mut self, now: f64, alive: impl Fn(&PeerToken) -> bool) -> Vec<Ended> {
        let mut out = Vec::new();
        let asks: Vec<Ask> = self.asks.values().cloned().collect();
        for ask in asks {
            if !self.asks.contains_key(&ask.id) {
                continue;
            }
            if ask.connections.is_empty() || !alive(&ask.token) {
                out.extend(self.end(ask.id, Outcome::Left, false, Grant::default()));
            } else if ask.deadline <= now {
                out.extend(self.end(ask.id, Outcome::Timeout, false, Grant::default()));
                self.quiet_all(ask.key.as_deref(), Outcome::Timeout, now, &mut out);
            }
        }
        out
    }

    pub fn stop(&mut self) -> Vec<Ended> {
        #[expect(
            clippy::needless_collect,
            reason = "the ids are copied so self.end can mutate the asks"
        )]
        let ids: Vec<u64> = self.asks.keys().copied().collect();
        let out = ids
            .into_iter()
            .filter_map(|id| self.end(id, Outcome::Stopped, false, Grant::default()))
            .collect();
        self.waiting.clear();
        self.quiet.clear();
        out
    }

    fn quiet_all(&mut self, key: Option<&str>, outcome: Outcome, now: f64, out: &mut Vec<Ended>) {
        let Some(key) = key else {
            return;
        };
        self.quiet.insert(key.to_owned(), now + QUIET_AFTER_REFUSAL);
        let same: Vec<u64> = self
            .asks
            .values()
            .filter(|a| a.key.as_deref() == Some(key))
            .map(|a| a.id)
            .collect();
        for id in same {
            out.extend(self.end(id, outcome, false, Grant::default()));
        }
    }

    fn end(&mut self, id: u64, outcome: Outcome, admit: bool, grant: Grant) -> Option<Ended> {
        let ask = self.asks.remove(&id)?;
        let connections: Vec<u64> = ask
            .connections
            .into_iter()
            .filter(|c| self.waiting.remove(c).is_some())
            .collect();
        Some(Ended {
            ask: id,
            outcome,
            admit,
            grant,
            connections,
        })
    }
}

#[derive(Debug, Default)]
pub struct PromptQueue {
    queued: VecDeque<Question>,
    showing: Option<Question>,
    ended: HashSet<u64>,
}

#[derive(Clone, Debug, PartialEq)]
pub enum PromptStep {
    Show(Question),
    Dismiss(u64),
    Answer(u64, Outcome),
}

impl PromptQueue {
    pub fn asked(&mut self, question: Question, now: f64) -> Vec<PromptStep> {
        self.queued.push_back(question);
        self.pump(now)
    }

    pub fn ended(&mut self, ask: u64) -> Vec<PromptStep> {
        if let Some(at) = self.queued.iter().position(|q| q.ask == ask) {
            self.queued.remove(at);
            return Vec::new();
        }
        if self.showing.as_ref().is_some_and(|q| q.ask == ask) && self.ended.insert(ask) {
            return vec![PromptStep::Dismiss(ask)];
        }
        Vec::new()
    }

    pub fn answered(&mut self, ask: u64, result: PromptResult, now: f64) -> Vec<PromptStep> {
        let Some(question) = self.showing.take_if(|q| q.ask == ask) else {
            return Vec::new();
        };
        let mut steps = Vec::new();
        if !self.ended.remove(&ask)
            && let Some(outcome) = question.answer_for(result)
        {
            steps.push(PromptStep::Answer(ask, outcome));
        }
        steps.extend(self.pump(now));
        steps
    }

    pub fn showing(&self) -> Option<u64> {
        self.showing.as_ref().map(|q| q.ask)
    }

    fn pump(&mut self, now: f64) -> Vec<PromptStep> {
        if self.showing.is_some() {
            return Vec::new();
        }
        while let Some(next) = self.queued.pop_front() {
            if next.deadline <= now {
                continue;
            }
            self.showing = Some(next.clone());
            return vec![PromptStep::Show(next)];
        }
        Vec::new()
    }
}

pub enum Admission {
    Open(Grant),
    Refused(Outcome),
}

pub trait PeerSource: Send + Sync {
    fn identify(&self, fd: std::os::fd::RawFd) -> Option<(ControlPeer, PeerToken)>;
    fn alive(&self, token: &PeerToken) -> bool;
}

struct SystemPeers;

impl PeerSource for SystemPeers {
    fn identify(&self, fd: std::os::fd::RawFd) -> Option<(ControlPeer, PeerToken)> {
        let token = crate::control_peer::peer_token(fd)?;
        Some((crate::control_peer::resolve(&token), token))
    }

    fn alive(&self, token: &PeerToken) -> bool {
        crate::control_peer::alive(token)
    }
}

#[cfg(unix)]
type Stream = std::os::unix::net::UnixStream;

#[derive(Default)]
struct GateState {
    doorbell: Doorbell,
    senders: HashMap<u64, std::sync::mpsc::SyncSender<Admission>>,
    #[cfg(unix)]
    waiting_streams: HashMap<u64, Stream>,
    #[cfg(unix)]
    granted: HashMap<u64, (String, Stream)>,
    prompts: PromptQueue,
}

pub struct ControlGate {
    policy: Mutex<Option<Arc<Policy>>>,
    peers: Mutex<Arc<dyn PeerSource>>,
    state: Mutex<GateState>,
    recheck_armed: AtomicBool,
    approvals_seen_ms: AtomicU64,
}

impl Default for ControlGate {
    fn default() -> Self {
        Self {
            policy: Mutex::new(None),
            peers: Mutex::new(Arc::new(SystemPeers)),
            state: Mutex::new(GateState::default()),
            recheck_armed: AtomicBool::new(false),
            approvals_seen_ms: AtomicU64::new(0),
        }
    }
}

impl std::fmt::Debug for ControlGate {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ControlGate").finish_non_exhaustive()
    }
}

fn now_seconds() -> f64 {
    ardia_state::store::now_ms() as f64 / 1000.0
}

#[cfg(unix)]
pub fn peer_left(stream: &Stream) -> bool {
    use std::os::fd::AsRawFd;
    let fd = stream.as_raw_fd();
    let mut probe = libc::pollfd {
        fd,
        events: libc::POLLIN,
        revents: 0,
    };
    if unsafe { libc::poll(&mut probe, 1, 0) } > 0
        && probe.revents & (libc::POLLHUP | libc::POLLERR | libc::POLLNVAL) != 0
    {
        return true;
    }
    let mut byte = 0u8;
    let got = unsafe {
        libc::recv(
            fd,
            (&mut byte as *mut u8).cast(),
            1,
            libc::MSG_PEEK | libc::MSG_DONTWAIT,
        )
    };
    if got == 0 {
        return true;
    }
    if got > 0 {
        return false;
    }
    let error = std::io::Error::last_os_error().raw_os_error();
    !matches!(error, Some(libc::EAGAIN | libc::EINTR))
}

impl AppCoordinator {
    pub fn control_gate(&self) -> Arc<ControlGate> {
        self.bridge.lock().control_gate.clone()
    }

    pub fn control_policy(&self) -> Arc<Policy> {
        let gate = self.control_gate();
        let mut policy = gate.policy.lock();
        policy
            .get_or_insert_with(|| {
                let test = std::env::var(crate::control_peer::TEST_ENV).ok();
                Arc::new(Policy::for_launch(self.config.scratch, test.as_deref()))
            })
            .clone()
    }

    pub fn set_control_policy(&self, policy: Policy) {
        *self.control_gate().policy.lock() = Some(Arc::new(policy));
    }

    pub fn set_control_peers(&self, peers: Arc<dyn PeerSource>) {
        *self.control_gate().peers.lock() = peers;
    }

    pub(crate) fn control_doorbell_on(&self) -> bool {
        !self.control_policy().same_user_is_enough
    }

    fn deliver(&self, gate: &ControlGate, ended: Vec<Ended>) {
        if ended.is_empty() {
            return;
        }
        let mut state = gate.state.lock();
        for end in &ended {
            if let Some(field) = doorbell_outcome_field(end.outcome) {
                ardia_telemetry::counts::count(field);
            }
            if end.outcome != Outcome::Once && end.outcome != Outcome::Unsaved {
                log::info!("control: ask {} ended {:?}", end.ask, end.outcome);
            }
            for connection in &end.connections {
                #[cfg(unix)]
                state.waiting_streams.remove(connection);
                if let Some(sender) = state.senders.remove(connection) {
                    let admission = if end.admit {
                        Admission::Open(end.grant.clone())
                    } else {
                        Admission::Refused(end.outcome)
                    };
                    let _ = sender.try_send(admission);
                }
            }
        }
        drop(state);
        let asks: Vec<u64> = ended.iter().map(|e| e.ask).collect();
        self.post(move |me| {
            for ask in asks {
                let steps = me.control_gate().state.lock().prompts.ended(ask);
                me.run_prompt_steps(steps);
            }
        });
    }

    fn prune_left(&self, gate: &ControlGate) {
        #[cfg(unix)]
        {
            let mut state = gate.state.lock();
            let left: Vec<u64> = state
                .waiting_streams
                .iter()
                .filter(|(_, stream)| peer_left(stream))
                .map(|(id, _)| *id)
                .collect();
            for connection in left {
                state.waiting_streams.remove(&connection);
                state.senders.remove(&connection);
                state.doorbell.leave(connection);
            }
        }
        #[cfg(not(unix))]
        let _ = gate;
    }

    #[cfg(unix)]
    pub fn admit_control_peer(
        &self,
        connection: u64,
        stream: &Stream,
        stop: &AtomicBool,
    ) -> Result<Grant, Option<Outcome>> {
        use std::os::fd::AsRawFd;
        let policy = self.control_policy();
        if policy.same_user_is_enough {
            return Ok(Grant::default());
        }
        let gate = self.control_gate();
        let peers = gate.peers.lock().clone();
        let Some((peer, token)) = peers.identify(stream.as_raw_fd()) else {
            return Err(None);
        };
        let now = now_seconds();
        let approvals = self
            .config
            .data_dir
            .as_deref()
            .map(|dir| crate::control_approvals::load(dir, now).entries)
            .unwrap_or_default();
        let key = match policy.verdict(&peer, &approvals, now) {
            Verdict::Ardia | Verdict::SameUser => return Ok(Grant::default()),
            Verdict::Approved(key) => {
                let until = approvals
                    .iter()
                    .find(|a| a.key == key)
                    .and_then(|a| a.until);
                return Ok(Grant {
                    key: Some(key),
                    until,
                });
            }
            Verdict::Ask(key) => key,
        };
        log::info!(
            "control: asking whether {} ({}) may control Ardia",
            peer.name(),
            peer.signed_by()
        );
        let (sender, admitted) = std::sync::mpsc::sync_channel(1);
        let ring = {
            let mut state = gate.state.lock();
            let ring = state.doorbell.ring(connection, &peer, key, token, now);
            if !matches!(ring, Ring::Refused(_)) {
                state.senders.insert(connection, sender);
                if let Ok(copy) = stream.try_clone() {
                    state.waiting_streams.insert(connection, copy);
                }
            }
            ring
        };
        match ring {
            Ring::Refused(outcome) => return Err(Some(outcome)),
            Ring::Joined(_) => {}
            Ring::Asked(question) => self.post(move |me| {
                let steps = me
                    .control_gate()
                    .state
                    .lock()
                    .prompts
                    .asked(question, now_seconds());
                me.run_prompt_steps(steps);
            }),
        }
        loop {
            match admitted.recv_timeout(TICK) {
                Ok(Admission::Open(grant)) => return Ok(grant),
                Ok(Admission::Refused(outcome)) => return Err(Some(outcome)),
                Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => {
                    return Err(Some(Outcome::Left));
                }
                Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {}
            }
            if stop.load(Ordering::Acquire) {
                let mut state = gate.state.lock();
                state.senders.remove(&connection);
                state.waiting_streams.remove(&connection);
                state.doorbell.leave(connection);
                drop(state);
                self.control_check(&gate, &*peers);
                return Err(Some(Outcome::Stopped));
            }
            self.control_check(&gate, &*peers);
        }
    }

    fn control_check(&self, gate: &ControlGate, peers: &dyn PeerSource) {
        self.prune_left(gate);
        let ended = gate
            .state
            .lock()
            .doorbell
            .check(now_seconds(), |t| peers.alive(t));
        self.deliver(gate, ended);
    }

    pub fn answer_control_peer(&self, ask: u64, result: PromptResult) {
        let steps = self
            .control_gate()
            .state
            .lock()
            .prompts
            .answered(ask, result, now_seconds());
        self.run_prompt_steps(steps);
    }

    pub fn showing_control_ask(&self) -> Option<u64> {
        self.control_gate().state.lock().prompts.showing()
    }

    fn run_prompt_steps(&self, steps: Vec<PromptStep>) {
        for step in steps {
            match step {
                PromptStep::Show(question) => {
                    ardia_telemetry::counts::count("cli_socket_doorbells_shown");
                    let window = crate::ipc::control_window(&self.store().snapshot());
                    self.effect(ShellEffect::AskControlPeer { question, window });
                }
                PromptStep::Dismiss(ask) => self.effect(ShellEffect::DismissControlPeer { ask }),
                PromptStep::Answer(ask, outcome) => self.settle_control_ask(ask, outcome),
            }
        }
    }

    fn settle_control_ask(&self, ask: u64, outcome: Outcome) {
        let gate = self.control_gate();
        let peers = gate.peers.lock().clone();
        self.prune_left(&gate);
        let dir = self.config.data_dir.clone();
        let (_, ended) = gate.state.lock().doorbell.answer(
            ask,
            outcome,
            now_seconds(),
            |t| peers.alive(t),
            |approval| {
                dir.as_deref()
                    .is_some_and(|dir| crate::control_approvals::add(dir, approval, now_seconds()))
            },
        );
        let refresh = ended
            .iter()
            .any(|e| matches!(e.outcome, Outcome::HalfHour | Outcome::Always));
        self.deliver(&gate, ended);
        if refresh {
            self.refresh_settings_values(vec![SettingsQuery::ControlApprovals]);
        }
    }

    #[cfg(unix)]
    pub(crate) fn control_granted(&self, connection: u64, grant: &Grant, stream: &Stream) {
        if let (Some(key), Ok(copy)) = (&grant.key, stream.try_clone()) {
            self.control_gate()
                .state
                .lock()
                .granted
                .insert(connection, (key.clone(), copy));
        }
    }

    #[cfg(unix)]
    pub(crate) fn control_closed(&self, connection: u64) {
        self.control_gate().state.lock().granted.remove(&connection);
    }

    pub(crate) fn retire_control_key(&self, key: &str) {
        #[cfg(unix)]
        {
            let gate = self.control_gate();
            let state = gate.state.lock();
            for (granted, stream) in state.granted.values() {
                if granted == key {
                    let _ = stream.shutdown(std::net::Shutdown::Both);
                }
            }
        }
        #[cfg(not(unix))]
        let _ = key;
    }

    pub fn control_still_approved(&self, grant: &mut Grant) -> bool {
        let now = now_seconds();
        let (Some(key), Some(until)) = (&grant.key, grant.until) else {
            return true;
        };
        if until > now {
            return true;
        }
        let live = self.config.data_dir.as_deref().and_then(|dir| {
            crate::control_approvals::load(dir, now)
                .entries
                .into_iter()
                .find(|a| &a.key == key && a.live(now))
        });
        match live {
            Some(approval) => {
                grant.until = approval.until;
                true
            }
            None => false,
        }
    }

    pub(crate) fn note_approvals_seen(&self) {
        self.control_gate()
            .approvals_seen_ms
            .store(ardia_state::store::now_ms() as u64, Ordering::Relaxed);
    }

    pub(crate) fn arm_approvals_recheck(&self, approvals: &serde_json::Value) {
        if !timed_approvals(approvals) {
            return;
        }
        let gate = self.control_gate();
        if gate.recheck_armed.swap(true, Ordering::AcqRel) {
            return;
        }
        self.recheck_approvals_later(gate);
    }

    fn recheck_approvals_later(&self, gate: Arc<ControlGate>) {
        let me = self.weak();
        let spawned = std::thread::Builder::new()
            .name("ardia-approvals-recheck".into())
            .spawn(move || {
                std::thread::sleep(APPROVALS_RECHECK);
                match me.upgrade() {
                    Some(coordinator) => coordinator.post(move |me| me.recheck_approvals(gate)),
                    None => gate.recheck_armed.store(false, Ordering::Release),
                }
            });
        if spawned.is_err() {
            self.control_gate()
                .recheck_armed
                .store(false, Ordering::Release);
        }
    }

    fn recheck_approvals(&self, gate: Arc<ControlGate>) {
        let now_ms = ardia_state::store::now_ms() as f64;
        let seen = gate.approvals_seen_ms.load(Ordering::Relaxed) as f64;
        let cached = self.cached_settings_value(&SettingsQuery::ControlApprovals);
        let shown = now_ms - seen <= APPROVALS_RECHECK.as_millis() as f64 * 2.0;
        let Some(approvals) = cached.filter(|v| shown && timed_approvals(v)) else {
            gate.recheck_armed.store(false, Ordering::Release);
            return;
        };
        if expired_approvals(&approvals, now_ms) {
            self.refresh_settings_values(vec![SettingsQuery::ControlApprovals]);
        }
        self.signal.emit(HostTopics::SYNC);
        self.recheck_approvals_later(gate);
    }
}

fn approval_untils(approvals: &serde_json::Value) -> impl Iterator<Item = Option<f64>> + '_ {
    approvals
        .get("approvals")
        .and_then(serde_json::Value::as_array)
        .into_iter()
        .flatten()
        .map(|a| a.get("until").and_then(serde_json::Value::as_f64))
}

pub fn timed_approvals(approvals: &serde_json::Value) -> bool {
    approval_untils(approvals).any(|until| until.is_some())
}

pub fn expired_approvals(approvals: &serde_json::Value, now_ms: f64) -> bool {
    approval_untils(approvals).any(|until| until.is_some_and(|until| until <= now_ms))
}

pub fn shown_window_unavailable(background: bool, policy: &Policy) -> bool {
    background && !policy.shown_in_background
}

#[cfg(target_os = "macos")]
pub use present::{dismiss, present};

#[cfg(not(target_os = "macos"))]
pub fn present(
    coordinator: &Arc<AppCoordinator>,
    question: Question,
    _: Option<ardia_state::WindowId>,
    _: &mut gpui::App,
) {
    coordinator.answer_control_peer(question.ask, PromptResult::Unshown);
}

#[cfg(not(target_os = "macos"))]
pub fn dismiss(_: u64) {}

#[cfg(target_os = "macos")]
mod present {
    use std::cell::RefCell;
    use std::collections::HashMap;
    use std::sync::Arc;

    use ardia_state::WindowId;
    use block2::RcBlock;
    use objc2::rc::Retained;
    use objc2::runtime::AnyObject;
    use objc2::{class, msg_send};
    use objc2_foundation::NSString;

    use super::{PromptResult, Question, shown_window_unavailable};
    use crate::coordinator::AppCoordinator;

    const FIRST_BUTTON: isize = 1000;
    const ESCAPE: &str = "\u{1b}";

    struct ShownSheet {
        alert: Retained<AnyObject>,
        parent: Retained<AnyObject>,
    }

    thread_local! {
        static SHOWN: RefCell<HashMap<u64, ShownSheet>> = RefCell::new(HashMap::new());
    }

    fn ns_window_of(window: &mut gpui::Window) -> Option<Retained<AnyObject>> {
        use raw_window_handle::{HasWindowHandle, RawWindowHandle};
        let handle = HasWindowHandle::window_handle(window).ok()?;
        let RawWindowHandle::AppKit(appkit) = handle.as_raw() else {
            return None;
        };
        let view = appkit.ns_view.as_ptr().cast::<AnyObject>();
        unsafe {
            let ns_window: *mut AnyObject = msg_send![view, window];
            Retained::retain(ns_window)
        }
    }

    fn visible(window: &AnyObject) -> bool {
        unsafe {
            let shown: bool = msg_send![window, isVisible];
            let minimized: bool = msg_send![window, isMiniaturized];
            shown && !minimized
        }
    }

    pub fn present(
        coordinator: &Arc<AppCoordinator>,
        question: Question,
        window: Option<WindowId>,
        cx: &mut gpui::App,
    ) {
        let ask = question.ask;
        let policy = coordinator.control_policy();
        let parent = (!shown_window_unavailable(coordinator.config().background, &policy))
            .then_some(window)
            .flatten()
            .and_then(|window| coordinator.gpui_window(&window))
            .and_then(|handle| handle.update(cx, |_, window, _| ns_window_of(window)).ok())
            .flatten()
            .filter(|window| visible(window));
        let Some(parent) = parent else {
            coordinator.answer_control_peer(ask, PromptResult::Unshown);
            return;
        };
        let alert = unsafe { build(&question) };
        let weak = Arc::downgrade(coordinator);
        let count = question.choices().len() as isize;
        let block = RcBlock::new(move |response: isize| {
            SHOWN.with(|shown| shown.borrow_mut().remove(&ask));
            let index = response - FIRST_BUTTON;
            let choice = (0..count).contains(&index).then_some(index as usize);
            if let Some(coordinator) = weak.upgrade() {
                coordinator.answer_control_peer(ask, PromptResult::Chose(choice));
            }
        });
        SHOWN.with(|shown| {
            shown.borrow_mut().insert(
                ask,
                ShownSheet {
                    alert: alert.clone(),
                    parent: parent.clone(),
                },
            )
        });
        let hidden = coordinator.config().background;
        unsafe {
            if hidden {
                let _: () = msg_send![&*alert, layout];
                let sheet: *mut AnyObject = msg_send![&*alert, window];
                let _: () = msg_send![&*parent, beginSheet: sheet, completionHandler: &*block];
            } else {
                let _: () = msg_send![&*alert, beginSheetModalForWindow: &*parent, completionHandler: &*block];
            }
        }
    }

    unsafe fn build(question: &Question) -> Retained<AnyObject> {
        unsafe {
            let alert: Retained<AnyObject> = msg_send![class!(NSAlert), new];
            let title = NSString::from_str(super::TITLE);
            let message = NSString::from_str(&question.message());
            let _: () = msg_send![&*alert, setMessageText: &*title];
            let _: () = msg_send![&*alert, setInformativeText: &*message];
            let cancel = question.cancel_choice();
            let mut cancel_button: *mut AnyObject = std::ptr::null_mut();
            for (index, title) in question.titles().into_iter().enumerate() {
                let title = NSString::from_str(title);
                let button: *mut AnyObject = msg_send![&*alert, addButtonWithTitle: &*title];
                if index == 0 {
                    let none = NSString::from_str("");
                    let _: () = msg_send![button, setKeyEquivalent: &*none];
                }
                if index == cancel {
                    let escape = NSString::from_str(ESCAPE);
                    let _: () = msg_send![button, setKeyEquivalent: &*escape];
                    cancel_button = button;
                }
            }
            if !cancel_button.is_null() {
                let window: *mut AnyObject = msg_send![&*alert, window];
                let _: () = msg_send![window, setInitialFirstResponder: cancel_button];
            }
            alert
        }
    }

    pub fn dismiss(ask: u64) {
        let shown = SHOWN.with(|shown| {
            shown
                .borrow()
                .get(&ask)
                .map(|sheet| (sheet.alert.clone(), sheet.parent.clone()))
        });
        if let Some((alert, parent)) = shown {
            unsafe {
                let sheet: *mut AnyObject = msg_send![&*alert, window];
                let _: () = msg_send![&*parent, endSheet: sheet, returnCode: 0isize];
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::control_peer::Signer;

    fn peer(identifier: &str) -> ControlPeer {
        ControlPeer {
            pid: 7,
            path: Some(format!("/opt/{identifier}")),
            identifier: Some(identifier.into()),
            signer: Signer::Team("T1".into()),
            developer: Some("Dev".into()),
            cdhash: Some("ff".into()),
            hardened: false,
            bundle_name: None,
        }
    }

    fn token(pid: u32) -> PeerToken {
        PeerToken([0, 0, 0, 0, 0, pid, 0, 1])
    }

    fn asked(ring: Ring) -> Question {
        match ring {
            Ring::Asked(question) => question,
            other => panic!("expected an ask, got {other:?}"),
        }
    }

    #[test]
    fn the_prompt_copy_matches_the_old_doorbell() {
        let mut bell = Doorbell::default();
        let p = peer("com.example.agent");
        let q = asked(bell.ring(1, &p, p.approval_key(), token(7), 0.0));
        assert_eq!(TITLE, "A program wants to control Ardia");
        assert_eq!(
            q.message(),
            "“com.example.agent”: Signed by Dev (T1)\n/opt/com.example.agent\n\nIt could open, read and change your tabs and pages, with your logins, as the ardia command can."
        );
        assert_eq!(
            q.titles(),
            vec![
                "Allow Once",
                "Allow for 30 Minutes",
                "Always Allow",
                "Don't Allow"
            ]
        );
        assert_eq!(q.cancel_choice(), 3);
        assert_eq!(q.deadline, ASK_SECONDS);
        let anon = ControlPeer::unknown(9);
        let q = asked(bell.ring(2, &anon, None, token(9), 0.0));
        assert!(!q.remember);
        assert_eq!(q.titles(), vec!["Allow Once", "Don't Allow"]);
        assert_eq!(
            q.message(),
            format!(
                "“An unknown program”: Not signed by an identified developer\n\n{WHAT_IT_CAN_DO}\n\n{ONLY_ONCE}"
            )
        );
        assert_eq!(
            q.answer_for(PromptResult::Chose(Some(1))),
            Some(Outcome::Deny)
        );
        assert_eq!(q.answer_for(PromptResult::Chose(None)), None);
        assert_eq!(q.answer_for(PromptResult::Chose(Some(5))), None);
        assert_eq!(q.answer_for(PromptResult::Unshown), Some(Outcome::Unshown));
        assert_eq!(prompt_text("a\u{2028}b", 5), "ab");
    }

    #[test]
    fn allowing_saves_with_the_old_expiry_and_admits_every_waiter() {
        let mut bell = Doorbell::default();
        let p = peer("agent");
        let key = p.approval_key();
        let q = asked(bell.ring(1, &p, key.clone(), token(7), 100.0));
        assert_eq!(
            bell.ring(2, &p, key.clone(), token(7), 101.0),
            Ring::Joined(q.ask)
        );
        let other_process = asked(bell.ring(3, &p, key, token(8), 101.0));
        let mut saved = None;
        let (ok, ended) = bell.answer(
            q.ask,
            Outcome::HalfHour,
            110.0,
            |_| true,
            |a| {
                saved = Some(a);
                true
            },
        );
        assert!(ok);
        let saved = saved.expect("saved");
        assert_eq!(saved.until, Some(110.0 + HALF_HOUR_SECONDS));
        assert_eq!(saved.added, 110.0);
        assert_eq!(ended.len(), 2);
        assert_eq!(ended[0].connections, vec![1, 2]);
        assert!(
            ended
                .iter()
                .all(|e| e.admit && e.outcome == Outcome::HalfHour)
        );
        assert_eq!(ended[1].ask, other_process.ask);
        assert_eq!(ended[0].grant.until, Some(110.0 + HALF_HOUR_SECONDS));
        assert_eq!(bell.waiting_count(), 0);
    }

    #[test]
    fn always_has_no_expiry_and_unsaved_still_admits_once() {
        let mut bell = Doorbell::default();
        let p = peer("agent");
        let q = asked(bell.ring(1, &p, p.approval_key(), token(7), 0.0));
        let (_, ended) = bell.answer(q.ask, Outcome::Always, 1.0, |_| true, |a| a.until.is_none());
        assert_eq!(ended[0].grant.until, None);
        assert_eq!(ended[0].outcome, Outcome::Always);
        let q = asked(bell.ring(2, &p, p.approval_key(), token(7), 2.0));
        let (_, ended) = bell.answer(q.ask, Outcome::Always, 3.0, |_| true, |_| false);
        assert_eq!(ended[0].outcome, Outcome::Unsaved);
        assert!(ended[0].admit);
        assert_eq!(ended[0].grant, Grant::default());
    }

    #[test]
    fn denying_refuses_and_keeps_the_program_quiet_for_30_seconds() {
        let mut bell = Doorbell::default();
        let p = peer("agent");
        let key = p.approval_key();
        let q = asked(bell.ring(1, &p, key.clone(), token(7), 0.0));
        let twin = asked(bell.ring(2, &p, key.clone(), token(8), 0.0));
        let (ok, ended) = bell.answer(q.ask, Outcome::Deny, 5.0, |_| true, |_| true);
        assert!(ok);
        assert_eq!(ended.len(), 2);
        assert!(ended.iter().all(|e| !e.admit && e.outcome == Outcome::Deny));
        assert_eq!(ended[1].ask, twin.ask);
        assert_eq!(
            bell.ring(3, &p, key.clone(), token(7), 34.0),
            Ring::Refused(Outcome::Quiet)
        );
        assert!(matches!(
            bell.ring(4, &p, key, token(7), 35.0),
            Ring::Asked(_)
        ));
        assert_eq!(
            refusal(Outcome::Quiet),
            "You chose Don't Allow when Ardia asked whether this program may control it."
        );
    }

    #[test]
    fn asks_time_out_after_a_minute_and_end_when_the_program_leaves() {
        let mut bell = Doorbell::default();
        let p = peer("agent");
        let q = asked(bell.ring(1, &p, p.approval_key(), token(7), 0.0));
        assert!(bell.check(59.0, |_| true).is_empty());
        let ended = bell.check(60.0, |_| true);
        assert_eq!(ended[0].outcome, Outcome::Timeout);
        assert_eq!(ended[0].connections, vec![1]);
        assert_eq!(
            bell.ring(2, &p, p.approval_key(), token(7), 61.0),
            Ring::Refused(Outcome::Quiet)
        );
        let (ok, _) = bell.answer(q.ask, Outcome::Once, 61.0, |_| true, |_| true);
        assert!(!ok);
        let anon = ControlPeer::unknown(1);
        let q = asked(bell.ring(3, &anon, None, token(1), 0.0));
        bell.leave(3);
        let (ok, ended) = bell.answer(q.ask, Outcome::Once, 1.0, |_| true, |_| true);
        assert!(!ok);
        assert_eq!(ended[0].outcome, Outcome::Left);
        let q = asked(bell.ring(4, &anon, None, token(1), 0.0));
        let ended = bell.check(1.0, |_| false);
        assert_eq!(ended[0].ask, q.ask);
        assert_eq!(ended[0].outcome, Outcome::Left);
    }

    #[test]
    fn at_most_eight_programs_wait_and_stop_refuses_them_all() {
        let mut bell = Doorbell::default();
        for n in 0..MAX_WAITING as u64 {
            let p = peer(&format!("agent{n}"));
            assert!(matches!(
                bell.ring(n, &p, p.approval_key(), token(n as u32), 0.0),
                Ring::Asked(_)
            ));
        }
        let p = peer("late");
        assert_eq!(
            bell.ring(99, &p, p.approval_key(), token(99), 0.0),
            Ring::Refused(Outcome::Full)
        );
        let ended = bell.stop();
        assert_eq!(ended.len(), MAX_WAITING);
        assert!(ended.iter().all(|e| e.outcome == Outcome::Stopped));
        assert_eq!(
            refusal(Outcome::Unshown),
            "Ardia has to ask before this program may control it, and nobody can see the question (no Ardia window is on screen, or Ardia runs in the background)."
        );
    }

    #[test]
    fn the_prompt_queue_shows_one_question_at_a_time() {
        let mut bell = Doorbell::default();
        let a = peer("a");
        let b = peer("b");
        let qa = asked(bell.ring(1, &a, a.approval_key(), token(1), 0.0));
        let qb = asked(bell.ring(2, &b, b.approval_key(), token(2), 0.0));
        let mut queue = PromptQueue::default();
        assert_eq!(
            queue.asked(qa.clone(), 0.0),
            vec![PromptStep::Show(qa.clone())]
        );
        assert!(queue.asked(qb.clone(), 0.0).is_empty());
        assert_eq!(
            queue.answered(qa.ask, PromptResult::Chose(Some(2)), 1.0),
            vec![
                PromptStep::Answer(qa.ask, Outcome::Always),
                PromptStep::Show(qb.clone())
            ]
        );
        assert_eq!(queue.ended(qb.ask), vec![PromptStep::Dismiss(qb.ask)]);
        assert!(queue.ended(qb.ask).is_empty());
        assert!(
            queue
                .answered(qb.ask, PromptResult::Chose(None), 2.0)
                .is_empty()
        );
        let late = Question {
            deadline: 5.0,
            ..qa.clone()
        };
        assert!(queue.asked(late, 6.0).is_empty());
        assert_eq!(queue.showing(), None);
        assert!(queue.asked(qa.clone(), 0.0).len() == 1);
        assert!(queue.asked(qb.clone(), 0.0).is_empty());
        assert!(queue.ended(qb.ask).is_empty());
        assert_eq!(
            queue.answered(qa.ask, PromptResult::Unshown, 1.0),
            vec![PromptStep::Answer(qa.ask, Outcome::Unshown)]
        );
    }

    #[test]
    fn the_15_second_recheck_sees_timed_and_expired_approvals() {
        let wire = serde_json::json!({ "approvals": [
            { "key": "a", "until": 5_000.0 },
            { "key": "b" }
        ] });
        assert!(timed_approvals(&wire));
        assert!(!expired_approvals(&wire, 4_999.0));
        assert!(expired_approvals(&wire, 5_000.0));
        let forever = serde_json::json!({ "approvals": [{ "key": "b" }] });
        assert!(!timed_approvals(&forever));
        assert!(!timed_approvals(&serde_json::json!({})));
        assert_eq!(APPROVALS_RECHECK, Duration::from_secs(15));
    }

    #[test]
    fn background_instances_only_show_the_question_when_a_test_asks() {
        let policy = Policy::default();
        assert!(shown_window_unavailable(true, &policy));
        assert!(!shown_window_unavailable(false, &policy));
        let shown = Policy {
            shown_in_background: true,
            ..Policy::default()
        };
        assert!(!shown_window_unavailable(true, &shown));
    }
}
