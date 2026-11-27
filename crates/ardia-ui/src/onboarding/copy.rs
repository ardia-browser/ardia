pub struct Choice {
    pub value: &'static str,
    pub title: &'static str,
    pub subtitle: &'static str,
}

const fn choice(value: &'static str, title: &'static str, subtitle: &'static str) -> Choice {
    Choice {
        value,
        title,
        subtitle,
    }
}

pub const TAB_CHOICES: [Choice; 2] = [
    choice(
        "sidebar",
        "In the sidebar",
        "A tall list down the side, as in Arc",
    ),
    choice("top", "Along the top", "Classic tabs above the page"),
];

pub const ADDRESS_CHOICES: [Choice; 2] = [
    choice("toolbar", "In the toolbar", "Above the page, as in Dia"),
    choice(
        "sidebar",
        "In the sidebar",
        "On top of your tabs, as in Arc",
    ),
];

pub const CMDL_CHOICES: [Choice; 2] = [
    choice(
        "field",
        "Under the address",
        "Drops down from the field, as in Dia",
    ),
    choice(
        "centred",
        "In the center",
        "Floats over the page, as in Arc",
    ),
];

pub const NEW_TAB_CHOICES: [Choice; 2] = [
    choice(
        "page",
        "The New Tab page",
        "Your apps and a search box, as in Dia",
    ),
    choice(
        "commandBar",
        "The command bar",
        "Start typing right away, as in Arc",
    ),
];

pub const TIDY_CHOICES: [Choice; 2] = [
    choice("keep", "Keep them", "Tabs stay until you close them"),
    choice(
        "tidy",
        "Tidy them up",
        "Close the ones you haven't used in a while",
    ),
];

pub const QUIT_CHOICES: [Choice; 2] = [
    choice("true", "Restore my tabs", "Pick up where you left off"),
    choice("false", "Start fresh", "Open to a clean window"),
];

pub const WINDOW_CHOICES: [Choice; 2] = [
    choice("false", "Separate", "Each window has its own tabs"),
    choice(
        "true",
        "Shared",
        "Every window shows the same tabs, as in Arc",
    ),
];

pub const CTRL_TAB_CHOICES: [Choice; 2] = [
    choice(
        "step",
        "Step through tabs",
        "Goes one tab down the list, like Chrome.",
    ),
    choice(
        "switcher",
        "Recent tabs switcher",
        "Shows recent tabs; let go to switch, like Arc.",
    ),
];

pub const APPEARANCE_CHOICES: [Choice; 3] = [
    choice(
        "auto",
        "Automatic",
        "Light by day, dark by night, like your Mac",
    ),
    choice("light", "Light", "Always light"),
    choice("dark", "Dark", "Always dark"),
];

pub const SITE_COLOR_CHOICES: [Choice; 2] = [
    choice(
        "true",
        "Take on the site's color",
        "The tab bar blends into the page",
    ),
    choice(
        "false",
        "Keep my theme color",
        "The same color on every site",
    ),
];

pub const STYLE_CHOICES: [Choice; 2] = [
    choice(
        "glass",
        "Liquid Glass",
        "Buttons and panels catch the light, as in Tahoe",
    ),
    choice("classic", "Classic", "Flat and quiet, as in Dia"),
];

pub const LINK_CHOICES: [Choice; 2] = [
    choice(
        "true",
        "Little Ardia",
        "A small window that's gone when you're done",
    ),
    choice("false", "A new tab", "Right in your main window"),
];

pub const FRAME_DEFAULT: f64 = 9.0;
pub const FRAME_MAX: f64 = 12.0;

pub const FRAME_CHOICES: [(f64, &str, &str); 3] = [
    (
        FRAME_DEFAULT,
        "Framed",
        "Rounded corners with a little room around the page",
    ),
    (4.0, "Thin", "A slim frame and softer corners"),
    (
        0.0,
        "Edge to edge",
        "No frame: the page meets the window and the sidebar",
    ),
];

pub const TIDY_AFTER: [(f64, &str); 3] = [(720.0, "12 h"), (1440.0, "1 day"), (10080.0, "1 week")];

pub const PEEK_WITH: [(&str, &str); 3] = [("shift", "⇧-click"), ("alt", "⌥-click"), ("off", "Off")];

pub const BOOKMARKS_BAR: [(&str, &str); 3] = [
    ("always", "Always"),
    ("newTab", "New Tab"),
    ("never", "Never"),
];

pub const ENGINES: [&str; 7] = [
    "google",
    "duckduckgo",
    "bing",
    "kagi",
    "ecosia",
    "brave",
    "startpage",
];

pub const SWITCH_TABS_KEY: &str = "⌃Tab";

pub const SHARING_TITLE: &str = "Help us fix what breaks";
pub const SHARING_TOGGLE: &str = "Share anonymous crash reports and usage stats";
pub const SHARING_ROW: &str =
    "Crashes, errors, feature counts and speed. Never your sites, typing or tabs.";

pub struct PinnableSite {
    pub id: &'static str,
    pub title: &'static str,
    pub url: &'static str,
}

const fn site(id: &'static str, title: &'static str, url: &'static str) -> PinnableSite {
    PinnableSite { id, title, url }
}

pub const PINNABLE_SITES: [PinnableSite; 12] = [
    site("gmail", "Gmail", "https://mail.google.com/"),
    site("calendar", "Calendar", "https://calendar.google.com/"),
    site("slack", "Slack", "https://app.slack.com/"),
    site("notion", "Notion", "https://www.notion.so/"),
    site("figma", "Figma", "https://www.figma.com/"),
    site("github", "GitHub", "https://github.com/"),
    site("linear", "Linear", "https://linear.app/"),
    site("docs", "Docs", "https://docs.google.com/"),
    site("drive", "Drive", "https://drive.google.com/"),
    site("outlook", "Outlook", "https://outlook.office.com/mail/"),
    site("youtube", "YouTube", "https://www.youtube.com/"),
    site("spotify", "Spotify", "https://open.spotify.com/"),
];

pub const OUTRO_COMMANDS: [(&str, &str); 3] = [
    ("newTab", "Open a new tab"),
    ("focusCommandBar", "Go anywhere from the command bar"),
    ("toggleSidebar", "Hide the sidebar for more room"),
];

pub fn duration_title(minutes: f64) -> String {
    if let Some((_, title)) = TIDY_AFTER
        .iter()
        .skip(1)
        .find(|(value, _)| *value == minutes)
    {
        return (*title).to_owned();
    }
    let minutes = minutes.max(0.0).round() as u64;
    if minutes >= 1440 && minutes.is_multiple_of(1440) {
        let days = minutes / 1440;
        return if days == 1 {
            "1 day".to_owned()
        } else {
            format!("{days} days")
        };
    }
    if minutes >= 60 && minutes.is_multiple_of(60) {
        let hours = minutes / 60;
        return if hours == 1 {
            "1 hour".to_owned()
        } else {
            format!("{hours} hours")
        };
    }
    if minutes == 1 {
        "1 minute".to_owned()
    } else {
        format!("{minutes} minutes")
    }
}

pub fn frame_picked(frame: f64) -> Vec<String> {
    if frame == FRAME_DEFAULT {
        Vec::new()
    } else if frame == 0.0 {
        vec!["Edge-to-edge page".to_owned()]
    } else {
        vec![format!("Page frame {frame} pt")]
    }
}
