use crate::base32::is_tag;

pub const FILE_EXTENSION: &str = "nns";

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Name {
    File(String),
    Pending(String),
    Other,
}

pub fn classify(name: &str) -> Name {
    if let Some(id) = name.strip_prefix('.').and_then(|rest| rest.strip_suffix(".nns.icloud")) {
        return if is_tag(id) {
            Name::Pending(id.to_owned())
        } else {
            Name::Other
        };
    }
    match name.strip_suffix(".nns") {
        Some(id) if is_tag(id) => Name::File(id.to_owned()),
        _ => Name::Other,
    }
}

pub fn file_name(id: &str) -> String {
    format!("{id}.{FILE_EXTENSION}")
}

pub fn relative_path(chain_tag: &str, scope_tag: &str, id: &str) -> String {
    format!("{chain_tag}/{scope_tag}/{}", file_name(id))
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Listing {
    pub open: Vec<String>,
    pub pending: Vec<String>,
    pub present: Vec<String>,
}

pub fn list<'a>(names: impl IntoIterator<Item = &'a str>, known: &[&str]) -> Listing {
    let known: std::collections::HashSet<&str> = known.iter().copied().collect();
    let mut names: Vec<&str> = names.into_iter().collect();
    names.sort_unstable();
    let mut listing = Listing::default();
    let mut present = std::collections::BTreeSet::new();
    for name in names {
        match classify(name) {
            Name::Pending(id) => {
                if !present.insert(id.clone()) {
                    continue;
                }
                listing.present.push(id.clone());
                if !known.contains(id.as_str()) {
                    listing.pending.push(id);
                }
            }
            Name::File(id) => {
                if present.insert(id.clone()) {
                    listing.present.push(id.clone());
                }
                if !known.contains(id.as_str()) {
                    listing.open.push(id);
                }
            }
            Name::Other => {}
        }
    }
    listing
}
