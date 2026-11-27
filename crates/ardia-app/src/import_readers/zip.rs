use std::io::Read;

const MAX_ENTRIES: usize = 10_000;
const MAX_ENTRY_SIZE: usize = 1 << 30;
const MAX_EXPANDED: usize = 4 << 30;
const MAX_RATIO: usize = 200;
const RATIO_FLOOR: usize = 4 << 20;
const UNIX_HOST: u16 = 3;
const FILE_TYPE_MASK: u32 = 0o170000;
const SYMBOLIC_LINK: u32 = 0o120000;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Entry {
    pub name: String,
    method: u16,
    compressed: usize,
    size: usize,
    crc: u32,
    data_offset: usize,
}

pub struct Archive<'a> {
    data: &'a [u8],
    pub entries: Vec<Entry>,
}

fn u16_at(data: &[u8], at: usize) -> Option<u16> {
    Some(u16::from_le_bytes(data.get(at..at + 2)?.try_into().ok()?))
}

fn u32_at(data: &[u8], at: usize) -> Option<u32> {
    Some(u32::from_le_bytes(data.get(at..at + 4)?.try_into().ok()?))
}

fn inflates_too_far(compressed: usize, size: usize) -> bool {
    size >= RATIO_FLOOR && size / compressed.max(1) > MAX_RATIO
}

pub fn is_safe_name(name: &str) -> bool {
    !name.is_empty()
        && !name.starts_with('/')
        && !name.contains('\\')
        && !name.contains('\0')
        && !name.split('/').any(|part| part == "..")
}

fn local_data_offset(data: &[u8], local: usize) -> Result<usize, String> {
    let damaged = || "Damaged zip entry".to_owned();
    if local.checked_add(30).is_none_or(|end| end > data.len())
        || u32_at(data, local) != Some(0x0403_4B50)
    {
        return Err(damaged());
    }
    let name = usize::from(u16_at(data, local + 26).ok_or_else(damaged)?);
    let extra = usize::from(u16_at(data, local + 28).ok_or_else(damaged)?);
    Ok(local + 30 + name + extra)
}

