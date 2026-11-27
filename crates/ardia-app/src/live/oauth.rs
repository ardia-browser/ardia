use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

use ardia_state::live::{LiveError, LiveErrorKind, LiveSourceId};
use ardia_state::{Action, NewTab, WindowId};
use base64::Engine as _;
use serde_json::Value;
use sha2::Digest;

use super::sources::{GoogleTokens, Net, account, bearer, stored_google_tokens};
use super::{LiveHub, now_ms};
use crate::net::{encode, form};

pub const GOOGLE_REDIRECT: &str = "http://127.0.0.1:53682/ardia-oauth";
const GOOGLE_SCOPE: &str = "https://www.googleapis.com/auth/drive.metadata.readonly";
const GOOGLE_WAIT: Duration = Duration::from_secs(15 * 60);
const POLL: Duration = Duration::from_millis(250);

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DeviceStart {
    pub device_code: String,
    pub user_code: String,
    pub verification_uri: String,
    pub expires_in: u64,
    pub interval: u64,
}

fn signed_out(message: &str) -> LiveError {
    LiveError::new(LiveErrorKind::SignedOut, message)
}

fn random_hex(chars: usize) -> String {
    let mut out = String::new();
    while out.len() < chars {
        out.push_str(&uuid::Uuid::new_v4().simple().to_string());
    }
    out.truncate(chars);
    out
}

pub fn pkce_challenge(verifier: &str) -> String {
    base64::engine::general_purpose::URL_SAFE_NO_PAD
        .encode(sha2::Sha256::digest(verifier.as_bytes()))
}

pub fn query_of(url: &str) -> Vec<(String, String)> {
    let search = url
        .split('#')
        .next()
        .unwrap_or("")
        .split_once('?')
        .map_or("", |(_, q)| q);
    url::form_urlencoded::parse(search.as_bytes())
        .map(|(k, v)| (k.into_owned(), v.into_owned()))
        .collect()
}

fn param<'a>(params: &'a [(String, String)], key: &str) -> Option<&'a str> {
    params
        .iter()
        .find(|(k, _)| k == key)
        .map(|(_, v)| v.as_str())
}

pub fn device_start_of(json: &Value) -> Option<DeviceStart> {
    Some(DeviceStart {
        device_code: json.get("device_code")?.as_str()?.to_owned(),
        user_code: json.get("user_code")?.as_str()?.to_owned(),
        verification_uri: json.get("verification_uri")?.as_str()?.to_owned(),
        expires_in: json
            .get("expires_in")
            .and_then(Value::as_u64)
            .unwrap_or(900),
        interval: json.get("interval").and_then(Value::as_u64).unwrap_or(5),
    })
}

pub enum DevicePoll {
    Token(String),
    Wait,
    SlowDown(u64),
    Failed(&'static str),
}

pub fn device_poll_of(json: &Value, interval: u64) -> DevicePoll {
    if let Some(token) = json.get("access_token").and_then(Value::as_str) {
        return DevicePoll::Token(token.to_owned());
    }
    match json.get("error").and_then(Value::as_str) {
        Some("slow_down") => DevicePoll::SlowDown(
            json.get("interval")
                .and_then(Value::as_u64)
                .unwrap_or(interval + 5),
        ),
        Some("authorization_pending") | None => DevicePoll::Wait,
        Some("access_denied") => DevicePoll::Failed("Access was denied"),
        Some(_) => DevicePoll::Failed("GitHub didn't finish signing in"),
    }
}

fn sleep_unless(cancel: &AtomicBool, total: Duration) -> bool {
    let until = Instant::now() + total;
    while Instant::now() < until {
        if cancel.load(Ordering::Relaxed) {
            return false;
        }
        std::thread::sleep(POLL.min(until.saturating_duration_since(Instant::now())));
    }
    !cancel.load(Ordering::Relaxed)
}

impl LiveHub {
    fn net(&self) -> Result<Net<'_>, LiveError> {
        let transport = self
            .transport
            .as_deref()
            .ok_or_else(|| LiveError::new(LiveErrorKind::Network, "Couldn't connect"))?;
        Ok(Net {
            transport,
            endpoints: &self.endpoints,
            secrets: &self.secrets,
        })
    }

