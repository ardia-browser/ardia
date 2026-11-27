use crate::icon_picker::symbols::SymbolWeight;
pub use crate::primitives::symbol_glyphs::symbol_fit;
use crate::primitives::symbol_glyphs::{
    SymbolGlyph, SymbolRaster, drawn_symbol_name, fitted_symbol_glyph, glyph_bounds,
};
use crate::scale::px;
use std::time::Duration;

use gpui::{
    App, Bounds, Element, ElementId, GlobalElementId, Hsla, InspectorElementId, LayoutId, Pixels,
    SharedString, Style, TimedTransformation, Transformation, TransformationMatrix, Window, size,
};

macro_rules! glyph {
    ($body:literal) => {
        concat!(
            "<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 16 16\" fill=\"none\" stroke=\"#000\" stroke-width=\"1.4\" stroke-linecap=\"round\" stroke-linejoin=\"round\">",
            $body,
            "</svg>"
        )
    };
}

macro_rules! icons {
    ($($name:ident => $key:literal, $body:literal;)+) => {
        #[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
        pub enum Icon {
            $($name,)+
        }

        impl Icon {
            pub const ALL: &'static [Icon] = &[$(Icon::$name,)+];

            pub const fn key(self) -> &'static str {
                match self {
                    $(Icon::$name => concat!("ardia-icon:", $key),)+
                }
            }

            pub const fn svg(self) -> &'static str {
                match self {
                    $(Icon::$name => glyph!($body),)+
                }
            }
        }
    };
}

