use std::path::Path;

use ardia_state::persistence::DataDir;
use ardia_state::persistence::documents::{DocRead, read_versioned};
use serde_json::Value;

pub const DOC: &str = "telemetry.json";
pub const VERSION: u64 = 2;

pub fn install_id(dir: &Path) -> Option<String> {
    match read_versioned(&DataDir::new(dir), DOC, "version", VERSION) {
        DocRead::Usable { doc, .. } => doc
            .get("installId")
            .and_then(Value::as_str)
            .filter(|id| !id.is_empty())
            .map(str::to_owned),
        _ => None,
    }
}

pub fn upcoming_install_id() -> String {
    if let Some(client) = ardia_telemetry::client() {
        return client.upcoming_install_id();
    }
    static UPCOMING: std::sync::OnceLock<String> = std::sync::OnceLock::new();
    UPCOMING
        .get_or_init(|| uuid::Uuid::new_v4().to_string())
        .clone()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_install_id_comes_from_the_saved_choice() {
        let dir = tempfile::tempdir().expect("dir");
        assert_eq!(install_id(dir.path()), None);
        std::fs::write(
            dir.path().join(DOC),
            r#"{"version":2,"sharing":true,"installId":"abc-123"}"#,
        )
        .expect("write");
        assert_eq!(install_id(dir.path()).as_deref(), Some("abc-123"));
        assert_eq!(upcoming_install_id(), upcoming_install_id());
    }
}