impl<'a> Archive<'a> {
    pub fn open(data: &'a [u8]) -> Result<Archive<'a>, String> {
        const MIN_EOCD: usize = 22;
        let not_zip = || "Not a zip file".to_owned();
        if data.len() < MIN_EOCD {
            return Err(not_zip());
        }
        let floor = data.len().saturating_sub(MIN_EOCD + 0xFFFF);
        let eocd = (floor..=data.len() - MIN_EOCD)
            .rev()
            .find(|i| data[*i..*i + 4] == [0x50, 0x4B, 0x05, 0x06])
            .ok_or_else(not_zip)?;
        let count = u16_at(data, eocd + 10).ok_or("Damaged zip file")?;
        let dir_offset = u32_at(data, eocd + 16).ok_or("Damaged zip file")?;
        if count == 0xFFFF || dir_offset == 0xFFFF_FFFF {
            return Err("ZIP64 archives aren't supported".into());
        }
        if usize::from(count) > MAX_ENTRIES {
            return Err(format!("The zip file has more than {MAX_ENTRIES} entries"));
        }
        let mut entries = Vec::new();
        let mut ranges: Vec<(usize, usize)> = Vec::new();
        let mut expanded = 0usize;
        let mut offset = dir_offset as usize;
        let damaged_dir = || "Damaged zip directory".to_owned();
        for _ in 0..count {
            if offset.checked_add(46).is_none_or(|end| end > data.len())
                || u32_at(data, offset) != Some(0x0201_4B50)
            {
                return Err(damaged_dir());
            }
            let made_by = u16_at(data, offset + 4).ok_or_else(damaged_dir)?;
            let flags = u16_at(data, offset + 8).ok_or_else(damaged_dir)?;
            let method = u16_at(data, offset + 10).ok_or_else(damaged_dir)?;
            let crc = u32_at(data, offset + 16).ok_or_else(damaged_dir)?;
            let compressed = u32_at(data, offset + 20).ok_or_else(damaged_dir)? as usize;
            let size = u32_at(data, offset + 24).ok_or_else(damaged_dir)? as usize;
            let name_len = usize::from(u16_at(data, offset + 28).ok_or_else(damaged_dir)?);
            let extra_len = usize::from(u16_at(data, offset + 30).ok_or_else(damaged_dir)?);
            let comment_len = usize::from(u16_at(data, offset + 32).ok_or_else(damaged_dir)?);
            let external = u32_at(data, offset + 38).ok_or_else(damaged_dir)?;
            let local = u32_at(data, offset + 42).ok_or_else(damaged_dir)? as usize;
            let raw_name = data
                .get(offset + 46..offset + 46 + name_len)
                .ok_or_else(damaged_dir)?;
            let name = if flags & 0x800 != 0 {
                String::from_utf8_lossy(raw_name).into_owned()
            } else {
                raw_name.iter().map(|b| char::from(*b)).collect()
            };
            offset += 46 + name_len + extra_len + comment_len;
            let is_link =
                made_by >> 8 == UNIX_HOST && (external >> 16) & FILE_TYPE_MASK == SYMBOLIC_LINK;
            if flags & 0x1 != 0 || is_link || !is_safe_name(&name) {
                continue;
            }
            if size > MAX_ENTRY_SIZE || compressed > MAX_ENTRY_SIZE {
                return Err(format!(
                    "{name} in the zip file is over {} MB",
                    MAX_ENTRY_SIZE >> 20
                ));
            }
            if inflates_too_far(compressed, size) {
                return Err(format!(
                    "{name} in the zip file unpacks to more than {MAX_RATIO} times its size"
                ));
            }
            if method == 0 && compressed != size {
                return Err("Damaged zip entry".into());
            }
            expanded += size;
            if expanded > MAX_EXPANDED {
                return Err(format!(
                    "The zip file unpacks to more than {} MB",
                    MAX_EXPANDED >> 20
                ));
            }
            let start = local_data_offset(data, local)?;
            if start > data.len().saturating_sub(compressed) {
                return Err("Damaged zip entry".into());
            }
            ranges.push((local, start + compressed));
            entries.push(Entry {
                name,
                method,
                compressed,
                size,
                crc,
                data_offset: start,
            });
        }
        ranges.sort_unstable();
        if ranges.windows(2).any(|pair| pair[1].0 < pair[0].1) {
            return Err("Damaged zip file: its entries overlap".into());
        }
        Ok(Archive { data, entries })
    }

    pub fn extract(&self, entry: &Entry) -> Result<Vec<u8>, String> {
        let body = self
            .data
            .get(entry.data_offset..entry.data_offset + entry.compressed)
            .ok_or("Damaged zip entry")?;
        let out = match entry.method {
            0 => body.to_vec(),
            8 => {
                let mut out = Vec::with_capacity(entry.size);
                flate2::read::DeflateDecoder::new(body)
                    .take(entry.size as u64 + 1)
                    .read_to_end(&mut out)
                    .map_err(|_| format!("Couldn't inflate {}", entry.name))?;
                if out.len() != entry.size {
                    return Err(format!("Couldn't inflate {}", entry.name));
                }
                out
            }
            other => return Err(format!("Unsupported zip compression method {other}")),
        };
        let mut crc = flate2::Crc::new();
        crc.update(&out);
        if crc.sum() != entry.crc {
            return Err(format!("{} is damaged", entry.name));
        }
        Ok(out)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::import_readers::fixture;

    #[test]
    fn the_safari_export_zip_lists_and_extracts_its_files() {
        let data = std::fs::read(fixture("safari/Safari Export.zip")).unwrap();
        let archive = Archive::open(&data).unwrap();
        let names: Vec<&str> = archive.entries.iter().map(|e| e.name.as_str()).collect();
        assert!(
            names.iter().any(|n| n.ends_with("Bookmarks.html")),
            "{names:?}"
        );
        let html = archive
            .entries
            .iter()
            .find(|e| e.name.ends_with("Bookmarks.html"))
            .unwrap();
        let text = String::from_utf8(archive.extract(html).unwrap()).unwrap();
        assert!(text.contains("NETSCAPE-Bookmark-file"));
        let empty = std::fs::read(fixture("safari/not-an-export.zip")).unwrap();
        assert!(Archive::open(&empty).unwrap().entries.is_empty());
        assert_eq!(
            Archive::open(b"plain text, not a zip").err().as_deref(),
            Some("Not a zip file")
        );
    }

    #[test]
    fn names_cannot_escape_the_archive() {
        assert!(is_safe_name("Safari Export/History.json"));
        assert!(!is_safe_name("Safari Export/../../escape.csv"));
        assert!(!is_safe_name("/etc/passwd"));
        assert!(!is_safe_name("Safari Export\\..\\escape.csv"));
        assert!(!is_safe_name(""));
    }
}
