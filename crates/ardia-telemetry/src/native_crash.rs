use std::path::{Path, PathBuf};
use std::sync::OnceLock;

use regex::Regex;
use serde_json::{Map, Value, json};

use crate::client::{CaptureOptions, Client};
use crate::consent::Consent;
use crate::ids::now_ms;

pub const PER_PROCESS_KIND: usize = 5;
pub const MAX_FRAMES: usize = 64;
pub const MAX_IMAGES: usize = 24;
const NEAREST_EXPORT_DISTANCE: i64 = 0x4000;
const MAX_CODE: u64 = 0xffff_ffff;
const NULL_PAGE_END: u64 = 0x10_0000;
const MAX_REPORT_BYTES: u64 = 8 * 1_048_576;

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Owner {
    pub executable: String,
    pub bundle: String,
    pub bundle_id: String,
    pub version: Option<String>,
    pub executable_uuid: Option<String>,
    pub helpers: Vec<(String, Option<String>)>,
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct NativeFrame {
    pub image: String,
    pub symbol: Option<String>,
    pub symbol_offset: Option<i64>,
    pub offset: Option<i64>,
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct Report {
    pub time: f64,
    pub file_time: f64,
    pub process: String,
    pub frames: Vec<NativeFrame>,
    pub exception_frames: Vec<NativeFrame>,
    pub images: Vec<(String, String)>,
    pub exception_name: Option<String>,
    pub exception_subtype: Option<String>,
    pub exception_type: Option<String>,
    pub signal: Option<String>,
    pub app_version: Option<String>,
    pub build: Option<String>,
    pub engine_version: Option<String>,
    pub termination_namespace: Option<String>,
    pub termination_indicator: Option<String>,
    pub termination_code: Option<i64>,
    pub exception_codes: Option<String>,
    pub crashed_thread: Option<String>,
    pub crashed_queue: Option<String>,
    pub uptime_seconds: Option<i64>,
    pub vm_writable_mb: Option<i64>,
}

fn regex(cell: &'static OnceLock<Regex>, pattern: &str) -> &'static Regex {
    cell.get_or_init(|| {
        Regex::new(pattern).unwrap_or_else(|_| Regex::new("$^").expect("empty pattern"))
    })
}

macro_rules! pattern {
    ($name:ident, $text:expr) => {
        fn $name() -> &'static Regex {
            static CELL: OnceLock<Regex> = OnceLock::new();
            regex(&CELL, $text)
        }
    };
}

pattern!(
    our_images,
    r"^(Ardia|ArdiaCore|ArdiaShell|Chromium Framework|Expo|ExpoModulesCore|React|hermes|RCT|Sparkle|chrome$|chrome_crashpad_handler$|lib(?:EGL|GLESv2|vk_swiftshader|vulkan|qt5_shim|qt6_shim)\.so)"
);
pattern!(
    stripped_export,
    r"^(?:ArdiaCoreMain|ChromeMain|ChromeWebAppShortcutCopierMain|ac_[a-z0-9_]+)$"
);
pattern!(
    image_id,
    r"^(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[0-9a-f]{40})$"
);
pattern!(system_name, r"^[A-Z][A-Z0-9_ ()]{1,40}$");
pattern!(exception_name, r"^[A-Z]{2,4}[A-Z][a-z][A-Za-z0-9]{1,60}$");
pattern!(subtype, r"^[A-Z][A-Z0-9_]{2,40}$");
pattern!(thrown_name, r"^[A-Z][A-Za-z0-9_]{2,63}$");
pattern!(
    uncaught_name,
    r"uncaught exception '([A-Za-z0-9_]{1,64})[':]"
);
pattern!(
    exception_codes,
    r"^0x([0-9a-f]{1,16})(?:, 0x([0-9a-f]{1,16})(?:, 0x[0-9a-f]{1,16}){0,2})?$"
);
pattern!(path_like, r"\S*/\S*");
pattern!(quoted, r#""[^"]*""#);
pattern!(version, r"^\d+\.\d+\.\d+(?:-[a-z]+\.\d+)?$");
pattern!(build, r"^[\w.-]{1,32}$");
pattern!(engine_version, r"^\d+(?:\.\d+){1,3}$");

fn frame_file(name: &str) -> String {
    let base = name.rsplit(['/', '\\']).next().unwrap_or(name);
    let cleaned: String = base
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '.' | '-' | '(' | ')'))
        .take(100)
        .collect();
    if cleaned.is_empty() {
        "<unknown>".into()
    } else {
        cleaned
    }
}

pub fn image_name(image: &str) -> String {
    frame_file(&image.replace(char::is_whitespace, "_")).replace('_', " ")
}

fn real_symbol(frame: &NativeFrame, in_app: bool) -> Option<String> {
    let symbol = frame.symbol.as_deref().filter(|s| !s.is_empty())?;
    if in_app {
        let stripped = match frame.symbol_offset {
            Some(distance) => distance >= NEAREST_EXPORT_DISTANCE,
            None => stripped_export().is_match(symbol),
        };
        if stripped {
            return None;
        }
    }
    let cleaned = path_like().replace_all(symbol, "<path>");
    let cleaned = quoted().replace_all(&cleaned, "<text>");
    Some(cleaned.chars().take(200).collect())
}

pub fn native_frames(frames: &[NativeFrame]) -> Vec<Value> {
    let mut out: Vec<Value> = frames
        .iter()
        .take(MAX_FRAMES)
        .map(|frame| {
            let image = image_name(&frame.image);
            let in_app = our_images().is_match(&image);
            let symbol = real_symbol(frame, in_app);
            let offset = frame
                .offset
                .filter(|o| *o >= 0)
                .map(|o| format!("0x{o:x}"));
            let mut entry = json!({
                "platform": "custom",
                "lang": "native",
                "function": symbol.clone().unwrap_or_else(|| format!("{image} + {}", offset.as_deref().unwrap_or("0x0"))),
                "module": image,
                "filename": image,
                "lineno": Value::Null,
                "colno": Value::Null,
                "resolved": symbol.is_some(),
                "in_app": in_app,
            });
            if let (Some(offset), Some(map)) = (offset, entry.as_object_mut()) {
                map.insert("image_offset".into(), json!(offset));
            }
            entry
        })
        .collect();
    out.reverse();
    out
}

pub fn native_images(images: &[(String, String)]) -> Vec<Value> {
    images
        .iter()
        .filter_map(|(name, uuid)| {
            let uuid = uuid.to_lowercase();
            let name = image_name(name);
            (image_id().is_match(&uuid) && our_images().is_match(&name))
                .then(|| json!({"name": name, "uuid": uuid}))
        })
        .take(MAX_IMAGES)
        .collect()
}

fn checked(value: Option<&str>, pattern: &Regex) -> Option<String> {
    value.filter(|v| pattern.is_match(v)).map(str::to_owned)
}

pub struct Exceptions {
    pub name: Option<String>,
    pub signal: Option<String>,
    pub subtype: Option<String>,
    pub images: Vec<Value>,
    pub entries: Vec<(String, String, Vec<Value>)>,
}

pub fn exceptions(report: &Report) -> Exceptions {
    let mach_type =
        checked(report.exception_type.as_deref(), system_name()).unwrap_or_else(|| "Crash".into());
    let signal = checked(report.signal.as_deref(), system_name());
    let name = checked(report.exception_name.as_deref(), exception_name());
    let subtype = checked(report.exception_subtype.as_deref(), subtype());
    let value = match &signal {
        Some(signal) => format!("{mach_type} ({signal})"),
        None => mach_type.clone(),
    };
    let crash = (mach_type, value, native_frames(&report.frames));
    let images = native_images(&report.images);
    if report.exception_frames.is_empty() && name.is_none() {
        return Exceptions {
            name,
            signal,
            subtype,
            images,
            entries: vec![crash],
        };
    }
    let kind = name.clone().unwrap_or_else(|| "NSException".into());
    let thrown = (
        kind.clone(),
        format!("Uncaught {kind}"),
        native_frames(&report.exception_frames),
    );
    Exceptions {
        name,
        signal,
        subtype,
        images,
        entries: vec![thrown, crash],
    }
}

fn indicator_kind(indicator: Option<&str>) -> Option<&'static str> {
    let indicator = indicator.filter(|i| !i.is_empty())?;
    let shown = match indicator.rsplit_once(':') {
        Some((head, tail))
            if tail.trim().chars().all(|c| c.is_ascii_digit()) && !tail.trim().is_empty() =>
        {
            head.trim_end()
        }
        _ => indicator,
    };
    Some(match shown {
        "Trace/BPT trap" => "trace_trap",
        "Segmentation fault" => "segmentation_fault",
        "Bus error" => "bus_error",
        "Abort trap" => "abort_trap",
        "Illegal instruction" => "illegal_instruction",
        "Killed" => "killed",
        "Terminated" => "terminated",
        "Floating point exception" => "floating_point",
        "Invalid Page" => "invalid_page",
        _ => "other",
    })
}

