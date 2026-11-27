use std::collections::HashSet;
use std::fs::{File, OpenOptions};
use std::io::{BufRead, BufReader, Read, Seek, SeekFrom, Write};
use std::os::unix::fs::{DirBuilderExt, MetadataExt, OpenOptionsExt, PermissionsExt};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, OnceLock};
use std::time::{Duration, Instant};

use futures::AsyncReadExt as _;
use http_client::{AsyncBody, HttpClient, HttpRequestExt as _, Method, RedirectPolicy, Request};
use serde_json::Value;
use sha2::{Digest, Sha256};

use super::folders::{OFFICIAL_PREFIX, PinEntry};
use super::manifest::{MANIFEST_FILE, is_name};

pub const IDLE_TIMEOUT: Duration = Duration::from_secs(60);
pub const DEADLINE: Duration = Duration::from_secs(900);
pub const ACTIVE: &str = "active";
pub const ARCHIVE_SUFFIX: &str = ".tar.gz";
pub const SOURCE_KEY: &str = "officialPluginsFrom";
const BLOCK: usize = 512;
const CHUNK: usize = 1 << 20;
const STEP: usize = 4 << 10;
const MANIFEST_LIMIT: u64 = 256 * 1024;
const MAX_REDIRECTS: usize = 10;
const CACHES: &str = "__pycache__";
const RESERVED: [&str; 3] = [".leases", ".after-update", ".after-update-claim"];
const INSTANCE_KEYS: [&str; 15] = [
    "jsLocation",
    "chromiumSwitches",
    "downloadsDir",
    "updateFeed",
    "allowAudio",
    "allowOcclusion",
    "releaseNotes",
    "cliHome",
    "cliBinDir",
    "cliUrl",
    "syncFolder",
    "sharedFolders",
    "importSourceDir",
    "importSafariHome",
    SOURCE_KEY,
];

#[derive(Clone, Copy, Debug)]
pub struct Limits {
    pub download: u64,
    pub expanded: u64,
    pub entries: usize,
    pub depth: usize,
    pub ratio: u64,
    pub entry_ratio: u64,
    pub ratio_floor: u64,
}

impl Default for Limits {
    fn default() -> Self {
        Limits {
            download: 512 << 20,
            expanded: 1 << 30,
            entries: 20_000,
            depth: 32,
            ratio: 100,
            entry_ratio: 200,
            ratio_floor: 4 << 20,
        }
    }
}

