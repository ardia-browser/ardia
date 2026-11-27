use ardia_state::model::EffectiveLayout;
use ardia_theme::layout::{PageFrame, lights, sidebar, tab_strip, toolbar};

pub const ARC_FIELD_ROW: f32 = 34.0;
pub const ARC_FIELD_GAP: f32 = 6.0;
pub const PEEK_OVERRUN: f32 = 16.0;
pub const RESIZE_HANDLE: f32 = 8.0;
pub const WINDOW_CORNER_RADIUS: f32 = 17.5;

#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct Rect {
    pub x: f32,
    pub y: f32,
    pub w: f32,
    pub h: f32,
}

impl Rect {
    pub const fn new(x: f32, y: f32, w: f32, h: f32) -> Self {
        Rect { x, y, w, h }
    }

    pub fn right(&self) -> f32 {
        self.x + self.w
    }

    pub fn bottom(&self) -> f32 {
        self.y + self.h
    }

    pub fn contains(&self, x: f32, y: f32) -> bool {
        x >= self.x && x < self.right() && y >= self.y && y < self.bottom()
    }
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct LayoutInput {
    pub width: f32,
    pub height: f32,
    pub layout: EffectiveLayout,
    pub inset: f32,
    pub sidebar_width: f32,
    pub trailing: bool,
    pub dock: f32,
    pub peek: f32,
    pub compact: bool,
    pub full_screen: bool,
    pub page_full_screen: bool,
    pub has_sidebar: bool,
    pub field_hidden: bool,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct ChromeLayout {
    pub layout: EffectiveLayout,
    pub width: f32,
    pub height: f32,
    pub frame: PageFrame,
    pub sidebar: Option<Rect>,
    pub sidebar_width: f32,
    pub trailing: bool,
    pub sidebar_field: bool,
    pub header: f32,
    pub first_row_top: f32,
    pub card: Rect,
    pub toolbar: f32,
    pub strip: Option<Rect>,
    pub lights: Option<[f32; 2]>,
    pub peek: Option<Rect>,
    pub edge_band: f32,
    pub resize: Option<Rect>,
}

impl ChromeLayout {
    pub fn page(&self) -> Rect {
        Rect::new(
            self.card.x,
            self.card.y + self.toolbar,
            self.card.w,
            (self.card.h - self.toolbar).max(0.0),
        )
    }

    pub fn sidebar_shows_address(&self) -> bool {
        self.layout == EffectiveLayout::ArcSidebar
    }
}

fn ease(value: f32) -> f32 {
    value.clamp(0.0, 1.0)
}

pub fn chrome_layout(input: LayoutInput) -> ChromeLayout {
    if !input.page_full_screen {
        return docked_layout(input);
    }
    let mut out = docked_layout(LayoutInput {
        inset: 0.0,
        dock: 0.0,
        page_full_screen: false,
        ..input
    });
    out.card = Rect::new(0.0, 0.0, out.width, out.height);
    out.toolbar = 0.0;
    out.strip = None;
    out.sidebar = None;
    out.resize = None;
    out.lights = None;
    out
}

fn docked_layout(input: LayoutInput) -> ChromeLayout {
    let width = input.width.max(1.0);
    let height = input.height.max(1.0);
    let frame = PageFrame::concentric(input.inset, WINDOW_CORNER_RADIUS, WINDOW_CORNER_RADIUS);
    let inset = frame.inset;
    let row = toolbar::row(input.compact);
    let sidebar_width = input.sidebar_width.max(0.0);
    let arc = input.layout == EffectiveLayout::ArcSidebar;
    let sidebar_field = arc && !input.field_hidden;
    let lights_y = lights::center(inset, input.compact)[1];
    let header = if arc {
        sidebar::HEADER
    } else {
        sidebar::header_of(false, lights_y)
    };
    let first_row_top = if sidebar_field {
        sidebar::first_row_top(true, lights_y) + ARC_FIELD_ROW + ARC_FIELD_GAP
            - (sidebar::PINNED_TOP - sidebar::HEADER)
    } else if arc {
        sidebar::first_row_top(true, lights_y)
    } else {
        sidebar::first_row_top(false, lights_y)
    };
    if input.layout == EffectiveLayout::TopStrip || !input.has_sidebar {
        let top = if input.layout == EffectiveLayout::TopStrip && input.has_sidebar {
            tab_strip::CARD_TOP
        } else {
            inset
        };
        let card = Rect::new(inset, top, width - 2.0 * inset, height - top - inset);
        let strip = (input.layout == EffectiveLayout::TopStrip && input.has_sidebar)
            .then(|| Rect::new(0.0, 0.0, width, tab_strip::CARD_TOP));
        return ChromeLayout {
            layout: input.layout,
            width,
            height,
            frame,
            sidebar: None,
            sidebar_width,
            trailing: false,
            sidebar_field,
            header,
            first_row_top,
            card,
            toolbar: row.height,
            strip,
            lights: strip
                .filter(|_| !input.full_screen)
                .map(|_| lights::TOP_STRIP_CENTER),
            peek: None,
            edge_band: frame.edge_watch_band(),
            resize: None,
        };
    }
    let dock = ease(input.dock);
    let peek = ease(input.peek);
    let docked_left = frame.card_left_at(dock, sidebar_width);
    let (card_x, card_right) = if input.trailing {
        (inset, width - docked_left)
    } else {
        (docked_left, width - inset)
    };
    let card = Rect::new(
        card_x,
        inset,
        (card_right - card_x).max(0.0),
        height - 2.0 * inset,
    );
    let offset = (1.0 - dock) * sidebar_width;
    let sidebar_rect = (dock > 0.0).then(|| {
        if input.trailing {
            Rect::new(width - sidebar_width + offset, 0.0, sidebar_width, height)
        } else {
            Rect::new(-offset, 0.0, sidebar_width, height)
        }
    });
    let lights_center = if arc {
        lights::ARC_CENTER
    } else {
        lights::center(inset, input.compact)
    };
    let cluster = 2.0 * lights::SPACING;
    let mut light_spot = sidebar_rect.map(|_| {
        if input.trailing {
            [
                width - lights_center[0] - cluster + offset,
                lights_center[1],
            ]
        } else {
            [lights_center[0] - offset, lights_center[1]]
        }
    });
    let peek_rect = (dock < 1.0 && peek > 0.0).then(|| {
        let gap = frame.peek;
        let travel = sidebar_width + gap.left + PEEK_OVERRUN;
        let shift = (1.0 - peek) * travel;
        let x = if input.trailing {
            width - gap.left - sidebar_width + shift
        } else {
            gap.left - shift
        };
        Rect::new(x, gap.top, sidebar_width, height - gap.top - gap.bottom)
    });
    if let Some(rect) = peek_rect
        && light_spot.is_none()
    {
        let rest = if input.trailing {
            width - frame.peek.left - sidebar_width
        } else {
            frame.peek.left
        };
        let moved = rect.x - rest;
        light_spot = Some(if input.trailing {
            [width - lights_center[0] - cluster + moved, lights_center[1]]
        } else {
            [lights_center[0] + moved, lights_center[1]]
        });
    }
    let resize = sidebar_rect.filter(|_| dock >= 1.0).map(|rect| {
        let edge = if input.trailing { rect.x } else { rect.right() };
        Rect::new(
            edge - RESIZE_HANDLE / 2.0,
            sidebar::HEADER,
            RESIZE_HANDLE,
            height - sidebar::HEADER,
        )
    });
    let visible_lights = light_spot.filter(|spot| {
        !input.full_screen && spot[0] > -lights::REACH && spot[0] < width + lights::REACH
    });
    ChromeLayout {
        layout: input.layout,
        width,
        height,
        frame,
        sidebar: sidebar_rect,
        sidebar_width,
        trailing: input.trailing,
        sidebar_field,
        header,
        first_row_top,
        card,
        toolbar: if arc { 0.0 } else { row.height },
        strip: None,
        lights: visible_lights,
        peek: peek_rect,
        edge_band: frame.edge_watch_band(),
        resize,
    }
}

pub fn little_ardia_layout(width: f32, height: f32, inset: f32) -> (Rect, [f32; 2]) {
    let bar = ardia_theme::layout::LITTLE_ARDIA_BAR_HEIGHT;
    (
        Rect::new(
            inset,
            bar,
            (width - 2.0 * inset).max(0.0),
            (height - bar - inset).max(0.0),
        ),
        lights::LITTLE_ARDIA_CENTER,
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn input(layout: EffectiveLayout, inset: f32) -> LayoutInput {
        LayoutInput {
            width: 1512.0,
            height: 949.0,
            layout,
            inset,
            sidebar_width: 190.0,
            trailing: false,
            dock: 1.0,
            peek: 0.0,
            compact: false,
            full_screen: false,
            page_full_screen: false,
            has_sidebar: true,
            field_hidden: false,
        }
    }

    #[test]
    fn the_docked_card_matches_the_measured_frames() {
        for (inset, left, radius) in [
            (0.0, 190.0, 0.0),
            (4.0, 190.0, 13.5),
            (5.0, 190.0, 12.5),
            (9.0, 190.0, 8.5),
            (12.0, 193.0, 5.5),
            (18.0, 199.0, 2.0),
        ] {
            let layout = chrome_layout(input(EffectiveLayout::Sidebar, inset));
            assert_eq!(layout.card.x, left, "{inset}");
            assert_eq!(layout.card.y, inset);
            assert_eq!(layout.card.right(), 1512.0 - inset);
            assert_eq!(layout.card.bottom(), 949.0 - inset);
            assert_eq!(layout.frame.radius, radius);
        }
        let layout = chrome_layout(input(EffectiveLayout::Sidebar, 9.0));
        assert_eq!(layout.toolbar, 41.0);
        assert_eq!(layout.header, 46.0);
        assert_eq!(layout.first_row_top, 54.0);
        assert_eq!(layout.lights, Some([25.0, 30.0]));
        assert_eq!(layout.sidebar, Some(Rect::new(0.0, 0.0, 190.0, 949.0)));
        assert!(layout.resize.is_some());
        assert_eq!(layout.page().y, 50.0);
    }

    #[test]
    fn a_hidden_sidebar_tucks_the_lights_and_widens_the_card() {
        let mut hidden = input(EffectiveLayout::Sidebar, 9.0);
        hidden.dock = 0.0;
        let layout = chrome_layout(hidden);
        assert_eq!(layout.card.x, 9.0);
        assert_eq!(layout.sidebar, None);
        assert_eq!(layout.lights, None);
        assert_eq!(layout.peek, None);
        hidden.peek = 1.0;
        let peeking = chrome_layout(hidden);
        let peek = peeking.peek.expect("a peek");
        assert_eq!((peek.x, peek.y, peek.w), (9.0, 9.0, 190.0));
        assert_eq!(peek.bottom(), 940.0);
        assert_eq!(peeking.lights, Some([25.0, 30.0]));
        assert_eq!(peeking.card.x, 9.0);
        hidden.peek = 0.5;
        let half = chrome_layout(hidden).peek.expect("a peek");
        assert!(half.x < 0.0);
    }

    #[test]
    fn the_top_strip_and_arc_layouts_place_the_card() {
        let strip = chrome_layout(input(EffectiveLayout::TopStrip, 9.0));
        assert_eq!(strip.card, Rect::new(9.0, 42.0, 1494.0, 898.0));
        assert_eq!(strip.lights, Some(lights::TOP_STRIP_CENTER));
        assert!(strip.strip.is_some() && strip.sidebar.is_none());
        let arc = chrome_layout(input(EffectiveLayout::ArcSidebar, 9.0));
        assert_eq!(arc.toolbar, 0.0);
        assert_eq!(arc.lights, Some(lights::ARC_CENTER));
        assert_eq!(arc.card.y, 9.0);
        assert!(arc.first_row_top > arc.header + ARC_FIELD_ROW);
        assert!(arc.sidebar_shows_address());
        assert!(arc.sidebar_field);
    }

    #[test]
    fn a_minimal_arc_sidebar_keeps_the_header_but_drops_the_field_row() {
        let minimal = chrome_layout(LayoutInput {
            field_hidden: true,
            ..input(EffectiveLayout::ArcSidebar, 0.0)
        });
        assert!(minimal.sidebar_shows_address());
        assert!(!minimal.sidebar_field);
        assert_eq!(minimal.toolbar, 0.0);
        assert_eq!(minimal.header, sidebar::HEADER);
        assert_eq!(minimal.first_row_top, sidebar::PINNED_TOP);
        assert_eq!(minimal.card.x, 190.0);
        let docked = chrome_layout(LayoutInput {
            field_hidden: true,
            ..input(EffectiveLayout::Sidebar, 9.0)
        });
        assert!(!docked.sidebar_field);
    }

    #[test]
    fn a_trailing_sidebar_mirrors_the_card() {
        let mut trailing = input(EffectiveLayout::Sidebar, 9.0);
        trailing.trailing = true;
        let layout = chrome_layout(trailing);
        assert_eq!(layout.card.x, 9.0);
        assert_eq!(layout.card.right(), 1512.0 - 190.0);
        assert_eq!(layout.sidebar.map(|s| s.x), Some(1322.0));
        assert_eq!(layout.lights, Some([1441.0, 30.0]));
        let zoom_center = 1441.0 + 2.0 * lights::SPACING;
        assert_eq!(zoom_center, 1512.0 - 25.0);
    }

    #[test]
    fn a_full_screen_page_fills_the_window_and_hides_the_chrome() {
        for layout in [
            EffectiveLayout::Sidebar,
            EffectiveLayout::ArcSidebar,
            EffectiveLayout::TopStrip,
        ] {
            let mut page = input(layout, 8.0);
            page.page_full_screen = true;
            let out = chrome_layout(page);
            assert_eq!(out.card, Rect::new(0.0, 0.0, 1512.0, 949.0));
            assert_eq!(out.page(), out.card);
            assert_eq!(out.toolbar, 0.0);
            assert_eq!(out.frame.radius, 0.0);
            assert!(out.sidebar.is_none() && out.strip.is_none() && out.resize.is_none());
            assert!(out.lights.is_none());
        }
    }

    #[test]
    fn the_sidebar_still_peeks_over_a_full_screen_page() {
        let mut page = input(EffectiveLayout::Sidebar, 8.0);
        page.page_full_screen = true;
        page.peek = 1.0;
        let out = chrome_layout(page);
        assert!(out.peek.is_some());
        assert_eq!(out.card, Rect::new(0.0, 0.0, 1512.0, 949.0));
    }

    #[test]
    fn full_screen_hides_the_lights() {
        let mut full = input(EffectiveLayout::Sidebar, 9.0);
        full.full_screen = true;
        assert_eq!(chrome_layout(full).lights, None);
    }

    #[test]
    fn little_ardia_sits_below_its_bar() {
        let (card, lights) = little_ardia_layout(900.0, 640.0, 9.0);
        assert_eq!(card, Rect::new(9.0, 38.0, 882.0, 593.0));
        assert_eq!(lights, [20.0, 19.0]);
    }
}
