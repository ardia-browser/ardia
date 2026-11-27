const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

fn value(byte: u8) -> Option<u32> {
    ALPHABET
        .iter()
        .position(|&candidate| candidate == byte)
        .map(|index| index as u32)
}

fn quads(core: &[u8], out: &mut Vec<u8>) -> Option<()> {
    for quad in core.as_chunks::<4>().0 {
        let mut bits = 0u32;
        for &byte in quad {
            bits = (bits << 6) | value(byte)?;
        }
        out.extend_from_slice(&bits.to_be_bytes()[1..]);
    }
    Some(())
}

fn only_padding(tail: &[u8]) -> bool {
    tail.iter().all(|&byte| byte == b'=')
}

pub fn decode(text: &str) -> Option<Vec<u8>> {
    let bytes = text.as_bytes();
    let split = bytes.iter().position(|&byte| byte == b'=').unwrap_or(bytes.len());
    let (core, tail) = bytes.split_at(split);
    if core.iter().any(|&byte| value(byte).is_none()) {
        return None;
    }
    if split == 0 {
        return match bytes.len() {
            0 => Some(Vec::new()),
            length if length >= 4 && only_padding(tail) => Some(vec![0]),
            _ => None,
        };
    }
    let whole = split - split % 4;
    let mut out = Vec::with_capacity(whole / 4 * 3 + 2);
    quads(&core[..whole], &mut out)?;
    let rest: Vec<u32> = core[whole..].iter().map(|&byte| value(byte).unwrap_or(0)).collect();
    match rest.as_slice() {
        [] if only_padding(tail) => {}
        [first, second] if tail.len() >= 2 && only_padding(tail) => out.push(((first << 2) | (second >> 4)) as u8),
        [first, second] if tail.len() >= 2 && only_padding(&tail[2..]) => {
            let third = value(tail[1])?;
            out.push(((first << 2) | (second >> 4)) as u8);
            out.push(third as u8);
        }
        [first, second, third] if !tail.is_empty() && only_padding(tail) => {
            out.push(((first << 2) | (second >> 4)) as u8);
            out.push((((second & 15) << 4) | (third >> 2)) as u8);
        }
        _ => return None,
    }
    Some(out)
}
