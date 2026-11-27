use std::fs::{self, File, Metadata};
use std::io::{self, Read, Write};
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

use zeroize::Zeroizing;

use crate::names::PARTIAL_SUFFIX;

#[cfg(windows)]
const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x400;
#[cfg(windows)]
const FILE_FLAG_OPEN_REPARSE_POINT: u32 = 0x0020_0000;
#[cfg(windows)]
const FILE_FLAG_BACKUP_SEMANTICS: u32 = 0x0200_0000;

#[cfg(windows)]
fn reparse_point(meta: &Metadata) -> bool {
    use std::os::windows::fs::MetadataExt;
    meta.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0
}

#[cfg(not(windows))]
fn reparse_point(_meta: &Metadata) -> bool {
    false
}

pub fn is_link(meta: &Metadata) -> bool {
    meta.file_type().is_symlink() || reparse_point(meta)
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Entry {
    Missing,
    Link,
    Directory,
    File,
    Other,
}

pub fn entry(path: &Path) -> io::Result<Entry> {
    match fs::symlink_metadata(path) {
        Ok(meta) => Ok(kind_of(&meta)),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(Entry::Missing),
        Err(error) => Err(error),
    }
}

fn kind_of(meta: &Metadata) -> Entry {
    if is_link(meta) {
        Entry::Link
    } else if meta.is_dir() {
        Entry::Directory
    } else if meta.is_file() {
        Entry::File
    } else {
        Entry::Other
    }
}

#[derive(Debug)]
pub struct Unsafe(pub PathBuf);

impl std::fmt::Display for Unsafe {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("a folder on the way is a link, not a folder, or leads outside its root")
    }
}

impl std::error::Error for Unsafe {}

pub fn unsafe_path(path: PathBuf) -> io::Error {
    io::Error::other(Unsafe(path))
}

pub fn is_unsafe(error: &io::Error) -> bool {
    error.get_ref().is_some_and(|inner| inner.is::<Unsafe>())
}

pub fn plain(path: PathBuf) -> PathBuf {
    let text = path.to_string_lossy();
    if let Some(rest) = text.strip_prefix(r"\\?\UNC\") {
        return PathBuf::from(format!(r"\\{rest}"));
    }
    match text.strip_prefix(r"\\?\") {
        Some(rest) => PathBuf::from(rest),
        None => path,
    }
}

fn folded_parts(path: &Path) -> Vec<String> {
    path.components()
        .filter(|c| !matches!(c, Component::CurDir))
        .map(|c| c.as_os_str().to_string_lossy().to_lowercase())
        .collect()
}

pub fn within(inner: &Path, outer: &Path) -> bool {
    let (inner, outer) = (folded_parts(inner), folded_parts(outer));
    inner.len() >= outer.len() && inner[..outer.len()] == outer[..]
}

pub fn same_place(a: &Path, b: &Path) -> bool {
    folded_parts(a) == folded_parts(b)
}

pub fn check_ancestors(path: &Path) -> io::Result<()> {
    let mut walked = PathBuf::new();
    for component in path.components() {
        walked.push(component);
        if matches!(component, Component::Prefix(_) | Component::RootDir) {
            continue;
        }
        match entry(&walked)? {
            Entry::Directory => {}
            Entry::Missing => return Ok(()),
            _ if walked == path => return Ok(()),
            _ => return Err(unsafe_path(walked)),
        }
    }
    Ok(())
}

fn child_name(name: &str) -> io::Result<&str> {
    let plain_name = !name.is_empty()
        && name != "."
        && name != ".."
        && !name.contains(['/', '\\', '\0'])
        && (cfg!(not(windows)) || !name.contains(':'));
    if plain_name {
        Ok(name)
    } else {
        Err(unsafe_path(PathBuf::from(name)))
    }
}