pattern!(
    thread_chrome_main,
    r"^Cr(?:Browser|Renderer|Gpu|Utility)Main$"
);
pattern!(
    thread_pool,
    r"^(?:ThreadPool(?:Foreground|Background|SingleThread)|ThreadPoolServiceThread$)"
);
pattern!(thread_io, r"^Chrome_(?:Child)?IOThread$");
pattern!(
    thread_compositor,
    r"^(?:Compositor|VizCompositorThread|CompositorTileWorker\w*)$"
);
pattern!(
    thread_worker,
    r"^(?:DedicatedWorker|ServiceWorker|SharedWorker) thread$"
);
pattern!(
    thread_media,
    r"^(?:Media|AudioOutputDevice|AudioThread|media::\w+)$"
);
pattern!(thread_react_js, r"^com\.facebook\.react\.JavaScript$");
pattern!(thread_react, r"^com\.facebook\.react\.\w+$");
pattern!(thread_events, r"^com\.apple\.NSEventThread$");
pattern!(thread_apple, r"^com\.apple\.");

fn thread_kind(name: Option<&str>) -> Option<&'static str> {
    let name = name.filter(|n| !n.is_empty())?;
    let table: [(&Regex, &'static str); 10] = [
        (thread_chrome_main(), "chrome_main"),
        (thread_pool(), "thread_pool"),
        (thread_io(), "io"),
        (thread_compositor(), "compositor"),
        (thread_worker(), "web_worker"),
        (thread_media(), "media"),
        (thread_react_js(), "react_js"),
        (thread_react(), "react_other"),
        (thread_events(), "appkit_events"),
        (thread_apple(), "apple_other"),
    ];
    Some(
        table
            .iter()
            .find(|(p, _)| p.is_match(name))
            .map_or("other", |(_, kind)| kind),
    )
}

