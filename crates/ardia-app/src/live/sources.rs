use std::collections::HashMap;

use ardia_state::live::documents::{
    CONFLUENCE_CQL, DRIVE_QUERY, map_bitbucket, map_confluence, map_drive, map_notion,
    notion_search_body,
};
use ardia_state::live::github::{
    self as gh, DETAILS_PAGE, Listing, SEARCH_AUTHORED, SEARCH_DIRECT, SEARCH_REVIEW,
};
use ardia_state::live::{
    CompletionState, LiveAccount, LiveError, LiveErrorKind, LiveFolder, LiveItem, LiveSourceId,
    LiveState, PullRequestSection,
};
use serde_json::{Value, json};

use crate::net::{NetError, Reply, Transport, encode, form};
use crate::secrets::SecretStore;

pub const LIST_SHARED_MS: i64 = 30_000;
pub const DETAILS_FRESH_MS: i64 = 10 * 60_000;
pub const PENDING_FRESH_MS: i64 = 60_000;
pub const FALLBACK_COOLDOWN_MS: i64 = 30_000;
const MAX_FALLBACK_COOLDOWN_MS: i64 = 15 * 60_000;
const RESERVE_RATIO: f64 = 0.1;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Endpoints {
    pub mock: Option<String>,
}

impl Endpoints {
    pub fn from_env() -> Endpoints {
        Endpoints {
            mock: std::env::var("ARDIA_LIVE_MOCK")
                .ok()
                .filter(|m| !m.is_empty()),
        }
    }

    fn pick(&self, mocked: &str, real: &str) -> String {
        match &self.mock {
            Some(base) => format!("{}{mocked}", base.trim_end_matches('/')),
            None => real.to_owned(),
        }
    }

    pub fn github_graphql(&self) -> String {
        self.pick("/github/graphql", "https://api.github.com/graphql")
    }

    pub fn github_web(&self) -> String {
        self.pick("/github", "https://github.com")
    }

    pub fn bitbucket(&self) -> String {
        self.pick("/bitbucket/2.0", "https://api.bitbucket.org/2.0")
    }

    pub fn notion(&self) -> String {
        self.pick("/notion/v1", "https://api.notion.com/v1")
    }

    pub fn confluence(&self, site: &str) -> String {
        self.pick("/confluence", site.trim_end_matches('/'))
    }

    pub fn google_auth(&self) -> String {
        self.pick(
            "/google/auth",
            "https://accounts.google.com/o/oauth2/v2/auth",
        )
    }

    pub fn google_token(&self) -> String {
        self.pick("/google/token", "https://oauth2.googleapis.com/token")
    }

    pub fn drive(&self) -> String {
        self.pick("/google/drive/v3", "https://www.googleapis.com/drive/v3")
    }

    pub fn account(&self, source: LiveSourceId) -> String {
        if self.mock.is_some() {
            format!("mock:{}", source.key())
        } else {
            source.key().to_owned()
        }
    }
}

pub fn check_reply(reply: &Reply) -> Result<Value, LiveError> {
    if reply.status == 401 {
        return Err(LiveError::new(LiveErrorKind::SignedOut, "Signed out"));
    }
    if reply.status == 403 && reply.header("x-github-sso").is_some() {
        return Err(LiveError::new(LiveErrorKind::Sso, "Needs Single Sign-On"));
    }
    if reply.status == 429
        || (reply.status == 403 && reply.header("x-ratelimit-remaining") == Some("0"))
    {
        return Err(LiveError::new(
            LiveErrorKind::RateLimited,
            "Rate Limit Exceeded",
        ));
    }
    if !reply.ok() {
        if reply.status == 403 && gh::names_rate_limit(&reply.text()) {
            return Err(LiveError::new(
                LiveErrorKind::RateLimited,
                "Rate Limit Exceeded",
            ));
        }
        let kind = if reply.status == 403 {
            LiveErrorKind::SignedOut
        } else {
            LiveErrorKind::Other
        };
        return Err(LiveError::new(
            kind,
            format!("The server answered {}", reply.status),
        ));
    }
    reply
        .json()
        .ok_or_else(|| LiveError::new(LiveErrorKind::Other, "The server's answer couldn't be read"))
}