#[cfg(windows)]
pub fn final_path(file: &File) -> io::Result<PathBuf> {
    use std::os::windows::ffi::OsStringExt;
    use std::os::windows::io::AsRawHandle;
    use windows_sys::Win32::Storage::FileSystem::GetFinalPathNameByHandleW;
    let handle = file.as_raw_handle();
    let mut buffer = vec![0u16; 1024];
    loop {
        let length = unsafe { GetFinalPathNameByHandleW(handle, buffer.as_mut_ptr(), buffer.len() as u32, 0) } as usize;
        if length == 0 {
            return Err(io::Error::last_os_error());
        }
        if length < buffer.len() {
            buffer.truncate(length);
            return Ok(plain(PathBuf::from(std::ffi::OsString::from_wide(&buffer))));
        }
        if buffer.len() >= 32_768 {
            return Err(io::Error::other("path too long"));
        }
        buffer.resize(length + 1, 0);
    }
}

#[cfg(target_os = "macos")]
pub fn final_path(file: &File) -> io::Result<PathBuf> {
    use std::ffi::CStr;
    use std::os::unix::ffi::OsStrExt;
    use std::os::unix::io::AsRawFd;
    let mut buffer = vec![0 as libc::c_char; libc::PATH_MAX as usize + 1];
    if unsafe { libc::fcntl(file.as_raw_fd(), libc::F_GETPATH, buffer.as_mut_ptr()) } == -1 {
        return Err(io::Error::last_os_error());
    }
    let text = unsafe { CStr::from_ptr(buffer.as_ptr()) };
    Ok(PathBuf::from(std::ffi::OsStr::from_bytes(text.to_bytes())))
}

#[cfg(all(unix, not(target_os = "macos")))]
pub fn final_path(file: &File) -> io::Result<PathBuf> {
    use std::os::unix::io::AsRawFd;
    fs::read_link(format!("/proc/self/fd/{}", file.as_raw_fd()))
}

#[cfg(windows)]
fn link_count(file: &File) -> io::Result<u64> {
    use std::os::windows::io::AsRawHandle;
    use windows_sys::Win32::Storage::FileSystem::{GetFileInformationByHandle, BY_HANDLE_FILE_INFORMATION};
    let mut info: BY_HANDLE_FILE_INFORMATION = unsafe { std::mem::zeroed() };
    if unsafe { GetFileInformationByHandle(file.as_raw_handle(), &mut info) } == 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(u64::from(info.nNumberOfLinks))
}

#[cfg(unix)]
fn link_count(file: &File) -> io::Result<u64> {
    use std::os::unix::fs::MetadataExt;
    Ok(file.metadata()?.nlink())
}

#[derive(Clone, Copy)]
enum Opening {
    Read,
    CreateNew,
    Lock,
}

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Access {
    Traverse,
    Read,
    Write,
}

#[cfg(unix)]
mod sys {
    use std::ffi::{CStr, CString};
    use std::fs::File;
    use std::io;
    use std::os::unix::io::{AsRawFd, FromRawFd};

    use super::{unsafe_path, Access, Entry, Opening};

    fn c_name(name: &str) -> io::Result<CString> {
        CString::new(name).map_err(|_| unsafe_path(name.into()))
    }

    pub fn open_base(path: &std::path::Path, _access: Access) -> io::Result<File> {
        use std::os::unix::fs::OpenOptionsExt;
        std::fs::OpenOptions::new()
            .read(true)
            .custom_flags(libc::O_NOFOLLOW | libc::O_DIRECTORY | libc::O_CLOEXEC)
            .open(path)
            .map_err(|_| unsafe_path(path.to_path_buf()))
    }

    pub fn child_dir(dir: &File, name: &str, _access: Access, create: bool) -> io::Result<Option<File>> {
        let c = c_name(name)?;
        for _ in 0..2 {
            let fd = unsafe {
                libc::openat(
                    dir.as_raw_fd(),
                    c.as_ptr(),
                    libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
                )
            };
            if fd >= 0 {
                return Ok(Some(unsafe { File::from_raw_fd(fd) }));
            }
            let error = io::Error::last_os_error();
            match error.raw_os_error() {
                Some(libc::ENOENT) if create => {
                    if unsafe { libc::mkdirat(dir.as_raw_fd(), c.as_ptr(), 0o700) } != 0 {
                        let made = io::Error::last_os_error();
                        if made.raw_os_error() != Some(libc::EEXIST) {
                            return Err(made);
                        }
                    }
                }
                Some(libc::ENOENT) => return Ok(None),
                Some(libc::ELOOP) | Some(libc::ENOTDIR) => return Err(unsafe_path(name.into())),
                _ => return Err(error),
            }
        }
        Err(unsafe_path(name.into()))
    }