fn queue_kind(queue: Option<&str>) -> Option<&'static str> {
    let queue = queue.filter(|q| !q.is_empty())?;
    Some(if queue == "com.apple.main-thread" {
        "main"
    } else {
        "other"
    })
}

fn small_code(value: Option<i64>) -> Option<i64> {
    value.filter(|v| *v >= 0 && (*v as u64) <= MAX_CODE)
}

fn exception_code(kind: Option<&str>, codes: Option<&str>) -> (Option<i64>, Option<bool>) {
    let Some(caps) = codes.map(str::to_lowercase).and_then(|c| {
        exception_codes().captures(&c).map(|m| {
            (
                m.get(1).map(|g| g.as_str().to_owned()),
                m.get(2).map(|g| g.as_str().to_owned()),
            )
        })
    }) else {
        return (None, None);
    };
    let code = caps
        .0
        .and_then(|hex| u64::from_str_radix(&hex, 16).ok())
        .filter(|c| *c <= MAX_CODE)
        .map(|c| c as i64);
    let near_null = (kind == Some("EXC_BAD_ACCESS"))
        .then(|| {
            caps.1
                .and_then(|hex| u64::from_str_radix(&hex, 16).ok())
                .map(|a| a < NULL_PAGE_END)
        })
        .flatten();
    (code, near_null)
}

