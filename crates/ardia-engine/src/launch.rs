use std::collections::HashSet;
use std::path::{Path, PathBuf};

pub const BACKGROUND_ENV: &str = "ARDIA_BACKGROUND";
pub const DATA_DIR_ENV: &str = "ARDIA_DATA_DIR";
pub const REMOTE_DEBUGGING_PORT_ENV: &str = "ARDIA_REMOTE_DEBUGGING_PORT";

const DISABLED_FEATURES: &str = "MacAppCodeSignClone,DevToolsAcceptDebuggingConnections,AutofillAiWalletPrivatePasses,SettingsGlowupJourneys,AsyncLiveResize";
const ENABLED_FEATURES: &str = "WebContentsDiscard,BrowserInitiatedAutomaticPictureInPicture,MacOcclusionForceShutoff,\
ImprovedStartupBestEffortDelay:StartupDelayStopOnLoadingTimedOut/true,CPUMeasurementInFreezingPolicy:freezing_visible_protection_time/0s";
const AUTO_ACCEPT_SWITCHES: [&str; 2] = [
    "--use-fake-ui-for-media-stream",
    "--auto-accept-camera-and-microphone-capture",
];

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LaunchOptions {
    pub program: String,
    pub user_data_dir: PathBuf,
    pub scratch_data_dir: bool,
    pub background: bool,
    pub allow_occlusion: bool,
    pub allow_audio: bool,
    pub mock_keychain: bool,
    pub remote_debugging_port: Option<u16>,
    pub extra_switches: Vec<String>,
    pub passthrough: Vec<String>,
}

pub fn is_background() -> bool {
    std::env::var(BACKGROUND_ENV).is_ok_and(|value| value == "1")
}

impl LaunchOptions {
    pub fn new(user_data_dir: impl Into<PathBuf>) -> Self {
        Self {
            program: "Ardia".into(),
            user_data_dir: user_data_dir.into(),
            scratch_data_dir: false,
            background: false,
            allow_occlusion: false,
            allow_audio: false,
            mock_keychain: false,
            remote_debugging_port: None,
            extra_switches: Vec::new(),
            passthrough: Vec::new(),
        }
    }

    pub fn from_environment(installed_data_dir: &Path) -> Self {
        let scratch = std::env::var_os(DATA_DIR_ENV)
            .filter(|dir| !dir.is_empty())
            .map(PathBuf::from);
        let mut options = Self::new(
            scratch
                .as_deref()
                .unwrap_or(installed_data_dir)
                .join("Chromium"),
        );
        options.scratch_data_dir = scratch.is_some();
        options.mock_keychain = scratch.is_some();
        options.background = is_background();
        options.remote_debugging_port = std::env::var(REMOTE_DEBUGGING_PORT_ENV)
            .ok()
            .and_then(|port| port.parse::<u16>().ok())
            .filter(|port| *port > 0);
        let mut args = std::env::args();
        if let Some(program) = args.next() {
            options.program = program;
        }
        options.passthrough = args.collect();
        options
    }

    pub fn to_args(&self) -> Vec<String> {
        let mut args = vec![
            format!("--user-data-dir={}", self.user_data_dir.display()),
            "--enable-smooth-scrolling".into(),
            "--disable-stack-profiler".into(),
            format!("--disable-features={DISABLED_FEATURES}"),
            format!("--enable-features={ENABLED_FEATURES}"),
            "--profile-directory=Default".into(),
            "--js-flags=--no-memory-reducer".into(),
        ];
        if self.mock_keychain {
            args.push("--use-mock-keychain".into());
        }
        if self.background {
            if !self.allow_occlusion {
                args.push("--disable-backgrounding-occluded-windows".into());
            }
            if !self.allow_audio {
                args.push("--mute-audio".into());
            }
            args.push("--use-fake-device-for-media-stream".into());
            args.push("--disable-modal-animations".into());
        }
        args.extend(
            self.extra_switches
                .iter()
                .filter(|switch| !self.refuses(switch))
                .cloned(),
        );
        if self.mock_keychain
            && let Some(port) = self.remote_debugging_port
        {
            args.push(format!("--remote-debugging-port={port}"));
            args.push("--remote-allow-origins=*".into());
        }
        if self.mock_keychain {
            let mut passthrough = self.passthrough.iter().peekable();
            while let Some(arg) = passthrough.next() {
                if is_cocoa_default(arg) && passthrough.peek().is_some() {
                    passthrough.next();
                    continue;
                }
                if self.refuses(arg) || arg.starts_with("--ardia-") || arg.starts_with("-psn_") {
                    continue;
                }
                args.push(arg.clone());
            }
        }
        let mut full = vec![self.program.clone()];
        full.extend(merge_feature_lists(&args));
        full
    }

