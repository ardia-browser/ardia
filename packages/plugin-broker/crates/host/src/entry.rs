use std::ffi::CString;
use std::os::fd::RawFd;

pub const LIMIT: usize = 16 << 20;

pub fn parts(relative: &str) -> Option<Vec<&str>> {
    let pieces: Vec<&str> = relative.split('/').collect();
    if pieces.is_empty() || pieces.iter().any(|piece| piece.is_empty() || *piece == "." || *piece == ".." || piece.contains('\0')) {
        return None;
    }
    Some(pieces)
}

struct Fd(RawFd);

impl Drop for Fd {
    fn drop(&mut self) {
        unsafe { libc::close(self.0) };
    }
}

fn open_at(directory: RawFd, name: &str, flags: i32) -> Option<Fd> {
    let name = CString::new(name).ok()?;
    let fd = unsafe { libc::openat(directory, name.as_ptr(), flags | libc::O_CLOEXEC) };
    (fd >= 0).then_some(Fd(fd))
}

pub fn read_from(root: RawFd, relative: &str) -> Result<String, String> {
    let Some(parts) = parts(relative) else { return Err(format!("--entry {relative} isn't a plain path inside the plugin's folder")) };
    let mut directory = open_at(root, ".", libc::O_RDONLY | libc::O_DIRECTORY).ok_or("the plugin's folder can't be opened")?;
    for part in &parts[..parts.len() - 1] {
        directory = open_at(directory.0, part, libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW).ok_or_else(|| format!("{relative} isn't inside the plugin's folder"))?;
    }
    let file = open_at(directory.0, parts[parts.len() - 1], libc::O_RDONLY | libc::O_NOFOLLOW | libc::O_NONBLOCK).ok_or_else(|| format!("{relative} wasn't found, or is a link"))?;
    drop(directory);
    read_open(file.0, relative)
}

pub fn read_open(fd: RawFd, relative: &str) -> Result<String, String> {
    let mut info: libc::stat = unsafe { std::mem::zeroed() };
    if unsafe { libc::fstat(fd, &mut info) } != 0 || (info.st_mode & libc::S_IFMT) != libc::S_IFREG {
        return Err(format!("{relative} isn't a file"));
    }
    if info.st_size as u64 > LIMIT as u64 {
        return Err(format!("{relative} is over 16 MB"));
    }
    let mut data = Vec::with_capacity(info.st_size as usize);
    let mut chunk = vec![0u8; 64 << 10];
    loop {
        let got = unsafe { libc::read(fd, chunk.as_mut_ptr().cast(), chunk.len()) };
        if got < 0 && std::io::Error::last_os_error().raw_os_error() == Some(libc::EINTR) {
            continue;
        }
        if got < 0 {
            return Err(format!("{relative} couldn't be read"));
        }
        if got == 0 {
            break;
        }
        data.extend_from_slice(&chunk[..got as usize]);
        if data.len() > LIMIT {
            return Err(format!("{relative} is over 16 MB"));
        }
    }
    String::from_utf8(data).map_err(|_| format!("{relative} isn't UTF-8 text"))
}

pub fn read(relative: &str) -> Result<String, String> {
    read_from(libc::AT_FDCWD, relative)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::os::unix::fs::symlink;

    fn scratch(name: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("ardia-host-entry-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(dir.join("dist")).unwrap();
        dir
    }

    fn root(dir: &std::path::Path) -> Fd {
        let path = CString::new(dir.to_str().unwrap()).unwrap();
        Fd(unsafe { libc::open(path.as_ptr(), libc::O_RDONLY | libc::O_DIRECTORY | libc::O_CLOEXEC) })
    }

    #[test]
    fn refuses_paths_that_leave_the_folder() {
        for bad in ["", "/abs", "a//b", "./a", "../a", "a/..", "a/./b", "dist/"] {
            assert!(parts(bad).is_none(), "{bad}");
        }
        assert_eq!(parts("dist/index.js").unwrap(), vec!["dist", "index.js"]);
    }

    #[test]
    fn reads_a_file_and_refuses_links_and_folders() {
        let dir = scratch("read");
        fs::write(dir.join("dist/index.js"), "ok()").unwrap();
        fs::write(dir.join("outside.js"), "no()").unwrap();
        symlink(dir.join("outside.js"), dir.join("dist/link.js")).unwrap();
        symlink(dir.join("dist"), dir.join("linked")).unwrap();
        fs::write(dir.join("dist/bad.js"), [0xffu8, 0xfe]).unwrap();
        let fd = root(&dir);
        assert_eq!(read_from(fd.0, "dist/index.js").unwrap(), "ok()");
        assert_eq!(read_from(fd.0, "dist/link.js").unwrap_err(), "dist/link.js wasn't found, or is a link");
        assert_eq!(read_from(fd.0, "linked/index.js").unwrap_err(), "linked/index.js isn't inside the plugin's folder");
        assert_eq!(read_from(fd.0, "dist").unwrap_err(), "dist isn't a file");
        assert_eq!(read_from(fd.0, "dist/bad.js").unwrap_err(), "dist/bad.js isn't UTF-8 text");
        assert_eq!(read_from(fd.0, "missing.js").unwrap_err(), "missing.js wasn't found, or is a link");
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn refuses_an_entry_over_16_mb() {
        let dir = scratch("big");
        fs::write(dir.join("dist/big.js"), vec![b' '; LIMIT + 1]).unwrap();
        let fd = root(&dir);
        assert_eq!(read_from(fd.0, "dist/big.js").unwrap_err(), "dist/big.js is over 16 MB");
        fs::remove_dir_all(&dir).unwrap();
    }
}
