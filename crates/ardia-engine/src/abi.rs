use std::ffi::{CStr, CString, c_char, c_void};
use std::panic::{AssertUnwindSafe, catch_unwind};
use std::sync::LazyLock;

#[cfg(any(target_os = "macos", test))]
use parking_lot::RwLock;
use serde_json::Value;
use zeroize::Zeroize;

use crate::error::{EngineError, EngineResult};
use crate::events::EngineEvent;
#[cfg(any(target_os = "macos", test))]
use crate::events::EventBus;
use crate::reply::{Completion, CompletionStatus, PendingRequests, Reply};
use crate::services::{SecretValue, ServiceArgs, ServiceName, decode_reply};
use crate::types::{DownloadEvent, DownloadItem, ServiceEvent, decode};

pub type AcEngineReply = unsafe extern "C" fn(context: *mut c_void, json: *const c_char);
pub type AcEngineCall = unsafe extern "C" fn(
    profile_dir: *const c_char,
    args_json: *const c_char,
    reply: AcEngineReply,
    context: *mut c_void,
);
pub type AcEngineEvent =
    unsafe extern "C" fn(context: *mut c_void, topic: *const c_char, json: *const c_char);
pub type AcEngineDispatch = unsafe extern "C" fn(
    name: *const c_char,
    profile_dir: *const c_char,
    args_json: *const c_char,
    reply: AcEngineReply,
    context: *mut c_void,
);
pub type AcEngineSetEventSink =
    unsafe extern "C" fn(sink: Option<AcEngineEvent>, context: *mut c_void);

pub const SET_EVENT_SINK_SYMBOL: &str = "ac_engine_set_event_sink";
pub const DISPATCH_SYMBOL: &str = "ac_engine_call";

#[derive(Clone, Copy, Debug)]
pub(crate) enum ServiceRoute {
    Dispatch(AcEngineDispatch),
    #[cfg(any(target_os = "macos", test))]
    Direct(AcEngineCall),
}

static SERVICE_REPLIES: LazyLock<PendingRequests> = LazyLock::new(PendingRequests::new);
pub(crate) static HOST_REPLIES: LazyLock<PendingRequests> = LazyLock::new(PendingRequests::new);

#[cfg(target_os = "macos")]
pub(crate) fn service_replies() -> &'static PendingRequests {
    &SERVICE_REPLIES
}

pub fn pending_service_replies() -> usize {
    SERVICE_REPLIES.len()
}

pub fn pending_host_replies() -> usize {
    HOST_REPLIES.len()
}

pub(crate) fn text_of(text: *const c_char) -> Option<String> {
    if text.is_null() {
        None
    } else {
        Some(
            unsafe { CStr::from_ptr(text) }
                .to_string_lossy()
                .into_owned(),
        )
    }
}

pub(crate) fn c_string(text: &str, what: &str) -> EngineResult<CString> {
    CString::new(text).map_err(|_| EngineError::bad_argument(format!("{what} holds a NUL byte")))
}

fn replied(registry: &PendingRequests, context: *mut c_void, json: *const c_char) {
    let request = context as usize as u64;
    let _ = catch_unwind(AssertUnwindSafe(|| {
        registry.complete_with(request, || Completion {
            status: CompletionStatus::Ok,
            json: text_of(json),
            bytes: None,
        });
    }));
}

pub(crate) unsafe extern "C" fn service_replied(context: *mut c_void, json: *const c_char) {
    replied(&SERVICE_REPLIES, context, json);
}

unsafe extern "C" fn host_replied(context: *mut c_void, json: *const c_char) {
    replied(&HOST_REPLIES, context, json);
}

fn service_answer(label: &str, completion: &Completion, secret: bool) -> EngineResult<Value> {
    match completion.status {
        CompletionStatus::Ok => decode_reply(label, completion.json.as_deref(), secret),
        CompletionStatus::Cancelled => Err(EngineError::Cancelled),
        CompletionStatus::Error => Err(EngineError::failed(format!(
            "{label} failed before the engine answered"
        ))),
    }
}

pub fn abandoned_host_opens() -> usize {
    HOST_REPLIES.abandoned()
}

pub(crate) fn abandon_host_calls(owner: u64) -> usize {
    HOST_REPLIES.abandon(owner)
}

pub(crate) unsafe extern "C" fn ignore_reply(_: *mut c_void, _: *const c_char) {}