impl Limits {
    fn expanded_allowed(&self, compressed: u64) -> u64 {
        self.expanded
            .min(self.ratio_floor.max(compressed.saturating_mul(self.ratio)))
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum FetchCode {
    Offline,
    Failed,
    Verify,
    Cancelled,
    Unsupported,
}

impl FetchCode {
    pub fn reason(self) -> &'static str {
        match self {
            FetchCode::Offline => {
                "Couldn't download it. Check your internet connection, then try again."
            }
            FetchCode::Failed => "Couldn't download it. Try again.",
            FetchCode::Verify => {
                "The download didn't match the copy this version of Ardia trusts, so it wasn't installed."
            }
            FetchCode::Cancelled => "Cancelled.",
            FetchCode::Unsupported => "Not available in this version of Ardia.",
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct FetchFailure {
    pub code: FetchCode,
    pub detail: String,
}

fn failed(code: FetchCode, detail: impl Into<String>) -> FetchFailure {
    FetchFailure {
        code,
        detail: detail.into(),
    }
}

pub fn is_sha(text: &str) -> bool {
    text.len() == 64
        && text
            .chars()
            .all(|c| c.is_ascii_digit() || ('a'..='f').contains(&c))
}

pub fn folder_id(sha: &str) -> String {
    format!("{OFFICIAL_PREFIX}{sha}")
}

pub fn sha_of_folder_id(id: &str) -> Option<&str> {
    id.strip_prefix(OFFICIAL_PREFIX).filter(|s| is_sha(s))
}

const COMMA_KEYS: [&str; 11] = [
    "chromiumSwitches",
    "downloadsDir",
    "updateFeed",
    "cliHome",
    "cliBinDir",
    "cliUrl",
    "syncFolder",
    "sharedFolders",
    "importSourceDir",
    "importSafariHome",
    SOURCE_KEY,
];

pub fn instance_value(text: &str, key: &str) -> Option<String> {
    let mut pieces: Vec<String> = Vec::new();
    let mut previous: Option<String> = None;
    for piece in text.split(',') {
        let head = piece.split('=').next().unwrap_or("").trim().to_owned();
        if !INSTANCE_KEYS.contains(&head.as_str())
            && previous.as_deref().is_some_and(|p| COMMA_KEYS.contains(&p))
        {
            if let Some(last) = pieces.last_mut() {
                last.push(',');
                last.push_str(piece);
            }
            continue;
        }
        pieces.push(piece.to_owned());
        previous = Some(head);
    }
    pieces.iter().find_map(|piece| {
        let (name, value) = piece.split_once('=')?;
        let value = value.trim();
        (name.trim() == key && !value.is_empty()).then(|| value.to_owned())
    })
}

pub fn instance_source(text: &str) -> Option<PathBuf> {
    instance_value(text, SOURCE_KEY)
        .map(|value| PathBuf::from(value.strip_prefix("file://").unwrap_or(&value)))
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

pub fn sha256_file(path: &Path) -> Option<String> {
    let mut file = OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW)
        .open(path)
        .ok()?;
    if !file.metadata().ok()?.is_file() {
        return None;
    }
    let mut hasher = Sha256::new();
    let mut buffer = vec![0u8; CHUNK];
    loop {
        let count = file.read(&mut buffer).ok()?;
        if count == 0 {
            break;
        }
        hasher.update(&buffer[..count]);
    }
    Some(hex(&hasher.finalize()))
}

fn random_suffix() -> String {
    format!("{}-{}", std::process::id(), uuid::Uuid::new_v4().simple())
}

fn anonymous_file(folder: &Path) -> Option<File> {
    let path = folder.join(format!(".snapshot-{}", random_suffix()));
    let file = OpenOptions::new()
        .read(true)
        .write(true)
        .create_new(true)
        .mode(0o600)
        .custom_flags(libc::O_NOFOLLOW)
        .open(&path)
        .ok()?;
    std::fs::remove_file(&path).ok()?;
    Some(file)
}

pub struct Snapshot {
    pub file: File,
    pub sha: String,
}

pub fn snapshot(path: &Path, scratch: &Path, limits: &Limits) -> Option<Snapshot> {
    let mut input = OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW)
        .open(path)
        .ok()?;
    let meta = input.metadata().ok()?;
    if !meta.is_file() || meta.len() > limits.download {
        return None;
    }
    let mut output = anonymous_file(scratch)?;
    let mut hasher = Sha256::new();
    let mut buffer = vec![0u8; CHUNK];
    let mut total = 0u64;
    loop {
        let count = input.read(&mut buffer).ok()?;
        if count == 0 {
            break;
        }
        total += count as u64;
        if total > limits.download {
            return None;
        }
        output.write_all(&buffer[..count]).ok()?;
        hasher.update(&buffer[..count]);
    }
    output.seek(SeekFrom::Start(0)).ok()?;
    Some(Snapshot {
        file: output,
        sha: hex(&hasher.finalize()),
    })
}

#[derive(Default)]
pub struct Inflation {
    produced: Vec<u64>,
    consumed: Vec<u64>,
}

impl Inflation {
    fn new() -> Self {
        Inflation {
            produced: vec![0],
            consumed: vec![0],
        }
    }

    fn mark(&mut self, produced: u64, consumed: u64) {
        self.produced.push(produced);
        self.consumed.push(consumed);
    }

    fn compressed(&self, start: u64, end: u64) -> u64 {
        let low = self
            .produced
            .partition_point(|p| *p <= start)
            .saturating_sub(1);
        let first = self
            .produced
            .partition_point(|p| *p < end)
            .min(self.produced.len() - 1);
        self.consumed[first]
            .saturating_sub(self.consumed[low])
            .max(1)
    }
}

struct Counted<R> {
    inner: R,
    consumed: u64,
}

impl<R: BufRead> Read for Counted<R> {
    fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
        let count = self.inner.read(buf)?;
        self.consumed += count as u64;
        Ok(count)
    }
}

impl<R: BufRead> BufRead for Counted<R> {
    fn fill_buf(&mut self) -> std::io::Result<&[u8]> {
        self.inner.fill_buf()
    }

    fn consume(&mut self, amount: usize) {
        self.consumed += amount as u64;
        self.inner.consume(amount);
    }
}

pub fn gunzip(input: &mut File, output: &mut File, limits: &Limits) -> Result<Inflation, String> {
    input
        .seek(SeekFrom::Start(0))
        .map_err(|_| "the download couldn't be read".to_owned())?;
    let size = input
        .metadata()
        .map_err(|_| "the download couldn't be read".to_owned())?
        .len();
    let mut magic = [0u8; 3];
    if input.read_exact(&mut magic).is_err() || magic != [0x1f, 0x8b, 8] {
        return Err("the download isn't a gzip file".into());
    }
    input
        .seek(SeekFrom::Start(0))
        .map_err(|_| "the download couldn't be read".to_owned())?;
    let allowed = limits.expanded_allowed(size);
    let counted = Counted {
        inner: BufReader::with_capacity(CHUNK, &*input),
        consumed: 0,
    };
    let mut decoder = flate2::bufread::GzDecoder::new(counted);
    let mut inflation = Inflation::new();
    let mut buffer = vec![0u8; STEP];
    let mut written = 0u64;
    loop {
        let count = match decoder.read(&mut buffer) {
            Ok(count) => count,
            Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
            Err(e) if e.kind() == std::io::ErrorKind::UnexpectedEof => {
                return Err("the download ends too soon".into());
            }
            Err(_) => return Err("the download is damaged".into()),
        };
        if count == 0 {
            break;
        }
        written += count as u64;
        inflation.mark(written, decoder.get_ref().consumed);
        if written > limits.expanded {
            return Err(format!(
                "the download unpacks to more than {} MB",
                limits.expanded >> 20
            ));
        }
        if written > allowed {
            return Err(format!(
                "the download unpacks to more than {} times its size",
                limits.ratio
            ));
        }
        output
            .write_all(&buffer[..count])
            .map_err(|e| format!("the download couldn't be unpacked ({e})"))?;
    }
    let mut rest = decoder.into_inner();
    let trailing = rest.fill_buf().map(|b| !b.is_empty()).unwrap_or(true);
    if trailing || rest.consumed != size {
        return Err("the download has data after its archive".into());
    }
    Ok(inflation)
}

struct Header {
    path: String,
    kind: u8,
    mode: u64,
    size: u64,
}

fn octal(bytes: &[u8]) -> Option<u64> {
    let mut value = 0u64;
    let mut seen = false;
    for &byte in bytes {
        if byte == 0 || byte == b' ' {
            if seen {
                break;
            }
            continue;
        }
        if !(b'0'..=b'7').contains(&byte) {
            return None;
        }
        seen = true;
        value = value * 8 + u64::from(byte - b'0');
        if value >= 1 << 40 {
            return None;
        }
    }
    Some(value)
}

fn text(bytes: &[u8]) -> Option<String> {
    let used = bytes.split(|b| *b == 0).next().unwrap_or(&[]);
    String::from_utf8(used.to_vec()).ok()
}

fn header(raw: &[u8]) -> Option<Option<Header>> {
    if raw.iter().all(|b| *b == 0) {
        return Some(None);
    }
    let sum = octal(&raw[148..156])?;
    let computed: u64 = raw
        .iter()
        .enumerate()
        .map(|(i, b)| {
            if (148..156).contains(&i) {
                0x20
            } else {
                u64::from(*b)
            }
        })
        .sum();
    if computed != sum {
        return None;
    }
    let name = text(&raw[0..100])?;
    let mode = octal(&raw[100..108])?;
    let size = octal(&raw[124..136])?;
    let mut path = name;
    if &raw[257..262] == b"ustar"
        && let Some(prefix) = text(&raw[345..500]).filter(|p| !p.is_empty())
    {
        path = format!("{prefix}/{path}");
    }
    Some(Some(Header {
        path,
        kind: raw[156],
        mode,
        size,
    }))
}

fn parts(path: &str, top: &str, depth: usize) -> Option<Vec<String>> {
    let trimmed = path.trim_end_matches('/');
    let pieces: Vec<&str> = trimmed.split('/').collect();
    if pieces.first() != Some(&top) || pieces.len() > depth {
        return None;
    }
    for piece in &pieces {
        if piece.is_empty()
            || *piece == "."
            || *piece == ".."
            || piece.len() > 255
            || piece.chars().any(|c| (c as u32) < 0x20 || c as u32 == 0x7f)
        {
            return None;
        }
    }
    Some(pieces[1..].iter().map(|s| (*s).to_owned()).collect())
}

fn pax_path(bytes: &[u8]) -> Option<Option<String>> {
    let mut path = None;
    let mut at = 0;
    while at < bytes.len() {
        let space = at + bytes[at..].iter().position(|b| *b == b' ')?;
        let length: usize = std::str::from_utf8(&bytes[at..space]).ok()?.parse().ok()?;
        if length <= space - at + 1 || length > bytes.len() - at || bytes[at + length - 1] != b'\n'
        {
            return None;
        }
        let record = &bytes[space + 1..at + length - 1];
        let equals = record.iter().position(|b| *b == b'=')?;
        let key = std::str::from_utf8(&record[..equals]).ok()?;
        if key == "size" || key == "linkpath" {
            return None;
        }
        if key == "path" {
            path = Some(String::from_utf8(record[equals + 1..].to_vec()).ok()?);
        }
        at += length;
    }
    Some(path)
}

fn folded(name: &str) -> String {
    name.to_lowercase()
}

trait Sink {
    fn folder(&mut self, path: &str) -> Result<(), String>;
    fn file(&mut self, path: &str) -> Result<(), String>;
    fn bytes(&mut self, path: &str, chunk: &[u8]) -> Result<(), String>;
    fn done(&mut self, path: &str, executable: bool) -> Result<(), String>;
}

fn read_exactly(tar: &mut File, count: usize, position: &mut u64) -> Option<Vec<u8>> {
    let mut bytes = vec![0u8; count];
    tar.read_exact(&mut bytes).ok()?;
    *position += count as u64;
    Some(bytes)
}

fn walk(
    tar: &mut File,
    top: &str,
    limits: &Limits,
    inflation: &Inflation,
    sink: &mut dyn Sink,
) -> Result<(), String> {
    tar.seek(SeekFrom::Start(0))
        .map_err(|_| "the download couldn't be unpacked".to_owned())?;
    let mut position = 0u64;
    let mut seen: HashSet<String> = HashSet::new();
    let mut folders: HashSet<String> = HashSet::from([String::new()]);
    let mut files: HashSet<String> = HashSet::new();
    let mut total = 0u64;
    let mut entries = 0usize;
    let mut next_path: Option<String> = None;
    let too_many = || format!("the archive has more than {} entries", limits.entries);
    loop {
        let raw = read_exactly(tar, BLOCK, &mut position).ok_or("the archive ends too soon")?;
        let entry = match header(&raw).ok_or("the archive is damaged")? {
            Some(entry) => entry,
            None => break,
        };
        entries += 1;
        if entries > limits.entries {
            return Err(too_many());
        }
        let padded = entry.size.div_ceil(BLOCK as u64) as usize * BLOCK;
        if entry.kind == b'x' {
            if next_path.is_some() || entry.size > 64 * 1024 {
                return Err("the archive is damaged".into());
            }
            let body = read_exactly(tar, padded, &mut position).ok_or("the archive is damaged")?;
            let path = pax_path(&body[..entry.size as usize])
                .ok_or("the archive has an extended header Ardia doesn't accept")?;
            next_path = Some(path.unwrap_or_default());
            continue;
        }
        let path = next_path
            .take()
            .filter(|p| !p.is_empty())
            .unwrap_or(entry.path.clone());
        let relative = parts(&path, top, limits.depth).ok_or_else(|| {
            format!(
                "{path} isn't inside {top}/ or is more than {} folders deep",
                limits.depth
            )
        })?;
        if relative.iter().any(|p| folded(p) == CACHES)
            || relative
                .first()
                .is_some_and(|p| RESERVED.contains(&folded(p).as_str()))
        {
            return Err(format!("{path} is a name Ardia keeps for itself"));
        }
        let joined = relative.join("/");
        if !seen.insert(joined.clone()) {
            return Err(format!("{path} is in the archive twice"));
        }
        let mut make_folders = |parts: &[String], sink: &mut dyn Sink| -> Result<(), String> {
            let mut current = String::new();
            for part in parts {
                current = if current.is_empty() {
                    part.clone()
                } else {
                    format!("{current}/{part}")
                };
                if folders.contains(&current) {
                    continue;
                }
                if files.contains(&current) {
                    return Err(format!("{current} is both a file and a folder"));
                }
                if folders.len() + files.len() > limits.entries {
                    return Err(too_many());
                }
                sink.folder(&current)?;
                folders.insert(current.clone());
            }
            Ok(())
        };
        match entry.kind {
            b'5' => {
                if entry.size != 0 {
                    return Err("the archive is damaged".into());
                }
                if relative.is_empty() {
                    continue;
                }
                make_folders(&relative, sink)?;
            }
            b'0' | 0 => {
                if relative.is_empty() {
                    return Err(format!("{path} isn't inside {top}/"));
                }
                total += entry.size;
                if total > limits.expanded {
                    return Err(format!(
                        "the archive unpacks to more than {} MB",
                        limits.expanded >> 20
                    ));
                }
                if relative.len() > 1 {
                    make_folders(&relative[..relative.len() - 1], sink)?;
                }
                if folders.contains(&joined) {
                    return Err(format!("{path} is both a file and a folder"));
                }
                if folders.len() + files.len() > limits.entries {
                    return Err(too_many());
                }
                let start = position;
                if entry.size >= limits.ratio_floor
                    && entry.size / inflation.compressed(start, start + entry.size)
                        > limits.entry_ratio
                {
                    return Err(format!(
                        "{path} unpacks to more than {} times its compressed size",
                        limits.entry_ratio
                    ));
                }
                sink.file(&joined)?;
                files.insert(joined.clone());
                let mut left = entry.size;
                while left > 0 {
                    let take = left.min(CHUNK as u64) as usize;
                    let chunk = read_exactly(tar, take, &mut position)
                        .ok_or("the archive ends too soon")?;
                    sink.bytes(&joined, &chunk)?;
                    left -= take as u64;
                }
                sink.done(&joined, entry.mode & 0o111 != 0)?;
                let skip = padded - entry.size as usize;
                if skip > 0 && read_exactly(tar, skip, &mut position).is_none() {
                    return Err("the archive ends too soon".into());
                }
            }
            _ => {
                return Err(format!(
                    "{path} is a link or a special file; an official plugin has only files and folders"
                ));
            }
        }
    }
    if !files.contains(MANIFEST_FILE) {
        return Err(format!("the archive has no {top}/{MANIFEST_FILE}"));
    }
    Ok(())
}

struct Extract<'a> {
    stage: &'a Path,
    out: Option<File>,
}

impl Sink for Extract<'_> {
    fn folder(&mut self, path: &str) -> Result<(), String> {
        std::fs::DirBuilder::new()
            .mode(0o755)
            .create(self.stage.join(path))
            .map_err(|e| format!("{path} couldn't be made ({e})"))
    }

