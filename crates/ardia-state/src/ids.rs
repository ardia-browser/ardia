use serde::{Deserialize, Deserializer, Serialize, Serializer};
use std::borrow::Borrow;
use std::collections::hash_map::RandomState;
use std::fmt;
use std::hash::{BuildHasher, Hasher};
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};

const INHERITED: [&str; 12] = [
    "constructor",
    "__defineGetter__",
    "__defineSetter__",
    "hasOwnProperty",
    "__lookupGetter__",
    "__lookupSetter__",
    "isPrototypeOf",
    "propertyIsEnumerable",
    "toString",
    "valueOf",
    "__proto__",
    "toLocaleString",
];

pub fn is_own_id(id: &str) -> bool {
    !INHERITED.contains(&id)
}

macro_rules! id_type {
    ($name:ident) => {
        #[derive(Clone, PartialEq, Eq, Hash, PartialOrd, Ord)]
        pub struct $name(Arc<str>);

        impl Default for $name {
            fn default() -> Self {
                Self(Arc::from(""))
            }
        }

        impl $name {
            pub fn new(id: impl AsRef<str>) -> Self {
                Self(Arc::from(id.as_ref()))
            }

            pub fn as_str(&self) -> &str {
                &self.0
            }
        }

        impl Borrow<str> for $name {
            fn borrow(&self) -> &str {
                &self.0
            }
        }

        impl AsRef<str> for $name {
            fn as_ref(&self) -> &str {
                &self.0
            }
        }

        impl fmt::Debug for $name {
            fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
                write!(f, "{}({:?})", stringify!($name), &*self.0)
            }
        }

        impl fmt::Display for $name {
            fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
                f.write_str(&self.0)
            }
        }

        impl From<&str> for $name {
            fn from(id: &str) -> Self {
                Self::new(id)
            }
        }

        impl From<String> for $name {
            fn from(id: String) -> Self {
                Self(Arc::from(id))
            }
        }

        impl From<&$name> for $name {
            fn from(id: &$name) -> Self {
                id.clone()
            }
        }

        impl PartialEq<str> for $name {
            fn eq(&self, other: &str) -> bool {
                &*self.0 == other
            }
        }

        impl PartialEq<&str> for $name {
            fn eq(&self, other: &&str) -> bool {
                &*self.0 == *other
            }
        }

        impl Serialize for $name {
            fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
                serializer.serialize_str(&self.0)
            }
        }

        impl<'de> Deserialize<'de> for $name {
            fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
                String::deserialize(deserializer).map(Self::from)
            }
        }
    };
}

id_type!(ProfileId);
id_type!(WindowId);
id_type!(TabId);
id_type!(GroupId);
id_type!(SplitId);
id_type!(EntryId);
id_type!(DownloadId);
id_type!(BookmarkId);
id_type!(RuleId);

pub const DEFAULT_PROFILE_ID: &str = "default";
pub const INCOGNITO_PREFIX: &str = "incognito:";

impl ProfileId {
    pub fn default_profile() -> Self {
        Self::new(DEFAULT_PROFILE_ID)
    }

    pub fn incognito(window: &WindowId, original: &ProfileId) -> Self {
        Self::new(format!("{INCOGNITO_PREFIX}{window}@{original}"))
    }

    pub fn is_incognito(&self) -> bool {
        self.0.starts_with(INCOGNITO_PREFIX)
    }

    pub fn incognito_original(&self) -> ProfileId {
        match self.0.find('@') {
            Some(at) if self.is_incognito() => ProfileId::new(&self.0[at + 1..]),
            _ => ProfileId::default_profile(),
        }
    }
}

pub fn to_base36(mut n: u64) -> String {
    if n == 0 {
        return "0".to_owned();
    }
    let mut digits = Vec::with_capacity(13);
    while n > 0 {
        let d = (n % 36) as u8;
        digits.push(if d < 10 { b'0' + d } else { b'a' + d - 10 });
        n /= 36;
    }
    digits.reverse();
    String::from_utf8(digits).unwrap_or_default()
}

