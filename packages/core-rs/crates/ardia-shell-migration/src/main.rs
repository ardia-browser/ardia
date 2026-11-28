use std::process::ExitCode;

use ardia_shell_migration::cli::{self, Command, Environment};

fn environment() -> Environment {
    let read = |name: &str| std::env::var(name).ok();
    Environment {
        local_app_data: read("LOCALAPPDATA"),
        roaming_app_data: read("APPDATA"),
        ardia_data_dir: read("ARDIA_DATA_DIR"),
    }
}

#[cfg(windows)]
fn test_faults() -> ardia_shell_migration::Faults {
    let marked = std::env::current_exe()
        .ok()
        .and_then(|exe| exe.parent().map(|folder| folder.join("Ardia.test-build")))
        .is_some_and(|marker| marker.is_file());
    let number = |name: &str| {
        std::env::var(name)
            .ok()
            .and_then(|v| v.parse::<usize>().ok())
            .filter(|_| marked)
    };
    ardia_shell_migration::Faults {
        fail_at_commit: number("ARDIA_TEST_MIGRATION_STOP_AT_COMMIT"),
        fail_at_file: number("ARDIA_TEST_MIGRATION_STOP_AT_FILE"),
        free_space: number("ARDIA_TEST_MIGRATION_FREE_SPACE").map(|free| free as u64),
        crash_at_commit: None,
        crash_in_rollback_at: None,
    }
}

#[cfg(windows)]
fn run(layout: &ardia_shell_migration::Layout) -> ExitCode {
    use ardia_shell_migration::windows::{CredentialManager, Dpapi};
    let report = ardia_shell_migration::migrate(layout, &Dpapi, &CredentialManager, &test_faults());
    println!("{}", report.to_json());
    ExitCode::from(report.exit_code())
}

#[cfg(windows)]
fn run_chromium(layout: &ardia_shell_migration::Layout) -> ExitCode {
    use ardia_shell_migration::windows::Dpapi;
    let report = ardia_shell_migration::migrate_chromium(layout, &Dpapi, &test_faults());
    println!("{}", report.to_json());
    ExitCode::from(report.exit_code())
}

#[cfg(not(windows))]
fn run(_layout: &ardia_shell_migration::Layout) -> ExitCode {
    eprintln!("ardia-webui-migrate reads DPAPI and Credential Manager, so it runs on Windows only");
    ExitCode::from(64)
}

#[cfg(not(windows))]
fn run_chromium(layout: &ardia_shell_migration::Layout) -> ExitCode {
    run(layout)
}

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    match cli::parse(&args, &environment()) {
        Ok(Command::Help) => {
            println!("{}", cli::USAGE);
            ExitCode::SUCCESS
        }
        Ok(Command::Migrate(layout)) => run(&layout),
        Ok(Command::MigrateChromium(layout)) => run_chromium(&layout),
        Err(message) => {
            eprintln!("{message}\n{}", cli::USAGE);
            ExitCode::from(64)
        }
    }
}
