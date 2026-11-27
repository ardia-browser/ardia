use std::collections::HashMap;
use std::sync::{Arc, OnceLock};
use std::time::Duration;

use futures::AsyncReadExt as _;
use futures::FutureExt as _;
use http_client::{AsyncBody, HttpClient, Method, Request};

pub const REQUEST_TIMEOUT: Duration = Duration::from_secs(30);

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Reply {
    pub status: u16,
    pub headers: HashMap<String, String>,
    pub body: Vec<u8>,
}

impl Reply {
    pub fn header(&self, name: &str) -> Option<&str> {
        self.headers
            .get(&name.to_ascii_lowercase())
            .map(String::as_str)
    }

    pub fn json(&self) -> Option<serde_json::Value> {
        serde_json::from_slice(&self.body).ok()
    }

    pub fn text(&self) -> String {
        String::from_utf8_lossy(&self.body).into_owned()
    }

    pub fn ok(&self) -> bool {
        (200..300).contains(&self.status)
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum NetError {
    Unreachable(String),
    TimedOut,
}

pub trait Transport: Send + Sync {
    fn send(
        &self,
        method: &str,
        url: &str,
        headers: &[(&str, String)],
        body: Option<Vec<u8>>,
    ) -> Result<Reply, NetError>;
}

pub struct HttpTransport {
    client: Arc<dyn HttpClient>,
}

impl HttpTransport {
    pub fn new() -> Option<HttpTransport> {
        let agent = format!("Ardia/{}", env!("CARGO_PKG_VERSION"));
        let client = reqwest_client::ReqwestClient::user_agent(&agent).ok()?;
        Some(HttpTransport {
            client: Arc::new(client),
        })
    }
}

pub fn shared() -> Option<Arc<dyn Transport>> {
    static SHARED: OnceLock<Option<Arc<dyn Transport>>> = OnceLock::new();
    SHARED
        .get_or_init(|| HttpTransport::new().map(|t| Arc::new(t) as Arc<dyn Transport>))
        .clone()
}

fn timer(after: Duration) -> futures::channel::oneshot::Receiver<()> {
    let (done, wait) = futures::channel::oneshot::channel();
    std::thread::spawn(move || {
        std::thread::sleep(after);
        let _ = done.send(());
    });
    wait
}

impl Transport for HttpTransport {
    fn send(
        &self,
        method: &str,
        url: &str,
        headers: &[(&str, String)],
        body: Option<Vec<u8>>,
    ) -> Result<Reply, NetError> {
        ardia_profile::strict::blocking(ardia_profile::strict::Blocking::Network);
        let method = Method::from_bytes(method.as_bytes()).unwrap_or(Method::GET);
        let mut builder = Request::builder().method(method).uri(url);
        for (name, value) in headers {
            builder = builder.header(*name, value.as_str());
        }
        let request = builder
            .body(body.map_or_else(AsyncBody::empty, AsyncBody::from))
            .map_err(|e| NetError::Unreachable(e.to_string()))?;
        let client = Arc::clone(&self.client);
        let work = async move {
            let response = client
                .send(request)
                .await
                .map_err(|e| NetError::Unreachable(e.to_string()))?;
            let status = response.status().as_u16();
            let headers = response
                .headers()
                .iter()
                .filter_map(|(k, v)| {
                    Some((k.as_str().to_ascii_lowercase(), v.to_str().ok()?.to_owned()))
                })
                .collect();
            let mut body = Vec::new();
            let mut stream = response.into_body();
            stream
                .read_to_end(&mut body)
                .await
                .map_err(|e| NetError::Unreachable(e.to_string()))?;
            Ok(Reply {
                status,
                headers,
                body,
            })
        };
        let deadline = timer(REQUEST_TIMEOUT);
        futures::executor::block_on(async move {
            futures::select! {
                reply = work.fuse() => reply,
                _ = deadline.fuse() => Err(NetError::TimedOut),
            }
        })
    }
}

pub fn form(fields: &[(&str, &str)]) -> String {
    fields
        .iter()
        .map(|(k, v)| format!("{}={}", encode(k), encode(v)))
        .collect::<Vec<_>>()
        .join("&")
}

pub fn encode(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for byte in text.bytes() {
        if byte.is_ascii_alphanumeric() || b"-_.!~*'()".contains(&byte) {
            out.push(byte as char);
        } else {
            out.push_str(&format!("%{byte:02X}"));
        }
    }
    out
}

#[cfg(test)]
pub mod stub {
    use super::*;
    use parking_lot::Mutex;

    pub type Handler = Box<dyn Fn(&str, &str, Option<&[u8]>) -> Reply + Send + Sync>;
    pub type Call = (String, String, Vec<(String, String)>, Option<Vec<u8>>);

    pub struct StubTransport {
        pub handler: Handler,
        pub calls: Mutex<Vec<Call>>,
    }

    impl StubTransport {
        pub fn new(handler: Handler) -> Arc<StubTransport> {
            Arc::new(StubTransport {
                handler,
                calls: Mutex::new(Vec::new()),
            })
        }
    }

    impl Transport for StubTransport {
        fn send(
            &self,
            method: &str,
            url: &str,
            headers: &[(&str, String)],
            body: Option<Vec<u8>>,
        ) -> Result<Reply, NetError> {
            self.calls.lock().push((
                method.to_owned(),
                url.to_owned(),
                headers
                    .iter()
                    .map(|(k, v)| ((*k).to_owned(), v.clone()))
                    .collect(),
                body.clone(),
            ));
            Ok((self.handler)(method, url, body.as_deref()))
        }
    }

    pub fn json(status: u16, value: serde_json::Value) -> Reply {
        Reply {
            status,
            headers: HashMap::new(),
            body: value.to_string().into_bytes(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn forms_encode_like_encode_uri_component() {
        assert_eq!(form(&[("a b", "c&d"), ("x", "é")]), "a%20b=c%26d&x=%C3%A9");
    }

    #[test]
    fn reply_headers_are_case_insensitive() {
        let mut reply = Reply::default();
        reply
            .headers
            .insert("x-ratelimit-remaining".into(), "0".into());
        assert_eq!(reply.header("X-RateLimit-Remaining"), Some("0"));
    }
}
