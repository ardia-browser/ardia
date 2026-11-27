use indexmap::IndexMap;
use std::collections::HashSet;

const DIGITS: &[u8] = b"0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
const BASE: usize = 62;

fn digit(c: Option<u8>) -> usize {
    c.and_then(|c| DIGITS.iter().position(|d| *d == c))
        .unwrap_or(0)
}

fn position_between(a: &[u8], b: Option<&[u8]>) -> Vec<u8> {
    if let Some(b) = b {
        if a >= b {
            return a.to_vec();
        }
        let mut n = 0;
        while n < b.len() && a.get(n).copied().unwrap_or(b'0') == b[n] {
            n += 1;
        }
        if n > 0 {
            let mut out = b[..n].to_vec();
            out.extend(position_between(a.get(n..).unwrap_or(&[]), Some(&b[n..])));
            return out;
        }
    }
    let da = digit(a.first().copied());
    let db = b.map_or(BASE, |b| digit(b.first().copied()));
    if db > da + 1 {
        let mid = ((da + db) as f64 / 2.0).round() as usize;
        return vec![DIGITS[mid.min(BASE - 1)]];
    }
    if let Some(b) = b
        && b.len() > 1
    {
        return b[..1].to_vec();
    }
    let mut out = vec![DIGITS[da]];
    out.extend(position_between(a.get(1..).unwrap_or(&[]), None));
    out
}

pub fn assign_positions(existing: &[Option<&str>]) -> Vec<String> {
    let mut tails: Vec<usize> = Vec::new();
    let mut previous = vec![usize::MAX; existing.len()];
    for (i, p) in existing.iter().enumerate() {
        let Some(p) = p.filter(|p| !p.is_empty() && !p.ends_with('0')) else {
            continue;
        };
        let (mut lo, mut hi) = (0, tails.len());
        while lo < hi {
            let mid = (lo + hi) >> 1;
            if existing[tails[mid]].unwrap_or("") < p {
                lo = mid + 1;
            } else {
                hi = mid;
            }
        }
        if lo > 0 {
            previous[i] = tails[lo - 1];
        }
        if lo == tails.len() {
            tails.push(i);
        } else {
            tails[lo] = i;
        }
    }
    let mut keep = HashSet::new();
    let mut at = tails.last().copied().unwrap_or(usize::MAX);
    while at != usize::MAX {
        keep.insert(at);
        at = previous[at];
    }
    let mut out: Vec<String> = vec![String::new(); existing.len()];
    for &i in &keep {
        out[i] = existing[i].unwrap_or("").to_owned();
    }
    let mut next_kept: Vec<Option<String>> = vec![None; existing.len()];
    let mut next: Option<String> = None;
    for i in (0..existing.len()).rev() {
        next_kept[i] = next.clone();
        if keep.contains(&i) {
            next = Some(out[i].clone());
        }
    }
    let mut before = String::new();
    for i in 0..existing.len() {
        if keep.contains(&i) {
            before = out[i].clone();
            continue;
        }
        let made = position_between(
            before.as_bytes(),
            next_kept[i].as_deref().map(str::as_bytes),
        );
        out[i] = String::from_utf8(made).unwrap_or_default();
        before = out[i].clone();
    }
    out
}

pub fn folder_children(
    parent_of: &mut IndexMap<String, String>,
    keys: &[String],
    fallback: &str,
) -> IndexMap<String, Vec<String>> {
    let mut rooted: HashSet<String> = HashSet::new();
    for key in keys {
        let mut path = vec![key.clone()];
        let mut seen: HashSet<String> = HashSet::from([key.clone()]);
        let mut looped = false;
        let mut at = parent_of.get(key).cloned().unwrap_or_default();
        while parent_of.contains_key(&at) && !rooted.contains(&at) {
            if seen.contains(&at) {
                parent_of.insert(key.clone(), fallback.to_owned());
                looped = true;
                break;
            }
            seen.insert(at.clone());
            path.push(at.clone());
            at = parent_of.get(&at).cloned().unwrap_or_default();
        }
        if looped {
            rooted.insert(key.clone());
        } else {
            rooted.extend(path);
        }
    }
    let mut children: IndexMap<String, Vec<String>> = IndexMap::new();
    for (key, parent) in parent_of.iter() {
        children
            .entry(parent.clone())
            .or_default()
            .push(key.clone());
    }
    children
}

#[cfg(test)]
mod tests {
    use super::*;

    fn assign(list: &[Option<&str>]) -> Vec<String> {
        assign_positions(list)
    }

    #[test]
    fn positions_keep_the_longest_run_like_order_ts() {
        assert_eq!(assign(&[None, None, None]), vec!["V", "l", "t"]);
        assert_eq!(assign(&[Some("a"), Some("b"), None]), vec!["a", "b", "o"]);
        assert_eq!(
            assign(&[Some("b"), Some("a"), Some("c")]),
            vec!["I", "a", "c"]
        );
        assert_eq!(assign(&[Some("a"), None, Some("b")]), vec!["a", "aV", "b"]);
        assert_eq!(assign(&[Some("V"), Some("V"), None]), vec!["G", "V", "l"]);
        assert_eq!(
            assign(&[Some("z"), Some("z0"), None, Some("zz")]),
            vec!["z", "zV", "zk", "zz"]
        );
    }

    #[test]
    fn folder_cycles_break_to_the_fallback() {
        let mut parents: IndexMap<String, String> = [("a", "b"), ("b", "a"), ("c", "bar")]
            .into_iter()
            .map(|(k, v)| (k.to_owned(), v.to_owned()))
            .collect();
        let keys: Vec<String> = ["a", "b", "c"].iter().map(|s| (*s).to_owned()).collect();
        let children = folder_children(&mut parents, &keys, "other");
        assert_eq!(parents["a"], "other");
        assert_eq!(children["other"], vec!["a"]);
        assert_eq!(children["a"], vec!["b"]);
        assert_eq!(children["bar"], vec!["c"]);
    }
}