#[cfg(test)]
pub(crate) fn call_with_callback(
    label: &str,
    done: impl FnOnce(EngineResult<Value>) + Send + 'static,
    invoke: impl FnOnce(AcEngineReply, *mut c_void),
) {
    call_owned(0, label, done, None, invoke)
}

pub(crate) fn call_owned(
    owner: u64,
    label: &str,
    done: impl FnOnce(EngineResult<Value>) + Send + 'static,
    if_abandoned: Option<Box<dyn FnOnce(EngineResult<Value>) + Send>>,
    invoke: impl FnOnce(AcEngineReply, *mut c_void),
) {
    let label = label.to_owned();
    let late_label = label.clone();
    let fallback = if_abandoned.map(|late| -> crate::reply::Waiter {
        Box::new(move |completion: Completion| {
            late(service_answer(&late_label, &completion, false))
        })
    });
    let request = HOST_REPLIES.register_owned(
        owner,
        Box::new(move |completion| done(service_answer(&label, &completion, false))),
        fallback,
    );
    let outcome = catch_unwind(AssertUnwindSafe(|| {
        invoke(host_replied, request as usize as *mut c_void)
    }));
    if outcome.is_err() {
        HOST_REPLIES.complete(
            request,
            Completion {
                status: CompletionStatus::Error,
                json: None,
                bytes: None,
            },
        );
    }
}

pub(crate) fn call_service(
    route: ServiceRoute,
    name: &ServiceName,
    profile_dir: &str,
    args: ServiceArgs,
) -> Reply<Value> {
    if args.is_secret() || name.is_secret() {
        return Reply::err(EngineError::bad_argument(format!(
            "{} carries secrets: use call_service_secret",
            name.as_str()
        )));
    }
    invoke_service(route, name, profile_dir, args, |value| value)
}

pub(crate) fn call_service_secret(
    route: ServiceRoute,
    name: &ServiceName,
    profile_dir: &str,
    args: ServiceArgs,
) -> Reply<SecretValue> {
    invoke_service(route, name, profile_dir, args, SecretValue::new)
}

fn invoke_service<T: Send + 'static>(
    route: ServiceRoute,
    name: &ServiceName,
    profile_dir: &str,
    args: ServiceArgs,
    wrap: fn(Value) -> T,
) -> Reply<T> {
    let profile = match c_string(profile_dir, "the profile folder") {
        Ok(profile) => profile,
        Err(error) => return Reply::err(error),
    };
    let secret = args.is_secret() || name.is_secret();
    let mut args = match args.into_c_string() {
        Ok(args) => args,
        Err(error) => return Reply::err(error),
    };
    let service = name.as_str().to_owned();
    let (request, reply) = SERVICE_REPLIES.register_reply(move |mut completion| {
        let answer = service_answer(&service, &completion, secret).map(wrap);
        if secret && let Some(text) = completion.json.as_mut() {
            text.zeroize();
        }
        answer
    });
    let context = request as usize as *mut c_void;
    let outcome = catch_unwind(AssertUnwindSafe(|| unsafe {
        match route {
            ServiceRoute::Dispatch(dispatch) => {
                let name = CString::new(name.as_str()).expect("service names are validated");
                dispatch(
                    name.as_ptr(),
                    profile.as_ptr(),
                    args.as_ptr(),
                    service_replied,
                    context,
                );
            }
            #[cfg(any(target_os = "macos", test))]
            ServiceRoute::Direct(call) => {
                call(profile.as_ptr(), args.as_ptr(), service_replied, context)
            }
        }
    }));
    if secret {
        let mut bytes = std::mem::take(&mut args).into_bytes_with_nul();
        bytes.zeroize();
    }
    if outcome.is_err() {
        SERVICE_REPLIES.complete(
            request,
            Completion {
                status: CompletionStatus::Error,
                json: None,
                bytes: None,
            },
        );
    }
    reply
}

pub fn cancel_service_replies() -> usize {
    SERVICE_REPLIES.cancel_all()
}

#[cfg(any(target_os = "macos", test))]
pub(crate) struct ServiceSink {
    bus: RwLock<Option<EventBus>>,
}

#[cfg(target_os = "macos")]
pub(crate) static SERVICE_SINK: ServiceSink = ServiceSink {
    bus: RwLock::new(None),
};