pub struct Net<'a> {
    pub transport: &'a dyn Transport,
    pub endpoints: &'a Endpoints,
    pub secrets: &'a SecretStore,
}

impl Net<'_> {
    pub fn request(
        &self,
        method: &str,
        url: &str,
        headers: &[(&str, String)],
        body: Option<Vec<u8>>,
    ) -> Result<(Value, Reply), LiveError> {
        let mut all: Vec<(&str, String)> = vec![("Accept", "application/json".into())];
        all.extend(headers.iter().cloned());
        let reply = self
            .transport
            .send(method, url, &all, body)
            .map_err(|e| match e {
                NetError::Unreachable(_) | NetError::TimedOut => {
                    LiveError::new(LiveErrorKind::Network, "Couldn't connect")
                }
            })?;
        let value = check_reply(&reply)?;
        Ok((value, reply))
    }

    pub fn secret(&self, state: &LiveState, source: LiveSourceId) -> Result<String, LiveError> {
        self.secrets
            .get(&self.endpoints.account(source))
            .ok_or_else(|| {
                let kind = if state.accounts.contains_key(&source) {
                    LiveErrorKind::SignedOut
                } else {
                    LiveErrorKind::NotConfigured
                };
                LiveError::new(kind, "Not signed in")
            })
    }
}

fn base64(text: &str) -> String {
    const B64: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let bytes = text.as_bytes();
    let mut out = String::new();
    for chunk in bytes.chunks(3) {
        let n = (u32::from(chunk[0]) << 16)
            | (u32::from(*chunk.get(1).unwrap_or(&0)) << 8)
            | u32::from(*chunk.get(2).unwrap_or(&0));
        out.push(B64[(n >> 18) as usize & 63] as char);
        out.push(B64[(n >> 12) as usize & 63] as char);
        out.push(if chunk.len() > 1 {
            B64[(n >> 6) as usize & 63] as char
        } else {
            '='
        });
        out.push(if chunk.len() > 2 {
            B64[n as usize & 63] as char
        } else {
            '='
        });
    }
    out
}

pub fn basic(user: &str, secret: &str) -> String {
    format!("Basic {}", base64(&format!("{user}:{secret}")))
}

