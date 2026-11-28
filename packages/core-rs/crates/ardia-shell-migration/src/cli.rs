use std::path::{Path, PathBuf};

use crate::migrate::Layout;

pub const USAGE: &str = "usage: ardia-webui-migrate --from-rnw [--chromium-profiles] [--test-instance]
       ardia-webui-migrate --from-rnw [--chromium-profiles] --rnw-data <dir> --webui-data <dir> [--test-instance]

Copies a React Native Windows Ardia's documents, window placement, config, sealed sync keys and
Credential Manager accounts into the WebUI host's data folder, once. The React Native Windows data
and Credential Manager items are only read. Prints a JSON report with counts and an outcome.
With --chromium-profiles it instead copies the Chromium profiles (history, cookies, saved passwords,
extensions) and the os_crypt key that unlocks them into the WebUI host's Chromium folder, once, while
neither shell is running; the setup program runs it before it starts Ardia.
Exit codes: 0 migrated or nothing to do, 1 failed (run again), 2 refused, 3 another run holds the lock
or a shell is running, 64 usage.";

#[derive(Debug, PartialEq, Eq)]
pub enum Command {
    Help,
    Migrate(Box<Layout>),
    MigrateChromium(Box<Layout>),
}

pub struct Environment {
    pub local_app_data: Option<String>,
    pub roaming_app_data: Option<String>,
    pub ardia_data_dir: Option<String>,
}

pub fn parse(args: &[String], environment: &Environment) -> Result<Command, String> {
    let mut from_rnw = false;
    let mut test_instance = false;
    let mut chromium = false;
    let mut rnw_data: Option<String> = None;
    let mut webui_data: Option<String> = None;
    let mut index = 0;
    while index < args.len() {
        let arg = args[index].as_str();
        let mut value = |name: &str| -> Result<String, String> {
            index += 1;
            args.get(index)
                .filter(|v| !v.is_empty())
                .cloned()
                .ok_or_else(|| format!("{name} needs a folder"))
        };
        match arg {
            "-h" | "--help" => return Ok(Command::Help),
            "--from-rnw" => from_rnw = true,
            "--test-instance" => test_instance = true,
            "--chromium-profiles" => chromium = true,
            "--rnw-data" if rnw_data.is_none() => rnw_data = Some(value("--rnw-data")?),
            "--webui-data" if webui_data.is_none() => webui_data = Some(value("--webui-data")?),
            other => return Err(format!("unknown or repeated argument: {other}")),
        }
        index += 1;
    }
    if !from_rnw {
        return Err("--from-rnw is required".into());
    }
    let command = if chromium {
        Command::MigrateChromium
    } else {
        Command::Migrate
    };
    match (rnw_data, webui_data) {
        (Some(rnw), Some(webui)) => Ok(command(Box::new(Layout::custom(
            &rnw,
            Path::new(&webui),
            test_instance,
        )))),
        (None, None) => {
            if environment.ardia_data_dir.as_deref().is_some_and(|d| !d.is_empty()) {
                return Err("ARDIA_DATA_DIR is set: name both folders with --rnw-data and --webui-data".into());
            }
            let local = environment
                .local_app_data
                .clone()
                .filter(|v| !v.is_empty())
                .ok_or("LOCALAPPDATA is not set")?;
            let roaming = environment
                .roaming_app_data
                .clone()
                .filter(|v| !v.is_empty())
                .ok_or("APPDATA is not set")?;
            Ok(command(Box::new(Layout::standard(
                &PathBuf::from(local),
                &PathBuf::from(roaming),
                test_instance,
            ))))
        }
        _ => Err("--rnw-data and --webui-data go together".into()),
    }
}
