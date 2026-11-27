use std::sync::OnceLock;

use super::emoji_data::EMOJI_GROUPS;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct EmojiEntry {
    pub emoji: &'static str,
    pub name: &'static str,
    name_words: String,
    words: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct EmojiSection {
    pub title: &'static str,
    pub emoji: Vec<EmojiEntry>,
}

fn fold_char(c: char) -> char {
    match c {
        'à' | 'á' | 'â' | 'ã' | 'ä' | 'å' | 'À' | 'Á' | 'Â' | 'Ã' | 'Ä' | 'Å' => 'a',
        'ç' | 'Ç' => 'c',
        'è' | 'é' | 'ê' | 'ë' | 'È' | 'É' | 'Ê' | 'Ë' => 'e',
        'ì' | 'í' | 'î' | 'ï' | 'Ì' | 'Í' | 'Î' | 'Ï' => 'i',
        'ñ' | 'Ñ' => 'n',
        'ò' | 'ó' | 'ô' | 'õ' | 'ö' | 'Ò' | 'Ó' | 'Ô' | 'Õ' | 'Ö' => 'o',
        'ù' | 'ú' | 'û' | 'ü' | 'Ù' | 'Ú' | 'Û' | 'Ü' => 'u',
        'ý' | 'ÿ' | 'Ý' => 'y',
        other => other,
    }
}

pub fn fold(text: &str) -> String {
    text.chars()
        .filter(|c| !('\u{0300}'..='\u{036f}').contains(c))
        .map(fold_char)
        .flat_map(char::to_lowercase)
        .collect()
}

fn words_of(text: &str) -> String {
    let folded: String = fold(text)
        .chars()
        .map(|c| if matches!(c, '.' | ',' | ':') { ' ' } else { c })
        .collect();
    format!(" {folded}")
}

pub fn emoji_sections() -> &'static [EmojiSection] {
    static SECTIONS: OnceLock<Vec<EmojiSection>> = OnceLock::new();
    SECTIONS.get_or_init(|| {
        EMOJI_GROUPS
            .iter()
            .map(|(title, list)| EmojiSection {
                title,
                emoji: list
                    .split('\n')
                    .map(|line| {
                        let mut parts = line.split('\t');
                        let emoji = parts.next().unwrap_or_default();
                        let name = parts.next().unwrap_or_default();
                        let words = parts.next().unwrap_or_default();
                        EmojiEntry {
                            emoji,
                            name,
                            name_words: words_of(name),
                            words: format!(" {}", fold(words)),
                        }
                    })
                    .collect(),
            })
            .collect()
    })
}

pub fn search_terms(query: &str) -> Vec<String> {
    fold(query)
        .trim()
        .split(|c: char| c.is_whitespace() || matches!(c, '.' | ',' | ':'))
        .filter(|term| !term.is_empty())
        .map(str::to_owned)
        .collect()
}

fn has_terms(words: &str, terms: &[String]) -> bool {
    terms.iter().all(|term| words.contains(&format!(" {term}")))
}

pub fn matches_terms(text: &str, terms: &[String]) -> bool {
    has_terms(&words_of(text), terms)
}

pub fn search_emoji(terms: &[String]) -> Vec<&'static EmojiEntry> {
    let mut by_word = Vec::new();
    let mut by_name = Vec::new();
    let mut by_keyword = Vec::new();
    for section in emoji_sections() {
        for entry in &section.emoji {
            let padded = format!("{} ", entry.name_words);
            if terms
                .iter()
                .all(|term| padded.contains(&format!(" {term} ")))
            {
                by_word.push(entry);
            } else if has_terms(&entry.name_words, terms) {
                by_name.push(entry);
            } else if has_terms(&format!("{}{}", entry.name_words, entry.words), terms) {
                by_keyword.push(entry);
            }
        }
    }
    by_word.extend(by_name);
    by_word.extend(by_keyword);
    by_word
}

fn bare(icon: &str) -> String {
    icon.replace('\u{fe0f}', "")
}

pub fn same_icon(a: Option<&str>, b: Option<&str>) -> bool {
    match (a, b) {
        (Some(a), Some(b)) => a == b || bare(a) == bare(b),
        (None, None) => true,
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sections_match_the_old_data() {
        let sections = emoji_sections();
        assert_eq!(sections.len(), 9);
        assert_eq!(sections[0].title, "Smileys");
        assert_eq!(sections[0].emoji[0].emoji, "😀");
        assert_eq!(sections[0].emoji[0].name, "grinning face");
    }

    #[test]
    fn whole_word_name_matches_rank_first() {
        let found = search_emoji(&search_terms("Cat"));
        assert!(!found.is_empty());
        assert!(found[0].name.split(' ').any(|word| word == "cat"));
        assert!(search_emoji(&search_terms("zzqqxx")).is_empty());
    }

    #[test]
    fn terms_fold_case_accents_and_punctuation() {
        assert_eq!(search_terms("  Café, Au:Lait "), vec!["cafe", "au", "lait"]);
        assert!(matches_terms("house.fill Home", &search_terms("hou")));
        assert!(!matches_terms("house.fill Home", &search_terms("ouse")));
    }

    #[test]
    fn variation_selectors_do_not_change_identity() {
        assert!(same_icon(Some("❤️"), Some("❤")));
        assert!(!same_icon(Some("❤"), None));
        assert!(same_icon(None, None));
    }
}
