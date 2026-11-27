use std::ffi::OsString;
use std::fmt;
use std::path::{Path, PathBuf};

use crate::abi::{
    AcEngineCall, AcEngineDispatch, AcEngineSetEventSink, DISPATCH_SYMBOL, SET_EVENT_SINK_SYMBOL,
};
use crate::desktop::{API_ENTRY_SYMBOL, ApiEntry};
use crate::error::{EngineError, EngineResult};
use crate::services::ServiceName;

pub const MAC_FRAMEWORK_ENV: &str = "ARDIACORE_FRAMEWORK";
pub const DESKTOP_LIBRARY_ENV: &str = "ARDIA_ENGINE_LIBRARY";
pub const MAC_FRAMEWORK_NAME: &str = "Chromium Framework";
pub const MAC_DEVELOPMENT_BUILD: &str =
    "chromium-build/chromium_git/chromium/src/out/Release_GN_arm64";

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Platform {
    Mac,
    Linux,
    Windows,
}

impl Platform {
    pub const fn current() -> Self {
        if cfg!(target_os = "macos") {
            Self::Mac
        } else if cfg!(target_os = "windows") {
            Self::Windows
        } else {
            Self::Linux
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum CandidateSource {
    Override,
    Bundle,
    Development,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Candidate {
    pub path: PathBuf,
    pub source: CandidateSource,
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct LoaderEnvironment {
    pub executable: Option<PathBuf>,
    pub home: Option<PathBuf>,
    pub override_path: Option<PathBuf>,
    pub trust_override_in_bundle: bool,
}

impl LoaderEnvironment {
    pub fn current(platform: Platform) -> Self {
        let override_var = match platform {
            Platform::Mac => MAC_FRAMEWORK_ENV,
            Platform::Linux | Platform::Windows => DESKTOP_LIBRARY_ENV,
        };
        Self {
            executable: std::env::current_exe().ok(),
            home: std::env::var_os(if platform == Platform::Windows {
                "USERPROFILE"
            } else {
                "HOME"
            })
            .filter(|home| !home.is_empty())
            .map(PathBuf::from),
            override_path: std::env::var_os(override_var)
                .filter(|path| !path.is_empty())
                .map(PathBuf::from),
            trust_override_in_bundle: cfg!(debug_assertions),
        }
    }
}

pub fn runs_from_app_bundle(executable: &Path) -> bool {
    let Some(macos) = executable.parent() else {
        return false;
    };
    let Some(contents) = macos.parent() else {
        return false;
    };
    let Some(bundle) = contents.parent() else {
        return false;
    };
    macos.file_name().is_some_and(|name| name == "MacOS")
        && contents.file_name().is_some_and(|name| name == "Contents")
        && bundle
            .extension()
            .is_some_and(|ext| ext.eq_ignore_ascii_case("app"))
}

fn mac_framework_binary(path: &Path) -> PathBuf {
    if path.extension().is_some_and(|ext| ext == "framework") {
        path.join(MAC_FRAMEWORK_NAME)
    } else {
        path.to_path_buf()
    }
}

pub fn candidates(platform: Platform, env: &LoaderEnvironment) -> Vec<Candidate> {
    let mut found = Vec::new();
    let bundled = env.executable.as_deref().is_some_and(runs_from_app_bundle);
    let mut push = |path: PathBuf, source: CandidateSource| {
        if path.is_absolute() && !found.iter().any(|c: &Candidate| c.path == path) {
            found.push(Candidate { path, source });
        }
    };
    if let Some(path) = &env.override_path
        && (!bundled || env.trust_override_in_bundle)
    {
        let path = if platform == Platform::Mac {
            mac_framework_binary(path)
        } else {
            path.clone()
        };
        push(path, CandidateSource::Override);
    }
    let exe_dir = env.executable.as_deref().and_then(Path::parent);
    match platform {
        Platform::Mac => {
            if let Some(dir) = exe_dir {
                push(
                    dir.join("../Frameworks")
                        .join(format!("{MAC_FRAMEWORK_NAME}.framework"))
                        .join(MAC_FRAMEWORK_NAME),
                    CandidateSource::Bundle,
                );
            }
            if !bundled && let Some(home) = &env.home {
                push(
                    home.join(MAC_DEVELOPMENT_BUILD)
                        .join(format!("{MAC_FRAMEWORK_NAME}.framework"))
                        .join(MAC_FRAMEWORK_NAME),
                    CandidateSource::Development,
                );
            }
        }
        Platform::Linux => {
            if let Some(dir) = exe_dir {
                push(dir.join("libardiacore.so"), CandidateSource::Bundle);
                push(
                    dir.join("lib").join("libardiacore.so"),
                    CandidateSource::Bundle,
                );
            }
        }
        Platform::Windows => {
            if let Some(dir) = exe_dir {
                push(dir.join("ardiacore.dll"), CandidateSource::Bundle);
            }
        }
    }
    found
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Refusal {
    Missing,
    NotAFile,
    WorldWritable(PathBuf),
    Unreadable(String),
}

impl fmt::Display for Refusal {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Missing => f.write_str("it doesn't exist"),
            Self::NotAFile => f.write_str("it isn't a file"),
            Self::WorldWritable(path) => write!(f, "anyone can write to {}", path.display()),
            Self::Unreadable(error) => write!(f, "it can't be read: {error}"),
        }
    }
}

pub fn vet(path: &Path) -> Result<PathBuf, Refusal> {
    let real = match path.canonicalize() {
        Ok(real) => real,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Err(Refusal::Missing),
        Err(error) => return Err(Refusal::Unreadable(error.to_string())),
    };
    let metadata = std::fs::metadata(&real).map_err(|e| Refusal::Unreadable(e.to_string()))?;
    if !metadata.is_file() {
        return Err(Refusal::NotAFile);
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        const WORLD_WRITABLE: u32 = 0o002;
        const STICKY: u32 = 0o1000;
        if metadata.permissions().mode() & WORLD_WRITABLE != 0 {
            return Err(Refusal::WorldWritable(real));
        }
        let mut dir = real.parent();
        while let Some(current) = dir {
            if let Ok(meta) = std::fs::metadata(current) {
                let mode = meta.permissions().mode();
                if mode & WORLD_WRITABLE != 0 && mode & STICKY == 0 {
                    return Err(Refusal::WorldWritable(current.to_path_buf()));
                }
            }
            dir = current.parent();
        }
    }
    Ok(real)
}

pub struct EngineLibrary {
    path: PathBuf,
    library: libloading::Library,
}

impl fmt::Debug for EngineLibrary {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("EngineLibrary")
            .field("path", &self.path)
            .finish()
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LoadAttempt {
    pub path: PathBuf,
    pub source: CandidateSource,
    pub problem: String,
}

pub const STOPPED_AFTER_LOAD: &str = "it loaded but was refused, so no later candidate was tried";

impl EngineLibrary {
    #[allow(clippy::missing_safety_doc)]
    pub unsafe fn open(path: &Path) -> EngineResult<&'static Self> {
        let real = vet(path)
            .map_err(|refusal| EngineError::NotLoaded(format!("{}: {refusal}", path.display())))?;
        let library = unsafe { open_library(&real) }
            .map_err(|e| EngineError::NotLoaded(format!("{}: {e}", real.display())))?;
        Ok(Box::leak(Box::new(Self {
            path: real,
            library,
        })))
    }

    #[allow(clippy::missing_safety_doc)]
    pub unsafe fn find(
        platform: Platform,
        env: &LoaderEnvironment,
    ) -> Result<&'static Self, Vec<LoadAttempt>> {
        unsafe {
            Self::find_with(platform, env, |library| {
                default_preflight(platform, library)
            })
        }
    }

    #[allow(clippy::missing_safety_doc)]
    pub unsafe fn find_with(
        platform: Platform,
        env: &LoaderEnvironment,
        preflight: impl Fn(&'static Self) -> Result<(), String>,
    ) -> Result<&'static Self, Vec<LoadAttempt>> {
        let mut attempts = Vec::new();
        for candidate in candidates(platform, env) {
            match unsafe { Self::open(&candidate.path) } {
                Ok(library) => {
                    let problem = match preflight(library) {
                        Ok(()) => return Ok(library),
                        Err(problem) => problem,
                    };
                    attempts.push(LoadAttempt {
                        path: candidate.path,
                        source: candidate.source,
                        problem: format!("{problem}; {STOPPED_AFTER_LOAD}"),
                    });
                    break;
                }
                Err(error) => attempts.push(LoadAttempt {
                    path: candidate.path,
                    source: candidate.source,
                    problem: error.to_string(),
                }),
            }
        }
        Err(attempts)
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    pub(crate) unsafe fn symbol<T: Copy>(&self, name: &str) -> Option<T> {
        let mut bytes: Vec<u8> = name.as_bytes().to_vec();
        if bytes.contains(&0) {
            return None;
        }
        bytes.push(0);
        unsafe { self.library.get::<T>(&bytes).ok().map(|symbol| *symbol) }
    }

    pub fn exports(&self, name: &str) -> bool {
        unsafe { self.symbol::<*mut std::ffi::c_void>(name) }.is_some()
    }

    pub fn set_event_sink(&self) -> Option<AcEngineSetEventSink> {
        unsafe { self.symbol(SET_EVENT_SINK_SYMBOL) }
    }

    pub fn dispatcher(&self) -> Option<AcEngineDispatch> {
        unsafe { self.symbol(DISPATCH_SYMBOL) }
    }

    pub fn service(&self, name: &ServiceName) -> Option<AcEngineCall> {
        if !name.is_registered() {
            return None;
        }
        unsafe { self.symbol(name.as_str()) }
    }

    pub fn api_entry(&self) -> Option<ApiEntry> {
        unsafe { self.symbol(API_ENTRY_SYMBOL) }
    }
}

fn default_preflight(platform: Platform, library: &EngineLibrary) -> Result<(), String> {
    let ready = match platform {
        Platform::Mac => library.set_event_sink().is_some(),
        Platform::Linux => {
            library.api_entry().is_some()
                || (library.dispatcher().is_some() && library.set_event_sink().is_some())
        }
        Platform::Windows => library.api_entry().is_some(),
    };
    if ready {
        Ok(())
    } else {
        Err("it doesn't export the Ardia engine ABI".into())
    }
}

#[cfg(target_os = "macos")]
unsafe fn open_library(path: &Path) -> Result<libloading::Library, libloading::Error> {
    use libloading::os::unix::{Library, RTLD_LAZY, RTLD_LOCAL};
    const RTLD_FIRST: std::ffi::c_int = 0x100;
    unsafe { Library::open(Some(path), RTLD_LAZY | RTLD_LOCAL | RTLD_FIRST) }.map(Into::into)
}

#[cfg(all(unix, not(target_os = "macos")))]
unsafe fn open_library(path: &Path) -> Result<libloading::Library, libloading::Error> {
    use libloading::os::unix::{Library, RTLD_LAZY, RTLD_LOCAL};
    unsafe { Library::open(Some(path), RTLD_LAZY | RTLD_LOCAL) }.map(Into::into)
}

#[cfg(windows)]
unsafe fn open_library(path: &Path) -> Result<libloading::Library, libloading::Error> {
    use libloading::os::windows::{
        LOAD_LIBRARY_SEARCH_DEFAULT_DIRS, LOAD_LIBRARY_SEARCH_DLL_LOAD_DIR, Library,
    };
    unsafe {
        Library::load_with_flags(
            path,
            LOAD_LIBRARY_SEARCH_DLL_LOAD_DIR | LOAD_LIBRARY_SEARCH_DEFAULT_DIRS,
        )
    }
    .map(Into::into)
}

pub fn describe_attempts(attempts: &[LoadAttempt]) -> String {
    if attempts.is_empty() {
        return "no place to look for the engine (set the override variable to its path)".into();
    }
    attempts
        .iter()
        .map(|attempt| {
            format!(
                "{:?} {}: {}",
                attempt.source,
                attempt.path.display(),
                attempt.problem
            )
        })
        .collect::<Vec<_>>()
        .join("; ")
}

pub fn override_variable(platform: Platform) -> OsString {
    OsString::from(match platform {
        Platform::Mac => MAC_FRAMEWORK_ENV,
        Platform::Linux | Platform::Windows => DESKTOP_LIBRARY_ENV,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn env(executable: &str) -> LoaderEnvironment {
        LoaderEnvironment {
            executable: Some(PathBuf::from(executable)),
            home: Some(PathBuf::from("/Users/dev")),
            override_path: None,
            trust_override_in_bundle: false,
        }
    }

    fn scratch(name: &str) -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("ardia-engine-loader-{}-{name}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn mac_bundle_only_trusts_its_own_frameworks() {
        let mut bundle = env("/Applications/Ardia.app/Contents/MacOS/Ardia");
        bundle.override_path = Some(PathBuf::from("/tmp/evil.framework"));
        let found = candidates(Platform::Mac, &bundle);
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].source, CandidateSource::Bundle);
        assert_eq!(
            found[0].path,
            PathBuf::from(
                "/Applications/Ardia.app/Contents/MacOS/../Frameworks/Chromium Framework.framework/Chromium Framework"
            )
        );
        bundle.trust_override_in_bundle = true;
        let trusted = candidates(Platform::Mac, &bundle);
        assert_eq!(
            trusted[0].path,
            PathBuf::from("/tmp/evil.framework/Chromium Framework")
        );
    }

    #[test]
    fn mac_development_runs_check_override_bundle_then_build_tree() {
        let mut dev = env("/Users/dev/ardia-gpui/target/debug/ardia");
        dev.override_path = Some(PathBuf::from("/opt/fw/Chromium Framework"));
        let found = candidates(Platform::Mac, &dev);
        assert_eq!(
            found.iter().map(|c| c.source).collect::<Vec<_>>(),
            vec![
                CandidateSource::Override,
                CandidateSource::Bundle,
                CandidateSource::Development
            ]
        );
        assert_eq!(found[0].path, PathBuf::from("/opt/fw/Chromium Framework"));
        assert_eq!(
            found[2].path,
            PathBuf::from(
                "/Users/dev/chromium-build/chromium_git/chromium/src/out/Release_GN_arm64/Chromium Framework.framework/Chromium Framework"
            )
        );
    }

    #[test]
    fn relative_overrides_are_ignored() {
        let mut dev = env("/Users/dev/bin/ardia");
        dev.override_path = Some(PathBuf::from("relative/Chromium Framework"));
        assert!(
            candidates(Platform::Mac, &dev)
                .iter()
                .all(|c| c.source != CandidateSource::Override)
        );
        assert!(candidates(Platform::Linux, &LoaderEnvironment::default()).is_empty());
    }

    #[test]
    fn desktop_candidates_sit_next_to_the_executable() {
        let linux = candidates(Platform::Linux, &env("/opt/ardia/ardia"));
        assert_eq!(linux[0].path, PathBuf::from("/opt/ardia/libardiacore.so"));
        assert_eq!(
            linux[1].path,
            PathBuf::from("/opt/ardia/lib/libardiacore.so")
        );
        let mut windows_env = env("/c/Program Files/Ardia/Ardia.exe");
        windows_env.override_path = Some(PathBuf::from("/d/engine/ardiacore.dll"));
        let windows = candidates(Platform::Windows, &windows_env);
        assert_eq!(windows[0].source, CandidateSource::Override);
        assert_eq!(
            windows[1].path,
            PathBuf::from("/c/Program Files/Ardia/ardiacore.dll")
        );
    }

    #[test]
    fn app_bundle_detection_needs_the_full_layout() {
        assert!(runs_from_app_bundle(Path::new(
            "/Applications/Ardia.app/Contents/MacOS/Ardia"
        )));
        assert!(runs_from_app_bundle(Path::new(
            "/x/Ardia Nightly.APP/Contents/MacOS/Ardia"
        )));
        assert!(!runs_from_app_bundle(Path::new("/x/Contents/MacOS/Ardia")));
        assert!(!runs_from_app_bundle(Path::new("/x/Ardia.app/MacOS/Ardia")));
        assert!(!runs_from_app_bundle(Path::new("ardia")));
    }

    #[test]
    fn vetting_refuses_missing_folders_and_writable_files() {
        let dir = scratch("vet");
        assert_eq!(vet(&dir.join("absent")), Err(Refusal::Missing));
        assert_eq!(vet(&dir), Err(Refusal::NotAFile));
        let file = dir.join("lib");
        std::fs::write(&file, b"not a library").unwrap();
        assert_eq!(
            vet(&file).map(|p| p.file_name().unwrap().to_owned()),
            Ok("lib".into())
        );
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&file, std::fs::Permissions::from_mode(0o666)).unwrap();
            assert!(matches!(vet(&file), Err(Refusal::WorldWritable(_))));
            std::fs::set_permissions(&file, std::fs::Permissions::from_mode(0o644)).unwrap();
            let open = dir.join("open");
            std::fs::create_dir(&open).unwrap();
            std::fs::set_permissions(&open, std::fs::Permissions::from_mode(0o777)).unwrap();
            let planted = open.join("lib");
            std::fs::write(&planted, b"x").unwrap();
            std::fs::set_permissions(&planted, std::fs::Permissions::from_mode(0o644)).unwrap();
            assert!(
                matches!(vet(&planted), Err(Refusal::WorldWritable(path)) if path.ends_with("open"))
            );
        }
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn opening_a_non_library_fails_gracefully() {
        let dir = scratch("open");
        let file = dir.join("Chromium Framework");
        std::fs::write(&file, b"definitely not mach-o").unwrap();
        match unsafe { EngineLibrary::open(&file) } {
            Err(EngineError::NotLoaded(message)) => assert!(message.contains("Chromium Framework")),
            other => panic!("unexpected {other:?}"),
        }
        let attempts = match unsafe {
            EngineLibrary::find(
                Platform::Mac,
                &LoaderEnvironment {
                    executable: Some(dir.join("ardia")),
                    home: None,
                    override_path: Some(file),
                    trust_override_in_bundle: false,
                },
            )
        } {
            Err(attempts) => attempts,
            Ok(_) => panic!("a text file loaded as a library"),
        };
        assert_eq!(attempts.len(), 2);
        assert!(
            attempts
                .iter()
                .all(|attempt| !attempt.problem.contains(STOPPED_AFTER_LOAD))
        );
        assert!(describe_attempts(&attempts).contains("Override"));
        assert!(describe_attempts(&[]).contains("override"));
        let _ = std::fs::remove_dir_all(&dir);
    }
}
