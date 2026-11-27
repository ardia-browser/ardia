use std::ffi::OsString;
use std::path::{Path, PathBuf};

use ardia_engine::LaunchOptions;

pub const DATA_DIR_ENV: &str = "ARDIA_DATA_DIR";
pub const BACKGROUND_ENV: &str = "ARDIA_BACKGROUND";
pub const MOCK_ENGINE_ENV: &str = "ARDIA_MOCK_ENGINE";
pub const REMOTE_DEBUGGING_PORT_ENV: &str = "ARDIA_REMOTE_DEBUGGING_PORT";
pub const FRAMEWORK_ENV: &str = "ARDIACORE_FRAMEWORK";

pub const USAGE: &str = "\
Usage: ardia [options] [url ...] [-- engine switches]

Options:
  --data-dir <path>              Keep everything in <path> (or set ARDIA_DATA_DIR)
  --mock-engine                  Run the UI on the mock engine, without Chromium (or ARDIA_MOCK_ENGINE=1)
  --background                   Never take focus or show dialogs (or ARDIA_BACKGROUND=1)
  --remote-debugging-port <port> Open Chromium's DevTools port (scratch data dirs only)
  --open-url <url>               Open <url> once the browser is up (repeatable)
  --framework <path>             Load this Chromium Framework (or set ARDIACORE_FRAMEWORK)
  --no-onboarding                Skip onboarding even if it was never finished
  --no-ipc                       Don't open the control socket
  --version                      Print the version
  -h, --help                     Print this help