    pub fn start_github_device(&self, client_id: &str) -> Result<DeviceStart, LiveError> {
        let net = self.net()?;
        let body = form(&[("client_id", client_id), ("scope", "repo read:org")]);
        let (json, _) = net.request(
            "POST",
            &format!("{}/login/device/code", self.endpoints.github_web()),
            &[(
                "Content-Type",
                "application/x-www-form-urlencoded".to_owned(),
            )],
            Some(body.into_bytes()),
        )?;
        self.update(true, |s| s.config.github_client_id = client_id.to_owned());
        device_start_of(&json).ok_or_else(|| signed_out("GitHub didn't start signing in"))
    }

    pub fn finish_github_device(
        &self,
        client_id: &str,
        start: &DeviceStart,
        cancel: &AtomicBool,
    ) -> Result<(), LiveError> {
        let net = self.net()?;
        let expires = Instant::now() + Duration::from_secs(start.expires_in);
        let mut interval = start.interval.max(1);
        while Instant::now() < expires {
            if !sleep_unless(cancel, Duration::from_secs(interval)) {
                return Err(signed_out("Cancelled"));
            }
            let body = form(&[
                ("client_id", client_id),
                ("device_code", &start.device_code),
                ("grant_type", "urn:ietf:params:oauth:grant-type:device_code"),
            ]);
            let (json, _) = net.request(
                "POST",
                &format!("{}/login/oauth/access_token", self.endpoints.github_web()),
                &[(
                    "Content-Type",
                    "application/x-www-form-urlencoded".to_owned(),
                )],
                Some(body.into_bytes()),
            )?;
            match device_poll_of(&json, interval) {
                DevicePoll::Token(token) => {
                    return self.connect(LiveSourceId::Github, &token, None, None);
                }
                DevicePoll::Wait => {}
                DevicePoll::SlowDown(next) => interval = next,
                DevicePoll::Failed(message) => return Err(signed_out(message)),
            }
        }
        Err(signed_out(if cancel.load(Ordering::Relaxed) {
            "Cancelled"
        } else {
            "The code expired"
        }))
    }

    pub fn google_consent_url(&self, client_id: &str, challenge: &str, state: &str) -> String {
        let pairs = [
            ("client_id", client_id),
            ("redirect_uri", GOOGLE_REDIRECT),
            ("response_type", "code"),
            ("scope", GOOGLE_SCOPE),
            ("code_challenge", challenge),
            ("code_challenge_method", "S256"),
            ("state", state),
            ("access_type", "offline"),
            ("prompt", "consent"),
        ];
        let query = pairs
            .iter()
            .map(|(k, v)| format!("{k}={}", encode(v)))
            .collect::<Vec<_>>()
            .join("&");
        format!("{}?{query}", self.endpoints.google_auth())
    }

    pub fn connect_google(
        &self,
        window: &WindowId,
        client_id: &str,
        client_secret: &str,
        cancel: &AtomicBool,
    ) -> Result<(), LiveError> {
        let store = self
            .store
            .clone()
            .ok_or_else(|| LiveError::new(LiveErrorKind::Other, "Open a browser window first"))?;
        let verifier = random_hex(64);
        let state = random_hex(32);
        let url = self.google_consent_url(client_id, &pkce_challenge(&verifier), &state);
        let tab = store
            .dispatch(Action::NewTab {
                window: window.clone(),
                tab: NewTab {
                    url: Some(url),
                    ..NewTab::default()
                },
            })
            .ok()
            .and_then(|outcome| outcome.tab)
            .ok_or_else(|| LiveError::new(LiveErrorKind::Other, "Open a browser window first"))?;
        let close = |store: &ardia_state::BrowserStore| {
            if store.snapshot().tab(tab.as_str()).is_some() {
                let _ = store.dispatch(Action::CloseTabs {
                    tabs: vec![tab.clone()],
                    last_closes_window: false,
                });
            }
        };
        let started = Instant::now();
        let address = loop {
            if cancel.load(Ordering::Relaxed) {
                close(&store);
                return Err(signed_out("Cancelled"));
            }
            if started.elapsed() > GOOGLE_WAIT {
                close(&store);
                return Err(signed_out("Sign-in was cancelled"));
            }
            let snapshot = store.snapshot();
            let Some(current) = snapshot.tab(tab.as_str()) else {
                return Err(signed_out("Sign-in was cancelled"));
            };
            if current.url.starts_with(GOOGLE_REDIRECT) {
                break current.url.clone();
            }
            std::thread::sleep(POLL);
        };
        close(&store);
        let params = query_of(&address);
        if param(&params, "state") != Some(state.as_str()) {
            return Err(signed_out("Sign-in didn't match this request"));
        }
        let code =
            param(&params, "code").ok_or_else(|| signed_out("Google didn't grant access"))?;
        self.exchange_google_code(client_id, client_secret, code, &verifier)
    }