pub fn crash_details(report: &Report) -> Map<String, Value> {
    let (code, near_null) = exception_code(
        report.exception_type.as_deref(),
        report.exception_codes.as_deref(),
    );
    Map::from_iter([
        (
            "crash_termination_indicator".to_owned(),
            json!(indicator_kind(report.termination_indicator.as_deref())),
        ),
        (
            "crash_termination_code".to_owned(),
            json!(small_code(report.termination_code)),
        ),
        ("crash_exception_code".to_owned(), json!(code)),
        ("crash_fault_near_null".to_owned(), json!(near_null)),
        (
            "crash_thread".to_owned(),
            json!(thread_kind(report.crashed_thread.as_deref())),
        ),
        (
            "crash_queue".to_owned(),
            json!(queue_kind(report.crashed_queue.as_deref())),
        ),
    ])
}

fn text(value: Option<&Value>) -> Option<String> {
    value.and_then(Value::as_str).map(str::to_owned)
}

fn report_time(value: Option<&Value>) -> Option<f64> {
    let raw = value?.as_str()?;
    let mut parts = raw.split_whitespace();
    let (date, clock, zone) = (parts.next()?, parts.next()?, parts.next()?);
    let clock = clock.split('.').next()?;
    let ymd: Vec<i64> = date.split('-').filter_map(|p| p.parse().ok()).collect();
    let hms: Vec<i64> = clock.split(':').filter_map(|p| p.parse().ok()).collect();
    if ymd.len() != 3 || hms.len() != 3 || zone.len() != 5 {
        return None;
    }
    let sign = if zone.starts_with('-') { -1 } else { 1 };
    let zh: i64 = zone.get(1..3)?.parse().ok()?;
    let zm: i64 = zone.get(3..5)?.parse().ok()?;
    let days = days_from_civil(ymd[0], ymd[1], ymd[2]);
    let seconds =
        days * 86_400 + hms[0] * 3600 + hms[1] * 60 + hms[2] - sign * (zh * 3600 + zm * 60);
    Some(seconds as f64 * 1000.0)
}

fn days_from_civil(y: i64, m: i64, d: i64) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let mp = (m + 9) % 12;
    let doy = (153 * mp + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

fn megabytes(text: &str) -> Option<i64> {
    let unit = text.chars().last()?;
    let number: f64 = text[..text.len() - unit.len_utf8()].parse().ok()?;
    let mb = match unit {
        'K' => number / 1024.0,
        'M' => number,
        'G' => number * 1024.0,
        'T' => number * 1024.0 * 1024.0,
        _ => return None,
    };
    Some(mb.round() as i64)
}

fn writable_megabytes(summary: Option<&str>) -> Option<i64> {
    let line = summary?
        .lines()
        .find(|l| l.starts_with("Writable regions:"))?;
    let total = line.split(' ').find(|w| w.starts_with("Total="))?;
    megabytes(&total["Total=".len()..])
}

fn main_thread_name(body: &Value) -> Option<String> {
    body["threads"]
        .as_array()?
        .iter()
        .find(|t| t["queue"].as_str() == Some("com.apple.main-thread"))
        .and_then(|t| text(t.get("name")))
}

fn faulting_index(body: &Value) -> Option<usize> {
    if let Some(index) = body["faultingThread"].as_u64() {
        return Some(index as usize);
    }
    body["threads"]
        .as_array()?
        .iter()
        .position(|t| t["triggered"].as_bool() == Some(true))
}

fn crashed_thread(body: &Value) -> (Option<String>, Option<String>) {
    let Some(thread) = faulting_index(body).and_then(|i| body["threads"].get(i)) else {
        return (None, None);
    };
    (text(thread.get("name")), text(thread.get("queue")))
}

fn wildcard_match(pattern: &str, candidate: &str) -> bool {
    let parts: Vec<&str> = pattern.split('*').collect();
    if parts.len() == 1 {
        return pattern == candidate;
    }
    let mut rest = candidate;
    for (i, part) in parts.iter().enumerate() {
        if i == 0 {
            let Some(after) = rest.strip_prefix(part) else {
                return false;
            };
            rest = after;
        } else if i == parts.len() - 1 {
            return rest.ends_with(part);
        } else {
            let Some(at) = rest.find(part) else {
                return false;
            };
            rest = &rest[at + part.len()..];
        }
    }
    true
}

fn is_ours(bundle_id: Option<&str>, owner: &Owner) -> bool {
    match bundle_id {
        None => true,
        Some(id) => {
            id == owner.bundle_id
                || owner
                    .helpers
                    .iter()
                    .any(|(_, helper)| helper.as_deref() == Some(id))
        }
    }
}

pub fn process_kind(
    proc_path: &str,
    header: &Value,
    main_thread: Option<&str>,
    owner: &Owner,
) -> Option<&'static str> {
    if !is_ours(header["bundleID"].as_str(), owner) {
        return None;
    }
    let at = proc_path.find(".app/Contents/")?;
    let inside = &proc_path[at + ".app/Contents/".len()..];
    let candidate = format!("{}/Contents/{inside}", owner.bundle);
    let pattern = proc_path.replace("/Users/USER/", "/Users/*/");
    if proc_path != candidate && !wildcard_match(&pattern, &candidate) {
        return None;
    }
    if candidate == owner.executable {
        if let (Some(slice), Some(running)) = (
            header["slice_uuid"].as_str(),
            owner.executable_uuid.as_deref(),
        ) && slice.to_lowercase() != running
            && header["app_version"].as_str() == owner.version.as_deref()
        {
            return None;
        }
        return Some("browser");
    }
    if !inside.contains("/Helpers/") {
        return None;
    }
    match main_thread {
        Some("CrRendererMain") => return Some("renderer"),
        Some("CrGpuMain") => return Some("gpu"),
        Some("CrUtilityMain") => return Some("utility"),
        _ => {}
    }
    let name = proc_path.rsplit('/').next().unwrap_or("");
    Some(
        if name.contains("(Renderer)") || name.contains(" Renderer)") {
            "renderer"
        } else if name.contains("GPU)") {
            "gpu"
        } else if name.contains("Alerts)") {
            "alerts"
        } else if name.contains("Plugin)") {
            "plugin"
        } else {
            "utility"
        },
    )
}

