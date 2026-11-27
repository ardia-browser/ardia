use std::net::TcpListener;

use flate2::Compression;
use flate2::write::GzEncoder;

use super::*;

pub struct Entry<'a> {
    pub path: &'a str,
    pub body: &'a [u8],
    pub mode: u32,
    pub kind: u8,
}

pub fn file<'a>(path: &'a str, body: &'a [u8]) -> Entry<'a> {
    Entry {
        path,
        body,
        mode: 0o644,
        kind: b'0',
    }
}

fn octal_field(field: &mut [u8], value: u64) {
    let text = format!("{value:0width$o}", width = field.len() - 1);
    field[..text.len()].copy_from_slice(text.as_bytes());
}

pub fn tar(entries: &[Entry]) -> Vec<u8> {
    let mut out = Vec::new();
    for entry in entries {
        let mut raw = [0u8; BLOCK];
        raw[..entry.path.len()].copy_from_slice(entry.path.as_bytes());
        octal_field(&mut raw[100..108], u64::from(entry.mode));
        octal_field(&mut raw[108..116], 0);
        octal_field(&mut raw[116..124], 0);
        octal_field(&mut raw[124..136], entry.body.len() as u64);
        octal_field(&mut raw[136..148], 0);
        raw[156] = entry.kind;
        raw[257..263].copy_from_slice(b"ustar\0");
        raw[263..265].copy_from_slice(b"00");
        raw[148..156].copy_from_slice(b"        ");
        let sum: u64 = raw.iter().map(|b| u64::from(*b)).sum();
        let text = format!("{sum:06o}\0 ");
        raw[148..156].copy_from_slice(text.as_bytes());
        out.extend_from_slice(&raw);
        out.extend_from_slice(entry.body);
        out.resize(out.len().div_ceil(BLOCK) * BLOCK, 0);
    }
    out.extend_from_slice(&[0u8; BLOCK * 2]);
    out
}

pub fn gz(bytes: &[u8]) -> Vec<u8> {
    let mut encoder = GzEncoder::new(Vec::new(), Compression::default());
    encoder.write_all(bytes).unwrap();
    encoder.finish().unwrap()
}

pub fn sha(bytes: &[u8]) -> String {
    hex(&Sha256::digest(bytes))
}

pub fn manifest(name: &str, version: &str, programs: &str) -> String {
    format!(
        r#"{{"manifest":2,"name":"{name}","title":"Kit","description":"A kit.","version":"{version}","official":true{programs}}}"#
    )
}

pub fn good_archive(name: &str) -> Vec<u8> {
    let text = manifest(name, "1.0.0", "");
    let manifest_path = format!("{name}/plugin.json");
    let tool_path = format!("{name}/bin/tool");
    gz(&tar(&[
        Entry {
            path: &format!("{name}/"),
            body: b"",
            mode: 0o755,
            kind: b'5',
        },
        file(&manifest_path, text.as_bytes()),
        Entry {
            path: &tool_path,
            body: b"#!/bin/sh\necho hi\n",
            mode: 0o755,
            kind: b'0',
        },
    ]))
}

pub fn pin_entry(name: &str, archive: &[u8]) -> PinEntry {
    PinEntry {
        name: name.to_owned(),
        title: "Kit".into(),
        icon: "shippingbox".into(),
        version: "1.0.0".into(),
        sha256: sha(archive),
        trusted: Vec::new(),
        preselected: true,
        blurb: "Tools.".into(),
        file: Some(format!("{name}.tar.gz")),
        url: Some(format!("https://example.invalid/{name}.tar.gz")),
        reserved_programs: vec!["kit".into()],
        example: None,
    }
}

struct NoNetwork;

impl Download for NoNetwork {
    fn download(
        &self,
        _: &str,
        _: &Path,
        _: &Arc<AtomicBool>,
        _: &mut dyn FnMut(u64, u64),
        _: &Limits,
    ) -> Result<(), FetchFailure> {
        Err(failed(FetchCode::Offline, "no network in tests"))
    }
}

fn fetch_from(dir: &Path, entry: &PinEntry, archive: &[u8]) -> Result<Fetched, FetchFailure> {
    let source = dir.join("source");
    std::fs::create_dir_all(&source).unwrap();
    std::fs::write(source.join(entry.file.as_deref().unwrap()), archive).unwrap();
    let store = Store::new(dir.join("OfficialPlugins"));
    fetch(
        entry,
        std::slice::from_ref(entry),
        &store,
        Some(&source),
        &NoNetwork,
        &Arc::new(AtomicBool::new(false)),
        &mut |_, _| {},
    )
}

