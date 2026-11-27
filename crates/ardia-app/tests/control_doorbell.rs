#![cfg(target_os = "macos")]

use std::io::{BufRead, BufReader, Write};
use std::os::unix::net::UnixStream;
use std::path::Path;
use std::sync::Arc;
use std::sync::mpsc::Receiver;
use std::time::{Duration, Instant};

use ardia_app::control_approvals::{FILE_NAME, load};
use ardia_app::control_doorbell::Outcome;
use ardia_app::control_doorbell::{PeerSource, PromptResult, Question, refusal};
use ardia_app::control_peer::{ControlPeer, PeerToken, Policy, Signer};
use ardia_app::coordinator::ShellEffect;
use ardia_app::ipc::socket::ControlServer;
use ardia_app::{AppCoordinator, CoordinatorConfig};
use ardia_engine::{BrowserEngine, MockBrowserEngine};
use ardia_state::ids::IdGen;
use ardia_state::persistence::session::{LoadOptions, SessionData};
use ardia_state::{BrowserState, BrowserStore};
use serde_json::Value;

struct FakePeers(ControlPeer);

impl PeerSource for FakePeers {
    fn identify(&self, _: std::os::fd::RawFd) -> Option<(ControlPeer, PeerToken)> {
        Some((self.0.clone(), PeerToken([0, 0, 0, 0, 0, 4242, 0, 1])))
    }

    fn alive(&self, _: &PeerToken) -> bool {
        true
    }
}

fn agent() -> ControlPeer {
    ControlPeer {
        pid: 4242,
        path: Some("/usr/local/bin/agent".into()),
        identifier: Some("agent".into()),
        signer: Signer::Other,
        developer: None,
        cdhash: Some("c0ffee".into()),
        hardened: false,
        bundle_name: None,
    }
}

struct Rig {
    app: Arc<AppCoordinator>,
    dir: tempfile::TempDir,
    _server: ControlServer,
}

impl Rig {
    fn new(policy: Policy) -> Self {
        let dir = tempfile::tempdir().expect("dir");
        let engine = Arc::new(MockBrowserEngine::started());
        let shared: Arc<dyn BrowserEngine> = engine;
        let store = Arc::new(BrowserStore::in_memory(
            BrowserState::from_session(
                SessionData::fresh(LoadOptions::default()),
                1_795_000_000_000,
            ),
            IdGen::with_launch("doorbell"),
        ));
        let config = CoordinatorConfig {
            data_dir: Some(dir.path().to_path_buf()),
            ..CoordinatorConfig::default()
        };
        let app = AppCoordinator::new(store, shared, config);
        app.set_waker(|| {});
        app.start();
        app.pump();
        app.set_control_policy(policy);
        app.set_control_peers(Arc::new(FakePeers(agent())));
        let server = ControlServer::start(dir.path().join("ArdiaControl.sock"), &app).expect("server");
        Self {
            app,
            dir,
            _server: server,
        }
    }

    fn ask_status(&self) -> Receiver<Option<Value>> {
        let path = self.dir.path().join("ArdiaControl.sock");
        let (send, got) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            let stream = UnixStream::connect(&path).expect("connect");
            stream
                .set_read_timeout(Some(Duration::from_secs(10)))
                .expect("timeout");
            let mut writer = stream.try_clone().expect("clone");
            let _ = writeln!(writer, r#"{{"id":1,"method":"status"}}"#);
            let mut line = String::new();
            let read = BufReader::new(stream).read_line(&mut line).unwrap_or(0);
            let _ = send.send((read > 0).then(|| serde_json::from_str(&line).expect("json")));
        });
        got
    }

    fn reply(&self, got: &Receiver<Option<Value>>) -> Option<Value> {
        let deadline = Instant::now() + Duration::from_secs(10);
        loop {
            self.app.pump();
            if let Ok(reply) = got.try_recv() {
                return reply;
            }
            assert!(Instant::now() < deadline, "no reply");
            std::thread::sleep(Duration::from_millis(5));
        }
    }

    fn question(&self) -> Question {
        let deadline = Instant::now() + Duration::from_secs(10);
        loop {
            self.app.pump();
            for effect in self.app.take_effects() {
                if let ShellEffect::AskControlPeer { question, .. } = effect {
                    return question;
                }
            }
            assert!(Instant::now() < deadline, "no question");
            std::thread::sleep(Duration::from_millis(5));
        }
    }

    fn file(&self) -> &Path {
        self.dir.path()
    }
}

fn refused_with(reply: Option<Value>, outcome: Outcome) {
    let reply = reply.expect("a refusal line");
    assert_eq!(reply["id"], Value::Null);
    assert_eq!(reply["error"]["code"], "refused");
    assert_eq!(reply["error"]["message"], refusal(outcome));
}