fn image_label(image: &Value) -> String {
    if let Some(name) = image["name"].as_str().filter(|n| !n.is_empty()) {
        return name.to_owned();
    }
    image["path"]
        .as_str()
        .and_then(|p| p.rsplit('/').next())
        .map_or_else(|| "???".into(), str::to_owned)
}

fn simplified(frames: Option<&Value>, images: &[String]) -> Vec<NativeFrame> {
    frames
        .and_then(Value::as_array)
        .map(|list| {
            list.iter()
                .take(MAX_FRAMES)
                .map(|frame| NativeFrame {
                    image: frame["imageIndex"]
                        .as_u64()
                        .and_then(|i| images.get(i as usize))
                        .cloned()
                        .unwrap_or_else(|| "???".into()),
                    symbol: text(frame.get("symbol")),
                    symbol_offset: frame["symbolLocation"].as_i64(),
                    offset: frame["imageOffset"].as_i64(),
                })
                .collect()
        })
        .unwrap_or_default()
}

fn bundled_images(images: &[Value], proc_path: &str) -> Vec<(String, String)> {
    let Some(at) = proc_path.find(".app/Contents/") else {
        return Vec::new();
    };
    let app = proc_path[..at].rsplit('/').next().unwrap_or("");
    if app.is_empty() {
        return Vec::new();
    }
    let bundle = format!("/{app}.app/Contents/");
    let mut seen = std::collections::HashSet::new();
    images
        .iter()
        .filter_map(|image| {
            let path = image["path"].as_str()?;
            let uuid = image["uuid"].as_str()?.to_lowercase();
            (path.contains(&bundle) && seen.insert(uuid.clone()))
                .then(|| (image_label(image), uuid))
        })
        .take(MAX_IMAGES)
        .collect()
}

fn thrown_exception_name(body: &Value) -> Option<String> {
    let check = |full: &str| {
        let name: String = full.chars().take_while(|c| *c != ':').collect();
        thrown_name().is_match(&name).then_some(name)
    };
    if let Some(name) = body["exceptionReason"]["name"].as_str() {
        return check(name);
    }
    for lines in body["asi"].as_object()?.values() {
        for line in lines
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
        {
            if let Some(m) = uncaught_name().captures(line).and_then(|c| c.get(1)) {
                return check(m.as_str());
            }
        }
    }
    None
}

