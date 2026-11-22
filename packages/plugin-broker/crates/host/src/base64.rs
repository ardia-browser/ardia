const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

pub fn btoa(units: &[u16]) -> Option<String> {
    let mut bytes = Vec::with_capacity(units.len());
    for &unit in units {
        if unit > 0xff {
            return None;
        }
        bytes.push(unit as u8);
    }
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let b = [chunk[0], *chunk.get(1).unwrap_or(&0), *chunk.get(2).unwrap_or(&0)];
        let n = (u32::from(b[0]) << 16) | (u32::from(b[1]) << 8) | u32::from(b[2]);
        out.push(ALPHABET[(n >> 18) as usize & 63] as char);
        out.push(ALPHABET[(n >> 12) as usize & 63] as char);
        out.push(if chunk.len() > 1 { ALPHABET[(n >> 6) as usize & 63] as char } else { '=' });
        out.push(if chunk.len() > 2 { ALPHABET[n as usize & 63] as char } else { '=' });
    }
    Some(out)
}

fn sextet(c: u16) -> Option<u32> {
    Some(match c {
        0x41..=0x5a => c - 0x41,
        0x61..=0x7a => c - 0x61 + 26,
        0x30..=0x39 => c - 0x30 + 52,
        0x2b => 62,
        0x2f => 63,
        _ => return None,
    } as u32)
}

pub fn atob(units: &[u16]) -> Option<String> {
    let mut data: Vec<u16> = units.iter().copied().filter(|&c| !matches!(c, 0x09 | 0x0a | 0x0c | 0x0d | 0x20)).collect();
    if data.len().is_multiple_of(4) {
        if data.ends_with(&[0x3d, 0x3d]) {
            data.truncate(data.len() - 2);
        } else if data.ends_with(&[0x3d]) {
            data.truncate(data.len() - 1);
        }
    }
    if data.len() % 4 == 1 {
        return None;
    }
    let mut out = String::with_capacity(data.len() * 3 / 4);
    let mut buffer = 0u32;
    let mut bits = 0;
    for &c in &data {
        buffer = (buffer << 6) | sextet(c)?;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push(char::from(((buffer >> bits) & 0xff) as u8));
        }
    }
    Some(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn u(s: &str) -> Vec<u16> {
        s.encode_utf16().collect()
    }

    #[test]
    fn btoa_matches_the_web_platform() {
        assert_eq!(btoa(&u("")).as_deref(), Some(""));
        assert_eq!(btoa(&u("a")).as_deref(), Some("YQ=="));
        assert_eq!(btoa(&u("ab")).as_deref(), Some("YWI="));
        assert_eq!(btoa(&u("abc")).as_deref(), Some("YWJj"));
        assert_eq!(btoa(&u("\u{ff}\u{fe}")).as_deref(), Some("//4="));
        assert_eq!(btoa(&u("\u{100}")), None);
        assert_eq!(btoa(&[0xd800]), None);
    }

    #[test]
    fn atob_is_forgiving_base64() {
        assert_eq!(atob(&u("YQ==")).as_deref(), Some("a"));
        assert_eq!(atob(&u("YQ")).as_deref(), Some("a"));
        assert_eq!(atob(&u(" Y Q = = ")).as_deref(), Some("a"));
        assert_eq!(atob(&u("YQ==\r\n")).as_deref(), Some("a"));
        assert_eq!(atob(&u("YR==")).as_deref(), Some("a"));
        assert_eq!(atob(&u("//4=")).as_deref(), Some("\u{ff}\u{fe}"));
        assert_eq!(atob(&u("")).as_deref(), Some(""));
        assert_eq!(atob(&u("Y")), None);
        assert_eq!(atob(&u("YQ=")), None);
        assert_eq!(atob(&u("Y===")), None);
        assert_eq!(atob(&u("YQ==YQ==")), None);
        assert_eq!(atob(&u("Y-Q=")), None);
        assert_eq!(atob(&u("Y\u{a0}Q")), None);
    }
}