#[test]
fn a_pinned_archive_unpacks_seals_publishes_and_activates() {
    let dir = tempfile::tempdir().unwrap();
    let archive = good_archive("kit");
    let entry = pin_entry("kit", &archive);
    let fetched = fetch_from(dir.path(), &entry, &archive).unwrap();
    assert!(!fetched.reused);
    assert!(fetched.manifest.contains("\"official\":true"));
    let store = Store::new(dir.path().join("OfficialPlugins"));
    assert_eq!(fetched.copy, store.copy_path("kit", &entry.sha256));
    assert!(is_sealed(&fetched.copy));
    let tool = std::fs::metadata(fetched.copy.join("bin/tool")).unwrap();
    assert_eq!(tool.mode() & 0o777, 0o555);
    assert_eq!(
        std::fs::metadata(store.archive_path("kit", &entry.sha256))
            .unwrap()
            .mode()
            & 0o777,
        0o444
    );
    assert_eq!(store.copy("kit", &entry.sha256), Some(fetched.copy.clone()));
    let again = fetch_from(dir.path(), &entry, &archive).unwrap();
    assert!(again.reused);
    assert_eq!(store.active_sha("kit"), None);
    assert!(store.activate("kit", &entry.sha256));
    assert_eq!(store.active_sha("kit"), Some(entry.sha256));
    let leftovers: Vec<String> = std::fs::read_dir(store.plugin_folder("kit"))
        .unwrap()
        .filter_map(|e| e.ok()?.file_name().into_string().ok())
        .filter(|n| n.starts_with(".fetch-") || n.starts_with(".stage-"))
        .collect();
    assert!(leftovers.is_empty(), "{leftovers:?}");
    discard(&fetched.copy);
    assert!(!fetched.copy.exists());
}

#[test]
fn a_changed_copy_is_no_longer_trusted() {
    let dir = tempfile::tempdir().unwrap();
    let archive = good_archive("kit");
    let entry = pin_entry("kit", &archive);
    let fetched = fetch_from(dir.path(), &entry, &archive).unwrap();
    let store = Store::new(dir.path().join("OfficialPlugins"));
    let tool = fetched.copy.join("bin");
    std::fs::set_permissions(&tool, std::fs::Permissions::from_mode(0o755)).unwrap();
    std::fs::set_permissions(tool.join("tool"), std::fs::Permissions::from_mode(0o755)).unwrap();
    std::fs::write(tool.join("tool"), b"#!/bin/sh\necho changed\n").unwrap();
    seal(&fetched.copy);
    assert_eq!(store.copy("kit", &entry.sha256), None);
    assert!(!store.activate("kit", &entry.sha256));
}

fn refused(archive: Vec<u8>, entry: Option<PinEntry>) -> FetchFailure {
    let dir = tempfile::tempdir().unwrap();
    let entry = entry.unwrap_or_else(|| pin_entry("kit", &archive));
    let failure = fetch_from(dir.path(), &entry, &archive)
        .err()
        .expect("refused");
    let store = Store::new(dir.path().join("OfficialPlugins"));
    assert!(!store.copy_path("kit", &entry.sha256).exists());
    failure
}