icons! {
    SidebarLeft => "sidebar.left", "<rect x=\"1.75\" y=\"2.75\" width=\"12.5\" height=\"10.5\" rx=\"2.5\"/><path d=\"M6 2.75v10.5M3.6 5.4h.9M3.6 7.4h.9\"/>";
    ChevronLeft => "chevron.left", "<path d=\"M10 2.75 4.75 8 10 13.25\"/>";
    ChevronRight => "chevron.right", "<path d=\"M6 2.75 11.25 8 6 13.25\"/>";
    ChevronDown => "chevron.down", "<path d=\"M3.25 5.75 8 10.5l4.75-4.75\"/>";
    ChevronUp => "chevron.up", "<path d=\"M3.25 10.25 8 5.5l4.75 4.75\"/>";
    Reload => "arrow.clockwise", "<path d=\"M13.5 8A5.5 5.5 0 1 1 8 2.5c1.54 0 3.02.62 4.12 1.68l1.38 1.32\"/><path d=\"M13.5 2.25V5.5h-3.25\"/>";
    XMark => "xmark", "<path d=\"M4 4l8 8M12 4l-8 8\"/>";
    Plus => "plus", "<path d=\"M8 3v10M3 8h10\"/>";
    Minus => "minus", "<path d=\"M3 8h10\"/>";
    ArrowDownCircle => "arrow.down.circle", "<circle cx=\"8\" cy=\"8\" r=\"6.25\"/><path d=\"M8 4.75v6.25M5.5 8.5 8 11l2.5-2.5\"/>";
    Lock => "lock", "<rect x=\"3.25\" y=\"7\" width=\"9.5\" height=\"7\" rx=\"1.75\"/><path d=\"M5.25 7V5a2.75 2.75 0 0 1 5.5 0v2\"/>";
    Shield => "shield", "<path d=\"M8 1.75 13 3.75v3.9c0 3.15-2.1 5.6-5 6.6-2.9-1-5-3.45-5-6.6v-3.9Z\"/>";
    Bookmark => "bookmark", "<path d=\"M4.25 2.25h7.5v11.5L8 11l-3.75 2.75Z\"/>";
    Split => "rectangle.split.2x1", "<rect x=\"1.75\" y=\"2.75\" width=\"12.5\" height=\"10.5\" rx=\"2\"/><path d=\"M8 2.75v10.5\"/>";
    Reader => "text.justify", "<path d=\"M3 4h10M3 7h10M3 10h10M3 13h6\"/>";
    TextFormat => "textformat", "<path d=\"M1.75 12.75 4.6 5.75l2.85 7M2.8 10.25h3.6M8.25 12.75 11.4 3.25l3.1 9.5M9.4 9.5h4.1\"/>";
    DocPlaintext => "doc.plaintext", "<rect x=\"3\" y=\"1\" width=\"10\" height=\"14\" rx=\"2\"/><path d=\"M5.5 4.75h5M5.5 7.5h5M5.5 10.25h3\"/>";
    Sliders => "slider.horizontal.3", "<path d=\"M2 4h1.75M7.25 4H14M2 8h6.25M11.75 8H14M2 12h2.75M8.25 12H14\"/><circle cx=\"5.5\" cy=\"4\" r=\"1.75\"/><circle cx=\"10\" cy=\"8\" r=\"1.75\"/><circle cx=\"6.5\" cy=\"12\" r=\"1.75\"/>";
    Speaker => "speaker.wave.2", "<path d=\"M2.5 6h2.25L8 3.25v9.5L4.75 10H2.5Z\"/><path d=\"M10.5 5.75a3 3 0 0 1 0 4.5M12.5 3.75a6 6 0 0 1 0 8.5\"/>";
    SpeakerSlash => "speaker.slash", "<path d=\"M2.5 6h2.25L8 3.25v9.5L4.75 10H2.5Z\"/><path d=\"M10.25 6l4 4M14.25 6l-4 4\"/>";
    Globe => "globe", "<circle cx=\"8\" cy=\"8\" r=\"6.25\"/><path d=\"M1.75 8h12.5M8 1.75c1.75 1.9 2.6 4 2.6 6.25S9.75 12.35 8 14.25M8 1.75C6.25 3.65 5.4 5.75 5.4 8s.85 4.35 2.6 6.25\"/>";
    Search => "magnifyingglass", "<circle cx=\"7\" cy=\"7\" r=\"4.75\"/><path d=\"M10.5 10.5 14 14\"/>";
    Gear => "gearshape", "<circle cx=\"8\" cy=\"8\" r=\"2.25\"/><circle cx=\"8\" cy=\"8\" r=\"4.5\"/><path d=\"M8 1.75v1.75M8 12.5v1.75M1.75 8H3.5M12.5 8h1.75M3.6 3.6l1.2 1.2M11.2 11.2l1.2 1.2M3.6 12.4l1.2-1.2M11.2 4.8l1.2-1.2\"/>";
    Trash => "trash", "<path d=\"M2.75 4.25h10.5M6.25 4.25V2.75h3.5v1.5M4 4.25l.7 9h6.6l.7-9M6.75 6.75v4M9.25 6.75v4\"/>";
    Copy => "doc.on.doc", "<rect x=\"5.25\" y=\"5.25\" width=\"8.5\" height=\"8.5\" rx=\"1.75\"/><path d=\"M10.75 5.25v-1.5a1.5 1.5 0 0 0-1.5-1.5h-5.5a1.5 1.5 0 0 0-1.5 1.5v5.5a1.5 1.5 0 0 0 1.5 1.5h1.5\"/>";
    Folder => "folder", "<path d=\"M1.75 4.25a1.5 1.5 0 0 1 1.5-1.5h3l1.5 1.75h5a1.5 1.5 0 0 1 1.5 1.5v6.25a1.5 1.5 0 0 1-1.5 1.5h-9.5a1.5 1.5 0 0 1-1.5-1.5Z\"/>";
    Star => "star", "<path d=\"M8 1.75l1.9 3.9 4.3.6-3.1 3 .75 4.25L8 11.5l-3.85 2 .75-4.25-3.1-3 4.3-.6Z\"/>";
    History => "clock.arrow.circlepath", "<path d=\"M2.25 8a5.75 5.75 0 1 0 1.7-4.1L1.9 5.95\"/><path d=\"M1.9 2.25v3.7h3.7M8 5v3.25l2.25 1.5\"/>";
    Puzzle => "puzzlepiece", "<path d=\"M2.75 5.25H5.5a1.5 1.5 0 1 1 3 0h2.25V7.5a1.5 1.5 0 1 1 0 3v2.75h-8Z\"/>";
    Sync => "arrow.triangle.2.circlepath", "<path d=\"M13.25 6.5A5.5 5.5 0 0 0 3.1 5.25M2.75 9.5a5.5 5.5 0 0 0 10.15 1.25M3.1 2.25v3h3M12.9 13.75v-3h-3\"/>";
    Check => "checkmark", "<path d=\"M3.25 8.25 6.5 11.5l6.25-7\"/>";
    Warning => "exclamationmark.triangle", "<path d=\"M8 2.25 14.25 13.25H1.75Z\"/><path d=\"M8 6.25v3.25M8 11.4v.1\"/>";
    Pin => "pin", "<path d=\"M5.75 2.25h4.5M6.75 2.25v4L4.5 9h7l-2.25-2.75v-4M8 9v4.75\"/>";
    Incognito => "eyeglasses", "<circle cx=\"4.5\" cy=\"9.5\" r=\"2.5\"/><circle cx=\"11.5\" cy=\"9.5\" r=\"2.5\"/><path d=\"M7 9.25c.65-.5 1.35-.5 2 0M2 9.25 3 5.5M14 9.25 13 5.5\"/>";
    ArdiaMark => "ardia.mark", "<circle cx=\"7.75\" cy=\"2.75\" r=\"2.75\" fill=\"#000\" stroke=\"none\"/><path d=\"M.5 11.25V8C.5 6.5 1.5 5.5 3 5.5S6 6.5 7.5 8Z\" fill=\"#000\" stroke=\"none\"/><path d=\"M.5 12.25 10 6c.75-.5 1.5-.6 2.5-.5 1.75.25 3 1 3 2.5v4.5c0 1.5-1 2.5-2.5 2.5H3c-1.5 0-2.5-1-2.5-2Z\" fill=\"#000\" stroke=\"none\"/>";
    Mic => "mic", "<rect x=\"5.75\" y=\"1.75\" width=\"4.5\" height=\"7.5\" rx=\"2.25\"/><path d=\"M3.5 7.5a4.5 4.5 0 0 0 9 0M8 12v2.25\"/>";
    ArrowUp => "arrow.up", "<path d=\"M8 13V3.25M3.75 7.5 8 3.25l4.25 4.25\"/>";
    ArrowDown => "arrow.down", "<path d=\"M8 3v9.75M3.75 8.5 8 12.75l4.25-4.25\"/>";
    MoonZzz => "moon.zzz", "<path d=\"M10.25 9.9A5 5 0 0 1 5.6 3.25a5 5 0 1 0 4.65 6.65Z\"/><path d=\"M10 2.25h3l-3 3.5h3\"/>";
    Return => "return", "<path d=\"M13 3.5v3.75A1.75 1.75 0 0 1 11.25 9H3.5M6.25 6 3.25 9l3 3\"/>";
    Link => "link", "<path d=\"M7 9a3 3 0 0 0 4.24 0l2-2a3 3 0 0 0-4.24-4.24l-.75.75M9 7a3 3 0 0 0-4.24 0l-2 2a3 3 0 0 0 4.24 4.24l.75-.75\"/>";
    Share => "square.and.arrow.up", "<path d=\"M8 1.75v8M5 4.5l3-3 3 3M5.25 6.5h-1A1.25 1.25 0 0 0 3 7.75v5A1.25 1.25 0 0 0 4.25 14h7.5A1.25 1.25 0 0 0 13 12.75v-5a1.25 1.25 0 0 0-1.25-1.25h-1\"/>";
    Ellipsis => "ellipsis", "<circle cx=\"3.5\" cy=\"8\" r=\"1.15\" fill=\"#000\" stroke=\"none\"/><circle cx=\"8\" cy=\"8\" r=\"1.15\" fill=\"#000\" stroke=\"none\"/><circle cx=\"12.5\" cy=\"8\" r=\"1.15\" fill=\"#000\" stroke=\"none\"/>";
    Tv => "tv", "<rect x=\"1.75\" y=\"2.75\" width=\"12.5\" height=\"8.5\" rx=\"1.5\"/><path d=\"M5.5 13.75h5M8 11.25v2.5\"/>";
    Display => "display", "<rect x=\"1.75\" y=\"2.25\" width=\"12.5\" height=\"8.75\" rx=\"1.25\"/><path d=\"M6.25 11v2.75M9.75 11v2.75M4.75 13.75h6.5\"/>";
    Person => "person", "<circle cx=\"8\" cy=\"5.25\" r=\"2.75\"/><path d=\"M2.75 14a5.25 5.25 0 0 1 10.5 0\"/>";
    PersonPair => "person.2.fill", "<circle cx=\"6\" cy=\"5.5\" r=\"2.25\" fill=\"#000\"/><circle cx=\"11\" cy=\"6\" r=\"1.9\" fill=\"#000\"/><path d=\"M1.75 13.25a4.25 4.25 0 0 1 8.5 0Z\" fill=\"#000\"/><path d=\"M10.75 9.5a3.5 3.5 0 0 1 3.5 3.75h-2.5\" fill=\"#000\"/>";
    HalfCircle => "circle.lefthalf.filled", "<circle cx=\"8\" cy=\"8\" r=\"6\"/><path d=\"M8 2a6 6 0 0 0 0 12Z\" fill=\"#000\"/>";
    Wand => "wand.and.rays", "<path d=\"M2.5 13.5 9.5 6.5\"/><path d=\"M11 2v2M11 7v2M8.5 4.5h-2M15 4.5h-2M13 2.5l-1 1M13 6.5l-1-1\"/>";
    Pause => "pause", "<path d=\"M5.5 3.5v9M10.5 3.5v9\"/>";
    Play => "play", "<path d=\"M5 3.25v9.5L12.75 8Z\" fill=\"#000\"/>";
    Camera => "video", "<rect x=\"1.75\" y=\"4.25\" width=\"9\" height=\"7.5\" rx=\"1.75\"/><path d=\"m10.75 7 3.5-2v6l-3.5-2\"/>";
    Location => "location", "<path d=\"M14 2 2 7l5 2 2 5Z\"/>";
    Bell => "bell", "<path d=\"M4 11V7a4 4 0 0 1 8 0v4l1.25 1.5H2.75ZM6.5 14h3\"/>";
    Clipboard => "clipboard", "<rect x=\"3.25\" y=\"2.75\" width=\"9.5\" height=\"11.5\" rx=\"1.75\"/><path d=\"M6 2.75h4v1.5H6Z\"/>";
    Cast => "airplayvideo", "<path d=\"M3.75 11.25h-.5a1.5 1.5 0 0 1-1.5-1.5v-6a1.5 1.5 0 0 1 1.5-1.5h9.5a1.5 1.5 0 0 1 1.5 1.5v6a1.5 1.5 0 0 1-1.5 1.5h-.5\"/><path d=\"M5.5 13.75h5L8 11Z\" fill=\"#000\"/>";
    PictureInPicture => "pip", "<rect x=\"1.75\" y=\"2.75\" width=\"12.5\" height=\"10.5\" rx=\"2\"/><rect x=\"8\" y=\"8\" width=\"4.25\" height=\"3.25\" rx=\".75\" fill=\"#000\"/>";
    Eye => "eye", "<path d=\"M1.5 8s2.4-4.75 6.5-4.75S14.5 8 14.5 8s-2.4 4.75-6.5 4.75S1.5 8 1.5 8Z\"/><circle cx=\"8\" cy=\"8\" r=\"2\"/>";
    Sparkles => "sparkles", "<path d=\"M7 2.5l1.1 3.4 3.4 1.1-3.4 1.1L7 11.5 5.9 8.1 2.5 7l3.4-1.1ZM12.5 10.5l.5 1.5 1.5.5-1.5.5-.5 1.5-.5-1.5-1.5-.5 1.5-.5Z\"/>";
    Undo => "arrow.uturn.backward", "<path d=\"M5.5 3.25 2.75 6l2.75 2.75M2.75 6h7a3.5 3.5 0 0 1 0 7H7\"/>";
    Download => "arrow.down.to.line", "<path d=\"M8 2v8.25M4.75 7 8 10.25 11.25 7M3 13.75h10\"/>";
    Import => "arrow.up.to.line", "<path d=\"M8 14V5.75M4.75 9 8 5.75 11.25 9M3 2.25h10\"/>";
    Key => "key", "<circle cx=\"5.25\" cy=\"10.75\" r=\"3\"/><path d=\"M7.4 8.6 13.5 2.5M11.25 4.75l1.75 1.75M9.75 6.25 11 7.5\"/>";
    Palette => "paintpalette", "<path d=\"M8 1.75a6.25 6.25 0 1 0 0 12.5c.9 0 1.35-.6 1.35-1.3 0-.4-.2-.75-.45-1-.25-.3-.4-.6-.4-1 0-.75.6-1.35 1.35-1.35h1.6a2.8 2.8 0 0 0 2.8-2.8c0-3.35-2.8-6.05-6.25-6.05Z\"/><circle cx=\"5\" cy=\"6.75\" r=\".9\" fill=\"#000\" stroke=\"none\"/><circle cx=\"7.75\" cy=\"4.6\" r=\".9\" fill=\"#000\" stroke=\"none\"/><circle cx=\"10.75\" cy=\"5.75\" r=\".9\" fill=\"#000\" stroke=\"none\"/>";
    Keyboard => "keyboard", "<rect x=\"1.75\" y=\"3.75\" width=\"12.5\" height=\"8.5\" rx=\"1.75\"/><path d=\"M4.25 6.5h.01M6.75 6.5h.01M9.25 6.5h.01M11.75 6.5h.01M5 9.5h6\"/>";
    CreditCard => "creditcard", "<rect x=\"1.75\" y=\"3.25\" width=\"12.5\" height=\"9.5\" rx=\"1.75\"/><path d=\"M1.75 6.5h12.5M4.25 10h2.5\"/>";
    Plug => "powerplug", "<path d=\"M5.5 1.75v3M10.5 1.75v3M3.75 4.75h8.5v2.5a4.25 4.25 0 0 1-8.5 0ZM8 11.5v2.75\"/>";
    Window => "macwindow", "<rect x=\"1.75\" y=\"2.75\" width=\"12.5\" height=\"10.5\" rx=\"2\"/><path d=\"M1.75 5.75h12.5\"/>";
    Tabs => "square.on.square", "<rect x=\"3.75\" y=\"4.75\" width=\"10.5\" height=\"9\" rx=\"1.75\"/><path d=\"M1.75 11V3.75A1.75 1.75 0 0 1 3.5 2h7.25\"/>";
    Wrench => "wrench", "<path d=\"M10.4 2.1a3.5 3.5 0 0 0-4.2 4.6L2.25 10.65a1.6 1.6 0 0 0 2.25 2.25l3.95-3.95a3.5 3.5 0 0 0 4.6-4.2l-2.05 2.05-1.8-.45-.45-1.8Z\"/>";
    Info => "info.circle", "<circle cx=\"8\" cy=\"8\" r=\"6.25\"/><path d=\"M8 7.25v4M8 4.9v.1\"/>";
    Sun => "sun.max", "<circle cx=\"8\" cy=\"8\" r=\"2.75\"/><path d=\"M8 1.5v1.25M8 13.25v1.25M1.5 8h1.25M13.25 8h1.25M3.4 3.4l.9.9M11.7 11.7l.9.9M3.4 12.6l.9-.9M11.7 4.3l.9-.9\"/>";
    Moon => "moon", "<path d=\"M13.25 9.5A5.75 5.75 0 1 1 6.5 2.75a4.5 4.5 0 0 0 6.75 6.75Z\"/>";
    Calculator => "plus.forwardslash.minus", "<rect x=\"3\" y=\"1.75\" width=\"10\" height=\"12.5\" rx=\"1.75\"/><path d=\"M5.5 4.75h5M5.75 8h.01M8 8h.01M10.25 8h.01M5.75 11h.01M8 11h.01M10.25 11h.01\"/>";
    Bang => "exclamationmark", "<path d=\"M8 2.75v7M8 12.75v.25\"/>";
    Command => "command", "<path d=\"M5.25 5.25h5.5v5.5h-5.5ZM5.25 5.25V3.9a1.4 1.4 0 1 0-1.35 1.35h1.35M10.75 5.25h1.35a1.4 1.4 0 1 0-1.35-1.35ZM10.75 10.75v1.35a1.4 1.4 0 1 0 1.35-1.35ZM5.25 10.75H3.9a1.4 1.4 0 1 0 1.35 1.35Z\"/>";
    DevTools => "chevron.left.forwardslash.chevron.right", "<path d=\"M5 4.5 1.75 8 5 11.5M11 4.5 14.25 8 11 11.5M9.25 3 6.75 13\"/>";
    Laptop => "laptopcomputer", "<rect x=\"2.75\" y=\"3.25\" width=\"10.5\" height=\"7.5\" rx=\"1.25\"/><path d=\"M1.25 13h13.5\"/>";
    Iphone => "iphone", "<rect x=\"4.75\" y=\"1.25\" width=\"6.5\" height=\"13.5\" rx=\"1.5\"/><path d=\"M7 3h2\"/>";
    DesktopComputer => "desktopcomputer", "<rect x=\"1.75\" y=\"2.25\" width=\"12.5\" height=\"8.75\" rx=\"1.25\"/><path d=\"M8 11v2.75M5.25 13.75h5.5\"/>";
    MacbookAndIphone => "macbook.and.iphone", "<rect x=\"1.75\" y=\"3.25\" width=\"8.5\" height=\"6.5\" rx=\"1\"/><path d=\"M0.75 12h8.5\"/><rect x=\"11.25\" y=\"5.25\" width=\"4\" height=\"7.5\" rx=\"1\"/>";
    PersonTwo => "person.2", "<circle cx=\"6\" cy=\"5.5\" r=\"2.25\"/><circle cx=\"11\" cy=\"6\" r=\"1.9\"/><path d=\"M1.75 13.25a4.25 4.25 0 0 1 8.5 0\"/><path d=\"M10.75 9.5a3.5 3.5 0 0 1 3.5 3.75\"/>";
    PersonBadgePlus => "person.crop.circle.badge.plus", "<circle cx=\"7\" cy=\"8.5\" r=\"5.75\"/><circle cx=\"7\" cy=\"7.25\" r=\"2\"/><path d=\"M3.5 12.5a4 4 0 0 1 7 0\"/><path d=\"M13 1.5v4M11 3.5h4\"/>";
    IcloudSlash => "icloud.slash", "<path d=\"M4.5 12.5h7a3 3 0 0 0 .4-6a4 4 0 0 0-7.6 1A2.5 2.5 0 0 0 4.5 12.5Z\"/><path d=\"M2 2l12 12\"/>";
    Grid => "square.grid.2x2", "<rect x=\"2\" y=\"2\" width=\"5\" height=\"5\" rx=\"1.25\"/><rect x=\"9\" y=\"2\" width=\"5\" height=\"5\" rx=\"1.25\"/><rect x=\"2\" y=\"9\" width=\"5\" height=\"5\" rx=\"1.25\"/><rect x=\"9\" y=\"9\" width=\"5\" height=\"5\" rx=\"1.25\"/>";
    TopStrip => "menubar.rectangle", "<rect x=\"1.75\" y=\"2.75\" width=\"12.5\" height=\"10.5\" rx=\"2\"/><path d=\"M1.75 6h12.5M5 4.4h.01M7.5 4.4h.01\"/>";
    SidebarRight => "sidebar.right", "<rect x=\"1.75\" y=\"2.75\" width=\"12.5\" height=\"10.5\" rx=\"2.5\"/><path d=\"M10 2.75v10.5M11.5 5.4h.9M11.5 7.4h.9\"/>";
    BookmarkFill => "bookmark.fill", "<path d=\"M4.25 2.25h7.5v11.5L8 11l-3.75 2.75Z\" fill=\"#000\"/>";
    ZoomIn => "plus.magnifyingglass", "<circle cx=\"7\" cy=\"7\" r=\"4.75\"/><path d=\"M10.5 10.5 14 14M7 4.9v4.2M4.9 7h4.2\"/>";
    ZoomOut => "minus.magnifyingglass", "<circle cx=\"7\" cy=\"7\" r=\"4.75\"/><path d=\"M10.5 10.5 14 14M4.9 7h4.2\"/>";
    LockWarning => "lock.open.trianglebadge.exclamationmark.fill", "<path d=\"M3.5 7h6.25a1.5 1.5 0 0 1 1.5 1.5v.5L8.5 14.25H3.5A1.5 1.5 0 0 1 2 12.75V8.5A1.5 1.5 0 0 1 3.5 7Z\" fill=\"#000\" stroke=\"none\"/><path d=\"M4.25 7V4.75a2.75 2.75 0 0 1 5.4-.75\"/><path d=\"M12.25 8.75 15 14.25H9.5Z\" fill=\"#000\" stroke=\"none\"/>";
    PopupBlocked => "macwindow.badge.plus", "<path d=\"M9 13.25H3.75a2 2 0 0 1-2-2v-6.5a2 2 0 0 1 2-2h8.5a2 2 0 0 1 2 2V8.5M1.75 5.75h12.5M12.5 10.5v4M10.5 12.5h4\"/>";
    TvMedia => "tv.and.mediabox.fill", "<rect x=\"1.25\" y=\"2.5\" width=\"10.5\" height=\"8\" rx=\"1.5\" fill=\"#000\" stroke=\"none\"/><path d=\"M4.5 13h4.25\"/><rect x=\"12.5\" y=\"5.5\" width=\"2.5\" height=\"8\" rx=\".75\" fill=\"#000\" stroke=\"none\"/>";
    PuzzleExtension => "puzzlepiece.extension", "<path d=\"M2.75 5.25H5.5a1.5 1.5 0 1 1 3 0h2.25V7.5a1.5 1.5 0 1 1 0 3v2.75h-8v-2.5a1.5 1.5 0 1 0 0-3Z\"/>";
    Dot => "circle.fill", "<circle cx=\"8\" cy=\"8\" r=\"3\" fill=\"#000\" stroke=\"none\"/>";
    TvAndMediabox => "tv.and.mediabox", "<rect x=\"1.25\" y=\"2.5\" width=\"10.5\" height=\"7.5\" rx=\"1.25\"/><path d=\"M4.25 12.75h4.5\"/><rect x=\"12.75\" y=\"5.25\" width=\"2.25\" height=\"7.5\" rx=\"0.75\"/>";
    HifiSpeaker => "hifispeaker", "<rect x=\"4\" y=\"1.75\" width=\"8\" height=\"12.5\" rx=\"1.75\"/><circle cx=\"8\" cy=\"9.75\" r=\"2.25\"/><circle cx=\"8\" cy=\"4.6\" r=\"0.9\"/>";
    HifiSpeakers => "hifispeaker.2", "<rect x=\"1.75\" y=\"3\" width=\"6.5\" height=\"11\" rx=\"1.5\"/><circle cx=\"5\" cy=\"10\" r=\"1.8\"/><path d=\"M9.75 3h3a1.5 1.5 0 0 1 1.5 1.5v8a1.5 1.5 0 0 1-1.5 1.5h-3\"/>";
    PinSlash => "pin.slash", "<path d=\"M5.75 2.25h4.5M6.75 2.25v4L4.5 9h7l-2.25-2.75v-4M8 9v4.75M2.5 2.5l11 11\"/>";
    PinFill => "pin.fill", "<path d=\"M5.75 2.25h4.5M6.75 2.25v4L4.5 9h7l-2.25-2.75v-4Z\" fill=\"#000\"/><path d=\"M8 9v4.75\"/>";
    ChevronUpDown => "chevron.up.chevron.down", "<path d=\"M5 6.25 8 3.25l3 3M5 9.75l3 3 3-3\"/>";
    CheckCircleFill => "checkmark.circle.fill", "<defs><mask id=\"c\"><rect width=\"16\" height=\"16\" fill=\"#fff\"/><path d=\"M5.25 8.25 7.25 10.25 10.75 6\" stroke=\"#000\" stroke-width=\"1.6\"/></mask></defs><circle cx=\"8\" cy=\"8\" r=\"6.75\" fill=\"#000\" stroke=\"none\" mask=\"url(#c)\"/>";
    WarningFill => "exclamationmark.triangle.fill", "<defs><mask id=\"w\"><rect width=\"16\" height=\"16\" fill=\"#fff\"/><path d=\"M8 6v3.5M8 11.5v.25\" stroke=\"#000\" stroke-width=\"1.6\"/></mask></defs><path d=\"M8 1.75 14.75 13.75H1.25Z\" fill=\"#000\" mask=\"url(#w)\"/>";
    ExclamationCircleFill => "exclamationmark.circle.fill", "<defs><mask id=\"x\"><rect width=\"16\" height=\"16\" fill=\"#fff\"/><path d=\"M8 4.75v3.75M8 10.75v.25\" stroke=\"#000\" stroke-width=\"1.6\"/></mask></defs><circle cx=\"8\" cy=\"8\" r=\"6.75\" fill=\"#000\" stroke=\"none\" mask=\"url(#x)\"/>";
    Clock => "clock", "<circle cx=\"8\" cy=\"8\" r=\"6.25\"/><path d=\"M8 4.5V8l2.5 1.5\"/>";
    StopCircle => "stop.circle", "<circle cx=\"8\" cy=\"8\" r=\"6.25\"/><rect x=\"5.75\" y=\"5.75\" width=\"4.5\" height=\"4.5\" rx=\"0.75\"/>";
    ScreenShare => "rectangle.inset.filled", "<rect x=\"1.75\" y=\"3\" width=\"12.5\" height=\"10\" rx=\"1.75\"/><rect x=\"4.25\" y=\"5.5\" width=\"7.5\" height=\"5\" rx=\"0.75\" fill=\"#000\"/>";
    Expand => "arrow.up.left.and.arrow.down.right", "<path d=\"M2.75 7V2.75H7M2.75 2.75l4.5 4.5M13.25 9v4.25H9M13.25 13.25l-4.5-4.5\"/>";
    SplitVertical => "rectangle.split.1x2", "<rect x=\"1.75\" y=\"2.75\" width=\"12.5\" height=\"10.5\" rx=\"2\"/><path d=\"M1.75 8h12.5\"/>";
    SwapVertical => "arrow.up.arrow.down", "<path d=\"M5 13V3M2.75 5.25 5 3l2.25 2.25M11 3v10M8.75 10.75 11 13l2.25-2.25\"/>";
    SwapHorizontal => "arrow.left.arrow.right", "<path d=\"M3 5h10M10.75 2.75 13 5l-2.25 2.25M13 11H3M5.25 8.75 3 11l2.25 2.25\"/>";
    HalfLeft => "rectangle.lefthalf.filled", "<rect x=\"1.75\" y=\"2.75\" width=\"12.5\" height=\"10.5\" rx=\"2\"/><path d=\"M3.75 2.75H8v10.5H3.75a2 2 0 0 1-2-2v-6.5a2 2 0 0 1 2-2Z\" fill=\"#000\"/>";
    HalfRight => "rectangle.righthalf.filled", "<rect x=\"1.75\" y=\"2.75\" width=\"12.5\" height=\"10.5\" rx=\"2\"/><path d=\"M8 2.75h4.25a2 2 0 0 1 2 2v6.5a2 2 0 0 1-2 2H8Z\" fill=\"#000\"/>";
    HalfTop => "rectangle.tophalf.filled", "<rect x=\"1.75\" y=\"2.75\" width=\"12.5\" height=\"10.5\" rx=\"2\"/><path d=\"M1.75 8V4.75a2 2 0 0 1 2-2h8.5a2 2 0 0 1 2 2V8Z\" fill=\"#000\"/>";
    HalfBottom => "rectangle.bottomhalf.filled", "<rect x=\"1.75\" y=\"2.75\" width=\"12.5\" height=\"10.5\" rx=\"2\"/><path d=\"M1.75 8h12.5v3.25a2 2 0 0 1-2 2h-8.5a2 2 0 0 1-2-2Z\" fill=\"#000\"/>";
    PlusSquareOnSquare => "plus.square.on.square", "<rect x=\"3.75\" y=\"4.75\" width=\"10.5\" height=\"9\" rx=\"1.75\"/><path d=\"M1.75 11V3.75A1.75 1.75 0 0 1 3.5 2h7.25M9 6.75v5M6.5 9.25h5\"/>";
    ArrowRight => "arrow.right", "<path d=\"M3 8h9.75M8.5 3.75 12.75 8 8.5 12.25\"/>";
    ArrowUpRight => "arrow.up.right", "<path d=\"M4.5 11.5 11.5 4.5M5.75 4.5h5.75v5.75\"/>";
    EqualCircle => "equal.circle", "<circle cx=\"8\" cy=\"8\" r=\"6.25\"/><path d=\"M5.5 6.75h5M5.5 9.25h5\"/>";
    Doc => "doc", "<path d=\"M4.25 1.75h4.75l2.75 2.75v9.75h-7.5Z\"/><path d=\"M9 1.75V4.5h2.75\"/>";
    Stethoscope => "stethoscope", "<path d=\"M3.5 2v3.5a2.75 2.75 0 0 0 5.5 0V2M6.25 8.25v1.5a3 3 0 0 0 6 0V8\"/><circle cx=\"12.25\" cy=\"6.75\" r=\"1.25\"/>";
    TextSearch => "text.magnifyingglass", "<path d=\"M2 4h7M2 7h4M2 10h3\"/><circle cx=\"10.5\" cy=\"9.5\" r=\"2.75\"/><path d=\"m12.5 11.5 2 2\"/>";
    Pencil => "pencil", "<path d=\"M10.75 2.75l2.5 2.5-7.5 7.5-3.25.75.75-3.25Z\"/><path d=\"M9.25 4.25l2.5 2.5\"/>";
    Photo => "photo", "<rect x=\"1.75\" y=\"2.75\" width=\"12.5\" height=\"10.5\" rx=\"2\"/><circle cx=\"5.5\" cy=\"6.25\" r=\"1.25\"/><path d=\"M1.75 11.5 5.5 8.5l2.5 2 2.75-2.75 3.5 3.25\"/>";
    EyeSlash => "eye.slash", "<path d=\"M1.5 8s2.4-4.75 6.5-4.75S14.5 8 14.5 8s-2.4 4.75-6.5 4.75S1.5 8 1.5 8Z\"/><circle cx=\"8\" cy=\"8\" r=\"2\"/><path d=\"M2.75 2.75l10.5 10.5\"/>";
    PersonCropCircle => "person.crop.circle", "<circle cx=\"8\" cy=\"8\" r=\"6.25\"/><circle cx=\"8\" cy=\"6.5\" r=\"2.25\"/><path d=\"M4 12.4a4.6 4.6 0 0 1 8 0\"/>";
    QuestionCircle => "questionmark.circle", "<circle cx=\"8\" cy=\"8\" r=\"6.25\"/><path d=\"M6.1 6.2a1.95 1.95 0 1 1 2.65 1.85c-.5.2-.75.55-.75 1.05v.4M8 11.1v.1\"/>";
    LockFill => "lock.fill", "<rect x=\"3.25\" y=\"7\" width=\"9.5\" height=\"7\" rx=\"1.75\" fill=\"#000\"/><path d=\"M5.25 7V5a2.75 2.75 0 0 1 5.5 0v2\"/>";
    PlayTv => "play.tv", "<rect x=\"1.75\" y=\"2.75\" width=\"12.5\" height=\"9\" rx=\"2\"/><path d=\"M5.5 14h5M6.75 5.25v4l3.25-2Z\"/>";
    RecordCircle => "record.circle", "<circle cx=\"8\" cy=\"8\" r=\"6.25\"/><circle cx=\"8\" cy=\"8\" r=\"3.25\" fill=\"#000\"/>";
}