    fn file(&mut self, path: &str) -> Result<(), String> {
        let file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .custom_flags(libc::O_NOFOLLOW)
            .open(self.stage.join(path))
            .map_err(|e| format!("{path} couldn't be written ({e})"))?;
        self.out = Some(file);
        Ok(())
    }

    fn bytes(&mut self, path: &str, chunk: &[u8]) -> Result<(), String> {
        self.out
            .as_mut()
            .ok_or_else(|| format!("{path} couldn't be written"))?
            .write_all(chunk)
            .map_err(|e| format!("{path} couldn't be written ({e})"))
    }

    fn done(&mut self, path: &str, executable: bool) -> Result<(), String> {
        let file = self
            .out
            .take()
            .ok_or_else(|| format!("{path} couldn't be written"))?;
        file.set_permissions(std::fs::Permissions::from_mode(if executable {
            0o755
        } else {
            0o644
        }))
        .map_err(|_| format!("{path} couldn't be written"))
    }
}

#[derive(Default)]
struct DigestSink {
    lines: Vec<(String, String)>,
    hasher: Sha256,
}

impl Sink for DigestSink {
    fn folder(&mut self, path: &str) -> Result<(), String> {
        self.lines.push((path.to_owned(), format!("d {path}\n")));
        Ok(())
    }