    fn refuses(&self, switch: &str) -> bool {
        self.background
            && AUTO_ACCEPT_SWITCHES
                .iter()
                .any(|refused| switch.starts_with(refused))
    }
}

fn is_cocoa_default(arg: &str) -> bool {
    let mut chars = arg.chars();
    chars.next() == Some('-')
        && chars.next().is_some_and(|c| c.is_ascii_alphabetic())
        && !arg.starts_with("-psn_")
}

fn feature_name(entry: &str) -> &str {
    let entry = entry.strip_prefix('*').unwrap_or(entry);
    let end = entry.find(['<', ':']).unwrap_or(entry.len());
    &entry[..end]
}

pub fn merge_feature_lists(args: &[String]) -> Vec<String> {
    let mut switches = Vec::new();
    let mut positional = Vec::new();
    let mut entries: Vec<(bool, &str)> = Vec::new();
    let mut terminated = false;
    for arg in args {
        if terminated || arg == "--" {
            terminated = true;
            positional.push(arg.clone());
            continue;
        }
        let (enable, list) = if let Some(list) = arg.strip_prefix("--enable-features=") {
            (true, list)
        } else if let Some(list) = arg.strip_prefix("--disable-features=") {
            (false, list)
        } else {
            switches.push(arg.clone());
            continue;
        };
        entries.extend(
            list.split(',')
                .filter(|entry| !entry.is_empty())
                .map(|entry| (enable, entry)),
        );
    }
    let mut decided = HashSet::new();
    let mut enabled = Vec::new();
    let mut disabled = Vec::new();
    for &(enable, entry) in entries.iter().rev() {
        if decided.insert(feature_name(entry)) {
            if enable {
                enabled.push(entry)
            } else {
                disabled.push(entry)
            }
        }
    }
    enabled.reverse();
    disabled.reverse();
    if !enabled.is_empty() {
        switches.push(format!("--enable-features={}", enabled.join(",")));
    }
    if !disabled.is_empty() {
        switches.push(format!("--disable-features={}", disabled.join(",")));
    }
    switches.extend(positional);
    switches
}

#[cfg(test)]
mod tests {
    use super::*;

    fn strings(items: &[&str]) -> Vec<String> {
        items.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn later_feature_switches_win_per_feature() {
        let merged = merge_feature_lists(&strings(&[
            "--enable-features=A,B:x/1",
            "--foo",
            "--disable-features=B,C",
            "--enable-features=C<Trial,*D",
            "--",
            "--enable-features=Z",
        ]));
        assert_eq!(
            merged,
            strings(&[
                "--foo",
                "--enable-features=A,C<Trial,*D",
                "--disable-features=B",
                "--",
                "--enable-features=Z"
            ])
        );
    }

    #[test]
    fn background_scratch_launch_carries_the_test_switches() {
        let mut options = LaunchOptions::new("/tmp/scratch/Chromium");
        options.background = true;
        options.mock_keychain = true;
        options.scratch_data_dir = true;
        options.remote_debugging_port = Some(9333);
        options.extra_switches =
            strings(&["--use-fake-ui-for-media-stream", "--enable-features=Extra"]);
        options.passthrough = strings(&[
            "-NSDocumentRevisionsDebugMode",
            "YES",
            "--ardia-secret",
            "--v=1",
            "-psn_0_1",
        ]);
        let args = options.to_args();
        assert_eq!(args[0], "Ardia");
        assert!(args.contains(&"--user-data-dir=/tmp/scratch/Chromium".to_string()));
        assert!(args.contains(&"--use-mock-keychain".to_string()));
        assert!(args.contains(&"--mute-audio".to_string()));
        assert!(args.contains(&"--disable-backgrounding-occluded-windows".to_string()));
        assert!(args.contains(&"--remote-debugging-port=9333".to_string()));
        assert!(args.contains(&"--v=1".to_string()));
        assert!(!args.iter().any(|a| a.contains("fake-ui")
            || a.contains("ardia-secret")
            || a.contains("NSDocument")
            || a == "YES"));
        assert!(!args.iter().any(|a| a.starts_with("-psn_")));
        let enabled: Vec<_> = args
            .iter()
            .filter(|a| a.starts_with("--enable-features="))
            .collect();
        assert_eq!(enabled.len(), 1);
        assert!(enabled[0].ends_with(",Extra"));
    }

    #[test]
    fn installed_launch_ignores_debugging_and_passthrough() {
        let mut options = LaunchOptions::new("/Users/x/Library/Application Support/Ardia/Chromium");
        options.remote_debugging_port = Some(9222);
        options.passthrough = strings(&["--remote-debugging-port=1"]);
        let args = options.to_args();
        assert!(
            !args
                .iter()
                .any(|a| a.starts_with("--remote-debugging-port"))
        );
        assert!(!args.contains(&"--use-mock-keychain".to_string()));
        assert!(!args.contains(&"--mute-audio".to_string()));
    }
}