#[cfg(any(target_os = "macos", test))]
impl ServiceSink {
    pub(crate) fn attach(&self, bus: EventBus) {
        *self.bus.write() = Some(bus);
    }

    pub(crate) fn detach(&self) {
        *self.bus.write() = None;
    }

    pub(crate) fn context(&'static self) -> *mut c_void {
        self as *const Self as *mut c_void
    }

    fn deliver(&self, topic: &str, json: &str) {
        let bus = self.bus.read().clone();
        if let Some(bus) = bus {
            bus.publish(decode_service_event(topic, json));
        }
    }
}

#[cfg(any(target_os = "macos", test))]
pub(crate) unsafe extern "C" fn service_event(
    context: *mut c_void,
    topic: *const c_char,
    json: *const c_char,
) {
    if context.is_null() || topic.is_null() {
        return;
    }
    let _ = catch_unwind(AssertUnwindSafe(|| {
        let sink = unsafe { &*(context as *const ServiceSink) };
        let topic = unsafe { CStr::from_ptr(topic) }.to_string_lossy();
        let json = text_of(json).unwrap_or_else(|| "{}".into());
        sink.deliver(&topic, &json);
    }));
}

#[cfg(target_os = "macos")]
pub(crate) fn install_service_sink(set_sink: AcEngineSetEventSink, bus: EventBus) {
    SERVICE_SINK.attach(bus);
    unsafe { set_sink(Some(service_event), SERVICE_SINK.context()) };
}