#[derive(Debug)]
pub struct IdGen {
    launch: String,
    counter: AtomicU64,
}

impl IdGen {
    pub fn new(now_ms: i64) -> Self {
        let mut hasher = RandomState::new().build_hasher();
        hasher.write_i64(now_ms);
        let noise = hasher.finish() % 36u64.pow(4);
        Self::with_launch(format!(
            "{}{:0>4}",
            to_base36(now_ms.max(0) as u64),
            to_base36(noise)
        ))
    }

    pub fn with_launch(launch: impl Into<String>) -> Self {
        IdGen {
            launch: launch.into(),
            counter: AtomicU64::new(0),
        }
    }

    pub fn launch(&self) -> &str {
        &self.launch
    }

    pub fn next(&self, prefix: &str) -> String {
        let n = self.counter.fetch_add(1, Ordering::Relaxed) + 1;
        format!("{prefix}-{}-{}", self.launch, to_base36(n))
    }

    pub fn tab(&self) -> TabId {
        TabId::from(self.next("tab"))
    }

    pub fn window(&self) -> WindowId {
        WindowId::from(self.next("w"))
    }

    pub fn group(&self) -> GroupId {
        GroupId::from(self.next("g"))
    }

    pub fn tile_folder(&self) -> String {
        self.next("tf")
    }

    pub fn split(&self) -> SplitId {
        SplitId::from(self.next("split"))
    }

    pub fn profile(&self) -> ProfileId {
        ProfileId::from(self.next("p"))
    }

    pub fn entry(&self, prefix: &str) -> EntryId {
        EntryId::from(self.next(prefix))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    #[test]
    fn ids_look_like_the_shell_ids() {
        let ids = IdGen::with_launch("mwb3icp3gkxs");
        assert_eq!(ids.tab().as_str(), "tab-mwb3icp3gkxs-1");
        assert_eq!(ids.window().as_str(), "w-mwb3icp3gkxs-2");
        assert_eq!(ids.next("ct"), "ct-mwb3icp3gkxs-3");
        let live = IdGen::new(1_795_624_452_665);
        assert!(live.launch().starts_with(&to_base36(1_795_624_452_665)));
        assert_eq!(live.launch().len(), to_base36(1_795_624_452_665).len() + 4);
    }

    #[test]
    fn base36_matches_number_to_string_36() {
        assert_eq!(to_base36(0), "0");
        assert_eq!(to_base36(35), "z");
        assert_eq!(to_base36(36), "10");
        assert_eq!(to_base36(1_795_624_452_665), "mwwcfqyh");
    }

    #[test]
    fn ids_borrow_as_str_for_map_lookups() {
        let mut map = HashMap::new();
        map.insert(TabId::new("tab-1"), 7);
        assert_eq!(map.get("tab-1"), Some(&7));
        assert_eq!(TabId::new("x"), "x");
        assert_eq!(
            serde_json::to_string(&TabId::new("a\"b")).unwrap(),
            "\"a\\\"b\""
        );
        let back: TabId = serde_json::from_str("\"tab-9\"").unwrap();
        assert_eq!(back.as_str(), "tab-9");
    }

    #[test]
    fn incognito_profiles_remember_their_original() {
        let id = ProfileId::incognito(&WindowId::new("w-1"), &ProfileId::new("p-x"));
        assert_eq!(id.as_str(), "incognito:w-1@p-x");
        assert!(id.is_incognito());
        assert_eq!(id.incognito_original().as_str(), "p-x");
        assert_eq!(
            ProfileId::new("incognito:w").incognito_original().as_str(),
            DEFAULT_PROFILE_ID
        );
        assert!(!ProfileId::default_profile().is_incognito());
    }

    #[test]
    fn inherited_object_keys_are_not_own_ids() {
        assert!(!is_own_id("__proto__"));
        assert!(!is_own_id("constructor"));
        assert!(is_own_id("tab-1"));
        assert!(is_own_id(""));
    }
}