    fn exchange_google_code(
        &self,
        client_id: &str,
        client_secret: &str,
        code: &str,
        verifier: &str,
    ) -> Result<(), LiveError> {
        let net = self.net()?;
        let body = form(&[
            ("client_id", client_id),
            ("client_secret", client_secret),
            ("code", code),
            ("code_verifier", verifier),
            ("grant_type", "authorization_code"),
            ("redirect_uri", GOOGLE_REDIRECT),
        ]);
        let (json, _) = net.request(
            "POST",
            &self.endpoints.google_token(),
            &[(
                "Content-Type",
                "application/x-www-form-urlencoded".to_owned(),
            )],
            Some(body.into_bytes()),
        )?;
        let refresh = json
            .get("refresh_token")
            .and_then(Value::as_str)
            .ok_or_else(|| signed_out("Google didn't return a refresh token"))?;
        let access = json
            .get("access_token")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_owned();
        let expires_in = json
            .get("expires_in")
            .and_then(Value::as_i64)
            .unwrap_or(3600);
        let tokens = GoogleTokens {
            access_token: access.clone(),
            refresh_token: refresh.to_owned(),
            expires_at: now_ms() + expires_in * 1000,
            client_secret: client_secret.to_owned(),
        };
        if !self.secrets.set(
            &self.endpoints.account(LiveSourceId::Gdrive),
            &stored_google_tokens(&tokens),
        ) {
            return Err(LiveError::new(
                LiveErrorKind::Other,
                "The Keychain didn't save the sign-in",
            ));
        }
        let about = net
            .request(
                "GET",
                &format!("{}/about?fields=user", self.endpoints.drive()),
                &[("Authorization", bearer(&access))],
                None,
            )
            .ok()
            .map(|(json, _)| json);
        let user = |key: &str| {
            about
                .as_ref()
                .and_then(|a| a.pointer(&format!("/user/{key}")))
                .and_then(Value::as_str)
                .map(str::to_owned)
        };
        let login = user("emailAddress").unwrap_or_else(|| "Google Drive".into());
        let linked = account(login, user("displayName"), user("photoLink"), now_ms());
        self.update(true, |s| {
            s.config.google_client_id = client_id.to_owned();
            s.set_account(LiveSourceId::Gdrive, Some(linked));
        });
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn pkce_challenges_match_rfc_7636() {
        assert_eq!(
            pkce_challenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"),
            "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM"
        );
    }

    #[test]
    fn redirect_queries_are_read_like_the_old_flow() {
        let params = query_of("http://127.0.0.1:53682/ardia-oauth?state=ab&code=4%2F0A+x#frag");
        assert_eq!(param(&params, "state"), Some("ab"));
        assert_eq!(param(&params, "code"), Some("4/0A x"));
        assert_eq!(param(&params, "missing"), None);
    }

    #[test]
    fn device_replies_are_understood() {
        let start = device_start_of(&json!({
            "device_code": "d", "user_code": "ABCD-1234",
            "verification_uri": "https://github.com/login/device",
            "expires_in": 900, "interval": 5
        }))
        .expect("start");
        assert_eq!(start.user_code, "ABCD-1234");
        assert!(matches!(
            device_poll_of(&json!({"error": "authorization_pending"}), 5),
            DevicePoll::Wait
        ));
        assert!(matches!(
            device_poll_of(&json!({"error": "slow_down"}), 5),
            DevicePoll::SlowDown(10)
        ));
        assert!(matches!(
            device_poll_of(&json!({"error": "access_denied"}), 5),
            DevicePoll::Failed("Access was denied")
        ));
        assert!(matches!(
            device_poll_of(&json!({"access_token": "t"}), 5),
            DevicePoll::Token(ref t) if t == "t"
        ));
        assert_eq!(random_hex(64).len(), 64);
    }
}
