use std::env;
use std::path::{Path, PathBuf};
use std::process::Command;

fn output(program: &str, args: &[&str]) -> Option<String> {
    let out = Command::new(program).args(args).output().ok()?;
    out.status
        .success()
        .then(|| String::from_utf8_lossy(&out.stdout).trim().to_owned())
        .filter(|text| !text.is_empty())
}

fn swift_sources(dir: &Path) -> Vec<PathBuf> {
    let mut sources: Vec<PathBuf> = std::fs::read_dir(dir)
        .map(|entries| {
            entries
                .filter_map(Result::ok)
                .map(|entry| entry.path())
                .filter(|path| path.extension().is_some_and(|ext| ext == "swift"))
                .collect()
        })
        .unwrap_or_default();
    sources.sort();
    sources
}

fn main() {
    println!("cargo:rustc-check-cfg=cfg(translate_shim)");
    println!("cargo:rerun-if-changed=swift/translate");
    println!("cargo:rerun-if-changed=build.rs");
    if env::var("CARGO_CFG_TARGET_OS").as_deref() != Ok("macos") {
        return;
    }
    let arch = match env::var("CARGO_CFG_TARGET_ARCH").as_deref() {
        Ok("aarch64") => "arm64",
        Ok("x86_64") => "x86_64",
        _ => return,
    };
    let (Ok(manifest), Ok(out_dir)) = (env::var("CARGO_MANIFEST_DIR"), env::var("OUT_DIR")) else {
        return;
    };
    let sources = swift_sources(&Path::new(&manifest).join("swift/translate"));
    if sources.is_empty() {
        return;
    }
    let library = Path::new(&out_dir).join("libardia_translate.a");
    let target = format!("{arch}-apple-macos12.0");
    let built = Command::new("xcrun")
        .args([
            "swiftc",
            "-parse-as-library",
            "-emit-library",
            "-static",
            "-module-name",
            "ArdiaTranslate",
            "-target",
            &target,
            "-O",
            "-swift-version",
            "5",
            "-o",
        ])
        .arg(&library)
        .args(&sources)
        .status()
        .is_ok_and(|status| status.success());
    if !built {
        println!(
            "cargo:warning=swiftc couldn't build the translation shim, so page translation is off"
        );
        return;
    }
    println!("cargo:rustc-link-search=native={out_dir}");
    println!("cargo:rustc-link-lib=static=ardia_translate");
    if let Some(sdk) = output("xcrun", &["--sdk", "macosx", "--show-sdk-path"]) {
        println!("cargo:rustc-link-search=native={sdk}/usr/lib/swift");
    }
    if let Some(swiftc) = output("xcrun", &["--find", "swiftc"])
        && let Some(toolchain) = Path::new(&swiftc).parent().and_then(Path::parent)
    {
        println!(
            "cargo:rustc-link-search=native={}",
            toolchain.join("lib/swift/macosx").display()
        );
    }
    println!("cargo:rustc-link-arg=-Wl,-rpath,/usr/lib/swift");
    println!("cargo:rustc-link-arg=-Wl,-weak_framework,Translation");
    println!("cargo:rustc-cfg=translate_shim");
}