    pub fn child_file(dir: &File, name: &str, opening: Opening) -> io::Result<File> {
        let c = c_name(name)?;
        let flags = libc::O_NOFOLLOW
            | libc::O_CLOEXEC
            | match opening {
                Opening::Read => libc::O_RDONLY | libc::O_NONBLOCK,
                Opening::CreateNew => libc::O_RDWR | libc::O_CREAT | libc::O_EXCL,
                Opening::Lock => libc::O_RDWR | libc::O_CREAT,
            };
        let fd = unsafe { libc::openat(dir.as_raw_fd(), c.as_ptr(), flags, 0o600 as libc::c_uint) };
        if fd < 0 {
            let error = io::Error::last_os_error();
            if error.raw_os_error() == Some(libc::ELOOP) {
                return Err(unsafe_path(name.into()));
            }
            return Err(error);
        }
        Ok(unsafe { File::from_raw_fd(fd) })
    }

    pub fn child_entry(dir: &File, name: &str) -> io::Result<Entry> {
        let c = c_name(name)?;
        let mut stat: libc::stat = unsafe { std::mem::zeroed() };
        if unsafe { libc::fstatat(dir.as_raw_fd(), c.as_ptr(), &mut stat, libc::AT_SYMLINK_NOFOLLOW) } != 0 {
            let error = io::Error::last_os_error();
            return if error.raw_os_error() == Some(libc::ENOENT) {
                Ok(Entry::Missing)
            } else {
                Err(error)
            };
        }
        Ok(match stat.st_mode & libc::S_IFMT {
            libc::S_IFLNK => Entry::Link,
            libc::S_IFDIR => Entry::Directory,
            libc::S_IFREG => Entry::File,
            _ => Entry::Other,
        })
    }

    pub fn list(dir: &File) -> io::Result<Vec<String>> {
        let fd = unsafe { libc::dup(dir.as_raw_fd()) };
        if fd < 0 {
            return Err(io::Error::last_os_error());
        }
        let stream = unsafe { libc::fdopendir(fd) };
        if stream.is_null() {
            let error = io::Error::last_os_error();
            unsafe { libc::close(fd) };
            return Err(error);
        }
        unsafe { libc::rewinddir(stream) };
        let mut names = Vec::new();
        loop {
            unsafe { *errno() = 0 };
            let entry = unsafe { libc::readdir(stream) };
            if entry.is_null() {
                let code = unsafe { *errno() };
                unsafe { libc::closedir(stream) };
                if code != 0 {
                    return Err(io::Error::from_raw_os_error(code));
                }
                return Ok(names);
            }
            let name = unsafe { CStr::from_ptr((*entry).d_name.as_ptr()) };
            if let Ok(name) = name.to_str() {
                if name != "." && name != ".." {
                    names.push(name.to_string());
                }
            }
        }
    }

    #[cfg(target_os = "macos")]
    unsafe fn errno() -> *mut libc::c_int {
        unsafe { libc::__error() }
    }

    #[cfg(not(target_os = "macos"))]
    unsafe fn errno() -> *mut libc::c_int {
        unsafe { libc::__errno_location() }
    }

    pub fn rename(dir: &File, _staged: &File, from: &str, to: &str) -> io::Result<()> {
        let (from, to) = (c_name(from)?, c_name(to)?);
        if unsafe { libc::renameat(dir.as_raw_fd(), from.as_ptr(), dir.as_raw_fd(), to.as_ptr()) } != 0 {
            return Err(io::Error::last_os_error());
        }
        Ok(())
    }

    pub fn remove(dir: &File, name: &str) -> io::Result<()> {
        let c = c_name(name)?;
        if unsafe { libc::unlinkat(dir.as_raw_fd(), c.as_ptr(), 0) } != 0 {
            return Err(io::Error::last_os_error());
        }
        Ok(())
    }
}

#[cfg(windows)]
mod sys {
    use std::ffi::c_void;
    use std::fs::File;
    use std::io;
    use std::os::windows::io::{AsRawHandle, FromRawHandle, RawHandle};
    use std::ptr::{null, null_mut};

