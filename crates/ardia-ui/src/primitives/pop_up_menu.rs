use std::sync::Arc;

use gpui::{App, ClickEvent, SharedString, Window};

use crate::host::{NativeMenuItem, UiHost};
use crate::msg::{Emit, Msg};

#[derive(Clone, Debug, PartialEq)]
pub struct PopUpChoice {
    pub value: Option<SharedString>,
    pub title: SharedString,
    pub checked: bool,
    pub separator_before: bool,
    pub enabled: bool,
    pub msgs: Vec<Msg>,
}

impl PopUpChoice {
    pub fn new(title: impl Into<SharedString>, checked: bool, msgs: Vec<Msg>) -> Self {
        PopUpChoice {
            value: None,
            title: title.into(),
            checked,
            separator_before: false,
            enabled: true,
            msgs,
        }
    }

    pub fn value(mut self, value: impl Into<SharedString>) -> Self {
        self.value = Some(value.into()).filter(|value| !value.is_empty());
        self
    }

    pub fn enabled(mut self, enabled: bool) -> Self {
        self.enabled = enabled;
        self
    }

    pub fn separated(mut self, separator_before: bool) -> Self {
        self.separator_before = separator_before;
        self
    }
}

pub fn menu_ids(choices: &[PopUpChoice]) -> Vec<String> {
    let values: Vec<Option<&str>> = choices
        .iter()
        .map(|choice| choice.value.as_deref())
        .collect();
    let unique = values.iter().all(Option::is_some)
        && values
            .iter()
            .collect::<std::collections::HashSet<_>>()
            .len()
            == values.len();
    values
        .iter()
        .enumerate()
        .map(|(index, value)| match (unique, value) {
            (true, Some(value)) => (*value).to_owned(),
            _ => index.to_string(),
        })
        .collect()
}

pub fn native_items(choices: &[PopUpChoice]) -> Vec<NativeMenuItem> {
    let ids = menu_ids(choices);
    let mut items = Vec::new();
    for (index, (choice, id)) in choices.iter().zip(&ids).enumerate() {
        if choice.separator_before && index > 0 {
            items.push(NativeMenuItem::separator());
        }
        items.push(
            NativeMenuItem::new(id, choice.title.to_string(), "")
                .checked(choice.checked)
                .enabled(choice.enabled),
        );
    }
    items
}

pub fn picked_index(id: &str, ids: &[String]) -> Option<usize> {
    ids.iter().position(|known| known == id)
}

pub fn show_native(
    host: &Arc<dyn UiHost>,
    choices: &[PopUpChoice],
    window: &mut Window,
    cx: &mut App,
    picked: impl FnOnce(usize, &mut Window, &mut App) + 'static,
) -> bool {
    let items = native_items(choices);
    let ids = menu_ids(choices);
    let Some(reply) = host.show_menu(items) else {
        return false;
    };
    window
        .spawn(cx, async move |cx| {
            let Ok(Some(id)) = reply.await else {
                return;
            };
            let Some(index) = picked_index(&id, &ids) else {
                return;
            };
            let _ = cx.update(|window, cx| picked(index, window, cx));
        })
        .detach();
    true
}

pub fn show_choices(
    host: &Arc<dyn UiHost>,
    emit: &Emit,
    choices: &[PopUpChoice],
    window: &mut Window,
    cx: &mut App,
) -> bool {
    let picks: Vec<Option<Vec<Msg>>> = choices
        .iter()
        .map(|choice| (!choice.checked && choice.enabled).then(|| choice.msgs.clone()))
        .collect();
    let emit = emit.clone();
    show_native(host, choices, window, cx, move |index, window, cx| {
        for msg in picks.into_iter().nth(index).flatten().unwrap_or_default() {
            emit.send(msg, window, cx);
        }
    })
}

pub fn opener(
    host: &Arc<dyn UiHost>,
    emit: &Emit,
    choices: Vec<PopUpChoice>,
    fallback: Msg,
) -> impl Fn(&ClickEvent, &mut Window, &mut App) + 'static {
    let host = Arc::clone(host);
    let emit = emit.clone();
    move |_, window, cx| {
        if !show_choices(&host, &emit, &choices, window, cx) {
            emit.send(fallback.clone(), window, cx);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn items_are_numbered_with_separators_and_states() {
        let items = native_items(&[
            PopUpChoice::new("Full", true, Vec::new()),
            PopUpChoice::new("Soft", false, Vec::new()).separated(true),
            PopUpChoice::new("Off", false, Vec::new()).enabled(false),
        ]);
        let shape: Vec<(String, String, bool, bool)> = items
            .iter()
            .map(|item| {
                (
                    item.id.clone(),
                    item.title.clone(),
                    item.checked,
                    item.enabled,
                )
            })
            .collect();
        assert_eq!(
            shape,
            vec![
                ("0".into(), "Full".into(), true, true),
                (String::new(), String::new(), false, false),
                ("1".into(), "Soft".into(), false, true),
                ("2".into(), "Off".into(), false, false),
            ]
        );
    }

    #[test]
    fn a_leading_separator_is_dropped() {
        let items = native_items(&[PopUpChoice::new("Only", false, Vec::new()).separated(true)]);
        assert_eq!(items.len(), 1);
        assert!(!items[0].separator);
    }

    #[test]
    fn picks_outside_the_list_are_ignored() {
        let ids = vec!["0".to_owned(), "1".to_owned(), "2".to_owned()];
        assert_eq!(picked_index("1", &ids), Some(1));
        assert_eq!(picked_index("3", &ids), None);
        assert_eq!(picked_index("x", &ids), None);
    }

    #[test]
    fn values_name_the_items_like_the_old_menu_when_they_are_unique() {
        let keyed = [
            PopUpChoice::new("Full", true, Vec::new()).value("full"),
            PopUpChoice::new("Soft", false, Vec::new()).value("soft"),
        ];
        assert_eq!(menu_ids(&keyed), ["full", "soft"]);
        let clashing = [
            PopUpChoice::new("A", false, Vec::new()).value("same"),
            PopUpChoice::new("B", false, Vec::new()).value("same"),
        ];
        assert_eq!(menu_ids(&clashing), ["0", "1"]);
        let partial = [
            PopUpChoice::new("A", false, Vec::new()).value("a"),
            PopUpChoice::new("B", false, Vec::new()),
        ];
        assert_eq!(menu_ids(&partial), ["0", "1"]);
    }
}
