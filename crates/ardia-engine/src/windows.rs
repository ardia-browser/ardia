use crate::desktop::{ApiTransport, ArdiaEngineApi, DesktopEngine};
use crate::error::EngineResult;
use crate::types::EngineBackend;

pub type WindowsEngine = DesktopEngine<ApiTransport>;

#[allow(clippy::missing_safety_doc)]
pub unsafe fn from_api(api: *const ArdiaEngineApi) -> EngineResult<WindowsEngine> {
    DesktopEngine::new(unsafe { ApiTransport::new(api, EngineBackend::Windows) }?)
}