#[test]
fn hostile_and_wrong_archives_are_refused() {
    let archive = good_archive("kit");
    let mut other = pin_entry("kit", &archive);
    other.sha256 = "0".repeat(64);
    let failure = refused(archive, Some(other));
    assert_eq!(failure.code, FetchCode::Verify);
    assert!(
        failure.detail.contains("doesn't match"),
        "{}",
        failure.detail
    );

    let text = manifest("kit", "1.0.0", "");
    let cases: Vec<(Vec<u8>, &str)> =
        vec![
        (
            gz(&tar(&[
                file("kit/plugin.json", text.as_bytes()),
                file("kit/../escape", b"x"),
            ])),
            "isn't inside",
        ),
        (
            gz(&tar(&[
                file("kit/plugin.json", text.as_bytes()),
                Entry {
                    path: "kit/link",
                    body: b"",
                    mode: 0o777,
                    kind: b'2',
                },
            ])),
            "a link or a special file",
        ),
        (gz(&tar(&[file("kit/other.txt", b"x")])), "has no kit/plugin.json"),
        (
            gz(&tar(&[
                file("kit/plugin.json", text.as_bytes()),
                file("kit/plugin.json", text.as_bytes()),
            ])),
            "twice",
        ),
        (
            gz(&tar(&[
                file("kit/plugin.json", text.as_bytes()),
                file("kit/.leases", b"x"),
            ])),
            "keeps for itself",
        ),
        (
            gz(&tar(&[
                file("kit/plugin.json", text.as_bytes()),
                file("kit/a/__pycache__/x.pyc", b"x"),
            ])),
            "keeps for itself",
        ),
        (
            gz(&tar(&[file("kit/plugin.json", manifest("kit", "2.0.0", "").as_bytes())])),
            "isn't version 1.0.0",
        ),
        (
            gz(&tar(&[file("kit/plugin.json", manifest("other", "1.0.0", "").as_bytes())])),
            "isn't the kit plugin",
        ),
        (
            gz(&tar(&[file(
                "kit/plugin.json",
                manifest(
                    "kit",
                    "1.0.0",
                    r#","contributes":{"programs":[{"name":"git","path":"bin/git","claim":true}]}"#,
                )
                .as_bytes(),
            )])),
            "it claims git",
        ),
        (b"not a gzip file at all".to_vec(), "isn't a gzip file"),
        (
            {
                let mut bytes = good_archive("kit");
                bytes.extend_from_slice(b"trailing");
                bytes
            },
            "data after its archive",
        ),
        (
            {
                let bytes = good_archive("kit");
                bytes[..bytes.len() - 12].to_vec()
            },
            "",
        ),
    ];
    for (archive, needle) in cases {
        let failure = refused(archive, None);
        assert_eq!(failure.code, FetchCode::Verify, "{}", failure.detail);
        assert!(
            failure.detail.contains(needle),
            "{needle}: {}",
            failure.detail
        );
    }
}

#[test]
fn expansion_limits_stop_bombs() {
    let dir = tempfile::tempdir().unwrap();
    let text = manifest("kit", "1.0.0", "");
    let zeros = vec![0u8; 3 << 20];
    let archive = gz(&tar(&[
        file("kit/plugin.json", text.as_bytes()),
        file("kit/zeros", &zeros),
    ]));
    let entry = pin_entry("kit", &archive);
    let archive_path = dir.path().join("kit.tar.gz");
    std::fs::write(&archive_path, &archive).unwrap();
    let mut store = Store::new(dir.path().join("OfficialPlugins"));
    store.limits.ratio_floor = 1 << 20;
    let scratch = store.make_scratch("kit", ".fetch-").unwrap();
    let failure = verify_and_publish(
        &entry,
        std::slice::from_ref(&entry),
        &archive_path,
        &scratch,
        &store,
    )
    .err()
    .unwrap();
    assert_eq!(failure.code, FetchCode::Verify);
    assert!(
        failure.detail.contains("times its size"),
        "{}",
        failure.detail
    );
    store.limits = Limits {
        expanded: 1 << 20,
        ..Limits::default()
    };
    let failure = verify_and_publish(
        &entry,
        std::slice::from_ref(&entry),
        &archive_path,
        &scratch,
        &store,
    )
    .err()
    .unwrap();
    assert!(
        failure.detail.contains("more than 1 MB"),
        "{}",
        failure.detail
    );
    store.limits = Limits {
        entries: 1,
        ..Limits::default()
    };
    let failure = verify_and_publish(
        &entry,
        std::slice::from_ref(&entry),
        &archive_path,
        &scratch,
        &store,
    )
    .err()
    .unwrap();
    assert!(
        failure.detail.contains("more than 1 entries"),
        "{}",
        failure.detail
    );
}

#[test]
fn a_missing_local_file_or_pin_is_reported() {
    let dir = tempfile::tempdir().unwrap();
    let archive = good_archive("kit");
    let entry = pin_entry("kit", &archive);
    let store = Store::new(dir.path().join("OfficialPlugins"));
    let failure = fetch(
        &entry,
        std::slice::from_ref(&entry),
        &store,
        Some(&dir.path().join("empty")),
        &NoNetwork,
        &Arc::new(AtomicBool::new(false)),
        &mut |_, _| {},
    )
    .err()
    .unwrap();
    assert_eq!(failure.code, FetchCode::Offline);
    let mut unpinned = entry;
    unpinned.url = None;
    let failure = fetch(
        &unpinned,
        std::slice::from_ref(&unpinned),
        &store,
        None,
        &NoNetwork,
        &Arc::new(AtomicBool::new(false)),
        &mut |_, _| {},
    )
    .err()
    .unwrap();
    assert_eq!(failure.code, FetchCode::Unsupported);
    assert_eq!(
        failure.code.reason(),
        "Not available in this version of Ardia."
    );
}