pub fn parse(contents: &[u8], owner: &Owner, modified_ms: f64) -> Option<Report> {
    let newline = contents.iter().position(|b| *b == b'\n')?;
    let header: Value = serde_json::from_slice(&contents[..newline]).ok()?;
    let body: Value = serde_json::from_slice(&contents[newline + 1..]).ok()?;
    let proc_path = body["procPath"].as_str()?;
    let process = process_kind(
        proc_path,
        &header,
        main_thread_name(&body).as_deref(),
        owner,
    )?;
    let used: Vec<Value> = body["usedImages"].as_array().cloned().unwrap_or_default();
    let images: Vec<String> = used.iter().map(image_label).collect();
    let frames = faulting_index(&body)
        .and_then(|i| body["threads"].get(i))
        .map(|t| simplified(t.get("frames"), &images))
        .unwrap_or_default();
    let (thread, queue) = crashed_thread(&body);
    let exception = &body["exception"];
    let termination = &body["termination"];
    let browser = process == "browser";
    let launched = report_time(body.get("procLaunch"));
    let captured = report_time(body.get("captureTime"));
    Some(Report {
        time: captured.unwrap_or(modified_ms),
        file_time: modified_ms,
        process: process.to_owned(),
        frames,
        exception_frames: simplified(body.get("lastExceptionBacktrace"), &images),
        images: bundled_images(&used, proc_path),
        exception_name: thrown_exception_name(&body),
        exception_subtype: exception["subtype"]
            .as_str()
            .and_then(|s| s.split(' ').next())
            .map(str::to_owned),
        exception_type: text(exception.get("type")),
        signal: text(exception.get("signal")),
        app_version: browser.then(|| text(header.get("app_version"))).flatten(),
        build: browser.then(|| text(header.get("build_version"))).flatten(),
        engine_version: (!browser)
            .then(|| text(header.get("app_version")))
            .flatten(),
        termination_namespace: text(termination.get("namespace")),
        termination_indicator: text(termination.get("indicator")),
        termination_code: termination["code"].as_i64().filter(|c| *c >= 0),
        exception_codes: text(exception.get("codes")),
        crashed_thread: thread,
        crashed_queue: queue,
        uptime_seconds: match (launched, captured) {
            (Some(l), Some(c)) if c >= l => Some(((c - l) / 1000.0).round() as i64),
            _ => None,
        },
        vm_writable_mb: writable_megabytes(body["vmSummary"].as_str()),
    })
}

pub fn reports_dir() -> Option<PathBuf> {
    std::env::var_os("HOME").map(|home| PathBuf::from(home).join("Library/Logs/DiagnosticReports"))
}

pub fn read_since(dir: &Path, since: f64, owner: &Owner) -> Vec<Report> {
    let executable_name = owner.executable.rsplit('/').next().unwrap_or("").to_owned();
    let prefixes: Vec<String> = std::iter::once(executable_name)
        .chain(owner.helpers.iter().map(|(n, _)| n.clone()))
        .filter(|p| !p.is_empty())
        .map(|p| format!("{p}-"))
        .collect();
    let mut reports: Vec<Report> = std::fs::read_dir(dir)
        .into_iter()
        .flatten()
        .flatten()
        .filter_map(|entry| {
            let name = entry.file_name().to_string_lossy().into_owned();
            if !name.ends_with(".ips") || !prefixes.iter().any(|p| name.starts_with(p.as_str())) {
                return None;
            }
            let meta = entry.metadata().ok()?;
            if meta.len() > MAX_REPORT_BYTES {
                return None;
            }
            let modified = meta
                .modified()
                .ok()?
                .duration_since(std::time::UNIX_EPOCH)
                .ok()?
                .as_millis() as f64;
            if modified <= since {
                return None;
            }
            parse(&std::fs::read(entry.path()).ok()?, owner, modified)
        })
        .collect();
    reports.sort_by(|a, b| a.file_time.total_cmp(&b.file_time));
    let (browser, helpers): (Vec<Report>, Vec<Report>) =
        reports.into_iter().partition(|r| r.process == "browser");
    let mut kept: Vec<Report> = browser
        .into_iter()
        .rev()
        .take(PER_PROCESS_KIND)
        .chain(helpers.into_iter().rev().take(PER_PROCESS_KIND))
        .collect();
    kept.sort_by(|a, b| a.file_time.total_cmp(&b.file_time));
    kept
}

