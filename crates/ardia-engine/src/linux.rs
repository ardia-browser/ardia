use serde_json::Value;

use crate::desktop::{
    ApiTransport, ArdiaEngineApi, DesktopEngine, DesktopTransport, Done, ServiceTransport, Sink,
    standalone_api_entry,
};
use crate::error::{EngineError, EngineResult};
use crate::loader::{EngineLibrary, LoaderEnvironment, Platform, describe_attempts};
use crate::reply::Reply;
use crate::services::{SecretValue, ServiceArgs, ServiceName};
use crate::types::EngineBackend;

pub enum LinuxTransport {
    Api(ApiTransport),
    Services(ServiceTransport),
}

impl DesktopTransport for LinuxTransport {
    fn backend(&self) -> EngineBackend {
        EngineBackend::Linux
    }

    fn has_host_calls(&self) -> bool {
        matches!(self, Self::Api(_))
    }

    fn host_call(&self, verb: &str, args: &Value, window: u64, done: Done) {
        match self {
            Self::Api(api) => api.host_call(verb, args, window, done),
            Self::Services(services) => services.host_call(verb, args, window, done),
        }
    }

    fn engine_call(&self, name: &ServiceName, profile: &str, args: ServiceArgs) -> Reply<Value> {
        match self {
            Self::Api(api) => api.engine_call(name, profile, args),
            Self::Services(services) => services.engine_call(name, profile, args),
        }
    }

    fn engine_call_secret(
        &self,
        name: &ServiceName,
        profile: &str,
        args: ServiceArgs,
    ) -> Reply<SecretValue> {
        match self {
            Self::Api(api) => api.engine_call_secret(name, profile, args),
            Self::Services(services) => services.engine_call_secret(name, profile, args),
        }
    }

    fn install_sink(&self, sink: Sink) -> EngineResult<()> {
        match self {
            Self::Api(api) => api.install_sink(sink),
            Self::Services(services) => services.install_sink(sink),
        }
    }

    fn remove_sink(&self) {
        match self {
            Self::Api(api) => api.remove_sink(),
            Self::Services(services) => services.remove_sink(),
        }
    }

    fn abandon_host_calls(&self) {
        if let Self::Api(api) = self {
            api.abandon_host_calls();
        }
    }
}

pub type LinuxEngine = DesktopEngine<LinuxTransport>;

pub fn on_main_thread() -> bool {
    unsafe { libc::syscall(libc::SYS_gettid) == libc::getpid() as libc::c_long }
}

#[allow(clippy::missing_safety_doc)]
pub unsafe fn from_api(api: *const ArdiaEngineApi) -> EngineResult<LinuxEngine> {
    if !on_main_thread() {
        return Err(EngineError::WrongThread);
    }
    let transport = unsafe { ApiTransport::new(api, EngineBackend::Linux) }?;
    DesktopEngine::new(LinuxTransport::Api(transport))
}

#[allow(clippy::missing_safety_doc)]
pub unsafe fn load() -> EngineResult<LinuxEngine> {
    if !on_main_thread() {
        return Err(EngineError::WrongThread);
    }
    let library = unsafe {
        EngineLibrary::find(
            Platform::Linux,
            &LoaderEnvironment::current(Platform::Linux),
        )
    }
    .map_err(|attempts| EngineError::NotLoaded(describe_attempts(&attempts)))?;
    unsafe { from_library(library) }
}

#[allow(clippy::missing_safety_doc)]
pub unsafe fn from_library(library: &'static EngineLibrary) -> EngineResult<LinuxEngine> {
    if !on_main_thread() {
        return Err(EngineError::WrongThread);
    }
    let entry = standalone_api_entry(library)?;
    unsafe { from_api(entry()) }
}

#[allow(clippy::missing_safety_doc)]
pub unsafe fn from_embedded_services(library: &'static EngineLibrary) -> EngineResult<LinuxEngine> {
    if !on_main_thread() {
        return Err(EngineError::WrongThread);
    }
    let missing =
        |what: &str| EngineError::NotLoaded(format!("{} has no {what}", library.path().display()));
    let dispatch = library
        .dispatcher()
        .ok_or_else(|| missing("ac_engine_call"))?;
    let set_sink = library
        .set_event_sink()
        .ok_or_else(|| missing("ac_engine_set_event_sink"))?;
    let transport = unsafe { ServiceTransport::new(dispatch, set_sink, EngineBackend::Linux) };
    DesktopEngine::new(LinuxTransport::Services(transport))
}