    use windows_sys::Wdk::Foundation::OBJECT_ATTRIBUTES;
    use windows_sys::Wdk::Storage::FileSystem::{
        FileDispositionInformationEx, FileRenameInformation, FileRenameInformationEx, NtCreateFile,
        NtSetInformationFile, FILE_CREATE, FILE_DIRECTORY_FILE, FILE_DISPOSITION_DELETE,
        FILE_DISPOSITION_INFORMATION_EX, FILE_DISPOSITION_POSIX_SEMANTICS, FILE_NON_DIRECTORY_FILE, FILE_OPEN,
        FILE_OPEN_IF, FILE_OPEN_REPARSE_POINT, FILE_RENAME_INFORMATION, FILE_RENAME_POSIX_SEMANTICS,
        FILE_RENAME_REPLACE_IF_EXISTS, FILE_SYNCHRONOUS_IO_NONALERT,
    };
    use windows_sys::Win32::Foundation::{
        RtlNtStatusToDosError, HANDLE, NTSTATUS, OBJ_CASE_INSENSITIVE, UNICODE_STRING,
    };
    use windows_sys::Win32::Storage::FileSystem::{
        FileDispositionInfo, FileFullDirectoryInfo, FileFullDirectoryRestartInfo, GetFileInformationByHandleEx,
        SetFileInformationByHandle, DELETE, FILE_ADD_FILE, FILE_ADD_SUBDIRECTORY, FILE_ATTRIBUTE_NORMAL,
        FILE_DISPOSITION_INFO, FILE_FULL_DIR_INFO, FILE_GENERIC_READ, FILE_GENERIC_WRITE, FILE_LIST_DIRECTORY,
        FILE_READ_ATTRIBUTES, FILE_SHARE_DELETE, FILE_SHARE_READ, FILE_SHARE_WRITE, FILE_TRAVERSE, SYNCHRONIZE,
    };
    use windows_sys::Win32::System::IO::IO_STATUS_BLOCK;

    use super::{
        kind_of, unsafe_path, Access, Entry, Opening, FILE_FLAG_BACKUP_SEMANTICS, FILE_FLAG_OPEN_REPARSE_POINT,
    };

    const ERROR_DIRECTORY: i32 = 267;
    const ERROR_FILE_NOT_FOUND: i32 = 2;
    const ERROR_PATH_NOT_FOUND: i32 = 3;
    const ERROR_NO_MORE_FILES: i32 = 18;
    const ERROR_CANT_ACCESS_FILE: i32 = 1920;
    const ERROR_STOPPED_ON_SYMLINK: i32 = 681;

    fn status_error(status: NTSTATUS) -> io::Error {
        io::Error::from_raw_os_error(unsafe { RtlNtStatusToDosError(status) } as i32)
    }

    fn handle(file: &File) -> HANDLE {
        file.as_raw_handle() as HANDLE
    }

    fn nt_open(dir: &File, name: &str, access: u32, disposition: u32, options: u32) -> io::Result<File> {
        let wide: Vec<u16> = name.encode_utf16().collect();
        let bytes = u16::try_from(wide.len() * 2).map_err(|_| unsafe_path(name.into()))?;
        let object_name = UNICODE_STRING {
            Length: bytes,
            MaximumLength: bytes,
            Buffer: wide.as_ptr() as *mut u16,
        };
        let attributes = OBJECT_ATTRIBUTES {
            Length: std::mem::size_of::<OBJECT_ATTRIBUTES>() as u32,
            RootDirectory: handle(dir),
            ObjectName: &object_name,
            Attributes: OBJ_CASE_INSENSITIVE,
            SecurityDescriptor: null(),
            SecurityQualityOfService: null(),
        };
        let mut opened: HANDLE = null_mut();
        let mut status_block: IO_STATUS_BLOCK = unsafe { std::mem::zeroed() };
        let status = unsafe {
            NtCreateFile(
                &mut opened,
                access,
                &attributes,
                &mut status_block,
                null(),
                FILE_ATTRIBUTE_NORMAL,
                FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
                disposition,
                options | FILE_OPEN_REPARSE_POINT | FILE_SYNCHRONOUS_IO_NONALERT,
                null(),
                0,
            )
        };
        if status < 0 {
            return Err(status_error(status));
        }
        Ok(unsafe { File::from_raw_handle(opened as RawHandle) })
    }