pub fn bearer(token: &str) -> String {
    format!("Bearer {token}")
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct Quota {
    limit: i64,
    remaining: i64,
    reset_at: i64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct Pause {
    attempt: u32,
    retry_at: i64,
}

#[derive(Clone, Debug, PartialEq)]
struct Detail {
    key: Option<String>,
    at: i64,
    item: Option<LiveItem>,
}

#[derive(Debug, Default)]
pub struct GithubClient {
    token: Option<String>,
    list: Option<(i64, Listing)>,
    details: HashMap<String, Detail>,
    quota: Option<Quota>,
    pause: Option<Pause>,
}

fn fallback_cooldown(attempt: u32) -> i64 {
    (FALLBACK_COOLDOWN_MS * 2i64.pow(attempt.saturating_sub(1).min(16)))
        .min(MAX_FALLBACK_COOLDOWN_MS)
}

pub fn retry_at_from(reply: &Reply, now: i64) -> Option<i64> {
    if let Some(seconds) = reply
        .header("retry-after")
        .map(str::trim)
        .and_then(|a| a.parse::<i64>().ok())
    {
        return Some(now + seconds * 1000);
    }
    reply
        .header("x-ratelimit-reset")
        .and_then(|r| r.parse::<i64>().ok())
        .map(|r| r * 1000)
        .filter(|r| *r > now)
}

impl GithubClient {
    fn adopt(&mut self, token: &str) {
        if self.token.as_deref() != Some(token) {
            *self = GithubClient {
                token: Some(token.to_owned()),
                ..GithubClient::default()
            };
        }
    }

    pub fn forget(&mut self) {
        *self = GithubClient::default();
    }

    pub fn blocked_until(&self, interactive: bool, now: i64) -> Option<i64> {
        let floor = if interactive {
            1.0
        } else {
            self.quota.map_or(0.0, |q| q.limit as f64 * RESERVE_RATIO)
        };
        let by_quota = self
            .quota
            .filter(|q| q.reset_at > now && (q.remaining as f64) < floor)
            .map(|q| q.reset_at);
        let by_pause = self
            .pause
            .filter(|p| !interactive && p.retry_at > now)
            .map(|p| p.retry_at);
        match (by_quota, by_pause) {
            (None, None) => None,
            (a, b) => Some(a.unwrap_or(0).max(b.unwrap_or(0))),
        }
    }

    pub fn paused_until(&self, now: i64) -> Option<i64> {
        self.blocked_until(false, now)
    }

    fn record(&mut self, quota: Quota) {
        if self.quota.is_some_and(|q| quota.reset_at < q.reset_at) {
            return;
        }
        self.quota = Some(quota);
    }

    fn observe(&mut self, reply: &Reply, body: &Value) {
        let num = |name: &str| reply.header(name).and_then(|v| v.parse::<i64>().ok());
        if let (Some(limit), Some(remaining), Some(reset)) = (
            num("x-ratelimit-limit"),
            num("x-ratelimit-remaining"),
            num("x-ratelimit-reset"),
        ) && limit > 0
            && remaining >= 0
        {
            self.record(Quota {
                limit,
                remaining,
                reset_at: reset * 1000,
            });
        }
        if let Some(rate) = body.pointer("/data/rateLimit")
            && let (Some(limit), Some(remaining), Some(reset)) = (
                rate.get("limit").and_then(Value::as_i64),
                rate.get("remaining").and_then(Value::as_i64),
                rate.get("resetAt")
                    .and_then(Value::as_str)
                    .and_then(gh::parse_rfc3339),
            )
            && limit > 0
            && remaining >= 0
        {
            self.record(Quota {
                limit,
                remaining,
                reset_at: reset,
            });
        }
    }

    fn rate_limited(&mut self, retry_at: Option<i64>, now: i64) {
        let previous = self.pause;
        let attempt = match previous {
            Some(p) if p.retry_at > now => p.attempt,
            Some(p) => p.attempt + 1,
            None => 1,
        };
        let proposed = retry_at
            .filter(|r| *r > now)
            .unwrap_or(now + fallback_cooldown(attempt));
        let retry_at = match previous {
            Some(p) if p.retry_at > now => p.retry_at.max(proposed),
            _ => proposed,
        };
        self.pause = Some(Pause { attempt, retry_at });
    }

    fn graphql(
        &mut self,
        net: &Net,
        interactive: bool,
        now: i64,
        query: &str,
        variables: Value,
    ) -> Result<Value, LiveError> {
        if self.blocked_until(interactive, now).is_some() {
            ardia_telemetry::counts::count("live_github_requests_held");
            return Err(LiveError::new(
                LiveErrorKind::RateLimited,
                "Waiting for the GitHub rate limit to reset",
            ));
        }
        let token = self.token.clone().unwrap_or_default();
        let body = json!({ "query": query, "variables": variables })
            .to_string()
            .into_bytes();
        let headers = [
            ("Authorization", bearer(&token)),
            ("Content-Type", "application/json".to_owned()),
        ];
        let mut all: Vec<(&str, String)> = vec![("Accept", "application/json".into())];
        all.extend(headers.iter().cloned());
        ardia_telemetry::counts::count("live_github_requests");
        let reply = net
            .transport
            .send("POST", &net.endpoints.github_graphql(), &all, Some(body))
            .map_err(|_| LiveError::new(LiveErrorKind::Network, "Couldn't connect"))?;
        let json = match check_reply(&reply) {
            Ok(json) => json,
            Err(error) if error.kind == LiveErrorKind::RateLimited => {
                ardia_telemetry::counts::count("live_github_rate_limited");
                self.rate_limited(retry_at_from(&reply, now), now);
                return Err(LiveError::new(
                    LiveErrorKind::RateLimited,
                    "Rate Limit Exceeded",
                ));
            }
            Err(error) => return Err(error),
        };
        self.observe(&reply, &json);
        if gh::graphql_rate_limited(&json, reply.header("x-ratelimit-remaining")) {
            ardia_telemetry::counts::count("live_github_rate_limited");
            self.rate_limited(retry_at_from(&reply, now), now);
            return Err(LiveError::new(
                LiveErrorKind::RateLimited,
                "Rate Limit Exceeded",
            ));
        }
        if self.pause.is_some_and(|p| p.retry_at <= now) {
            self.pause = None;
        }
        let has_error = json
            .get("errors")
            .and_then(Value::as_array)
            .is_some_and(|e| !e.is_empty());
        if has_error && json.get("data").is_none_or(Value::is_null) {
            return Err(LiveError::new(
                LiveErrorKind::Other,
                "GitHub couldn't answer that request",
            ));
        }
        Ok(json)
    }

    fn listing(&mut self, net: &Net, interactive: bool, now: i64) -> Result<Listing, LiveError> {
        if let Some((at, listing)) = &self.list
            && !interactive
            && now - at < LIST_SHARED_MS
        {
            return Ok(listing.clone());
        }
        let search = gh::search_query();
        let authored = self.graphql(
            net,
            interactive,
            now,
            &search,
            json!({ "q": SEARCH_AUTHORED }),
        )?;
        let review = self.graphql(
            net,
            interactive,
            now,
            &search,
            json!({ "q": SEARCH_REVIEW }),
        )?;
        let direct = self.graphql(
            net,
            interactive,
            now,
            &gh::direct_query(),
            json!({ "q": SEARCH_DIRECT }),
        )?;
        let listing = gh::listing_of(&authored, &review, &direct);
        if listing.blocked.is_some() {
            ardia_telemetry::counts::count("live_github_blocked_listings");
        }
        self.details.retain(|id, _| listing.keys.contains_key(id));
        self.list = Some((now, listing.clone()));
        Ok(listing)
    }

    fn ensure_details(
        &mut self,
        net: &Net,
        interactive: bool,
        now: i64,
        listing: &Listing,
        ids: &[String],
    ) -> Result<(), LiveError> {
        let stale: Vec<String> = ids
            .iter()
            .filter(|id| {
                let key = listing.keys.get(*id).cloned().flatten();
                let unsettled = |item: &Option<LiveItem>| {
                    item.as_ref().and_then(|i| i.pr.as_ref()).is_some_and(|p| {
                        p.checks.iter().any(|c| {
                            matches!(
                                c.state,
                                ardia_state::live::CheckState::Pending
                                    | ardia_state::live::CheckState::Queued
                            )
                        })
                    })
                };
                !self.details.get(*id).is_some_and(|d| {
                    key.is_some()
                        && d.key == key
                        && now - d.at
                            < if unsettled(&d.item) {
                                PENDING_FRESH_MS
                            } else {
                                DETAILS_FRESH_MS
                            }
                })
            })
            .cloned()
            .collect();
        ardia_telemetry::counts::add("live_github_details_fetched", stale.len() as u64);
        ardia_telemetry::counts::add(
            "live_github_details_reused",
            ids.len().saturating_sub(stale.len()) as u64,
        );
        for page in stale.chunks(DETAILS_PAGE) {
            let ids: Vec<String> = page.to_vec();
            let read = |client: &mut GithubClient| -> Result<Vec<Value>, LiveError> {
                let response = client.graphql(
                    net,
                    interactive,
                    now,
                    &gh::details_query(),
                    json!({ "ids": ids }),
                )?;
                gh::detail_nodes(&ids, &response)
            };
            let nodes = match read(self) {
                Err(e) if matches!(e.kind, LiveErrorKind::Other | LiveErrorKind::Network) => {
                    read(self)?
                }
                other => other?,
            };
            let by_id: HashMap<&str, &Value> = nodes
                .iter()
                .filter_map(|n| Some((n.get("id")?.as_str()?, n)))
                .collect();
            for id in page {
                let item = by_id
                    .get(id.as_str())
                    .filter(|n| n.get("state").and_then(Value::as_str) == Some("OPEN"))
                    .and_then(|n| gh::pr_item(n, None));
                let key = listing.keys.get(id).cloned().flatten();
                self.details
                    .insert(id.clone(), Detail { key, at: now, item });
            }
        }
        Ok(())
    }

    pub fn fetch_folder(
        &mut self,
        net: &Net,
        token: &str,
        folder: &LiveFolder,
        interactive: bool,
        now: i64,
    ) -> Result<Vec<LiveItem>, LiveError> {
        self.adopt(token);
        let listing = self.listing(net, interactive, now)?;
        let wanted = gh::sectioned(
            &listing,
            folder.filters.authored,
            folder.filters.review_requests,
        );
        let ids: Vec<String> = wanted.iter().map(|(id, _)| id.clone()).collect();
        self.ensure_details(net, interactive, now, &listing, &ids)?;
        let items: Vec<LiveItem> = wanted
            .into_iter()
            .filter_map(|(id, section)| {
                let mut item = self.details.get(&id)?.item.clone()?;
                item.section = Some(section);
                Some(item)
            })
            .collect();
        Ok(gh::with_stacks(items))
    }

    pub fn resolve_gone(
        &mut self,
        net: &Net,
        token: &str,
        items: &[LiveItem],
        interactive: bool,
        now: i64,
    ) -> Result<HashMap<String, CompletionState>, LiveError> {
        self.adopt(token);
        let by_id: HashMap<String, &LiveItem> = items
            .iter()
            .filter(|it| it.source == LiveSourceId::Github)
            .filter_map(|it| Some((it.id.strip_prefix("github:")?.to_owned(), it)))
            .collect();
        if by_id.is_empty() {
            return Ok(HashMap::new());
        }
        let ids: Vec<&String> = by_id.keys().collect();
        let json = self.graphql(
            net,
            interactive,
            now,
            gh::STATE_QUERY,
            json!({ "ids": ids }),
        )?;
        let mut out = HashMap::new();
        for node in json
            .pointer("/data/nodes")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
        {
            let Some(item) = node
                .get("id")
                .and_then(Value::as_str)
                .and_then(|id| by_id.get(id))
            else {
                continue;
            };
            match node.get("state").and_then(Value::as_str) {
                Some("MERGED") => {
                    out.insert(item.id.clone(), CompletionState::Merged);
                }
                Some("CLOSED") => {
                    out.insert(item.id.clone(), CompletionState::Closed);
                }
                _ if matches!(
                    item.section,
                    Some(PullRequestSection::Review | PullRequestSection::Team)
                ) =>
                {
                    out.insert(item.id.clone(), CompletionState::Reviewed);
                }
                _ => {}
            }
        }
        Ok(out)
    }

    pub fn warning(&self) -> Option<LiveError> {
        self.list.as_ref().and_then(|(_, l)| l.blocked.clone())
    }

    pub fn viewer(
        &mut self,
        net: &Net,
        token: &str,
        now: i64,
    ) -> Result<Option<Viewer>, LiveError> {
        self.adopt(token);
        let json = self.graphql(net, true, now, gh::VIEWER_QUERY, json!({}))?;
        Ok(json.pointer("/data/viewer").and_then(|v| {
            Some((
                v.get("login")?.as_str()?.to_owned(),
                v.get("name").and_then(Value::as_str).map(str::to_owned),
                v.get("avatarUrl")
                    .and_then(Value::as_str)
                    .map(str::to_owned),
            ))
        }))
    }
}

pub type Viewer = (String, Option<String>, Option<String>);

pub fn fetch_bitbucket(
    net: &Net,
    state: &LiveState,
    folder: &LiveFolder,
) -> Result<Vec<LiveItem>, LiveError> {
    if !folder.filters.authored {
        return Ok(Vec::new());
    }
    let auth = basic(
        &state.config.bitbucket_user,
        &net.secret(state, LiveSourceId::Bitbucket)?,
    );
    let me = state
        .accounts
        .get(&LiveSourceId::Bitbucket)
        .ok_or_else(|| LiveError::new(LiveErrorKind::SignedOut, "Not signed in"))?;
    let base = net.endpoints.bitbucket();
    let (page, _) = net.request(
        "GET",
        &format!(
            "{base}/pullrequests/{}?state=OPEN&pagelen=50",
            encode(&me.login)
        ),
        &[("Authorization", auth.clone())],
        None,
    )?;
    Ok(page
        .get("values")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|pr| {
            let repo = pr
                .pointer("/destination/repository/full_name")
                .and_then(Value::as_str)
                .unwrap_or_default();
            let id = pr.get("id").and_then(Value::as_u64).unwrap_or(0);
            let statuses = net
                .request(
                    "GET",
                    &format!("{base}/repositories/{repo}/pullrequests/{id}/statuses?pagelen=50"),
                    &[("Authorization", auth.clone())],
                    None,
                )
                .ok()
                .map(|(v, _)| v);
            map_bitbucket(pr, statuses.as_ref())
        })
        .collect())
}

pub fn resolve_bitbucket(
    net: &Net,
    state: &LiveState,
    items: &[LiveItem],
) -> Result<HashMap<String, CompletionState>, LiveError> {
    let auth = basic(
        &state.config.bitbucket_user,
        &net.secret(state, LiveSourceId::Bitbucket)?,
    );
    let base = net.endpoints.bitbucket();
    let mut out = HashMap::new();
    for it in items {
        let Some(pr) = &it.pr else {
            continue;
        };
        let Ok((value, _)) = net.request(
            "GET",
            &format!("{base}/repositories/{}/pullrequests/{}", pr.repo, pr.number),
            &[("Authorization", auth.clone())],
            None,
        ) else {
            continue;
        };
        match value.get("state").and_then(Value::as_str) {
            Some("MERGED") => {
                out.insert(it.id.clone(), CompletionState::Merged);
            }
            Some("DECLINED" | "SUPERSEDED") => {
                out.insert(it.id.clone(), CompletionState::Closed);
            }
            _ => {}
        }
    }
    Ok(out)
}

fn notion_headers(token: &str) -> Vec<(&'static str, String)> {
    vec![
        ("Authorization", bearer(token)),
        ("Notion-Version", "2022-06-28".into()),
        ("Content-Type", "application/json".into()),
    ]
}

pub fn fetch_notion(net: &Net, state: &LiveState) -> Result<Vec<LiveItem>, LiveError> {
    let token = net.secret(state, LiveSourceId::Notion)?;
    let base = net.endpoints.notion();
    let (pages, _) = net.request(
        "POST",
        &format!("{base}/search"),
        &notion_headers(&token),
        Some(notion_search_body().to_string().into_bytes()),
    )?;
    let users = net
        .request(
            "GET",
            &format!("{base}/users?page_size=100"),
            &notion_headers(&token),
            None,
        )
        .ok()
        .map(|(v, _)| v);
    let workspace = state
        .accounts
        .get(&LiveSourceId::Notion)
        .and_then(|a| a.name.clone());
    Ok(map_notion(&pages, users.as_ref(), workspace.as_deref()))
}

pub fn fetch_confluence(net: &Net, state: &LiveState) -> Result<Vec<LiveItem>, LiveError> {
    let site = state.config.confluence_site.clone();
    if site.is_empty() {
        return Err(LiveError::new(
            LiveErrorKind::NotConfigured,
            "No Confluence site",
        ));
    }
    let auth = basic(
        &state.config.confluence_email,
        &net.secret(state, LiveSourceId::Confluence)?,
    );
    let url = format!(
        "{}/wiki/rest/api/content/search?limit=30&expand=space,history.lastUpdated&cql={}",
        net.endpoints.confluence(&site),
        encode(CONFLUENCE_CQL)
    );
    let (json, _) = net.request("GET", &url, &[("Authorization", auth)], None)?;
    Ok(map_confluence(&json, &site))
}

#[derive(Clone, Debug, PartialEq)]
pub struct GoogleTokens {
    pub access_token: String,
    pub refresh_token: String,
    pub expires_at: i64,
    pub client_secret: String,
}

pub fn google_tokens_of(stored: &str) -> Result<GoogleTokens, LiveError> {
    let bad = || {
        LiveError::new(
            LiveErrorKind::SignedOut,
            "The saved Google sign-in can't be read",
        )
    };
    let raw: Value = serde_json::from_str(stored).map_err(|_| bad())?;
    let text = |k: &str| {
        raw.get(k)
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty())
            .map(str::to_owned)
    };
    Ok(GoogleTokens {
        access_token: text("access_token").ok_or_else(bad)?,
        refresh_token: text("refresh_token").ok_or_else(bad)?,
        client_secret: text("client_secret").ok_or_else(bad)?,
        expires_at: raw
            .get("expires_at")
            .and_then(Value::as_f64)
            .ok_or_else(bad)? as i64,
    })
}