    fn file(&mut self, _: &str) -> Result<(), String> {
        self.hasher = Sha256::new();
        Ok(())
    }

    fn bytes(&mut self, _: &str, chunk: &[u8]) -> Result<(), String> {
        self.hasher.update(chunk);
        Ok(())
    }

    fn done(&mut self, path: &str, executable: bool) -> Result<(), String> {
        let digest = hex(&std::mem::take(&mut self.hasher).finalize());
        let mode = if executable { "755" } else { "644" };
        self.lines
            .push((path.to_owned(), format!("f {mode} {digest} {path}\n")));
        Ok(())
    }
}

fn digest_lines(mut lines: Vec<(String, String)>) -> String {
    lines.sort_by(|a, b| a.0.as_bytes().cmp(b.0.as_bytes()));
    let mut hasher = Sha256::new();
    for (_, line) in lines {
        hasher.update(line.as_bytes());
    }
    hex(&hasher.finalize())
}

pub fn unpack(
    archive: &mut File,
    top: &str,
    stage: &Path,
    scratch: &Path,
    limits: &Limits,
) -> Result<(), String> {
    let mut tar = anonymous_file(scratch).ok_or("the download couldn't be unpacked")?;
    let inflation = gunzip(archive, &mut tar, limits)?;
    let mut sink = Extract { stage, out: None };
    walk(&mut tar, top, limits, &inflation, &mut sink)
}

