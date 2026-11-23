const ALPHABET: &[u8; 32] = b"abcdefghijklmnopqrstuvwxyz234567";

pub const TAG_LENGTH: usize = 26;

pub fn base32_encode(data: &[u8]) -> String {
    let mut out = String::with_capacity((data.len() * 8).div_ceil(5));
    let mut buffer: u32 = 0;
    let mut bits = 0u32;
    for &byte in data {
        buffer = (buffer << 8) | u32::from(byte);
        bits += 8;
        while bits >= 5 {
            out.push(char::from(ALPHABET[((buffer >> (bits - 5)) & 31) as usize]));
            bits -= 5;
        }
        buffer &= (1 << bits) - 1;
    }
    if bits > 0 {
        out.push(char::from(ALPHABET[((buffer << (5 - bits)) & 31) as usize]));
    }
    out
}

pub fn is_tag(name: &str) -> bool {
    name.len() == TAG_LENGTH && name.bytes().all(|byte| ALPHABET.contains(&byte))
}