pub fn stored_google_tokens(tokens: &GoogleTokens) -> String {
    json!({
        "access_token": tokens.access_token,
        "refresh_token": tokens.refresh_token,
        "expires_at": tokens.expires_at,
        "client_secret": tokens.client_secret,
    })
    .to_string()
}

pub fn google_access_token(net: &Net, state: &LiveState, now: i64) -> Result<String, LiveError> {
    let stored = google_tokens_of(&net.secret(state, LiveSourceId::Gdrive)?)?;
    if stored.expires_at > now + 60_000 {
        return Ok(stored.access_token);
    }
    let body = form(&[
        ("client_id", &state.config.google_client_id),
        ("client_secret", &stored.client_secret),
        ("refresh_token", &stored.refresh_token),
        ("grant_type", "refresh_token"),
    ]);
    let (json, _) = net.request(
        "POST",
        &net.endpoints.google_token(),
        &[("Content-Type", "application/x-www-form-urlencoded".into())],
        Some(body.into_bytes()),
    )?;
    let access = json
        .get("access_token")
        .and_then(Value::as_str)
        .ok_or_else(|| {
            LiveError::new(
                LiveErrorKind::SignedOut,
                "Google didn't refresh the sign-in",
            )
        })?
        .to_owned();
    let expires_in = json
        .get("expires_in")
        .and_then(Value::as_i64)
        .unwrap_or(3600);
    let next = GoogleTokens {
        access_token: access.clone(),
        expires_at: now + expires_in * 1000,
        ..stored
    };
    net.secrets.set(
        &net.endpoints.account(LiveSourceId::Gdrive),
        &stored_google_tokens(&next),
    );
    Ok(access)
}