pub fn archive_payload_digest(
    archive: &mut File,
    top: &str,
    scratch: &Path,
    limits: &Limits,
) -> Option<String> {
    let mut tar = anonymous_file(scratch)?;
    let inflation = gunzip(archive, &mut tar, limits).ok()?;
    let mut sink = DigestSink::default();
    walk(&mut tar, top, limits, &inflation, &mut sink).ok()?;
    Some(digest_lines(sink.lines))
}

pub fn tree_payload_digest(root: &Path) -> Option<String> {
    let mut lines = Vec::new();
    let mut pending = vec![PathBuf::new()];
    while let Some(relative) = pending.pop() {
        for entry in std::fs::read_dir(root.join(&relative)).ok()? {
            let entry = entry.ok()?;
            let child = relative.join(entry.file_name());
            let name = child.to_str()?.to_owned();
            let meta = std::fs::symlink_metadata(root.join(&child)).ok()?;
            if meta.is_dir() {
                lines.push((name.clone(), format!("d {name}\n")));
                pending.push(child);
            } else if meta.is_file() {
                let digest = sha256_file(&root.join(&child))?;
                let mode = if meta.mode() & 0o111 != 0 {
                    "755"
                } else {
                    "644"
                };
                lines.push((name.clone(), format!("f {mode} {digest} {name}\n")));
            } else {
                return None;
            }
        }
    }
    Some(digest_lines(lines))
}

fn walk_tree(root: &Path, visit: &mut dyn FnMut(&Path, &std::fs::Metadata) -> bool) -> bool {
    let Ok(meta) = std::fs::symlink_metadata(root) else {
        return false;
    };
    if meta.is_dir() {
        let Ok(entries) = std::fs::read_dir(root) else {
            return false;
        };
        for entry in entries {
            let Ok(entry) = entry else {
                return false;
            };
            if !walk_tree(&entry.path(), visit) {
                return false;
            }
        }
    }
    visit(root, &meta)
}

pub fn seal(root: &Path) -> bool {
    walk_tree(root, &mut |path, meta| {
        if meta.file_type().is_symlink() {
            return false;
        }
        let mode = meta.mode() & 0o777;
        let sealed = if meta.is_dir() || mode & 0o111 != 0 {
            0o555
        } else {
            0o444
        };
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(sealed)).is_ok()
    })
}

pub fn is_sealed(root: &Path) -> bool {
    walk_tree(root, &mut |_, meta| {
        !meta.file_type().is_symlink() && meta.mode() & 0o222 == 0
    })
}

fn unseal(root: &Path) {
    if let Ok(meta) = std::fs::symlink_metadata(root)
        && meta.is_dir()
    {
        let _ = std::fs::set_permissions(root, std::fs::Permissions::from_mode(0o700));
        if let Ok(entries) = std::fs::read_dir(root) {
            for entry in entries.flatten() {
                unseal(&entry.path());
            }
        }
    }
}

pub fn discard(path: &Path) {
    let Ok(meta) = std::fs::symlink_metadata(path) else {
        return;
    };
    if !meta.is_dir() {
        let _ = std::fs::remove_file(path);
        return;
    }
    unseal(path);
    let trash = path.with_file_name(format!(".trash-{}", random_suffix()));
    let doomed = if std::fs::rename(path, &trash).is_ok() {
        trash
    } else {
        path.to_path_buf()
    };
    let _ = std::fs::remove_dir_all(doomed);
}

fn is_real_folder(path: &Path) -> bool {
    std::fs::symlink_metadata(path).is_ok_and(|m| m.is_dir())
}

fn real_folder(path: &Path) -> Option<PathBuf> {
    if !is_real_folder(path) {
        std::fs::DirBuilder::new()
            .recursive(true)
            .mode(0o700)
            .create(path)
            .ok()?;
    }
    is_real_folder(path).then(|| path.to_path_buf())
}

pub fn read_manifest_text(folder: &Path) -> Option<String> {
    let path = folder.join(MANIFEST_FILE);
    let meta = std::fs::symlink_metadata(&path).ok()?;
    if !meta.is_file() || meta.len() > MANIFEST_LIMIT {
        return None;
    }
    std::fs::read_to_string(path).ok()
}

pub fn claimed_programs(text: &str) -> Vec<String> {
    let Ok(doc) = serde_json::from_str::<Value>(text) else {
        return Vec::new();
    };
    doc.get("contributes")
        .and_then(|c| c.get("programs"))
        .or_else(|| doc.get("programs"))
        .and_then(Value::as_array)
        .map(|list| {
            list.iter()
                .filter(|p| p.get("claim") == Some(&Value::Bool(true)))
                .filter_map(|p| p.get("name").and_then(Value::as_str).map(str::to_owned))
                .collect()
        })
        .unwrap_or_default()
}

