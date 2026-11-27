macro_rules! string_enum {
    ($(#[$meta:meta])* $name:ident { $($variant:ident = $key:literal),+ $(,)? } default $default:ident) => {
        $(#[$meta])*
        #[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord)]
        pub enum $name {
            $($variant,)+
        }

        impl $name {
            pub const ALL: &'static [$name] = &[$($name::$variant),+];

            pub const fn key(self) -> &'static str {
                match self {
                    $($name::$variant => $key),+
                }
            }

            pub fn from_key(key: &str) -> Option<Self> {
                match key {
                    $($key => Some($name::$variant),)+
                    _ => None,
                }
            }
        }

        impl Default for $name {
            fn default() -> Self {
                $name::$default
            }
        }

        impl serde::Serialize for $name {
            fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
                serializer.serialize_str(self.key())
            }
        }

        impl<'de> serde::Deserialize<'de> for $name {
            fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
                let text = <std::borrow::Cow<'de, str> as serde::Deserialize>::deserialize(deserializer)?;
                $name::from_key(&text).ok_or_else(|| <D::Error as serde::de::Error>::unknown_variant(&text, &[$($key),+]))
            }
        }

        impl std::fmt::Display for $name {
            fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                f.write_str(self.key())
            }
        }
    };
}

pub(crate) use string_enum;