pub fn fetch_drive(net: &Net, state: &LiveState, now: i64) -> Result<Vec<LiveItem>, LiveError> {
    let token = google_access_token(net, state, now)?;
    let query = DRIVE_QUERY
        .iter()
        .map(|(k, v)| format!("{k}={}", encode(v)))
        .collect::<Vec<_>>()
        .join("&");
    let (json, _) = net.request(
        "GET",
        &format!("{}/files?{query}", net.endpoints.drive()),
        &[("Authorization", bearer(&token))],
        None,
    )?;
    Ok(map_drive(&json))
}

pub fn account(
    login: impl Into<String>,
    name: Option<String>,
    avatar: Option<String>,
    now: i64,
) -> LiveAccount {
    LiveAccount {
        login: login.into(),
        name,
        avatar,
        connected_at: now,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::net::stub::{StubTransport, json as reply};

    fn net_with<'a>(
        transport: &'a StubTransport,
        endpoints: &'a Endpoints,
        secrets: &'a SecretStore,
    ) -> Net<'a> {
        Net {
            transport,
            endpoints,
            secrets,
        }
    }

    #[test]
    fn replies_map_to_live_errors() {
        let mut r = reply(401, json!({}));
        assert_eq!(
            check_reply(&r).map_err(|e| e.kind),
            Err(LiveErrorKind::SignedOut)
        );
        r.status = 403;
        r.headers.insert("x-ratelimit-remaining".into(), "0".into());
        assert_eq!(
            check_reply(&r).map_err(|e| e.kind),
            Err(LiveErrorKind::RateLimited)
        );
        assert_eq!(
            check_reply(&reply(500, json!({}))).map_err(|e| e.kind),
            Err(LiveErrorKind::Other)
        );
        assert!(check_reply(&reply(200, json!({"a": 1}))).is_ok());
        assert_eq!(basic("a", "b"), "Basic YTpi");
    }

    #[test]
    fn github_fetch_lists_then_reads_details_and_caches() {
        let dir = tempfile::tempdir().expect("dir");
        let secrets = SecretStore::isolated(dir.path().to_path_buf());
        let endpoints = Endpoints {
            mock: Some("http://stub".into()),
        };
        let pr = json!({"id": "PR_1", "state": "OPEN", "number": 1, "title": "One", "url": "https://github.com/a/b/pull/1", "isDraft": false, "updatedAt": "2026-01-01T00:00:00Z", "headRefName": "h", "baseRefName": "main", "mergeable": "MERGEABLE", "reviewDecision": null, "additions": 1, "deletions": 0, "changedFiles": 1, "repository": {"nameWithOwner": "a/b"}, "author": {"login": "me", "avatarUrl": "x"}, "comments": {"totalCount": 0}, "commits": {"nodes": []}});
        let transport = StubTransport::new(Box::new(move |_, url, body| {
            assert_eq!(url, "http://stub/github/graphql");
            let body: Value = serde_json::from_slice(body.unwrap_or_default()).unwrap_or_default();
            let query = body["query"].as_str().unwrap_or_default();
            if query.contains("LiveFolderSearch") {
                let q = body["variables"]["q"].as_str().unwrap_or_default();
                let nodes = if q.contains("author:@me") {
                    json!([{"id": "PR_1", "updatedAt": "t"}])
                } else {
                    json!([])
                };
                reply(200, json!({"data": {"search": {"nodes": nodes}}}))
            } else if query.contains("LiveFolderDirect") {
                reply(200, json!({"data": {"search": {"nodes": []}}}))
            } else {
                reply(200, json!({"data": {"nodes": [pr.clone()]}}))
            }
        }));
        let net = net_with(&transport, &endpoints, &secrets);
        let mut client = GithubClient::default();
        let folder: LiveFolder = serde_json::from_value(json!({"id": "f", "profileId": "p", "kind": "pullRequests", "name": "PRs", "sources": ["github"]})).expect("folder");
        let items = client
            .fetch_folder(&net, "tok", &folder, false, 0)
            .expect("items");
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].section, Some(PullRequestSection::Authored));
        let sent = transport.calls.lock().len();
        assert_eq!(sent, 4);
        client
            .fetch_folder(&net, "tok", &folder, false, 1000)
            .expect("cached");
        assert_eq!(transport.calls.lock().len(), sent);
        assert!(
            transport.calls.lock()[0]
                .2
                .iter()
                .any(|(k, v)| k == "Authorization" && v == "Bearer tok")
        );
    }

    #[test]
    fn rate_limits_pause_background_requests() {
        let mut client = GithubClient::default();
        client.rate_limited(None, 0);
        assert_eq!(client.paused_until(0), Some(FALLBACK_COOLDOWN_MS));
        assert_eq!(client.blocked_until(true, 0), None);
        client.rate_limited(None, FALLBACK_COOLDOWN_MS + 1);
        assert_eq!(
            client.paused_until(FALLBACK_COOLDOWN_MS + 1),
            Some(FALLBACK_COOLDOWN_MS + 1 + 2 * FALLBACK_COOLDOWN_MS)
        );
    }

    #[test]
    fn google_tokens_round_trip_and_refresh() {
        let dir = tempfile::tempdir().expect("dir");
        let secrets = SecretStore::isolated(dir.path().to_path_buf());
        let endpoints = Endpoints {
            mock: Some("http://stub".into()),
        };
        let stored = stored_google_tokens(&GoogleTokens {
            access_token: "old".into(),
            refresh_token: "r".into(),
            expires_at: 0,
            client_secret: "s".into(),
        });
        secrets.set("mock:gdrive", &stored);
        let transport = StubTransport::new(Box::new(|_, url, _| {
            if url.ends_with("/google/token") {
                reply(200, json!({"access_token": "new", "expires_in": 60}))
            } else {
                reply(
                    200,
                    json!({"files": [{"id": "d1", "name": "Doc", "mimeType": "application/pdf", "webViewLink": "https://d", "modifiedTime": "2026-01-01T00:00:00Z"}]}),
                )
            }
        }));
        let net = net_with(&transport, &endpoints, &secrets);
        let mut state = LiveState::default();
        state.config.google_client_id = "cid".into();
        let items = fetch_drive(&net, &state, 1000).expect("drive");
        assert_eq!(items[0].subtitle, "PDF");
        let saved =
            google_tokens_of(&secrets.get("mock:gdrive").unwrap_or_default()).expect("saved");
        assert_eq!(saved.access_token, "new");
        assert_eq!(saved.expires_at, 61_000);
    }
}