pub fn refusal(text: &str, entry: &PinEntry, pin: &[PinEntry]) -> Option<String> {
    let doc = serde_json::from_str::<Value>(text).ok();
    let field = |key: &str| {
        doc.as_ref()
            .and_then(|d| d.get(key))
            .and_then(Value::as_str)
    };
    if field("name") != Some(entry.name.as_str()) {
        return Some(format!("its plugin.json isn't the {} plugin", entry.name));
    }
    if field("version") != Some(entry.version.as_str()) {
        return Some(format!(
            "its plugin.json isn't version {}, the one this Ardia pins",
            entry.version
        ));
    }
    for program in claimed_programs(text) {
        if !entry.reserved_programs.contains(&program) {
            return Some(format!(
                "it claims {program}, which this Ardia doesn't reserve for it"
            ));
        }
        let owner = pin
            .iter()
            .find(|e| e.reserved_programs.contains(&program))
            .map(|e| e.name.as_str());
        if owner != Some(entry.name.as_str()) {
            return Some(format!(
                "it claims {program}, which Ardia's signed list doesn't give it"
            ));
        }
    }
    None
}

#[derive(Clone, Debug)]
pub struct Store {
    pub root: PathBuf,
    pub limits: Limits,
}

pub struct Held(File);

impl Drop for Held {
    fn drop(&mut self) {
        use std::os::fd::AsRawFd;
        unsafe {
            libc::flock(self.0.as_raw_fd(), libc::LOCK_UN);
        }
    }
}

impl Store {
    pub fn new(root: PathBuf) -> Self {
        Store {
            root,
            limits: Limits::default(),
        }
    }

    pub fn plugin_folder(&self, name: &str) -> PathBuf {
        self.root.join(name)
    }

    pub fn copy_path(&self, name: &str, sha: &str) -> PathBuf {
        self.plugin_folder(name).join(sha)
    }

    pub fn archive_path(&self, name: &str, sha: &str) -> PathBuf {
        self.plugin_folder(name)
            .join(format!("{sha}{ARCHIVE_SUFFIX}"))
    }

    fn lock(&self, name: &str) -> Option<Held> {
        use std::os::fd::AsRawFd;
        if !is_name(name) {
            return None;
        }
        real_folder(&self.root)?;
        let file = OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .mode(0o600)
            .custom_flags(libc::O_NOFOLLOW)
            .open(self.root.join(format!(".{name}.lock")))
            .ok()?;
        let locked = unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX) } == 0;
        locked.then_some(Held(file))
    }

    pub fn make_scratch(&self, name: &str, prefix: &str) -> Option<PathBuf> {
        if !is_name(name) {
            return None;
        }
        let folder = real_folder(&self.plugin_folder(name))?;
        let path = folder.join(format!("{prefix}{}", random_suffix()));
        std::fs::DirBuilder::new().mode(0o700).create(&path).ok()?;
        Some(path)
    }

    pub fn copy(&self, name: &str, sha: &str) -> Option<PathBuf> {
        if !is_name(name) || !is_sha(sha) {
            return None;
        }
        let path = self.copy_path(name, sha);
        let archive = self.archive_path(name, sha);
        if !is_real_folder(&path)
            || !std::fs::symlink_metadata(&archive).is_ok_and(|m| m.is_file())
            || !is_sealed(&path)
        {
            return None;
        }
        let scratch = self.plugin_folder(name);
        let held = snapshot(&archive, &scratch, &self.limits)?;
        if held.sha != sha {
            return None;
        }
        let mut file = held.file;
        let expected = archive_payload_digest(&mut file, name, &scratch, &self.limits)?;
        (tree_payload_digest(&path)? == expected).then_some(path)
    }

    pub fn active_sha(&self, name: &str) -> Option<String> {
        let target = std::fs::read_link(self.plugin_folder(name).join(ACTIVE)).ok()?;
        let sha = target.to_str()?.to_owned();
        is_sha(&sha).then_some(sha)
    }

    pub fn publish(
        &self,
        name: &str,
        staged: &Path,
        archive: &mut File,
        sha: &str,
    ) -> Result<PathBuf, String> {
        let Some(_held) = self.lock(name) else {
            discard(staged);
            return Err("its folder couldn't be locked".into());
        };
        if let Some(existing) = self.copy(name, sha) {
            discard(staged);
            return Ok(existing);
        }
        let copy = self.copy_path(name, sha);
        let archive_path = self.archive_path(name, sha);
        if is_real_folder(&copy) {
            discard(&copy);
        }
        let _ = std::fs::remove_file(&archive_path);
        let Some(folder) = real_folder(&self.plugin_folder(name)) else {
            discard(staged);
            return Err("its folder isn't one you own".into());
        };
        let kept = folder.join(format!(".download-{}", random_suffix()));
        let written = (|| -> std::io::Result<()> {
            let mut out = OpenOptions::new()
                .write(true)
                .create_new(true)
                .mode(0o600)
                .custom_flags(libc::O_NOFOLLOW)
                .open(&kept)?;
            archive.seek(SeekFrom::Start(0))?;
            std::io::copy(archive, &mut out)?;
            out.set_permissions(std::fs::Permissions::from_mode(0o444))
        })();
        if let Err(e) = written.and_then(|_| std::fs::rename(&kept, &archive_path)) {
            let _ = std::fs::remove_file(&kept);
            discard(staged);
            return Err(format!("its download couldn't be kept ({e})"));
        }
        if copy.exists() || std::fs::rename(staged, &copy).is_err() {
            let _ = std::fs::remove_file(&archive_path);
            discard(staged);
            return Err("its copy couldn't be put in place".into());
        }
        if !seal(&copy) {
            discard(&copy);
            let _ = std::fs::remove_file(&archive_path);
            return Err("its copy couldn't be made read-only".into());
        }
        if self.copy(name, sha).is_none() {
            discard(&copy);
            let _ = std::fs::remove_file(&archive_path);
            return Err("its copy doesn't match its download".into());
        }
        Ok(copy)
    }

    pub fn activate(&self, name: &str, sha: &str) -> bool {
        let Some(_held) = self.lock(name) else {
            return false;
        };
        if self.copy(name, sha).is_none() {
            return false;
        }
        let folder = self.plugin_folder(name);
        let path = folder.join(ACTIVE);
        if std::fs::symlink_metadata(&path).is_ok_and(|m| !m.file_type().is_symlink()) {
            return false;
        }
        let temporary = folder.join(format!(".{ACTIVE}.{}", random_suffix()));
        if std::os::unix::fs::symlink(sha, &temporary).is_err() {
            return false;
        }
        if std::fs::rename(&temporary, &path).is_err() {
            let _ = std::fs::remove_file(&temporary);
            return false;
        }
        true
    }
}