    fn missing(error: &io::Error) -> bool {
        matches!(error.raw_os_error(), Some(ERROR_FILE_NOT_FOUND | ERROR_PATH_NOT_FOUND))
    }

    fn folder_access(access: Access) -> u32 {
        let traverse = FILE_TRAVERSE | FILE_READ_ATTRIBUTES | SYNCHRONIZE;
        match access {
            Access::Traverse => traverse,
            Access::Read => traverse | FILE_LIST_DIRECTORY,
            Access::Write => traverse | FILE_LIST_DIRECTORY | FILE_ADD_FILE | FILE_ADD_SUBDIRECTORY,
        }
    }

    pub fn open_base(path: &std::path::Path, access: Access) -> io::Result<File> {
        use std::os::windows::fs::OpenOptionsExt;
        std::fs::OpenOptions::new()
            .access_mode(folder_access(access))
            .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT | FILE_FLAG_BACKUP_SEMANTICS)
            .open(path)
            .map_err(|_| unsafe_path(path.to_path_buf()))
    }

    pub fn child_dir(dir: &File, name: &str, access: Access, create: bool) -> io::Result<Option<File>> {
        let wanted = if create { Access::Write } else { access };
        let disposition = if create { FILE_OPEN_IF } else { FILE_OPEN };
        match nt_open(dir, name, folder_access(wanted), disposition, FILE_DIRECTORY_FILE) {
            Ok(folder) => Ok(Some(folder)),
            Err(error) if !create && missing(&error) => Ok(None),
            Err(error)
                if matches!(
                    error.raw_os_error(),
                    Some(ERROR_DIRECTORY | ERROR_CANT_ACCESS_FILE | ERROR_STOPPED_ON_SYMLINK)
                ) =>
            {
                Err(unsafe_path(name.into()))
            }
            Err(error) => Err(error),
        }
    }

    pub fn child_file(dir: &File, name: &str, opening: Opening) -> io::Result<File> {
        let (access, disposition) = match opening {
            Opening::Read => (FILE_GENERIC_READ, FILE_OPEN),
            Opening::CreateNew => (FILE_GENERIC_READ | FILE_GENERIC_WRITE | DELETE, FILE_CREATE),
            Opening::Lock => (FILE_GENERIC_READ | FILE_GENERIC_WRITE, FILE_OPEN_IF),
        };
        nt_open(dir, name, access, disposition, FILE_NON_DIRECTORY_FILE)
    }

    pub fn child_entry(dir: &File, name: &str) -> io::Result<Entry> {
        match nt_open(dir, name, FILE_READ_ATTRIBUTES | SYNCHRONIZE, FILE_OPEN, 0) {
            Ok(file) => Ok(kind_of(&file.metadata()?)),
            Err(error) if missing(&error) => Ok(Entry::Missing),
            Err(error) => Err(error),
        }
    }

    pub fn list(dir: &File) -> io::Result<Vec<String>> {
        let mut names = Vec::new();
        let mut buffer = vec![0u64; 8192];
        let size = (buffer.len() * 8) as u32;
        let name_at = std::mem::offset_of!(FILE_FULL_DIR_INFO, FileName);
        let length_at = std::mem::offset_of!(FILE_FULL_DIR_INFO, FileNameLength);
        let mut class = FileFullDirectoryRestartInfo;
        loop {
            let base = buffer.as_mut_ptr() as *mut u8;
            if unsafe { GetFileInformationByHandleEx(handle(dir), class, base as *mut c_void, size) } == 0 {
                let error = io::Error::last_os_error();
                if error.raw_os_error() == Some(ERROR_NO_MORE_FILES) {
                    return Ok(names);
                }
                return Err(error);
            }
            class = FileFullDirectoryInfo;
            let mut offset = 0usize;
            loop {
                let entry = unsafe { base.add(offset) };
                let next = unsafe { std::ptr::read_unaligned(entry as *const u32) } as usize;
                let length = unsafe { std::ptr::read_unaligned(entry.add(length_at) as *const u32) } as usize;
                if name_at + length > buffer.len() * 8 - offset {
                    return Err(io::Error::other("directory entry runs past its buffer"));
                }
                let mut wide = vec![0u16; length / 2];
                unsafe { std::ptr::copy_nonoverlapping(entry.add(name_at), wide.as_mut_ptr() as *mut u8, length) };
                if let Ok(name) = String::from_utf16(&wide) {
                    if name != "." && name != ".." {
                        names.push(name);
                    }
                }
                if next == 0 {
                    break;
                }
                offset += next;
            }
        }
    }

    fn rename_buffer(dir: &File, to: &str, flags: u32) -> (Vec<u64>, u32) {
        let wide: Vec<u16> = to.encode_utf16().collect();
        let header = std::mem::offset_of!(FILE_RENAME_INFORMATION, FileName);
        let bytes = (header + wide.len() * 2).max(std::mem::size_of::<FILE_RENAME_INFORMATION>());
        let mut buffer = vec![0u64; (bytes + 2).div_ceil(8)];
        let base = buffer.as_mut_ptr() as *mut u8;
        let info = base as *mut FILE_RENAME_INFORMATION;
        unsafe {
            std::ptr::addr_of_mut!((*info).Anonymous).cast::<u32>().write(flags);
            std::ptr::addr_of_mut!((*info).RootDirectory).write(handle(dir));
            std::ptr::addr_of_mut!((*info).FileNameLength).write((wide.len() * 2) as u32);
            std::ptr::copy_nonoverlapping(wide.as_ptr() as *const u8, base.add(header), wide.len() * 2);
        }
        (buffer, bytes as u32)
    }

    fn set_information(file: &File, buffer: *const c_void, length: u32, class: i32) -> io::Result<()> {
        let mut status_block: IO_STATUS_BLOCK = unsafe { std::mem::zeroed() };
        let status = unsafe { NtSetInformationFile(handle(file), &mut status_block, buffer, length, class) };
        if status < 0 {
            return Err(status_error(status));
        }
        Ok(())
    }

    pub fn rename(dir: &File, staged: &File, _from: &str, to: &str) -> io::Result<()> {
        let (posix, length) = rename_buffer(dir, to, FILE_RENAME_REPLACE_IF_EXISTS | FILE_RENAME_POSIX_SEMANTICS);
        if set_information(staged, posix.as_ptr() as *const c_void, length, FileRenameInformationEx).is_ok() {
            return Ok(());
        }
        let (plain, length) = rename_buffer(dir, to, 1);
        set_information(staged, plain.as_ptr() as *const c_void, length, FileRenameInformation)
    }

    pub fn remove(dir: &File, name: &str) -> io::Result<()> {
        let file = nt_open(dir, name, DELETE | FILE_READ_ATTRIBUTES | SYNCHRONIZE, FILE_OPEN, 0)?;
        let posix = FILE_DISPOSITION_INFORMATION_EX {
            Flags: FILE_DISPOSITION_DELETE | FILE_DISPOSITION_POSIX_SEMANTICS,
        };
        let length = std::mem::size_of::<FILE_DISPOSITION_INFORMATION_EX>() as u32;
        if set_information(
            &file,
            &posix as *const _ as *const c_void,
            length,
            FileDispositionInformationEx,
        )
        .is_ok()
        {
            return Ok(());
        }
        let plain = FILE_DISPOSITION_INFO { DeleteFile: true };
        let removed = unsafe {
            SetFileInformationByHandle(
                handle(&file),
                FileDispositionInfo,
                &plain as *const _ as *const c_void,
                std::mem::size_of::<FILE_DISPOSITION_INFO>() as u32,
            )
        };
        if removed == 0 {
            return Err(io::Error::last_os_error());
        }
        Ok(())
    }
}

