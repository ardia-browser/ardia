use serde_json::{Map, Value, json};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Environment {
    Dev,
    Test,
    Production,
}

impl Environment {
    pub fn as_str(self) -> &'static str {
        match self {
            Environment::Dev => "dev",
            Environment::Test => "test",
            Environment::Production => "production",
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AppInfo {
    pub app_version: String,
    pub app_build: Option<String>,
    pub os: &'static str,
    pub os_type: &'static str,
    pub os_version: Option<String>,
    pub arch: &'static str,
    pub dev: bool,
    pub isolated: bool,
    pub engine_version: Option<String>,
    pub process_start: Option<i64>,
    pub boot_time: Option<i64>,
}

impl Default for AppInfo {
    fn default() -> Self {
        AppInfo {
            app_version: env!("CARGO_PKG_VERSION").to_owned(),
            app_build: None,
            os: platform_os(),
            os_type: platform_os_type(),
            os_version: None,
            arch: host_arch(),
            dev: cfg!(debug_assertions),
            isolated: false,
            engine_version: None,
            process_start: None,
            boot_time: None,
        }
    }
}

pub fn platform_os() -> &'static str {
    if cfg!(target_os = "windows") {
        "Windows"
    } else if cfg!(target_os = "linux") {
        "Linux"
    } else {
        "macOS"
    }
}

pub fn platform_os_type() -> &'static str {
    if cfg!(target_os = "windows") {
        "windows"
    } else if cfg!(target_os = "linux") {
        "linux"
    } else {
        "darwin"
    }
}

pub fn host_arch() -> &'static str {
    if cfg!(target_arch = "aarch64") {
        "arm64"
    } else {
        "x86_64"
    }
}

impl AppInfo {
    pub fn environment(&self) -> Environment {
        if self.dev {
            Environment::Dev
        } else if self.isolated {
            Environment::Test
        } else {
            Environment::Production
        }
    }

    pub fn context(&self, session_id: &str, watch_report: Option<String>) -> Map<String, Value> {
        let mut out = Map::new();
        out.insert("$lib".into(), json!("ardia-telemetry"));
        out.insert("$lib_version".into(), json!("1"));
        out.insert("$app_name".into(), json!("Ardia"));
        out.insert("$app_version".into(), json!(self.app_version));
        out.insert("$app_build".into(), json!(self.app_build));
        out.insert("$os".into(), json!(self.os));
        out.insert("$os_version".into(), json!(self.os_version));
        out.insert("arch".into(), json!(self.arch));
        out.insert("engine_version".into(), json!(self.engine_version));
        out.insert("$environment".into(), json!(self.environment().as_str()));
        out.insert("$process_person_profile".into(), json!(false));
        out.insert("$geoip_disable".into(), json!(true));
        out.insert("$session_id".into(), json!(session_id));
        if let Some(report) = watch_report {
            out.insert("watch_report".into(), json!(report));
        }
        out
    }

    pub fn resource(&self) -> Map<String, Value> {
        let production = self.environment() == Environment::Production;
        let mut out = Map::new();
        out.insert("service.name".into(), json!("ardia-app"));
        out.insert("service.version".into(), json!(self.app_version));
        out.insert(
            "deployment.environment".into(),
            json!(if production {
                "production"
            } else {
                "development"
            }),
        );
        out.insert("os.type".into(), json!(self.os_type));
        out.insert("os.version".into(), json!(self.os_version));
        out.insert("host.arch".into(), json!(self.arch));
        out.insert("engine.version".into(), json!(self.engine_version));
        out
    }

    pub fn daily_resource(&self) -> Map<String, Value> {
        let production = self.environment() == Environment::Production;
        let mut out = Map::new();
        out.insert("service.name".into(), json!("ardia-app"));
        out.insert("service.version".into(), json!(self.app_version));
        out.insert(
            "deployment.environment".into(),
            json!(if production {
                "production"
            } else {
                "development"
            }),
        );
        out
    }
}