pub struct IconElement {
    icon: Icon,
    size: Pixels,
    color: Hsla,
    weight: SymbolWeight,
    centres_ink: bool,
    symbol: Option<SharedString>,
    spin: Option<Duration>,
    fit: Option<(f32, f32)>,
}

pub const SPINNER_TURN: Duration = Duration::from_millis(1000);

impl Icon {
    pub fn from_symbol(name: &str) -> Option<Icon> {
        Icon::ALL
            .iter()
            .copied()
            .find(|glyph| glyph.symbol_name() == name)
    }

    pub fn symbol_name(self) -> &'static str {
        let key = self.key();
        key.strip_prefix("ardia-icon:").unwrap_or(key)
    }
}

pub fn icon(icon: Icon, side: f32, color: impl Into<Hsla>) -> IconElement {
    IconElement {
        icon,
        size: px(side),
        color: color.into(),
        weight: SymbolWeight::Regular,
        centres_ink: false,
        symbol: None,
        spin: None,
        fit: None,
    }
}

pub fn symbol_icon(
    name: impl Into<SharedString>,
    fallback: Icon,
    side: f32,
    color: impl Into<Hsla>,
) -> IconElement {
    let name = name.into();
    let mut element = icon(
        Icon::from_symbol(name.as_ref()).unwrap_or(fallback),
        side,
        color,
    );
    element.symbol = Some(name);
    element
}