pub enum Fetched {
    Data(Zeroizing<Vec<u8>>),
    Missing,
    Link,
    NotRegular,
    HardLinked,
    TooLarge,
}

pub struct Staged {
    file: File,
    temp: String,
}

pub struct Dir {
    file: File,
    path: PathBuf,
}

static STAGED: AtomicU64 = AtomicU64::new(0);

pub const STAGED_PREFIX: &str = ".ardia-mig-";

pub fn partial_name() -> String {
    format!(
        "{STAGED_PREFIX}{:x}-{}-{}{PARTIAL_SUFFIX}",
        std::process::id(),
        STAGED.fetch_add(1, Ordering::Relaxed),
        random_hex(4)
    )
}

impl Dir {
    pub fn path(&self) -> &Path {
        &self.path
    }

    pub fn entry(&self, name: &str) -> io::Result<Entry> {
        sys::child_entry(&self.file, child_name(name)?)
    }

    fn child_with(&self, name: &str, access: Access, create: bool) -> io::Result<Option<Dir>> {
        let name = child_name(name)?;
        let Some(file) = sys::child_dir(&self.file, name, access, create)? else {
            return Ok(None);
        };
        let meta = file.metadata()?;
        if is_link(&meta) || !meta.is_dir() {
            return Err(unsafe_path(self.path.join(name)));
        }
        Ok(Some(Dir {
            file,
            path: self.path.join(name),
        }))
    }