fn now_seconds() -> f64 {
    ardia_state::store::now_ms() as f64 / 1000.0
}

#[test]
fn an_unknown_program_waits_for_the_question_and_is_refused_when_nobody_sees_it() {
    let rig = Rig::new(Policy::default());
    let got = rig.ask_status();
    let question = rig.question();
    assert_eq!(question.name, "agent");
    assert!(question.remember);
    assert!(got.try_recv().is_err());
    rig.app
        .answer_control_peer(question.ask, PromptResult::Unshown);
    refused_with(rig.reply(&got), Outcome::Unshown);
}

#[test]
fn always_allow_saves_the_program_and_lets_it_straight_back_in() {
    let rig = Rig::new(Policy::default());
    let got = rig.ask_status();
    let question = rig.question();
    rig.app
        .answer_control_peer(question.ask, PromptResult::Chose(Some(2)));
    let reply = rig.reply(&got).expect("a reply");
    assert!(reply["result"]["version"].is_string());
    let saved = load(rig.file(), now_seconds()).entries;
    assert_eq!(saved.len(), 1);
    assert_eq!(saved[0].key, "code:c0ffee:/usr/local/bin/agent");
    assert_eq!(saved[0].until, None);
    assert_eq!(saved[0].signed_by, "Not signed by an identified developer");
    let again = rig.ask_status();
    assert!(rig.reply(&again).expect("a reply")["result"].is_object());
    assert!(
        !rig.app
            .take_effects()
            .iter()
            .any(|e| matches!(e, ShellEffect::AskControlPeer { .. }))
    );
}

#[test]
fn half_hour_approvals_expire_and_ask_again() {
    let rig = Rig::new(Policy::default());
    let got = rig.ask_status();
    let question = rig.question();
    let before = now_seconds();
    rig.app
        .answer_control_peer(question.ask, PromptResult::Chose(Some(1)));
    assert!(rig.reply(&got).expect("a reply")["result"].is_object());
    let saved = load(rig.file(), now_seconds()).entries;
    let until = saved[0].until.expect("an expiry");
    assert!(until >= before + 1800.0 - 1.0 && until <= now_seconds() + 1800.0 + 1.0);
    let mut stale = saved[0].clone();
    stale.until = Some(now_seconds() - 1.0);
    let stale = serde_json::to_vec(&[stale]).expect("json");
    std::fs::write(rig.file().join(FILE_NAME), stale).expect("write");
    let got = rig.ask_status();
    let question = rig.question();
    rig.app
        .answer_control_peer(question.ask, PromptResult::Unshown);
    refused_with(rig.reply(&got), Outcome::Unshown);
}

#[test]
fn dont_allow_refuses_and_stays_quiet_for_the_next_try() {
    let rig = Rig::new(Policy::default());
    let got = rig.ask_status();
    let question = rig.question();
    rig.app
        .answer_control_peer(question.ask, PromptResult::Chose(Some(3)));
    refused_with(rig.reply(&got), Outcome::Deny);
    let again = rig.ask_status();
    refused_with(rig.reply(&again), Outcome::Quiet);
    assert!(load(rig.file(), now_seconds()).entries.is_empty());
}

#[test]
fn test_instances_let_every_program_of_yours_in_without_asking() {
    let rig = Rig::new(Policy {
        same_user_is_enough: true,
        ..Policy::default()
    });
    let got = rig.ask_status();
    assert!(rig.reply(&got).expect("a reply")["result"].is_object());
    assert!(
        !rig.app
            .take_effects()
            .iter()
            .any(|e| matches!(e, ShellEffect::AskControlPeer { .. }))
    );
}

#[test]
fn ardia_itself_gets_in_through_the_real_peer_check() {
    let rig = Rig::new(Policy::for_launch(false, None));
    rig.app.set_control_peers(Arc::new(SystemPeerProbe));
    let got = rig.ask_status();
    assert!(rig.reply(&got).expect("a reply")["result"].is_object());
}

struct SystemPeerProbe;

impl PeerSource for SystemPeerProbe {
    fn identify(&self, fd: std::os::fd::RawFd) -> Option<(ControlPeer, PeerToken)> {
        let token = ardia_app::control_peer::peer_token(fd)?;
        let peer = ardia_app::control_peer::resolve(&token);
        assert_eq!(token.pid(), std::process::id() as i32);
        assert!(
            peer.cdhash.is_some(),
            "the test binary is identified by its code hash"
        );
        Some((peer, token))
    }

    fn alive(&self, token: &PeerToken) -> bool {
        ardia_app::control_peer::alive(token)
    }
}
