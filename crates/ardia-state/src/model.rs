use crate::ids::TabId;
use crate::json::{self, Fields};
use crate::macros::string_enum;
use serde::de::Error as _;
use serde::ser::SerializeSeq;
use serde::{Deserialize, Deserializer, Serialize, Serializer};
use serde_json::Value;

pub type Millis = i64;

#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct Frame {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

impl Frame {
    pub const fn new(x: f64, y: f64, width: f64, height: f64) -> Self {
        Frame {
            x,
            y,
            width,
            height,
        }
    }

    pub fn is_valid(&self) -> bool {
        [self.x, self.y, self.width, self.height]
            .iter()
            .all(|v| v.is_finite())
            && self.width > 0.0
            && self.height > 0.0
    }
}

impl Serialize for Frame {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let mut seq = serializer.serialize_seq(Some(4))?;
        for v in [self.x, self.y, self.width, self.height] {
            seq.serialize_element(&json::js_number(v))?;
        }
        seq.end()
    }
}

impl<'de> Deserialize<'de> for Frame {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let parts = Vec::<f64>::deserialize(deserializer)?;
        match parts[..] {
            [x, y, width, height] if [x, y, width, height].iter().all(|v| v.is_finite()) => {
                Ok(Frame {
                    x,
                    y,
                    width,
                    height,
                })
            }
            _ => Err(D::Error::custom("a frame is four finite numbers")),
        }
    }
}

string_enum!(PageEngine { Chromium = "chromium", Webkit = "webkit" } default Chromium);
string_enum!(TabLayout { Sidebar = "sidebar", Top = "top" } default Sidebar);
string_enum!(SidebarSide { Left = "left", Right = "right" } default Left);
string_enum!(Orientation { Horizontal = "horizontal", Vertical = "vertical" } default Horizontal);

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum EffectiveLayout {
    Sidebar,
    TopStrip,
    ArcSidebar,
}

impl EffectiveLayout {
    pub fn of(layout: TabLayout, address_bar_in_sidebar: bool) -> Self {
        match (layout, address_bar_in_sidebar) {
            (TabLayout::Top, _) => EffectiveLayout::TopStrip,
            (TabLayout::Sidebar, true) => EffectiveLayout::ArcSidebar,
            (TabLayout::Sidebar, false) => EffectiveLayout::Sidebar,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TileFolder {
    pub id: String,
    pub name: String,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "json::option_millis"
    )]
    pub renamed_at: Option<Millis>,
}

#[derive(Clone, Debug, PartialEq)]
pub enum TabPin {
    Tile { folder: Option<TileFolder> },
    Row,
}

impl TabPin {
    pub const TILE: TabPin = TabPin::Tile { folder: None };

    pub fn is_tile(&self) -> bool {
        matches!(self, TabPin::Tile { .. })
    }

    pub fn is_row(&self) -> bool {
        matches!(self, TabPin::Row)
    }

    pub fn folder(&self) -> Option<&TileFolder> {
        match self {
            TabPin::Tile { folder } => folder.as_ref(),
            TabPin::Row => None,
        }
    }

    pub fn from_value(value: &Value) -> Option<TabPin> {
        let fields = value.as_object()?;
        match fields.get("as").and_then(Value::as_str)? {
            "row" => Some(TabPin::Row),
            "tile" => Some(TabPin::Tile {
                folder: fields.get("folder").and_then(folder_of),
            }),
            _ => None,
        }
    }
}

fn folder_of(value: &Value) -> Option<TileFolder> {
    let fields = value.as_object()?;
    Some(TileFolder {
        id: fields.get("id")?.as_str()?.to_owned(),
        name: fields.get("name")?.as_str()?.to_owned(),
        renamed_at: fields.get("renamedAt").and_then(json::as_millis),
    })
}

impl Serialize for TabPin {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let mut out = Fields::new();
        match self {
            TabPin::Row => {
                out.insert("as".into(), "row".into());
            }
            TabPin::Tile { folder } => {
                out.insert("as".into(), "tile".into());
                if let Some(folder) = folder {
                    out.insert(
                        "folder".into(),
                        serde_json::to_value(folder).map_err(serde::ser::Error::custom)?,
                    );
                }
            }
        }
        out.serialize(serializer)
    }
}

pub fn pin_from_disk<'de, D: Deserializer<'de>>(
    deserializer: D,
) -> Result<Option<TabPin>, D::Error> {
    let value = Value::deserialize(deserializer)?;
    Ok(TabPin::from_value(&value))
}

pub const RESTORE_PREFIX: &str = "restore:";
const ADOPT_KINDS: [&str; 6] = ["restore", "clone", "tab", "ardiacore", "webkit", "link"];

pub fn adopt_kind(id: &str) -> Option<(&str, &str)> {
    let colon = id.find(':')?;
    let kind = &id[..colon];
    ADOPT_KINDS
        .contains(&kind)
        .then(|| (kind, &id[colon + 1..]))
}

