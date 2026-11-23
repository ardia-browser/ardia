use ardia_crypto::{Backend, Crypto};
use zeroize::Zeroizing;

use crate::lowercase_letters::LOWERCASE_LETTERS;
use crate::wordlist::ENGLISH;
use crate::{Error, PhraseError};

pub const WORD_COUNT: usize = 24;
pub const ENTROPY_BYTES: usize = 32;
pub const PREFIX_LETTERS: usize = 4;

const BITS_PER_WORD: usize = 11;

pub fn generate_entropy() -> Result<Zeroizing<[u8; ENTROPY_BYTES]>, Error> {
    let mut entropy = Zeroizing::new([0u8; ENTROPY_BYTES]);
    Backend::fill_random(entropy.as_mut()).map_err(|_| Error::Random)?;
    Ok(entropy)
}

fn bit(bytes: &[u8], at: usize) -> usize {
    usize::from((bytes[at / 8] >> (7 - at % 8)) & 1)
}

pub fn words(entropy: &[u8; ENTROPY_BYTES]) -> [&'static str; WORD_COUNT] {
    let mut stream = Zeroizing::new([0u8; ENTROPY_BYTES + 1]);
    stream[..ENTROPY_BYTES].copy_from_slice(entropy);
    stream[ENTROPY_BYTES] = Backend::sha256(entropy)[0];
    std::array::from_fn(|word| {
        let index =
            (word * BITS_PER_WORD..(word + 1) * BITS_PER_WORD).fold(0, |acc, at| (acc << 1) | bit(&*stream, at));
        ENGLISH[index]
    })
}

pub fn phrase(entropy: &[u8; ENTROPY_BYTES]) -> Zeroizing<String> {
    Zeroizing::new(words(entropy).join(" "))
}

fn is_lowercase_letter(scalar: char) -> bool {
    let value = u32::from(scalar);
    LOWERCASE_LETTERS
        .binary_search_by(|&(first, last)| {
            if last < value {
                std::cmp::Ordering::Less
            } else if first > value {
                std::cmp::Ordering::Greater
            } else {
                std::cmp::Ordering::Equal
            }
        })
        .is_ok()
}

fn push_wiping(token: &mut Zeroizing<String>, scalar: char) {
    if token.len() + scalar.len_utf8() > token.capacity() {
        let mut grown = Zeroizing::new(String::with_capacity((token.capacity() * 2).max(32)));
        grown.push_str(token);
        *token = grown;
    }
    token.push(scalar);
}

fn empty_token() -> Zeroizing<String> {
    Zeroizing::new(String::with_capacity(32))
}

pub fn tokens(text: &str) -> Vec<Zeroizing<String>> {
    let mut tokens = Vec::new();
    let mut current = empty_token();
    for scalar in text.chars().flat_map(char::to_lowercase) {
        if is_lowercase_letter(scalar) {
            push_wiping(&mut current, scalar);
        } else if !current.is_empty() {
            tokens.push(std::mem::replace(&mut current, empty_token()));
        }
    }
    if !current.is_empty() {
        tokens.push(current);
    }
    tokens
}

pub fn index_of(token: &str) -> Option<usize> {
    if let Ok(index) = ENGLISH.binary_search(&token) {
        return Some(index);
    }
    if token.chars().count() < PREFIX_LETTERS {
        return None;
    }
    let index = ENGLISH.partition_point(|word| *word < token);
    ENGLISH.get(index).filter(|word| word.starts_with(token)).map(|_| index)
}

pub fn entropy(text: &str) -> Result<Zeroizing<[u8; ENTROPY_BYTES]>, PhraseError> {
    let tokens = tokens(text);
    if tokens.len() != WORD_COUNT {
        return Err(PhraseError::WordCount(tokens.len()));
    }
    let mut stream = Zeroizing::new([0u8; ENTROPY_BYTES + 1]);
    for (word, token) in tokens.iter().enumerate() {
        let index = index_of(token).ok_or(PhraseError::UnknownWord(word))?;
        for offset in 0..BITS_PER_WORD {
            if (index >> (BITS_PER_WORD - 1 - offset)) & 1 == 1 {
                let at = word * BITS_PER_WORD + offset;
                stream[at / 8] |= 1 << (7 - at % 8);
            }
        }
    }
    let mut entropy = Zeroizing::new([0u8; ENTROPY_BYTES]);
    entropy.copy_from_slice(&stream[..ENTROPY_BYTES]);
    if Backend::sha256(entropy.as_ref())[0] != stream[ENTROPY_BYTES] {
        return Err(PhraseError::Checksum);
    }
    Ok(entropy)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_lowercase_letter_ranges_are_sorted_and_disjoint() {
        for pair in LOWERCASE_LETTERS.windows(2) {
            assert!(pair[0].0 <= pair[0].1 && pair[0].1 + 1 < pair[1].0, "{pair:x?}");
        }
        assert!(is_lowercase_letter('a') && is_lowercase_letter('z') && is_lowercase_letter('ß'));
        assert!(!is_lowercase_letter('A') && !is_lowercase_letter('1') && !is_lowercase_letter('漢'));
        assert!(!is_lowercase_letter('\u{0301}') && !is_lowercase_letter('😀'));
    }

    #[test]
    fn long_tokens_grow_without_losing_letters() {
        let long = "a".repeat(1000) + " " + &"Ä".repeat(300);
        let tokens = tokens(&long);
        assert_eq!(tokens.len(), 2);
        assert_eq!(tokens[0].as_str(), "a".repeat(1000));
        assert_eq!(tokens[1].as_str(), "ä".repeat(300));
    }
}