    pub fn child(&self, name: &str, create: bool) -> io::Result<Option<Dir>> {
        self.child_with(name, if create { Access::Write } else { Access::Read }, create)
    }

    pub fn list(&self) -> io::Result<Vec<String>> {
        let mut names = sys::list(&self.file)?;
        names.sort();
        Ok(names)
    }

    pub fn read(&self, name: &str, limit: u64) -> io::Result<Fetched> {
        match self.entry(name)? {
            Entry::Missing => return Ok(Fetched::Missing),
            Entry::Link => return Ok(Fetched::Link),
            Entry::File => {}
            Entry::Directory | Entry::Other => return Ok(Fetched::NotRegular),
        }
        let mut file = match sys::child_file(&self.file, name, Opening::Read) {
            Ok(file) => file,
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(Fetched::Missing),
            Err(error) if is_unsafe(&error) => return Ok(Fetched::Link),
            Err(error) => return Err(error),
        };
        let meta = file.metadata()?;
        if is_link(&meta) {
            return Ok(Fetched::Link);
        }
        if !meta.is_file() {
            return Ok(Fetched::NotRegular);
        }
        if link_count(&file)? != 1 {
            return Ok(Fetched::HardLinked);
        }
        if meta.len() > limit {
            return Ok(Fetched::TooLarge);
        }
        let mut bytes = Zeroizing::new(vec![0u8; meta.len() as usize]);
        file.read_exact(&mut bytes)?;
        let mut more = [0u8; 1];
        if file.read(&mut more)? != 0 {
            return Ok(Fetched::TooLarge);
        }
        Ok(Fetched::Data(bytes))
    }

    pub fn stage(&self, bytes: &[u8]) -> io::Result<Staged> {
        let temp = partial_name();
        let mut file = sys::child_file(&self.file, &temp, Opening::CreateNew)?;
        if let Err(error) = file.write_all(bytes).and_then(|()| file.sync_all()) {
            drop(file);
            let _ = sys::remove(&self.file, &temp);
            return Err(error);
        }
        Ok(Staged { file, temp })
    }

    pub fn commit(&self, staged: Staged, name: &str) -> io::Result<()> {
        let name = child_name(name)?;
        let checked = match self.entry(name)? {
            Entry::Missing | Entry::File => sys::rename(&self.file, &staged.file, &staged.temp, name),
            _ => Err(unsafe_path(self.path.join(name))),
        };
        if let Err(error) = checked {
            self.discard(staged);
            return Err(error);
        }
        drop(staged);
        let _ = self.file.sync_all();
        Ok(())
    }

    pub fn discard(&self, staged: Staged) {
        let Staged { file, temp } = staged;
        drop(file);
        let _ = sys::remove(&self.file, &temp);
    }

    pub fn abandon(&self, staged: Staged) {
        drop(staged);
    }

    pub fn write(&self, name: &str, bytes: &[u8]) -> io::Result<()> {
        let staged = self.stage(bytes)?;
        self.commit(staged, name)
    }

    pub fn sweep_partials(&self) -> io::Result<usize> {
        let mut swept = 0;
        for name in self.list()? {
            if !(name.starts_with(STAGED_PREFIX) && name.ends_with(PARTIAL_SUFFIX)) {
                continue;
            }
            if matches!(self.entry(&name)?, Entry::File | Entry::Link) {
                sys::remove(&self.file, &name)?;
                swept += 1;
            }
        }
        Ok(swept)
    }