pub fn decode_service_event(topic: &str, json: &str) -> EngineEvent {
    let payload: Value =
        serde_json::from_str(json).unwrap_or_else(|_| Value::Object(Default::default()));
    let profile = payload
        .get("profile")
        .and_then(Value::as_str)
        .map(str::to_owned);
    let off_the_record = payload
        .get("offTheRecord")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    match topic {
        "downloads.changed" if payload.get("download").is_some() => {
            EngineEvent::Download(DownloadEvent::Changed {
                profile,
                item: Box::new(decode::<DownloadItem>(payload.get("download"))),
            })
        }
        "downloads.removed" => EngineEvent::Download(DownloadEvent::Removed {
            profile,
            id: payload
                .get("id")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_owned(),
            off_the_record,
        }),
        _ => EngineEvent::Service(ServiceEvent {
            topic: topic.to_owned(),
            profile,
            off_the_record,
            payload,
        }),
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use crate::services::ServiceArgs;
    use futures::executor::block_on;
    use parking_lot::Mutex;
    use serde_json::json;
    use std::sync::{Arc, LazyLock};

    pub(crate) static CALLS: LazyLock<Mutex<Vec<(String, String, String)>>> =
        LazyLock::new(|| Mutex::new(Vec::new()));
    static DEFERRED: LazyLock<Mutex<Vec<(usize, AcEngineReply)>>> =
        LazyLock::new(|| Mutex::new(Vec::new()));
    static HELD: LazyLock<Mutex<Vec<(usize, AcEngineReply)>>> =
        LazyLock::new(|| Mutex::new(Vec::new()));

    unsafe extern "C" fn fake_dispatch(
        name: *const c_char,
        profile: *const c_char,
        args: *const c_char,
        reply: AcEngineReply,
        context: *mut c_void,
    ) {
        let name = text_of(name).unwrap();
        let profile = text_of(profile).unwrap();
        let args = text_of(args).unwrap();
        CALLS.lock().push((name.clone(), profile, args.clone()));
        match name.as_str() {
            "ac_echo" => {
                let reply_text = CString::new(format!("{{\"echo\":{args}}}")).unwrap();
                unsafe { reply(context, reply_text.as_ptr()) };
            }
            "ac_later" => DEFERRED.lock().push((context as usize, reply)),
            "ac_held" => HELD.lock().push((context as usize, reply)),
            "ac_null" => unsafe { reply(context, std::ptr::null()) },
            "ac_twice" => {
                let first = CString::new("{\"n\":1}").unwrap();
                let second = CString::new("{\"n\":2}").unwrap();
                unsafe {
                    reply(context, first.as_ptr());
                    reply(context, second.as_ptr());
                }
            }
            _ => {
                let error = CString::new("{\"error\":\"unknown engine service\"}").unwrap();
                unsafe { reply(context, error.as_ptr()) };
            }
        }
    }

    unsafe extern "C" fn fake_direct(
        profile: *const c_char,
        args: *const c_char,
        reply: AcEngineReply,
        context: *mut c_void,
    ) {
        CALLS.lock().push((
            "direct".into(),
            text_of(profile).unwrap(),
            text_of(args).unwrap(),
        ));
        let ok = CString::new("{\"ok\":true}").unwrap();
        unsafe { reply(context, ok.as_ptr()) };
    }

    fn name(text: &str) -> ServiceName {
        ServiceName::new(text).unwrap()
    }

    #[test]
    fn dispatch_frames_name_profile_and_args() {
        let reply = call_service(
            ServiceRoute::Dispatch(fake_dispatch),
            &name("ac_echo"),
            "/tmp/Default",
            ServiceArgs::object(&json!({"maxUrls": 5})).unwrap(),
        );
        assert_eq!(block_on(reply), Ok(json!({"echo": {"maxUrls": 5}})));
        let calls = CALLS.lock();
        let call = calls.iter().rev().find(|(n, _, _)| n == "ac_echo").unwrap();
        assert_eq!(call.1, "/tmp/Default");
        assert_eq!(call.2, "{\"maxUrls\":5}");
    }

    #[test]
    fn direct_calls_resolve() {
        let reply = call_service(
            ServiceRoute::Direct(fake_direct),
            &name("ac_x"),
            "",
            ServiceArgs::empty(),
        );
        assert_eq!(block_on(reply), Ok(json!({"ok": true})));
    }

    #[test]
    fn engine_errors_become_service_errors() {
        let reply = call_service(
            ServiceRoute::Dispatch(fake_dispatch),
            &name("ac_missing"),
            "",
            ServiceArgs::empty(),
        );
        assert_eq!(
            block_on(reply),
            Err(EngineError::MissingService("ac_missing".into()))
        );
        let null = call_service(
            ServiceRoute::Dispatch(fake_dispatch),
            &name("ac_null"),
            "",
            ServiceArgs::empty(),
        );
        assert!(matches!(block_on(null), Err(EngineError::BadReply(_))));
    }

    #[test]
    fn late_and_duplicate_replies_are_safe() {
        let mut reply = call_service(
            ServiceRoute::Dispatch(fake_dispatch),
            &name("ac_later"),
            "",
            ServiceArgs::empty(),
        );
        assert_eq!(reply.try_take(), None);
        let (context, deliver) = DEFERRED.lock().pop().unwrap();
        let text = CString::new("{\"late\":true}").unwrap();
        unsafe {
            deliver(context as *mut c_void, text.as_ptr());
            deliver(context as *mut c_void, text.as_ptr());
        }
        assert_eq!(reply.try_take(), Some(Ok(json!({"late": true}))));
        let twice = call_service(
            ServiceRoute::Dispatch(fake_dispatch),
            &name("ac_twice"),
            "",
            ServiceArgs::empty(),
        );
        assert_eq!(block_on(twice), Ok(json!({"n": 1})));
        unsafe { service_replied(usize::MAX as *mut c_void, text.as_ptr()) };
    }

    #[test]
    fn cancelled_and_abandoned_replies_settle_cleanly() {
        let reply = call_service(
            ServiceRoute::Dispatch(fake_dispatch),
            &name("ac_held"),
            "",
            ServiceArgs::empty(),
        );
        let (context, _) = HELD.lock().pop().unwrap();
        assert!(SERVICE_REPLIES.cancel(context as u64));
        assert_eq!(block_on(reply), Err(EngineError::Cancelled));
        let secret = call_service_secret(
            ServiceRoute::Dispatch(fake_dispatch),
            &name("ac_held"),
            "",
            ServiceArgs::secret(zeroize::Zeroizing::new("{\"id\":\"p\"}".into())).unwrap(),
        );
        let (context, deliver) = HELD.lock().pop().unwrap();
        drop(secret);
        assert!(!SERVICE_REPLIES.complete_with(context as u64, || panic!("built a late reply")));
        let text = CString::new("{\"password\":\"hunter2\"}").unwrap();
        unsafe { deliver(context as *mut c_void, text.as_ptr()) };
        let callback = Arc::new(Mutex::new(None));
        let seen = callback.clone();
        call_with_callback(
            "tab.create",
            move |result| *seen.lock() = Some(result),
            |reply, context| HELD.lock().push((context as usize, reply)),
        );
        let (context, reply) = HELD.lock().pop().unwrap();
        assert!(
            std::ptr::fn_addr_eq(reply, host_replied as AcEngineReply),
            "host lifecycle replies don't share the service registry"
        );
        assert!(HOST_REPLIES.cancel(context as u64));
        assert_eq!(callback.lock().take(), Some(Err(EngineError::Cancelled)));
        call_with_callback(
            "tab.create",
            {
                let seen = callback.clone();
                move |result| *seen.lock() = Some(result)
            },
            |reply, context| HELD.lock().push((context as usize, reply)),
        );
        let (context, reply) = HELD.lock().pop().unwrap();
        let answer = CString::new("{\"tab\":4}").unwrap();
        unsafe { reply(context as *mut c_void, answer.as_ptr()) };
        assert_eq!(callback.lock().take(), Some(Ok(json!({"tab": 4}))));
    }

    #[test]
    fn secret_services_refuse_the_plain_path() {
        let before = CALLS.lock().len();
        let reply = call_service(
            ServiceRoute::Dispatch(fake_dispatch),
            &name("ac_passwords_reveal"),
            "",
            ServiceArgs::object(&json!({"origin": "https://a.test"})).unwrap(),
        );
        assert!(matches!(block_on(reply), Err(EngineError::BadArgument(_))));
        assert!(
            CALLS.lock()[before..]
                .iter()
                .all(|(name, _, _)| name != "ac_passwords_reveal")
        );
        assert!(
            decode_reply(
                "ac_passwords_reveal",
                Some("{\"error\":\"No such password\"}"),
                true
            )
            .is_err()
        );
    }

    #[test]
    fn nul_bytes_are_refused_before_the_engine_sees_them() {
        let reply = call_service(
            ServiceRoute::Dispatch(fake_dispatch),
            &name("ac_echo"),
            "bad\0dir",
            ServiceArgs::empty(),
        );
        assert!(matches!(block_on(reply), Err(EngineError::BadArgument(_))));
    }

    #[test]
    fn service_events_decode_downloads_and_topics() {
        let changed = decode_service_event(
            "downloads.changed",
            &json!({"profile": "/p", "download": {"id": "g1", "state": "in_progress", "received": 10.0, "total": -1.0, "paused": 0}})
                .to_string(),
        );
        match changed {
            EngineEvent::Download(DownloadEvent::Changed { profile, item }) => {
                assert_eq!(profile.as_deref(), Some("/p"));
                assert_eq!(item.id, "g1");
                assert!(!item.paused);
            }
            other => panic!("unexpected {other:?}"),
        }
        let removed =
            decode_service_event("downloads.removed", "{\"id\":\"g2\",\"offTheRecord\":true}");
        assert_eq!(
            removed,
            EngineEvent::Download(DownloadEvent::Removed {
                profile: None,
                id: "g2".into(),
                off_the_record: true
            })
        );
        let bookmarks = decode_service_event("bookmarks.changed", "{\"profile\":\"/p\"}");
        match bookmarks {
            EngineEvent::Service(event) => {
                assert_eq!(
                    event.topic_kind(),
                    crate::types::ServiceTopic::BookmarksChanged
                );
                assert_eq!(event.profile.as_deref(), Some("/p"));
            }
            other => panic!("unexpected {other:?}"),
        }
        assert!(matches!(
            decode_service_event("x", "not json"),
            EngineEvent::Service(_)
        ));
    }

    #[test]
    fn sink_trampoline_publishes_to_the_attached_bus() {
        static SINK: ServiceSink = ServiceSink {
            bus: RwLock::new(None),
        };
        let bus = EventBus::new();
        let events = bus.subscribe();
        SINK.attach(bus);
        let topic = CString::new("history.changed").unwrap();
        let json = CString::new("{\"profile\":\"/p\"}").unwrap();
        unsafe {
            service_event(SINK.context(), topic.as_ptr(), json.as_ptr());
            service_event(SINK.context(), std::ptr::null(), json.as_ptr());
            service_event(std::ptr::null_mut(), topic.as_ptr(), json.as_ptr());
            service_event(SINK.context(), topic.as_ptr(), std::ptr::null());
        }
        let drained = events.drain();
        assert_eq!(drained.len(), 2);
        SINK.detach();
        unsafe { service_event(SINK.context(), topic.as_ptr(), json.as_ptr()) };
        assert!(events.drain().is_empty());
    }
}