impl IconElement {
    pub fn weight(mut self, weight: SymbolWeight) -> Self {
        self.weight = weight;
        self
    }

    pub fn centres_ink(mut self) -> Self {
        self.centres_ink = true;
        self
    }

    pub fn spinning(mut self, turn: Duration) -> Self {
        self.spin = Some(turn);
        self
    }

    pub fn fit_within(mut self, width: f32, height: f32) -> Self {
        self.fit = Some((width, height));
        self
    }

    fn system_symbol(&self, window: &Window) -> Option<SymbolGlyph> {
        self.system_symbol_at(window.scale_factor(), 1.0)
    }

    fn fitted_symbol(&self, window: &Window) -> Option<(SymbolGlyph, f32)> {
        let glyph = self.system_symbol(window)?;
        let ratio = self.fit.map_or(1.0, |(width, height)| {
            symbol_fit(glyph.width, glyph.height, width, height)
        });
        if ratio >= 1.0 {
            return Some((glyph, 1.0));
        }
        let small = self.system_symbol_at(window.scale_factor(), ratio)?;
        Some((
            SymbolGlyph {
                ink_offset: (glyph.ink_offset.0 * ratio, glyph.ink_offset.1 * ratio),
                ..small
            },
            ratio,
        ))
    }

    fn system_symbol_at(&self, scale: f32, fit: f32) -> Option<SymbolGlyph> {
        let name = drawn_symbol_name(
            self.symbol
                .as_ref()
                .map_or(self.icon.symbol_name(), |name| name.as_ref()),
        );
        fitted_symbol_glyph(
            &SymbolRaster {
                name: &name,
                point_size: f32::from(self.size),
                weight: self.weight,
                scale,
            },
            fit,
            gpui::white(),
        )
    }
}