fn whole(value: Option<i64>) -> Option<i64> {
    value.filter(|v| *v >= 0)
}

pub fn properties(report: &Report, now: i64) -> (Map<String, Value>, Map<String, Value>) {
    let browser = report.process == "browser";
    let mechanism = if browser {
        "native_crash"
    } else {
        "helper_crash"
    };
    let found = exceptions(report);
    let mut props = Map::new();
    props.insert("$exception_level".into(), json!("fatal"));
    props.insert("source".into(), json!(mechanism));
    props.insert("crash_process".into(), json!(report.process));
    props.insert("crash_signal".into(), json!(found.signal));
    props.insert("crash_subtype".into(), json!(found.subtype));
    props.insert(
        "crash_termination".into(),
        json!(checked(report.termination_namespace.as_deref(), subtype())),
    );
    props.extend(crash_details(report));
    props.insert("objc_exception".into(), json!(found.name));
    props.insert(
        "crashed_minutes_ago".into(),
        json!(((now as f64 - report.time) / 60_000.0).round() as i64),
    );
    props.insert(
        "crashed_version".into(),
        json!(
            browser
                .then(|| checked(report.app_version.as_deref(), version()))
                .flatten()
        ),
    );
    props.insert(
        "crashed_build".into(),
        json!(
            browser
                .then(|| checked(report.build.as_deref(), build()))
                .flatten()
        ),
    );
    props.insert(
        "crashed_engine_version".into(),
        json!(
            (!browser)
                .then(|| checked(report.engine_version.as_deref(), engine_version()))
                .flatten()
        ),
    );
    props.insert("crash_uptime_s".into(), json!(whole(report.uptime_seconds)));
    props.insert(
        "crash_vm_writable_mb".into(),
        json!(whole(report.vm_writable_mb)),
    );
    let mut raw = Map::new();
    raw.insert(
        "$exception_types".into(),
        json!(
            found
                .entries
                .iter()
                .map(|e| e.0.clone())
                .collect::<Vec<_>>()
        ),
    );
    raw.insert(
        "$exception_values".into(),
        json!(
            found
                .entries
                .iter()
                .map(|e| e.1.clone())
                .collect::<Vec<_>>()
        ),
    );
    raw.insert(
        "$exception_list".into(),
        json!(
            found
                .entries
                .iter()
                .map(|(kind, value, frames)| json!({
                    "type": kind,
                    "value": value,
                    "mechanism": {"type": mechanism, "handled": false, "synthetic": false},
                    "stacktrace": {"type": "raw", "frames": frames},
                }))
                .collect::<Vec<_>>()
        ),
    );
    raw.insert("crash_images".into(), json!(found.images));
    (props, raw)
}

pub fn report_new(client: &Client, owner: &Owner, dir: &Path, consent: Option<&Consent>) -> usize {
    let since = client.saved_number("crashCursor").unwrap_or(0) as f64;
    let reports = read_since(dir, since, owner);
    let now = now_ms();
    let mut latest = since;
    let mut sent = 0;
    for report in &reports {
        latest = latest.max(report.file_time);
        let (props, raw) = properties(report, now);
        if client.capture(
            "$exception",
            &props,
            consent,
            CaptureOptions {
                urgent: true,
                persist: true,
                raw: Some(raw),
                ..CaptureOptions::default()
            },
        ) {
            sent += 1;
        }
    }
    let floor = client.saved_number("crashCursor").unwrap_or(0) as f64;
    if latest > floor {
        client.save_fields(Map::from_iter([(
            "crashCursor".to_owned(),
            json!(latest as i64),
        )]));
    }
    sent
}

#[cfg(test)]
mod tests {
    use super::*;

    fn owner() -> Owner {
        Owner {
            executable: "/Applications/Ardia.app/Contents/MacOS/Ardia".into(),
            bundle: "/Applications/Ardia.app".into(),
            bundle_id: "dev.ardia".into(),
            version: Some("0.3.0".into()),
            executable_uuid: None,
            helpers: vec![(
                "Ardia Helper (Renderer)".into(),
                Some("dev.ardia.helper.renderer".into()),
            )],
        }
    }

