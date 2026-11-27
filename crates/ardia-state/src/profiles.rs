use crate::ids::{DEFAULT_PROFILE_ID, ProfileId};
use crate::json::{self, Fields};
use crate::model::Millis;
use ardia_theme::{ProfileColor, ProfileLook, ProfileTheme};
use indexmap::IndexMap;
use serde::{Deserialize, Deserializer, Serialize, Serializer};
use serde_json::Value;
use std::sync::Arc;

#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub enum ColorChoice {
    Preset(ProfileColor),
    Other(String),
}

impl ColorChoice {
    pub fn preset(&self) -> ProfileColor {
        match self {
            ColorChoice::Preset(color) => *color,
            ColorChoice::Other(_) => ProfileColor::Plum,
        }
    }

    pub fn key(&self) -> &str {
        match self {
            ColorChoice::Preset(color) => color.key(),
            ColorChoice::Other(raw) => raw,
        }
    }
}

impl Default for ColorChoice {
    fn default() -> Self {
        ColorChoice::Preset(ProfileColor::Plum)
    }
}

impl From<ProfileColor> for ColorChoice {
    fn from(color: ProfileColor) -> Self {
        ColorChoice::Preset(color)
    }
}

impl Serialize for ColorChoice {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(self.key())
    }
}

impl<'de> Deserialize<'de> for ColorChoice {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let text = String::deserialize(deserializer)?;
        Ok(ProfileColor::from_key(&text).map_or(ColorChoice::Other(text), ColorChoice::Preset))
    }
}

fn lenient_theme<'de, D: Deserializer<'de>>(
    deserializer: D,
) -> Result<Option<Arc<ProfileTheme>>, D::Error> {
    let value = Value::deserialize(deserializer)?;
    Ok(ProfileTheme::sanitize(&value).map(Arc::new))
}

fn lenient_presets<'de, D: Deserializer<'de>>(
    deserializer: D,
) -> Result<Option<IndexMap<String, Arc<ProfileTheme>>>, D::Error> {
    let value = Value::deserialize(deserializer)?;
    let Some(fields) = value.as_object() else {
        return Ok(None);
    };
    Ok(Some(
        fields
            .iter()
            .filter_map(|(key, theme)| {
                Some((key.clone(), Arc::new(ProfileTheme::sanitize(theme)?)))
            })
            .collect(),
    ))
}

fn lenient_color<'de, D: Deserializer<'de>>(deserializer: D) -> Result<ColorChoice, D::Error> {
    let value = Value::deserialize(deserializer)?;
    Ok(value.as_str().map_or_else(ColorChoice::default, |text| {
        ProfileColor::from_key(text)
            .map_or_else(|| ColorChoice::Other(text.to_owned()), ColorChoice::Preset)
    }))
}

fn lenient_seen_color<'de, D: Deserializer<'de>>(
    deserializer: D,
) -> Result<Option<ColorChoice>, D::Error> {
    let value = Value::deserialize(deserializer)?;
    Ok(value.as_str().map(|text| {
        ProfileColor::from_key(text)
            .map_or_else(|| ColorChoice::Other(text.to_owned()), ColorChoice::Preset)
    }))
}

fn present_theme<'de, D: Deserializer<'de>>(
    deserializer: D,
) -> Result<Option<Option<Arc<ProfileTheme>>>, D::Error> {
    let value = Value::deserialize(deserializer)?;
    Ok(Some(ProfileTheme::sanitize(&value).map(Arc::new)))
}

fn serialize_theme<S: Serializer>(
    theme: &Option<Arc<ProfileTheme>>,
    serializer: S,
) -> Result<S::Ok, S::Error> {
    match theme {
        Some(theme) => theme.serialize(serializer),
        None => serializer.serialize_unit(),
    }
}

#[expect(
    clippy::trivially_copy_pass_by_ref,
    reason = "serde serialize_with hands the field over by reference"
)]
fn serialize_cleared_theme<S: Serializer>(_: &bool, serializer: S) -> Result<S::Ok, S::Error> {
    serializer.serialize_unit()
}