Unknown --switches go to Chromium unchanged.
";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum EngineChoice {
    Auto,
    Mock,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LaunchConfig {
    pub program: String,
    pub data_dir: PathBuf,
    pub scratch: bool,
    pub engine: EngineChoice,
    pub background: bool,
    pub remote_debugging_port: Option<u16>,
    pub open_urls: Vec<String>,
    pub switches: Vec<String>,
    pub framework: Option<PathBuf>,
    pub onboarding: bool,
    pub ipc: bool,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum CliOutcome {
    Run(Box<LaunchConfig>),
    Exit { code: i32, message: String },
}

fn flag_on(value: Option<String>) -> bool {
    value.is_some_and(|value| matches!(value.trim(), "1" | "true" | "yes"))
}

fn port(value: &str) -> Option<u16> {
    value.trim().parse::<u16>().ok().filter(|port| *port > 0)
}

fn looks_like_url(arg: &str) -> bool {
    let lower = arg.to_ascii_lowercase();
    ["http://", "https://", "file://", "about:", "ardia://"]
        .iter()
        .any(|scheme| lower.starts_with(scheme))
}

fn is_cocoa_default(arg: &str) -> bool {
    let mut chars = arg.chars();
    chars.next() == Some('-')
        && chars.next().is_some_and(|c| c.is_ascii_alphabetic())
        && !arg.starts_with("-psn_")
}

pub fn default_data_dir(home: Option<&Path>, env: &dyn Fn(&str) -> Option<String>) -> PathBuf {
    let home = home
        .map(Path::to_path_buf)
        .unwrap_or_else(std::env::temp_dir);
    if cfg!(target_os = "macos") {
        home.join("Library/Application Support/Ardia GPUI")
    } else if cfg!(target_os = "windows") {
        env("APPDATA")
            .filter(|dir| !dir.is_empty())
            .map(PathBuf::from)
            .unwrap_or_else(|| home.join("AppData/Roaming"))
            .join("Ardia GPUI")
    } else {
        env("XDG_DATA_HOME")
            .filter(|dir| !dir.is_empty())
            .map(PathBuf::from)
            .unwrap_or_else(|| home.join(".local/share"))
            .join("ardia-gpui")
    }
}

fn exit(code: i32, message: impl Into<String>) -> CliOutcome {
    CliOutcome::Exit {
        code,
        message: message.into(),
    }
}

pub fn parse(
    args: impl IntoIterator<Item = OsString>,
    env: &dyn Fn(&str) -> Option<String>,
) -> CliOutcome {
    let mut args = args
        .into_iter()
        .map(|arg| arg.to_string_lossy().into_owned());
    let program = args.next().unwrap_or_else(|| "ardia".to_owned());
    let mut data_dir: Option<PathBuf> = None;
    let mut mock = flag_on(env(MOCK_ENGINE_ENV));
    let mut background = flag_on(env(BACKGROUND_ENV));
    let mut remote_debugging_port = env(REMOTE_DEBUGGING_PORT_ENV).and_then(|value| port(&value));
    let mut open_urls = Vec::new();
    let mut switches = Vec::new();
    let mut framework = env(FRAMEWORK_ENV)
        .filter(|path| !path.is_empty())
        .map(PathBuf::from);
    let mut onboarding = true;
    let mut ipc = true;
    let mut engine_only = false;
    while let Some(arg) = args.next() {
        if engine_only {
            switches.push(arg);
            continue;
        }
        let (name, inline) = match arg.split_once('=') {
            Some((name, value)) if name.starts_with("--") => {
                (name.to_owned(), Some(value.to_owned()))
            }
            _ => (arg.clone(), None),
        };
        let mut value = |what: &str| -> Result<String, CliOutcome> {
            match inline.clone().or_else(|| args.next()) {
                Some(value) if !value.is_empty() => Ok(value),
                _ => Err(exit(2, format!("{name} needs {what}\n\n{USAGE}"))),
            }
        };
        match name.as_str() {
            "--" => engine_only = true,
            "-h" | "--help" => return exit(0, USAGE),
            "--version" => return exit(0, format!("Ardia GPUI {}", env!("CARGO_PKG_VERSION"))),
            "--data-dir" => match value("a folder") {
                Ok(dir) => data_dir = Some(PathBuf::from(dir)),
                Err(outcome) => return outcome,
            },
            "--mock-engine" => mock = true,
            "--background" => background = true,
            "--no-onboarding" => onboarding = false,
            "--no-ipc" => ipc = false,
            "--remote-debugging-port" => match value("a port").map(|v| port(&v)) {
                Ok(Some(parsed)) => remote_debugging_port = Some(parsed),
                Ok(None) => {
                    return exit(
                        2,
                        format!("--remote-debugging-port needs a port from 1 to 65535\n\n{USAGE}"),
                    );
                }
                Err(outcome) => return outcome,
            },
            "--open-url" => match value("a URL") {
                Ok(url) => open_urls.push(url),
                Err(outcome) => return outcome,
            },
            "--framework" => match value("a path") {
                Ok(path) => framework = Some(PathBuf::from(path)),
                Err(outcome) => return outcome,
            },
            _ if arg.starts_with("-psn_") => {}
            _ if arg.starts_with("--") => switches.push(arg),
            _ if is_cocoa_default(&arg) => {
                args.next();
            }
            _ if looks_like_url(&arg) => open_urls.push(arg),
            _ => return exit(2, format!("ardia doesn't know {arg:?}\n\n{USAGE}")),
        }
    }
    let scratch = data_dir.is_some() || env(DATA_DIR_ENV).is_some_and(|dir| !dir.is_empty());
    let data_dir = data_dir
        .or_else(|| {
            env(DATA_DIR_ENV)
                .filter(|dir| !dir.is_empty())
                .map(PathBuf::from)
        })
        .unwrap_or_else(|| default_data_dir(env("HOME").map(PathBuf::from).as_deref(), env));
    CliOutcome::Run(Box::new(LaunchConfig {
        program,
        data_dir,
        scratch,
        engine: if mock {
            EngineChoice::Mock
        } else {
            EngineChoice::Auto
        },
        background,
        remote_debugging_port,
        open_urls,
        switches,
        framework,
        onboarding,
        ipc,
    }))
}

impl LaunchConfig {
    pub fn chromium_data_dir(&self) -> PathBuf {
        self.data_dir.join("Chromium")
    }

    pub fn socket_path(&self) -> PathBuf {
        self.data_dir.join(crate::control_protocol::SOCKET_NAME)
    }

    pub fn launch_options(&self) -> LaunchOptions {
        let mut options = LaunchOptions::new(self.chromium_data_dir());
        options.program = self.program.clone();
        options.scratch_data_dir = self.scratch;
        options.mock_keychain = self.scratch;
        options.background = self.background;
        options.remote_debugging_port = self.remote_debugging_port;
        options.extra_switches = self.switches.clone();
        options
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    fn run(args: &[&str], vars: &[(&str, &str)]) -> CliOutcome {
        let vars: HashMap<String, String> = vars
            .iter()
            .map(|(k, v)| ((*k).to_owned(), (*v).to_owned()))
            .collect();
        let env = move |name: &str| vars.get(name).cloned();
        parse(
            std::iter::once("ardia")
                .chain(args.iter().copied())
                .map(OsString::from),
            &env,
        )
    }

    fn config(args: &[&str], vars: &[(&str, &str)]) -> LaunchConfig {
        match run(args, vars) {
            CliOutcome::Run(config) => *config,
            other => panic!("expected a launch, got {other:?}"),
        }
    }

    #[test]
    fn flags_and_their_environment_twins_agree() {
        let flagged = config(
            &[
                "--data-dir",
                "/tmp/a",
                "--mock-engine",
                "--background",
                "--remote-debugging-port=9333",
            ],
            &[("HOME", "/Users/x")],
        );
        let from_env = config(
            &[],
            &[
                ("ARDIA_DATA_DIR", "/tmp/a"),
                ("ARDIA_MOCK_ENGINE", "1"),
                ("ARDIA_BACKGROUND", "1"),
                ("ARDIA_REMOTE_DEBUGGING_PORT", "9333"),
            ],
        );
        for config in [&flagged, &from_env] {
            assert_eq!(config.data_dir, PathBuf::from("/tmp/a"));
            assert!(config.scratch && config.background);
            assert_eq!(config.engine, EngineChoice::Mock);
            assert_eq!(config.remote_debugging_port, Some(9333));
        }
        let options = flagged.launch_options();
        assert!(options.mock_keychain && options.background);
        assert_eq!(options.user_data_dir, PathBuf::from("/tmp/a/Chromium"));
        let args = options.to_args();
        assert!(args.contains(&"--remote-debugging-port=9333".to_owned()));
        assert!(args.contains(&"--use-mock-keychain".to_owned()));
    }

    #[test]
    fn urls_switches_and_launch_services_noise_are_sorted() {
        let config = config(
            &[
                "-psn_0_12345",
                "-NSDocumentRevisionsDebugMode",
                "YES",
                "https://ardia.dev",
                "--open-url",
                "ardia://settings",
                "--enable-logging=stderr",
                "--",
                "--v=1",
                "plain",
            ],
            &[("HOME", "/Users/x")],
        );
        assert_eq!(config.open_urls, ["https://ardia.dev", "ardia://settings"]);
        assert_eq!(
            config.switches,
            ["--enable-logging=stderr", "--v=1", "plain"]
        );
        assert!(!config.scratch);
        assert_eq!(config.engine, EngineChoice::Auto);
        if cfg!(target_os = "macos") {
            assert_eq!(
                config.data_dir,
                PathBuf::from("/Users/x/Library/Application Support/Ardia GPUI")
            );
        }
        let options = config.launch_options();
        assert!(!options.mock_keychain);
        assert!(
            options
                .to_args()
                .contains(&"--enable-logging=stderr".to_owned())
        );
    }

    #[test]
    fn bad_input_explains_itself() {
        assert!(matches!(
            run(&["--help"], &[]),
            CliOutcome::Exit { code: 0, .. }
        ));
        assert!(matches!(
            run(&["--version"], &[]),
            CliOutcome::Exit { code: 0, .. }
        ));
        for bad in [
            vec!["--data-dir"],
            vec!["--remote-debugging-port", "0"],
            vec!["--remote-debugging-port", "huge"],
            vec!["--open-url"],
            vec!["bogus"],
        ] {
            match run(&bad, &[]) {
                CliOutcome::Exit { code: 2, message } => {
                    assert!(message.contains("Usage"), "{bad:?}")
                }
                other => panic!("{bad:?} gave {other:?}"),
            }
        }
        let quiet = config(
            &["--no-onboarding", "--no-ipc"],
            &[("ARDIA_BACKGROUND", "0")],
        );
        assert!(!quiet.onboarding && !quiet.ipc && !quiet.background);
    }
}