#[test]
fn the_instance_source_reads_from_ardia_instance() {
    assert_eq!(
        instance_source("cliHome=/a,officialPluginsFrom=/tmp/x,y,syncFolder=/s"),
        Some(PathBuf::from("/tmp/x,y"))
    );
    assert_eq!(
        instance_source("officialPluginsFrom=file:///tmp/src"),
        Some(PathBuf::from("/tmp/src"))
    );
    assert_eq!(instance_source("cliHome=/a"), None);
    assert_eq!(instance_source("officialPluginsFrom="), None);
}

type Reply = Box<dyn FnOnce(&mut std::net::TcpStream) + Send>;
type Downloaded = (Result<(), FetchFailure>, Vec<u8>, Vec<(u64, u64)>);

fn serve(replies: Vec<Reply>) -> String {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let address = listener.local_addr().unwrap();
    std::thread::spawn(move || {
        for reply in replies {
            let Ok((mut stream, _)) = listener.accept() else {
                return;
            };
            let mut reader = std::io::BufReader::new(stream.try_clone().unwrap());
            let mut line = String::new();
            while reader.read_line(&mut line).is_ok_and(|n| n > 2) {
                line.clear();
            }
            reply(&mut stream);
        }
    });
    format!("http://{address}")
}

fn download(url: &str, cancel: &Arc<AtomicBool>) -> Downloaded {
    let dir = tempfile::tempdir().unwrap();
    let to = dir.path().join("file");
    let mut seen = Vec::new();
    let result = HttpDownload.download(
        url,
        &to,
        cancel,
        &mut |received, total| seen.push((received, total)),
        &Limits::default(),
    );
    (result, std::fs::read(&to).unwrap_or_default(), seen)
}

#[test]
fn http_downloads_report_progress_refuse_plain_redirects_and_cancel() {
    let body = vec![7u8; 3 << 20];
    let sent = body.clone();
    let base = serve(vec![Box::new(move |stream| {
        let _ = write!(
            stream,
            "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
            sent.len()
        );
        let _ = stream.write_all(&sent);
    })]);
    let (result, got, seen) = download(&format!("{base}/a"), &Arc::new(AtomicBool::new(false)));
    assert_eq!(result, Ok(()));
    assert_eq!(got, body);
    assert!(!seen.is_empty());
    assert!(seen.iter().all(|(_, total)| *total == body.len() as u64));

    let base = serve(vec![Box::new(|stream| {
        let _ = stream.write_all(
            b"HTTP/1.1 302 Found\r\nLocation: http://example.invalid/x\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
        );
    })]);
    let (result, got, _) = download(&format!("{base}/b"), &Arc::new(AtomicBool::new(false)));
    let failure = result.err().unwrap();
    assert_eq!(failure.code, FetchCode::Failed);
    assert_eq!(failure.detail, "the server answered 302");
    assert!(got.is_empty());

    let base = serve(vec![Box::new(|stream| {
        let _ = stream
            .write_all(b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
    })]);
    let (result, _, _) = download(&format!("{base}/c"), &Arc::new(AtomicBool::new(false)));
    assert_eq!(result.err().unwrap().detail, "the server answered 404");

    let base = serve(vec![Box::new(|stream| {
        let _ = stream.write_all(
            b"HTTP/1.1 200 OK\r\nContent-Length: 1000000\r\nConnection: close\r\n\r\nstart",
        );
        std::thread::sleep(Duration::from_secs(5));
    })]);
    let cancel = Arc::new(AtomicBool::new(false));
    let flag = cancel.clone();
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(300));
        flag.store(true, Ordering::SeqCst);
    });
    let started = Instant::now();
    let (result, got, _) = download(&format!("{base}/d"), &cancel);
    assert_eq!(result.err().unwrap().code, FetchCode::Cancelled);
    assert!(started.elapsed() < Duration::from_secs(3));
    assert!(got.is_empty());
}