fn serialize_seen_theme<S: Serializer>(
    theme: &Option<Option<Arc<ProfileTheme>>>,
    serializer: S,
) -> Result<S::Ok, S::Error> {
    serialize_theme(theme.as_ref().unwrap_or(&None), serializer)
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Profile {
    pub id: ProfileId,
    #[serde(deserialize_with = "json::lenient", default)]
    pub name: String,
    #[serde(deserialize_with = "lenient_color", default)]
    pub color: ColorChoice,
    #[serde(deserialize_with = "json::lenient", default)]
    pub icon: Option<String>,
    #[serde(
        default,
        skip_serializing_if = "json::is_false",
        serialize_with = "json::serialize_true",
        deserialize_with = "json::true_flag"
    )]
    pub switcher_dot: bool,
    #[serde(deserialize_with = "json::millis", default)]
    pub created_at: Millis,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "json::lenient"
    )]
    pub data_id: Option<String>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        serialize_with = "serialize_theme",
        deserialize_with = "lenient_theme"
    )]
    pub theme: Option<Arc<ProfileTheme>>,
    #[serde(
        rename = "theme",
        skip_deserializing,
        skip_serializing_if = "json::is_false",
        serialize_with = "serialize_cleared_theme"
    )]
    pub theme_cleared: bool,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "lenient_presets"
    )]
    pub preset_themes: Option<IndexMap<String, Arc<ProfileTheme>>>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        serialize_with = "serialize_seen_theme",
        deserialize_with = "present_theme"
    )]
    pub seen_theme: Option<Option<Arc<ProfileTheme>>>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "lenient_seen_color"
    )]
    pub seen_color: Option<ColorChoice>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "json::lenient"
    )]
    pub pinned_collapsed: Option<bool>,
    #[serde(
        default,
        skip_serializing_if = "json::is_false",
        serialize_with = "json::serialize_true",
        deserialize_with = "json::true_flag"
    )]
    pub share_top_apps: bool,
    #[serde(
        default,
        skip_serializing_if = "json::is_false",
        serialize_with = "json::serialize_true",
        deserialize_with = "json::true_flag"
    )]
    pub sync_tabs: bool,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "json::lenient"
    )]
    pub password_manager: Option<String>,
    #[serde(flatten)]
    pub extra: Fields,
}

impl Profile {
    pub fn new(
        id: ProfileId,
        name: impl Into<String>,
        color: ProfileColor,
        created_at: Millis,
    ) -> Self {
        Profile {
            id,
            name: name.into(),
            color: ColorChoice::Preset(color),
            icon: None,
            switcher_dot: false,
            created_at,
            data_id: None,
            theme: None,
            theme_cleared: false,
            preset_themes: Some(IndexMap::new()),
            seen_theme: Some(None),
            seen_color: Some(ColorChoice::Preset(color)),
            pinned_collapsed: None,
            share_top_apps: false,
            sync_tabs: false,
            password_manager: None,
            extra: Fields::new(),
        }
    }

    pub fn default_profile() -> Self {
        Profile::new(
            ProfileId::new(DEFAULT_PROFILE_ID),
            "Personal",
            ProfileColor::Plum,
            0,
        )
    }

