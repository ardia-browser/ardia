use ardia_state::TabId;
use ardia_state::tabs::Tab;
use gpui::{AnyElement, IntoElement, ParentElement, Styled, div};

pub const RETIRING_SUFFIX: &str = "#retiring";

pub fn retiring_slot(tab: &TabId) -> TabId {
    TabId::new(format!("{tab}{RETIRING_SUFFIX}"))
}

pub fn shows_retiring(tab: &Tab, new_tab_shown: bool) -> bool {
    !new_tab_shown
        && !crate::content::toolbar::is_new_tab_page(Some(tab))
        && crate::pages::InternalPage::of(&tab.url).is_none()
}

pub fn retiring_swap(live: AnyElement, old: AnyElement, old_above: bool) -> AnyElement {
    let arriving = div().absolute().inset_0().opacity(0.).child(live);
    let retired = div().absolute().inset_0().child(old);
    let stack = div().relative().size_full();
    if old_above {
        stack.child(arriving).child(retired).into_any_element()
    } else {
        stack.child(retired).child(arriving).into_any_element()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn retiring_slots_never_collide_with_real_tabs() {
        let tab = TabId::new("tab-1");
        let slot = retiring_slot(&tab);
        assert_ne!(slot, tab);
        assert_eq!(slot.as_str().strip_suffix(RETIRING_SUFFIX), Some("tab-1"));
    }

    fn tab_at(url: &str, peek: bool) -> Tab {
        let mut tab: Tab = serde_json::from_value(serde_json::json!({
            "id": "tab-1",
            "windowId": "w-1",
            "profileId": "default",
            "url": url,
        }))
        .expect("tab");
        tab.live.peek = peek;
        tab
    }

    #[test]
    fn the_old_page_shows_wherever_the_web_view_is_visible() {
        assert!(shows_retiring(
            &tab_at("https://example.com/", false),
            false
        ));
        assert!(shows_retiring(&tab_at("https://example.com/", true), false));
        assert!(!shows_retiring(
            &tab_at("https://example.com/", false),
            true
        ));
        assert!(!shows_retiring(&tab_at("", false), false));
        assert!(!shows_retiring(&tab_at("ardia://newtab", false), false));
        assert!(!shows_retiring(&tab_at("ardia://history", false), false));
    }
}