    pub fn open_lock(&self, name: &str) -> io::Result<File> {
        let name = child_name(name)?;
        if !matches!(self.entry(name)?, Entry::Missing | Entry::File) {
            return Err(unsafe_path(self.path.join(name)));
        }
        let lock = sys::child_file(&self.file, name, Opening::Lock)?;
        let meta = lock.metadata()?;
        if is_link(&meta) || !meta.is_file() || link_count(&lock)? != 1 {
            return Err(unsafe_path(self.path.join(name)));
        }
        Ok(lock)
    }
}

pub struct Root {
    dir: Dir,
    pub path: PathBuf,
    pub resolved: PathBuf,
}

fn base_and_parts(path: &Path) -> io::Result<(PathBuf, Vec<String>)> {
    let mut base = PathBuf::new();
    let mut parts = Vec::new();
    for component in path.components() {
        match component {
            Component::Prefix(_) | Component::RootDir if parts.is_empty() => base.push(component),
            Component::Normal(name) => parts.push(
                name.to_str()
                    .ok_or_else(|| unsafe_path(path.to_path_buf()))?
                    .to_string(),
            ),
            _ => return Err(unsafe_path(path.to_path_buf())),
        }
    }
    if base.as_os_str().is_empty() || !path.is_absolute() {
        return Err(unsafe_path(path.to_path_buf()));
    }
    Ok((base, parts))
}

impl Root {
    fn walk(path: &Path, create: bool) -> io::Result<Option<Root>> {
        let (base, parts) = base_and_parts(path)?;
        let base_access = match (parts.is_empty(), create) {
            (true, true) => Access::Write,
            (true, false) => Access::Read,
            (false, _) => Access::Traverse,
        };
        let mut dir = Dir {
            file: sys::open_base(&base, base_access)?,
            path: base,
        };
        let last = parts.len();
        for (index, part) in parts.iter().enumerate() {
            let access = if index + 1 == last {
                Access::Read
            } else {
                Access::Traverse
            };
            let next = match dir.child_with(part, access, false)? {
                Some(next) if create && index + 1 == last => dir.child_with(part, Access::Write, true)?.or(Some(next)),
                Some(next) => Some(next),
                None if create => dir.child_with(part, Access::Write, true)?,
                None => None,
            };
            let Some(next) = next else {
                return Ok(None);
            };
            dir = next;
        }
        let resolved = final_path(&dir.file)?;
        dir.path = path.to_path_buf();
        Ok(Some(Root {
            dir,
            path: path.to_path_buf(),
            resolved,
        }))
    }

    pub fn new(path: &Path) -> io::Result<Root> {
        Root::walk(path, false)?.ok_or_else(|| io::Error::new(io::ErrorKind::NotFound, "no such folder"))
    }

    pub fn open_or_create(path: &Path) -> io::Result<Root> {
        Root::walk(path, true)?.ok_or_else(|| unsafe_path(path.to_path_buf()))
    }

    pub fn dir(&self) -> &Dir {
        &self.dir
    }

    pub fn folder(&self, parts: &[&str], create: bool) -> io::Result<Option<Dir>> {
        let mut current = Dir {
            file: self.dir.file.try_clone()?,
            path: self.path.clone(),
        };
        for part in parts {
            match current.child(part, create)? {
                Some(next) => current = next,
                None => return Ok(None),
            }
        }
        if !within(&final_path(&current.file)?, &self.resolved) {
            return Err(unsafe_path(current.path));
        }
        Ok(Some(current))
    }
}

fn random_hex(bytes: usize) -> String {
    let mut random = vec![0u8; bytes];
    if getrandom::getrandom(&mut random).is_err() {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or_default();
        for (index, byte) in random.iter_mut().enumerate() {
            *byte = (nanos >> ((index % 16) * 8)) as u8 ^ (std::process::id() as u8);
        }
    }
    random.iter().map(|b| format!("{b:02x}")).collect()
}

pub fn run_id() -> String {
    random_hex(16)
}