    pub fn look(&self) -> ProfileLook<'_> {
        ProfileLook {
            color: self.color.preset(),
            theme: self.theme.as_deref(),
        }
    }

    pub fn engine_profile(&self) -> String {
        let id = self.data_id.as_deref().unwrap_or(self.id.as_str());
        if id == DEFAULT_PROFILE_ID {
            String::new()
        } else {
            id.to_owned()
        }
    }

    pub fn switcher_icon(&self) -> Option<&str> {
        if self.switcher_dot {
            None
        } else {
            self.icon.as_deref()
        }
    }

    pub fn with_own_looks_seeded(mut self) -> Self {
        let shown = self.theme.clone();
        let key = self.color.key().to_owned();
        let Some(presets) = self.preset_themes.as_mut() else {
            self.preset_themes = Some(
                shown
                    .iter()
                    .map(|theme| (key.clone(), Arc::clone(theme)))
                    .collect(),
            );
            self.seen_theme = Some(shown);
            self.seen_color = Some(self.color.clone());
            return self;
        };
        let Some(seen) = &self.seen_theme else {
            return self;
        };
        if *seen == shown {
            return self;
        }
        let picked_elsewhere = shown.is_none()
            && self
                .seen_color
                .as_ref()
                .is_some_and(|color| *color != self.color);
        if !picked_elsewhere {
            presets.shift_remove(&key);
            if let Some(theme) = &shown {
                presets.insert(key, Arc::clone(theme));
            }
        }
        self.seen_theme = Some(shown);
        self.seen_color = Some(self.color.clone());
        self
    }

    pub fn with_legacy_dots(mut self, legacy_icons_shown: Option<bool>) -> Self {
        if legacy_icons_shown == Some(false) && self.icon.is_some() {
            self.switcher_dot = true;
        }
        self
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn real_profile() -> Value {
        json!({
            "color": "plum", "createdAt": 1795539679330u64, "icon": null, "id": "p-mwur3ykub40s-av", "name": "Work",
            "presetThemes": {"plum": {"grain": 0, "intensity": 0.6, "mode": "auto", "texture": "grain", "translucency": 1,
                "stops": [{"color": {"a": 1, "b": 0.596, "g": 0.478, "r": 0.753}, "x": 0.66, "y": 0.42}]}},
            "seenColor": "plum", "seenTheme": null, "syncTabs": true, "pinnedCollapsed": false, "futureField": {"x": 1}
        })
    }

    #[test]
    fn real_profile_rows_round_trip_with_unknown_fields() {
        let profile: Profile = serde_json::from_value(real_profile()).unwrap();
        assert_eq!(profile.color.preset(), ProfileColor::Plum);
        assert!(profile.sync_tabs);
        assert_eq!(profile.preset_themes.as_ref().map(IndexMap::len), Some(1));
        assert_eq!(profile.extra.get("futureField"), Some(&json!({"x": 1})));
        let out = serde_json::to_value(&profile).unwrap();
        assert_eq!(out["futureField"], json!({"x": 1}));
        assert_eq!(out["seenTheme"], Value::Null);
        assert_eq!(out["syncTabs"], json!(true));
        assert!(out.get("shareTopApps").is_none());
        assert_eq!(out["createdAt"], json!(1795539679330u64));
    }

    #[test]
    fn unknown_colors_survive_and_render_as_plum() {
        let profile: Profile =
            serde_json::from_value(json!({"id": "p", "name": "x", "color": "teal"})).unwrap();
        assert_eq!(profile.color, ColorChoice::Other("teal".into()));
        assert_eq!(profile.color.preset(), ProfileColor::Plum);
        assert_eq!(
            serde_json::to_value(&profile).unwrap()["color"],
            json!("teal")
        );
        let bad: Profile = serde_json::from_value(
            json!({"id": "p", "name": 3, "color": 9, "theme": {"stops": "no"}}),
        )
        .unwrap();
        assert_eq!(
            (bad.name.as_str(), bad.color.preset(), bad.theme.is_none()),
            ("", ProfileColor::Plum, true)
        );
    }

    fn theme_value(r: f64) -> Value {
        json!({"stops": [{"color": {"r": r, "g": 0.2, "b": 0.3}, "x": 0.5, "y": 0.5}]})
    }

    #[test]
    fn seeding_adds_preset_themes_once() {
        let fresh: Profile =
            serde_json::from_value(json!({"id": "p", "name": "x", "color": "blue"})).unwrap();
        assert_eq!(fresh.seen_theme, None);
        let seeded = fresh.with_own_looks_seeded();
        assert_eq!(seeded.preset_themes, Some(IndexMap::new()));
        assert_eq!(
            seeded.seen_color,
            Some(ColorChoice::Preset(ProfileColor::Blue))
        );
        assert_eq!(seeded.seen_theme, Some(None));
        assert_eq!(seeded.clone().with_own_looks_seeded(), seeded);
        let themed: Profile = serde_json::from_value(
            json!({"id": "p", "name": "x", "color": "red", "theme": theme_value(0.9)}),
        )
        .unwrap();
        let seeded = themed.with_own_looks_seeded();
        assert!(seeded.preset_themes.as_ref().unwrap().contains_key("red"));
    }

    #[test]
    fn a_changed_theme_replaces_the_preset_it_was_seen_with() {
        let edited: Profile = serde_json::from_value(json!({
            "id": "p", "name": "x", "color": "red", "theme": theme_value(0.1),
            "presetThemes": {"red": theme_value(0.9), "blue": theme_value(0.5)}, "seenTheme": theme_value(0.9), "seenColor": "red"
        }))
        .unwrap();
        let seeded = edited.with_own_looks_seeded();
        let presets = seeded.preset_themes.as_ref().unwrap();
        assert_eq!(presets.keys().collect::<Vec<_>>(), vec!["blue", "red"]);
        assert_eq!(presets["red"].look.stops[0].color.r, 0.1);
        assert_eq!(seeded.seen_theme, Some(seeded.theme.clone()));
        let absent: Profile = serde_json::from_value(
            json!({"id": "p", "name": "x", "color": "red", "presetThemes": {}}),
        )
        .unwrap();
        assert_eq!(absent.clone().with_own_looks_seeded(), absent);
        assert!(
            serde_json::to_value(&absent)
                .unwrap()
                .get("seenTheme")
                .is_none()
        );
    }

    #[test]
    fn engine_profile_maps_default_to_the_unnamed_profile() {
        assert_eq!(Profile::default_profile().engine_profile(), "");
        let mut p = Profile::new(ProfileId::new("p-1"), "Work", ProfileColor::Green, 1);
        assert_eq!(p.engine_profile(), "p-1");
        p.data_id = Some("data-2".into());
        assert_eq!(p.engine_profile(), "data-2");
        p.icon = Some("💼".into());
        assert_eq!(
            p.clone().with_legacy_dots(Some(false)).switcher_icon(),
            None
        );
        assert_eq!(p.with_legacy_dots(Some(true)).switcher_icon(), Some("💼"));
    }
}