impl Element for IconElement {
    type RequestLayoutState = ();
    type PrepaintState = ();

    fn id(&self) -> Option<ElementId> {
        None
    }

    fn source_location(&self) -> Option<&'static core::panic::Location<'static>> {
        None
    }

    fn request_layout(
        &mut self,
        _id: Option<&GlobalElementId>,
        _inspector_id: Option<&InspectorElementId>,
        window: &mut Window,
        cx: &mut App,
    ) -> (LayoutId, Self::RequestLayoutState) {
        let style = Style {
            size: size(self.size.into(), self.size.into()),
            flex_shrink: 0.0,
            ..Style::default()
        };
        (window.request_layout(style, [], cx), ())
    }

    fn prepaint(
        &mut self,
        _id: Option<&GlobalElementId>,
        _inspector_id: Option<&InspectorElementId>,
        _bounds: Bounds<Pixels>,
        _request_layout: &mut Self::RequestLayoutState,
        _window: &mut Window,
        _cx: &mut App,
    ) -> Self::PrepaintState {
    }

    fn paint(
        &mut self,
        _id: Option<&GlobalElementId>,
        _inspector_id: Option<&InspectorElementId>,
        bounds: Bounds<Pixels>,
        _request_layout: &mut Self::RequestLayoutState,
        _prepaint: &mut Self::PrepaintState,
        window: &mut Window,
        cx: &mut App,
    ) {
        if self.color.a <= 0.0 {
            return;
        }
        if let Some((glyph, _)) = self.fitted_symbol(window) {
            let placed = glyph_bounds(bounds, &glyph, window.scale_factor(), self.centres_ink);
            let painted = match self.spin {
                Some(turn) => window.paint_animated_image_mask(
                    placed,
                    glyph.image,
                    0,
                    TimedTransformation::rotation(turn, Transformation::default()),
                    self.color,
                    cx,
                ),
                None => window.paint_image_mask(
                    placed,
                    glyph.image,
                    0,
                    TransformationMatrix::unit(),
                    self.color,
                ),
            };
            match painted {
                Ok(()) => return,
                Err(error) => log::debug!("symbol {} failed to paint: {error}", self.icon.key()),
            }
        }
        let painted = window.paint_svg(
            bounds,
            SharedString::new_static(self.icon.key()),
            Some(self.icon.svg().as_bytes()),
            TransformationMatrix::unit(),
            self.color,
            cx,
        );
        if let Err(error) = painted {
            log::debug!("icon {} failed to paint: {error}", self.icon.key());
        }
    }
}