pub struct Fetched {
    pub copy: PathBuf,
    pub manifest: String,
    pub reused: bool,
}

pub trait Download: Send + Sync {
    fn download(
        &self,
        url: &str,
        to: &Path,
        cancel: &Arc<AtomicBool>,
        progress: &mut dyn FnMut(u64, u64),
        limits: &Limits,
    ) -> Result<(), FetchFailure>;
}

pub fn fetch(
    entry: &PinEntry,
    pin: &[PinEntry],
    store: &Store,
    source: Option<&Path>,
    transport: &dyn Download,
    cancel: &Arc<AtomicBool>,
    progress: &mut dyn FnMut(u64, u64),
) -> Result<Fetched, FetchFailure> {
    let (Some(url), Some(file)) = (entry.url.as_deref(), entry.file.as_deref()) else {
        return Err(failed(
            FetchCode::Unsupported,
            format!("this Ardia doesn't pin an official {} plugin", entry.name),
        ));
    };
    if let Some(copy) = store.copy(&entry.name, &entry.sha256)
        && let Some(manifest) = read_manifest_text(&copy)
    {
        return Ok(Fetched {
            copy,
            manifest,
            reused: true,
        });
    }
    let scratch = store
        .make_scratch(&entry.name, ".fetch-")
        .ok_or_else(|| failed(FetchCode::Failed, "its download folder couldn't be made"))?;
    let archive = scratch.join(file);
    let fetched = match source {
        Some(folder) => copy_local(folder, file, &archive, &store.limits),
        None => transport.download(url, &archive, cancel, progress, &store.limits),
    };
    let outcome = fetched.and_then(|()| {
        if cancel.load(Ordering::SeqCst) {
            return Err(failed(FetchCode::Cancelled, "Cancelled."));
        }
        verify_and_publish(entry, pin, &archive, &scratch, store)
    });
    discard(&scratch);
    outcome
}

fn copy_local(
    folder: &Path,
    file: &str,
    archive: &Path,
    limits: &Limits,
) -> Result<(), FetchFailure> {
    let path = folder.join(file);
    let meta = std::fs::symlink_metadata(&path)
        .ok()
        .filter(|m| m.is_file())
        .ok_or_else(|| {
            failed(
                FetchCode::Offline,
                format!("{file} isn't in {}", folder.display()),
            )
        })?;
    if meta.len() > limits.download {
        return Err(failed(
            FetchCode::Verify,
            format!("{file} is over {} MB", limits.download >> 20),
        ));
    }
    std::fs::copy(&path, archive).map(|_| ()).map_err(|e| {
        failed(
            FetchCode::Failed,
            format!("{file} couldn't be copied ({e})"),
        )
    })
}

pub fn verify_and_publish(
    entry: &PinEntry,
    pin: &[PinEntry],
    archive: &Path,
    scratch: &Path,
    store: &Store,
) -> Result<Fetched, FetchFailure> {
    let held = snapshot(archive, scratch, &store.limits)
        .ok_or_else(|| failed(FetchCode::Failed, "the download couldn't be read"))?;
    if held.sha != entry.sha256 {
        return Err(failed(
            FetchCode::Verify,
            format!(
                "the download doesn't match the copy this Ardia pins (SHA-256 {}…, not {}…)",
                &held.sha[..12],
                &entry.sha256[..12]
            ),
        ));
    }
    let mut file = held.file;
    let stage = store
        .make_scratch(&entry.name, ".stage-")
        .ok_or_else(|| failed(FetchCode::Failed, "its folder couldn't be made"))?;
    let refuse = |failure: FetchFailure| {
        discard(&stage);
        Err(failure)
    };
    if let Err(problem) = unpack(&mut file, &entry.name, &stage, scratch, &store.limits) {
        return refuse(failed(FetchCode::Verify, problem));
    }
    let Some(text) = read_manifest_text(&stage) else {
        return refuse(failed(FetchCode::Verify, "its plugin.json can't be read"));
    };
    if let Some(problem) = refusal(&text, entry, pin) {
        return refuse(failed(FetchCode::Verify, problem));
    }
    let copy = store
        .publish(&entry.name, &stage, &mut file, &entry.sha256)
        .map_err(|reason| failed(FetchCode::Failed, reason))?;
    Ok(Fetched {
        copy,
        manifest: text,
        reused: false,
    })
}

pub struct HttpDownload;

fn http_client() -> Option<Arc<dyn HttpClient>> {
    static CLIENT: OnceLock<Option<Arc<dyn HttpClient>>> = OnceLock::new();
    CLIENT
        .get_or_init(|| {
            reqwest_client::ReqwestClient::user_agent("Ardia")
                .ok()
                .map(|c| Arc::new(c) as Arc<dyn HttpClient>)
        })
        .clone()
}