pub fn restore_id(tab: &TabId) -> String {
    format!("{RESTORE_PREFIX}{tab}")
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub enum PageKind {
    #[default]
    Idle,
    Asleep,
    Frozen {
        holder: TabId,
    },
    Loaded,
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct TabPage {
    pub kind: PageKind,
    pub wake: Option<String>,
}

impl TabPage {
    pub const IDLE: TabPage = TabPage {
        kind: PageKind::Idle,
        wake: None,
    };
    pub const ASLEEP: TabPage = TabPage {
        kind: PageKind::Asleep,
        wake: None,
    };
    pub const LOADED: TabPage = TabPage {
        kind: PageKind::Loaded,
        wake: None,
    };

    pub fn is_asleep(&self) -> bool {
        self.kind == PageKind::Asleep
    }

    pub fn has_page(&self) -> bool {
        matches!(self.kind, PageKind::Loaded)
    }

    pub fn pending_restore(&self) -> Option<&str> {
        self.wake
            .as_deref()
            .and_then(adopt_kind)
            .filter(|(kind, _)| *kind == "restore")
            .map(|(_, key)| key)
    }

    pub fn from_value(value: &Value) -> TabPage {
        let fields = value.as_object();
        let asleep = fields.and_then(|f| f.get("kind")).and_then(Value::as_str) == Some("asleep");
        let wake = fields
            .and_then(|f| f.get("wake"))
            .and_then(Value::as_str)
            .filter(|w| adopt_kind(w).is_some_and(|(kind, _)| kind == "restore"));
        TabPage {
            kind: if asleep {
                PageKind::Asleep
            } else {
                PageKind::Idle
            },
            wake: wake.map(str::to_owned),
        }
    }

    pub fn saved(&self, incognito: bool) -> Value {
        let mut out = Fields::new();
        let asleep = matches!(self.kind, PageKind::Asleep | PageKind::Frozen { .. });
        out.insert("kind".into(), if asleep { "asleep" } else { "idle" }.into());
        if let Some(wake) = self
            .wake
            .as_deref()
            .filter(|w| !incognito && adopt_kind(w).is_some_and(|(kind, _)| kind == "restore"))
        {
            out.insert("wake".into(), wake.into());
        }
        Value::Object(out)
    }
}

pub fn page_from_disk<'de, D: Deserializer<'de>>(deserializer: D) -> Result<TabPage, D::Error> {
    let value = Value::deserialize(deserializer)?;
    Ok(TabPage::from_value(&value))
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LiveItem {
    pub folder_id: String,
    pub item_id: String,
    #[serde(
        default,
        skip_serializing_if = "json::is_false",
        serialize_with = "json::serialize_true",
        deserialize_with = "json::true_flag"
    )]
    pub completed: bool,
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn frames_round_trip_as_four_numbers() {
        let frame: Frame = serde_json::from_value(json!([0, 90, 1512, 859])).unwrap();
        assert_eq!(frame, Frame::new(0.0, 90.0, 1512.0, 859.0));
        assert_eq!(serde_json::to_string(&frame).unwrap(), "[0,90,1512,859]");
        assert!(serde_json::from_value::<Frame>(json!([0, 1, 2])).is_err());
        assert!(serde_json::from_value::<Frame>(json!("x")).is_err());
        assert!(!Frame::new(0.0, 0.0, 0.0, 10.0).is_valid());
    }

    #[test]
    fn pins_read_every_saved_shape() {
        assert_eq!(TabPin::from_value(&json!({"as": "row"})), Some(TabPin::Row));
        assert_eq!(
            TabPin::from_value(&json!({"as": "tile"})),
            Some(TabPin::TILE)
        );
        let folder = TabPin::from_value(
            &json!({"as": "tile", "folder": {"id": "f", "name": "Work", "renamedAt": 5}}),
        )
        .unwrap();
        assert_eq!(folder.folder().unwrap().renamed_at, Some(5));
        assert_eq!(TabPin::from_value(&json!({"as": "dock"})), None);
        assert_eq!(TabPin::from_value(&json!(null)), None);
        assert_eq!(
            serde_json::to_value(&folder).unwrap(),
            json!({"as": "tile", "folder": {"id": "f", "name": "Work", "renamedAt": 5}})
        );
    }

    #[test]
    fn pages_keep_only_restore_wakes() {
        let page = TabPage::from_value(&json!({"kind": "asleep", "wake": "restore:tab-1"}));
        assert_eq!(page.kind, PageKind::Asleep);
        assert_eq!(page.pending_restore(), Some("tab-1"));
        assert_eq!(
            TabPage::from_value(&json!({"kind": "idle", "wake": "clone:tab-1"})).wake,
            None
        );
        assert_eq!(
            TabPage::from_value(&json!({"kind": "loaded"})).kind,
            PageKind::Idle
        );
        assert_eq!(
            page.saved(false),
            json!({"kind": "asleep", "wake": "restore:tab-1"})
        );
        assert_eq!(page.saved(true), json!({"kind": "asleep"}));
        let frozen = TabPage {
            kind: PageKind::Frozen {
                holder: TabId::new("t"),
            },
            wake: None,
        };
        assert_eq!(frozen.saved(false), json!({"kind": "asleep"}));
        assert_eq!(TabPage::LOADED.saved(false), json!({"kind": "idle"}));
    }

    #[test]
    fn layouts_and_enums_use_the_shell_keys() {
        assert_eq!(
            EffectiveLayout::of(TabLayout::Sidebar, true),
            EffectiveLayout::ArcSidebar
        );
        assert_eq!(
            EffectiveLayout::of(TabLayout::Top, true),
            EffectiveLayout::TopStrip
        );
        assert_eq!(
            serde_json::to_string(&PageEngine::Webkit).unwrap(),
            "\"webkit\""
        );
        assert!(serde_json::from_str::<TabLayout>("\"strip\"").is_err());
        assert_eq!(adopt_kind("restore:tab:1"), Some(("restore", "tab:1")));
        assert_eq!(adopt_kind("bogus:1"), None);
    }
}