    fn ips() -> Vec<u8> {
        let header = json!({"app_version": "0.3.0", "build_version": "42", "bundleID": "dev.ardia", "incident_id": "X"});
        let body = json!({
            "procPath": "/Applications/Ardia.app/Contents/MacOS/Ardia",
            "captureTime": "2026-11-26 10:00:30.1234 +0000",
            "procLaunch": "2026-11-26 10:00:00.0000 +0000",
            "exception": {"type": "EXC_BAD_ACCESS", "signal": "SIGSEGV", "codes": "0x0000000000000001, 0x0000000000000010", "subtype": "KERN_INVALID_ADDRESS at 0x10"},
            "termination": {"namespace": "SIGNAL", "indicator": "Segmentation fault: 11", "code": 11},
            "faultingThread": 0,
            "threads": [{"queue": "com.apple.main-thread", "name": "CrBrowserMain", "frames": [
                {"imageIndex": 0, "symbol": "ardia_app::shell::open \"/Users/me/secret.txt\"", "symbolLocation": 20, "imageOffset": 4096},
                {"imageIndex": 1, "symbol": "objc_msgSend", "imageOffset": 12}
            ]}],
            "usedImages": [
                {"name": "Ardia", "path": "/Applications/Ardia.app/Contents/MacOS/Ardia", "uuid": "AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE"},
                {"name": "libobjc.A.dylib", "path": "/usr/lib/libobjc.A.dylib", "uuid": "11111111-2222-3333-4444-555555555555"}
            ],
            "vmSummary": "Writable regions: Total=1.5G written=10M"
        });
        format!("{header}\n{body}").into_bytes()
    }

    #[test]
    fn an_ips_report_parses_into_scrubbed_enums() {
        let report = parse(&ips(), &owner(), 1.0).expect("parsed");
        assert_eq!(report.process, "browser");
        assert_eq!(report.uptime_seconds, Some(30));
        assert_eq!(report.vm_writable_mb, Some(1536));
        let details = crash_details(&report);
        assert_eq!(details["crash_termination_indicator"], "segmentation_fault");
        assert_eq!(details["crash_exception_code"], 1);
        assert_eq!(details["crash_fault_near_null"], true);
        assert_eq!(details["crash_thread"], "chrome_main");
        assert_eq!(details["crash_queue"], "main");
        let (props, raw) = properties(&report, report.time as i64 + 120_000);
        assert_eq!(props["source"], "native_crash");
        assert_eq!(props["crash_signal"], "SIGSEGV");
        assert_eq!(props["crash_subtype"], "KERN_INVALID_ADDRESS");
        assert_eq!(props["crashed_minutes_ago"], 2);
        assert_eq!(props["crashed_version"], "0.3.0");
        let text = serde_json::to_string(&raw).unwrap_or_default();
        assert!(!text.contains("secret"));
        assert!(text.contains("<path>"));
        assert_eq!(raw["crash_images"].as_array().map(Vec::len), Some(1));
    }

    #[test]
    fn reports_from_other_apps_are_ignored() {
        let mut other = owner();
        other.bundle_id = "com.example".into();
        other.helpers.clear();
        assert!(parse(&ips(), &other, 1.0).is_none());
        let helper = json!({"bundleID": "dev.ardia.helper.renderer"});
        assert_eq!(
            process_kind(
                "/Applications/Ardia.app/Contents/Frameworks/X.framework/Helpers/Ardia Helper (Renderer).app/Contents/MacOS/Ardia Helper (Renderer)",
                &helper,
                Some("CrRendererMain"),
                &owner()
            ),
            Some("renderer")
        );
    }

    #[test]
    fn stripped_in_app_symbols_fall_back_to_image_offsets() {
        let frames = native_frames(&[NativeFrame {
            image: "Ardia".into(),
            symbol: Some("ChromeMain".into()),
            symbol_offset: Some(0x5000),
            offset: Some(255),
        }]);
        assert_eq!(frames[0]["function"], "Ardia + 0xff");
        assert_eq!(frames[0]["resolved"], false);
        assert_eq!(frames[0]["in_app"], true);
    }
}