#[cfg(test)]
mod tests {

    #[test]
    fn symbols_shrink_to_fit_their_frame_like_the_old_symbol_view() {
        assert_eq!(symbol_fit(16.0, 12.0, 16.0, 10.0), 10.0 / 12.0);
        assert_eq!(symbol_fit(10.0, 14.0, 16.0, 16.0), 1.0);
        assert_eq!(symbol_fit(20.0, 10.0, 16.0, 10.0), 0.8);
        assert_eq!(symbol_fit(0.0, 10.0, 16.0, 10.0), 1.0);
        let fitted = icon(Icon::PersonPair, 10.0, gpui::black()).fit_within(16.0, 10.0);
        assert_eq!(fitted.fit, Some((16.0, 10.0)));
    }

    #[test]
    fn spinning_icons_turn_once_a_second_by_default() {
        let spinner = icon(Icon::Reload, 13.0, gpui::black()).spinning(SPINNER_TURN);
        assert_eq!(spinner.spin, Some(Duration::from_millis(1000)));
    }

    #[test]
    fn any_system_symbol_name_draws_with_a_table_fallback() {
        let known = symbol_icon("doc.plaintext", Icon::Puzzle, 13.0, gpui::black());
        assert_eq!(known.icon, Icon::DocPlaintext);
        assert_eq!(known.symbol.as_deref(), Some("doc.plaintext"));
        let other = symbol_icon("lightbulb", Icon::Puzzle, 13.0, gpui::black());
        assert_eq!(other.icon, Icon::Puzzle);
        assert_eq!(other.symbol.as_deref(), Some("lightbulb"));
    }

