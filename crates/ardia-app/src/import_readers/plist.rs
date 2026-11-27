use std::collections::BTreeMap;

pub const COCOA_EPOCH_SECONDS: f64 = 978_307_200.0;
const MAX_DEPTH: usize = 256;

#[derive(Clone, Debug, PartialEq)]
pub enum Plist {
    Dict(BTreeMap<String, Plist>),
    Array(Vec<Plist>),
    String(String),
    Int(i64),
    Real(f64),
    Bool(bool),
    Date(f64),
    Data(Vec<u8>),
    Null,
}

impl Plist {
    pub fn get(&self, key: &str) -> Option<&Plist> {
        match self {
            Plist::Dict(map) => map.get(key),
            _ => None,
        }
    }

    pub fn as_str(&self) -> Option<&str> {
        match self {
            Plist::String(s) => Some(s),
            _ => None,
        }
    }

    pub fn as_array(&self) -> &[Plist] {
        match self {
            Plist::Array(items) => items,
            _ => &[],
        }
    }

    pub fn as_int(&self) -> Option<i64> {
        match self {
            Plist::Int(n) => Some(*n),
            Plist::Real(n) => Some(*n as i64),
            _ => None,
        }
    }

    pub fn unix_ms(&self) -> Option<f64> {
        match self {
            Plist::Date(seconds) => Some((seconds + COCOA_EPOCH_SECONDS) * 1000.0),
            _ => None,
        }
    }
}

struct Reader<'a> {
    bytes: &'a [u8],
    offsets: Vec<usize>,
    ref_size: usize,
}

fn be(bytes: &[u8]) -> Option<u64> {
    if bytes.is_empty() || bytes.len() > 8 {
        return None;
    }
    Some(bytes.iter().fold(0u64, |acc, b| (acc << 8) | u64::from(*b)))
}

impl Reader<'_> {
    fn slice(&self, start: usize, len: usize) -> Option<&[u8]> {
        self.bytes.get(start..start.checked_add(len)?)
    }

    fn length(&self, marker: u8, at: usize) -> Option<(usize, usize)> {
        let low = usize::from(marker & 0x0F);
        if low != 0x0F {
            return Some((low, at + 1));
        }
        let int_marker = *self.bytes.get(at + 1)?;
        if int_marker & 0xF0 != 0x10 {
            return None;
        }
        let size = 1usize << (int_marker & 0x0F);
        let value = be(self.slice(at + 2, size)?)? as usize;
        Some((value, at + 2 + size))
    }

    fn reference(&self, at: usize) -> Option<usize> {
        be(self.slice(at, self.ref_size)?).map(|v| v as usize)
    }

    fn object(&self, index: usize, depth: usize) -> Option<Plist> {
        if depth > MAX_DEPTH {
            return None;
        }
        let at = *self.offsets.get(index)?;
        let marker = *self.bytes.get(at)?;
        Some(match marker >> 4 {
            0x0 => match marker {
                0x08 => Plist::Bool(false),
                0x09 => Plist::Bool(true),
                _ => Plist::Null,
            },
            0x1 => {
                let size = 1usize << (marker & 0x0F);
                Plist::Int(be(self.slice(at + 1, size)?)? as i64)
            }
            0x2 => {
                let size = 1usize << (marker & 0x0F);
                let raw = self.slice(at + 1, size)?;
                match size {
                    4 => Plist::Real(f64::from(f32::from_be_bytes(raw.try_into().ok()?))),
                    8 => Plist::Real(f64::from_be_bytes(raw.try_into().ok()?)),
                    _ => return None,
                }
            }
            0x3 => Plist::Date(f64::from_be_bytes(self.slice(at + 1, 8)?.try_into().ok()?)),
            0x4 => {
                let (len, start) = self.length(marker, at)?;
                Plist::Data(self.slice(start, len)?.to_vec())
            }
            0x5 => {
                let (len, start) = self.length(marker, at)?;
                Plist::String(
                    self.slice(start, len)?
                        .iter()
                        .map(|b| char::from(*b))
                        .collect(),
                )
            }
            0x6 => {
                let (len, start) = self.length(marker, at)?;
                let raw = self.slice(start, len.checked_mul(2)?)?;
                let units: Vec<u16> = raw
                    .as_chunks::<2>()
                    .0
                    .iter()
                    .map(|c| u16::from_be_bytes(*c))
                    .collect();
                Plist::String(String::from_utf16_lossy(&units))
            }
            0x8 => {
                let size = usize::from(marker & 0x0F) + 1;
                Plist::Int(be(self.slice(at + 1, size)?)? as i64)
            }
            0xA => {
                let (len, start) = self.length(marker, at)?;
                let mut items = Vec::with_capacity(len.min(4096));
                for i in 0..len {
                    let child = self.reference(start + i * self.ref_size)?;
                    items.push(self.object(child, depth + 1)?);
                }
                Plist::Array(items)
            }
            0xD => {
                let (len, start) = self.length(marker, at)?;
                let mut map = BTreeMap::new();
                for i in 0..len {
                    let key = self.reference(start + i * self.ref_size)?;
                    let value = self.reference(start + (len + i) * self.ref_size)?;
                    let Plist::String(key) = self.object(key, depth + 1)? else {
                        return None;
                    };
                    map.insert(key, self.object(value, depth + 1)?);
                }
                Plist::Dict(map)
            }
            _ => return None,
        })
    }
}

pub fn parse_binary(bytes: &[u8]) -> Option<Plist> {
    if !bytes.starts_with(b"bplist00") || bytes.len() < 8 + 32 {
        return None;
    }
    let trailer = &bytes[bytes.len() - 32..];
    let offset_size = usize::from(trailer[6]);
    let ref_size = usize::from(trailer[7]);
    let count = be(&trailer[8..16])? as usize;
    let top = be(&trailer[16..24])? as usize;
    let table = be(&trailer[24..32])? as usize;
    if offset_size == 0 || ref_size == 0 || count == 0 || count > bytes.len() {
        return None;
    }
    let mut offsets = Vec::with_capacity(count);
    for i in 0..count {
        let start = table.checked_add(i.checked_mul(offset_size)?)?;
        let offset = be(bytes.get(start..start + offset_size)?)? as usize;
        if offset >= bytes.len() {
            return None;
        }
        offsets.push(offset);
    }
    Reader {
        bytes,
        offsets,
        ref_size,
    }
    .object(top, 0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::import_readers::fixture;

    #[test]
    fn safari_bookmarks_parse_with_unicode_titles_and_dates() {
        let bytes = std::fs::read(fixture("home/Library/Safari/Bookmarks.plist")).unwrap();
        let top = parse_binary(&bytes).unwrap();
        let bar = &top.get("Children").unwrap().as_array()[0];
        assert_eq!(
            bar.get("WebBookmarkIdentifier").and_then(Plist::as_str),
            Some("BookmarksBar")
        );
        let travel = &bar.get("Children").unwrap().as_array()[1];
        let kyoto = &travel.get("Children").unwrap().as_array()[0];
        assert_eq!(
            kyoto
                .get("URIDictionary")
                .and_then(|d| d.get("title"))
                .and_then(Plist::as_str),
            Some("京都 guide")
        );
        assert!(parse_binary(b"not a plist").is_none());
        assert!(parse_binary(&bytes[..40]).is_none());
    }

    #[test]
    fn dates_convert_from_the_cocoa_epoch() {
        assert_eq!(Plist::Date(0.0).unix_ms(), Some(978_307_200_000.0));
    }
}
