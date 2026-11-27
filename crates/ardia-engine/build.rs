use std::collections::BTreeSet;
use std::env;
use std::fs;
use std::path::{Path, PathBuf};

const SERVICE_MACROS: [&str; 3] = ["AC_ENGINE_CALL(", "AC_PROFILE_CALL(", "AC_ARGS_CALL("];
const SERVICE_SOURCES: [&str; 2] = [
    "engine/chromium/src/chrome/browser/ardia",
    "engine/ardiacore/src/ardia/core",
];

fn main() {
    println!("cargo:rerun-if-changed=build.rs");
    println!("cargo:rerun-if-env-changed=ARDIACORE_HEADER_DIR");
    let manifest =
        PathBuf::from(env::var("CARGO_MANIFEST_DIR").expect("cargo sets CARGO_MANIFEST_DIR"));
    let repo = manifest.join("../..");
    write_service_registry(&repo);
    if env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("macos") {
        build_bridge(&manifest, &repo);
    }
}

fn source_files(dir: &Path, out: &mut Vec<PathBuf>) {
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            source_files(&path, out);
        } else if path
            .extension()
            .is_some_and(|ext| ext == "cc" || ext == "mm")
        {
            out.push(path);
        }
    }
}

fn registered_services(text: &str) -> impl Iterator<Item = String> + '_ {
    text.lines().filter_map(|line| {
        let rest = SERVICE_MACROS
            .iter()
            .find_map(|mac| line.strip_prefix(mac))?;
        let name: String = rest
            .trim_start()
            .chars()
            .take_while(|c| c.is_ascii_alphanumeric() || *c == '_')
            .collect();
        name.starts_with("ac_").then_some(name)
    })
}

fn write_service_registry(repo: &Path) {
    let mut services = BTreeSet::new();
    for source in SERVICE_SOURCES {
        let dir = repo.join(source);
        if !dir.is_dir() {
            panic!("engine service sources not found at {}", dir.display());
        }
        println!("cargo:rerun-if-changed={}", dir.display());
        let mut files = Vec::new();
        source_files(&dir, &mut files);
        for file in files {
            if let Ok(text) = fs::read_to_string(&file) {
                services.extend(registered_services(&text));
            }
        }
    }
    if services.is_empty() {
        panic!(
            "no engine services were registered under {}",
            repo.display()
        );
    }
    let list: Vec<String> = services
        .iter()
        .map(|name| format!("    {name:?},"))
        .collect();
    let registry = format!(
        "pub const ENGINE_SERVICES: &[&str] = &[\n{}\n];\n",
        list.join("\n")
    );
    let out =
        PathBuf::from(env::var("OUT_DIR").expect("cargo sets OUT_DIR")).join("engine_services.rs");
    fs::write(out, registry).expect("OUT_DIR is writable");
}

fn build_bridge(manifest: &Path, repo: &Path) {
    let header_dir = env::var_os("ARDIACORE_HEADER_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|| repo.join("engine/ardiacore/src/ardia/core/public"));
    let header = header_dir.join("ArdiaCore.h");
    if !header.is_file() {
        panic!(
            "ArdiaCore.h not found at {}; set ARDIACORE_HEADER_DIR to the folder holding it",
            header.display()
        );
    }
    let bridge_dir = manifest.join("src/macos");
    for file in ["bridge.h", "bridge.mm"] {
        println!("cargo:rerun-if-changed={}", bridge_dir.join(file).display());
    }
    let pip_dir = bridge_dir.join("pip");
    println!("cargo:rerun-if-changed={}", pip_dir.display());
    let mut pip_sources: Vec<PathBuf> = fs::read_dir(&pip_dir)
        .map(|entries| {
            entries
                .flatten()
                .map(|entry| entry.path())
                .filter(|path| path.extension().is_some_and(|ext| ext == "mm"))
                .collect()
        })
        .unwrap_or_default();
    pip_sources.sort();
    println!("cargo:rerun-if-changed={}", header.display());
    cc::Build::new()
        .cpp(true)
        .file(bridge_dir.join("bridge.mm"))
        .files(&pip_sources)
        .include(&bridge_dir)
        .include(&pip_dir)
        .link_lib_modifier("+whole-archive")
        .flag("-isystem")
        .flag(
            header_dir
                .to_str()
                .expect("ArdiaCore.h folder is valid UTF-8"),
        )
        .flag("-std=c++20")
        .flag("-fobjc-arc")
        .flag("-fobjc-exceptions")
        .flag("-Wall")
        .flag("-Wextra")
        .flag("-Wno-unused-parameter")
        .flag("-Wno-objc-protocol-method-implementation")
        .flag("-Wno-incomplete-implementation")
        .flag("-Werror")
        .compile("ardia_engine_bridge");
    for framework in [
        "AppKit",
        "Foundation",
        "UniformTypeIdentifiers",
        "QuartzCore",
        "ApplicationServices",
    ] {
        println!("cargo:rustc-link-lib=framework={framework}");
    }
    println!("cargo:rustc-link-lib=objc");
}
