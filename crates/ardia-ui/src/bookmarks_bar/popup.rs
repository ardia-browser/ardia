use std::rc::Rc;

use crate::scale::px;
use ardia_theme::tokens::space;
use gpui::{
    AnyElement, App, IntoElement, ParentElement, Pixels, Point, Styled, Window, anchored, deferred,
    div, prelude::*,
};

use crate::host::NativeMenuItem;
use crate::look::Palette;
use crate::primitives::controls::{MenuRow, popover, separator};
use crate::primitives::icons::Icon;

pub const MENU_WIDTH: f32 = 240.0;

pub type OnChoice = Rc<dyn Fn(String, &mut Window, &mut App)>;
pub type OnClose = Rc<dyn Fn(&mut App)>;
pub type OnToggle = Rc<dyn Fn(&mut App)>;

pub fn glyph_for(symbol: Option<&str>) -> Option<Icon> {
    Some(match symbol? {
        "plus.app" => Icon::Plus,
        "rectangle.split.2x1" => Icon::Split,
        "macwindow" | "macwindow.badge.plus" => Icon::Window,
        "eyeglasses" => Icon::Incognito,
        "folder" | "folder.badge.plus" => Icon::Folder,
        "link" => Icon::Link,
        "pencil" => Icon::Reader,
        "trash" => Icon::Trash,
        "sidebar.left" => Icon::SidebarLeft,
        "arrow.uturn.backward" => Icon::Undo,
        "bookmark" => Icon::Bookmark,
        "book" => Icon::Bookmark,
        "square.and.arrow.down" => Icon::Import,
        "square.and.arrow.up" => Icon::Share,
        _ => return None,
    })
}

pub fn visible(items: &[NativeMenuItem], alternate: bool) -> Vec<&NativeMenuItem> {
    let mut out: Vec<&NativeMenuItem> = Vec::new();
    for item in items {
        if item.alternate {
            if alternate && let Some(last) = out.last_mut() {
                *last = item;
            }
            continue;
        }
        out.push(item);
    }
    out
}

#[allow(clippy::too_many_arguments)]
pub fn render(
    id: &'static str,
    items: &[NativeMenuItem],
    at: Point<Pixels>,
    glass: bool,
    p: &Palette,
    alternate: bool,
    expanded: bool,
    on_choice: OnChoice,
    on_close: OnClose,
    on_toggle: OnToggle,
) -> AnyElement {
    let p = *p;
    let mut rows: Vec<AnyElement> = Vec::new();
    for (index, item) in visible(items, alternate).into_iter().enumerate() {
        if item.separator {
            rows.push(separator(&p).into_any_element());
            continue;
        }
        rows.push(row(item, index, false, &p, &on_choice, &on_toggle));
        if !item.children.is_empty() && expanded {
            for (child, entry) in item.children.iter().enumerate() {
                rows.push(row(
                    entry,
                    100 + index * 10 + child,
                    true,
                    &p,
                    &on_choice,
                    &on_toggle,
                ));
            }
        }
    }
    let close = on_close.clone();
    deferred(
        anchored()
            .position(at)
            .snap_to_window_with_margin(px(8.))
            .child(
                popover(id, glass, MENU_WIDTH, &p)
                    .debug_selector(move || id.into())
                    .on_mouse_down_out(move |_, _, cx| close(cx))
                    .on_modifiers_changed(|_, window, _| window.refresh())
                    .children(rows),
            ),
    )
    .with_priority(6)
    .into_any_element()
}

fn row(
    item: &NativeMenuItem,
    index: usize,
    nested: bool,
    p: &Palette,
    on_choice: &OnChoice,
    on_toggle: &OnToggle,
) -> AnyElement {
    let choice = item.id.clone();
    let parent = !item.children.is_empty();
    let run = on_choice.clone();
    let toggle = on_toggle.clone();
    let mut menu_row = MenuRow::new(("bookmark-popup-row", index), item.title.clone(), p)
        .disabled(!item.enabled)
        .checked(item.checked)
        .on_click(move |_, window, cx| {
            if parent {
                toggle(cx);
            } else {
                run(choice.clone(), window, cx);
            }
        });
    if let Some(glyph) = glyph_for(item.symbol.as_deref()) {
        menu_row = menu_row.icon(glyph);
    }
    if parent {
        menu_row = menu_row.trailing("›");
    }
    let selector = format!("bookmark-menu:{}", item.title);
    div()
        .debug_selector(move || selector)
        .when(nested, |this| this.pl(px(space::XL)))
        .child(menu_row)
        .into_any_element()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn option_swaps_in_the_alternate_item() {
        let items = super::super::native::copy_link_items(1);
        let plain: Vec<&str> = visible(&items, false)
            .iter()
            .map(|i| i.title.as_str())
            .collect();
        assert_eq!(plain, ["Copy Link"]);
        let held: Vec<&str> = visible(&items, true)
            .iter()
            .map(|i| i.title.as_str())
            .collect();
        assert_eq!(held, ["Copy Link as Markdown"]);
    }
}
