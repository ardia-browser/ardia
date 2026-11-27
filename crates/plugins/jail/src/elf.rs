use std::io;
use std::os::fd::RawFd;

use crate::sys;

const PT_INTERP: u32 = 3;
const PT_DYNAMIC: u32 = 2;

fn read_at(fd: RawFd, offset: u64, buffer: &mut [u8]) -> io::Result<()> {
    let mut done = 0;
    while done < buffer.len() {
        let count = unsafe {
            libc::pread(
                fd,
                buffer[done..].as_mut_ptr().cast(),
                buffer.len() - done,
                (offset + done as u64) as libc::off_t,
            )
        };
        if count < 0 {
            let error = sys::last_error();
            if error.kind() == io::ErrorKind::Interrupted {
                continue;
            }
            return Err(error);
        }
        if count == 0 {
            return Err(sys::invalid("the executable is cut short"));
        }
        done += count as usize;
    }
    Ok(())
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Linkage {
    Static,
    StaticPie,
    Dynamic,
}

pub fn linkage(fd: RawFd) -> io::Result<Linkage> {
    let mut header = [0u8; 64];
    read_at(fd, 0, &mut header)?;
    if &header[..4] != b"\x7fELF" || header[4] != 2 || header[5] != 1 {
        return Err(sys::invalid(
            "the executable isn't a 64-bit little-endian ELF",
        ));
    }
    let phoff = u64::from_le_bytes(header[32..40].try_into().unwrap());
    let phentsize = u16::from_le_bytes(header[54..56].try_into().unwrap()) as u64;
    let phnum = u16::from_le_bytes(header[56..58].try_into().unwrap()) as u64;
    if phentsize < 56 || phnum > 4096 {
        return Err(sys::invalid("the executable's program headers look wrong"));
    }
    let mut dynamic = false;
    for index in 0..phnum {
        let mut entry = [0u8; 4];
        read_at(fd, phoff + index * phentsize, &mut entry)?;
        match u32::from_le_bytes(entry) {
            PT_INTERP => return Ok(Linkage::Dynamic),
            PT_DYNAMIC => dynamic = true,
            _ => {}
        }
    }
    Ok(if dynamic {
        Linkage::StaticPie
    } else {
        Linkage::Static
    })
}

pub fn needs_no_loader(fd: RawFd) -> io::Result<bool> {
    Ok(linkage(fd)? != Linkage::Dynamic)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::fd::AsRawFd;

    #[test]
    fn a_system_binary_with_an_interpreter_is_dynamic() {
        let file = std::fs::File::open("/bin/sh").unwrap();
        assert_eq!(linkage(file.as_raw_fd()).unwrap(), Linkage::Dynamic);
    }

    #[test]
    fn a_script_is_not_an_elf() {
        let path = std::env::temp_dir().join(format!("jail-elf-{}", std::process::id()));
        std::fs::write(&path, b"#!/bin/sh\necho hi\n").unwrap();
        let file = std::fs::File::open(&path).unwrap();
        assert!(linkage(file.as_raw_fd()).is_err());
        std::fs::remove_file(path).unwrap();
    }
}