fn offline_error(text: &str) -> bool {
    let text = text.to_ascii_lowercase();
    [
        "dns",
        "connect",
        "timed out",
        "timeout",
        "network",
        "unreachable",
        "resolve",
        "tls",
        "certificate",
    ]
    .iter()
    .any(|needle| text.contains(needle))
}

impl Download for HttpDownload {
    fn download(
        &self,
        url: &str,
        to: &Path,
        cancel: &Arc<AtomicBool>,
        progress: &mut dyn FnMut(u64, u64),
        limits: &Limits,
    ) -> Result<(), FetchFailure> {
        let client = http_client().ok_or_else(|| failed(FetchCode::Failed, "no network client"))?;
        let started = Instant::now();
        let last = Arc::new(AtomicU64::new(0));
        let finished = Arc::new(AtomicBool::new(false));
        let (stop, stopped) = futures::channel::oneshot::channel::<FetchFailure>();
        let watchdog = {
            let last = last.clone();
            let finished = finished.clone();
            let cancel = cancel.clone();
            std::thread::spawn(move || {
                loop {
                    std::thread::sleep(Duration::from_millis(50));
                    if finished.load(Ordering::SeqCst) {
                        return;
                    }
                    let idle = started.elapsed().as_millis() as u64 - last.load(Ordering::SeqCst);
                    let reason = if cancel.load(Ordering::SeqCst) {
                        Some(failed(FetchCode::Cancelled, "Cancelled."))
                    } else if started.elapsed() > DEADLINE + Duration::from_secs(30)
                        || Duration::from_millis(idle) > IDLE_TIMEOUT
                    {
                        Some(failed(FetchCode::Offline, "the download took too long"))
                    } else {
                        None
                    };
                    if let Some(reason) = reason {
                        let _ = stop.send(reason);
                        return;
                    }
                }
            })
        };
        let touch =
            |last: &AtomicU64| last.store(started.elapsed().as_millis() as u64, Ordering::SeqCst);
        let transfer = async {
            let mut current =
                url::Url::parse(url).map_err(|e| failed(FetchCode::Failed, e.to_string()))?;
            let mut redirects = 0;
            let response = loop {
                let request = Request::builder()
                    .method(Method::GET)
                    .uri(current.as_str())
                    .follow_redirects(RedirectPolicy::NoFollow)
                    .body(AsyncBody::empty())
                    .map_err(|e| failed(FetchCode::Failed, e.to_string()))?;
                let response = client.send(request).await.map_err(|e| {
                    let text = format!("{e:#}");
                    failed(
                        if offline_error(&text) {
                            FetchCode::Offline
                        } else {
                            FetchCode::Failed
                        },
                        text,
                    )
                })?;
                touch(&last);
                let status = response.status().as_u16();
                let location = response
                    .headers()
                    .get("location")
                    .and_then(|v| v.to_str().ok())
                    .and_then(|l| current.join(l).ok());
                match location {
                    Some(next)
                        if matches!(status, 301 | 302 | 303 | 307 | 308)
                            && next.scheme() == "https"
                            && redirects < MAX_REDIRECTS =>
                    {
                        redirects += 1;
                        current = next;
                    }
                    _ if status != 200 => {
                        return Err(failed(
                            FetchCode::Failed,
                            format!("the server answered {status}"),
                        ));
                    }
                    _ => break response,
                }
            };
            let expected: u64 = response
                .headers()
                .get("content-length")
                .and_then(|v| v.to_str().ok())
                .and_then(|v| v.parse().ok())
                .unwrap_or(0);
            if expected > limits.download {
                return Err(failed(
                    FetchCode::Verify,
                    format!("the download is over {} MB", limits.download >> 20),
                ));
            }
            let mut out = OpenOptions::new()
                .write(true)
                .create_new(true)
                .mode(0o600)
                .custom_flags(libc::O_NOFOLLOW)
                .open(to)
                .map_err(|e| {
                    failed(
                        FetchCode::Failed,
                        format!("the download couldn't be kept ({e})"),
                    )
                })?;
            let mut body = response.into_body();
            let mut buffer = vec![0u8; 64 * 1024];
            let mut received = 0u64;
            let mut reported = 0u64;
            let step = (expected / 50).max(1 << 20);
            loop {
                let count = body.read(&mut buffer).await.map_err(|e| {
                    let text = e.to_string();
                    failed(
                        if offline_error(&text) {
                            FetchCode::Offline
                        } else {
                            FetchCode::Failed
                        },
                        text,
                    )
                })?;
                touch(&last);
                if count == 0 {
                    break;
                }
                received += count as u64;
                if received > limits.download {
                    return Err(failed(
                        FetchCode::Verify,
                        format!("the download is over {} MB", limits.download >> 20),
                    ));
                }
                out.write_all(&buffer[..count]).map_err(|e| {
                    failed(
                        FetchCode::Failed,
                        format!("the download couldn't be kept ({e})"),
                    )
                })?;
                if received - reported >= step {
                    reported = received;
                    progress(received, expected);
                }
            }
            Ok(())
        };
        let outcome = futures::executor::block_on(async {
            futures::pin_mut!(transfer);
            match futures::future::select(transfer, stopped).await {
                futures::future::Either::Left((result, _)) => result,
                futures::future::Either::Right((Ok(reason), _)) => Err(reason),
                futures::future::Either::Right((Err(_), _)) => {
                    Err(failed(FetchCode::Failed, "the download didn't finish"))
                }
            }
        });
        finished.store(true, Ordering::SeqCst);
        let _ = watchdog.join();
        if outcome.is_err() {
            let _ = std::fs::remove_file(to);
        }
        outcome
    }
}

#[cfg(test)]
pub mod tests;