    #[test]
    fn symbols_name_their_icons() {
        assert_eq!(Icon::from_symbol("doc.plaintext"), Some(Icon::DocPlaintext));
        assert_eq!(Icon::from_symbol("no.such.symbol"), None);
        assert_eq!(Icon::SidebarLeft.symbol_name(), "sidebar.left");
        assert_eq!(Icon::ArdiaMark.symbol_name(), "ardia.mark");
    }

    #[test]
    fn icons_draw_regular_until_asked_and_fall_back_to_svg_without_a_renderer() {
        let plain = icon(Icon::ChevronLeft, 13.0, gpui::black());
        assert_eq!(plain.weight, SymbolWeight::Regular);
        assert!(!plain.centres_ink);
        assert!(plain.spin.is_none());
        let tuned = plain.weight(SymbolWeight::Medium).centres_ink();
        assert_eq!(tuned.weight, SymbolWeight::Medium);
        assert!(tuned.centres_ink);
        assert!(
            symbol_glyph(
                &SymbolRaster {
                    name: Icon::ChevronLeft.symbol_name(),
                    point_size: 13.0,
                    weight: SymbolWeight::Medium,
                    scale: 2.0,
                },
                gpui::black(),
            )
            .is_none()
        );
    }

    use super::*;
    use crate::primitives::symbol_glyphs::symbol_glyph;
    use std::collections::HashSet;

    #[test]
    fn every_icon_has_a_unique_key_and_a_well_formed_svg() {
        let mut keys = HashSet::new();
        for icon in Icon::ALL {
            assert!(keys.insert(icon.key()), "{icon:?}");
            let svg = icon.svg();
            assert!(
                svg.starts_with("<svg ") && svg.ends_with("</svg>"),
                "{icon:?}"
            );
            assert_eq!(
                svg.matches('<').count(),
                svg.matches('>').count(),
                "{icon:?}"
            );
            assert_eq!(svg.matches('"').count() % 2, 0, "{icon:?}");
        }
        assert!(Icon::ALL.len() >= 70);
    }
}
