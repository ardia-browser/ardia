macro_rules! named {
    ($kind:ident { $($variant:ident => $name:literal),+ $(,)? }) => {
        #[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
        #[repr(u8)]
        pub enum $kind {
            $($variant),+
        }

        impl $kind {
            pub const ALL: &'static [$kind] = &[$($kind::$variant),+];
            pub const COUNT: usize = Self::ALL.len();

            pub const fn name(self) -> &'static str {
                match self {
                    $($kind::$variant => $name),+
                }
            }

            pub fn from_index(index: usize) -> Option<Self> {
                Self::ALL.get(index).copied()
            }
        }
    };
}

named!(Span {
    OpenMainWindow => "window.open.main",
    OpenSettingsWindow => "window.open.settings",
    OpenOnboardingWindow => "window.open.onboarding",
    OpenLittleWindow => "window.open.little",
    FirstFrameMain => "window.first_frame.main",
    FirstFrameSettings => "window.first_frame.settings",
    FirstFrameOnboarding => "window.first_frame.onboarding",
    FirstFrameLittle => "window.first_frame.little",
    OmniboxQuery => "omnibox.query",
    SessionRestore => "session.restore",
    SessionSave => "session.save",
    SyncCycle => "sync.cycle",
    SyncSave => "sync.save",
    EngineReply => "engine.reply",
    WebkitReply => "webkit.reply",
    ControlRequest => "control.request",
    ControlHandler => "control.handler",
    FaviconDecode => "favicon.decode",
    ImageDecode => "image.decode",
    SettingsQuery => "settings.query",
    Command => "command",
    KeyAction => "action.key",
    MainBusy => "main.busy",
});

named!(FrameSlot {
    Main => "main",
    Settings => "settings",
    Onboarding => "onboarding",
    Little => "little",
});

named!(FrameMetric {
    Layout => "layout",
    Prepaint => "prepaint",
    Paint => "paint",
    Frame => "frame",
    InputToFrame => "input_to_frame",
});

impl FrameSlot {
    pub const fn open_span(self) -> Span {
        match self {
            FrameSlot::Main => Span::OpenMainWindow,
            FrameSlot::Settings => Span::OpenSettingsWindow,
            FrameSlot::Onboarding => Span::OpenOnboardingWindow,
            FrameSlot::Little => Span::OpenLittleWindow,
        }
    }

    pub const fn first_frame_span(self) -> Span {
        match self {
            FrameSlot::Main => Span::FirstFrameMain,
            FrameSlot::Settings => Span::FirstFrameSettings,
            FrameSlot::Onboarding => Span::FirstFrameOnboarding,
            FrameSlot::Little => Span::FirstFrameLittle,
        }
    }

    pub const fn trace_name(self, metric: FrameMetric) -> &'static str {
        const NAMES: [[&str; FrameMetric::COUNT]; FrameSlot::COUNT] = [
            [
                "frame.main.layout",
                "frame.main.prepaint",
                "frame.main.paint",
                "frame.main",
                "frame.main.input",
            ],
            [
                "frame.settings.layout",
                "frame.settings.prepaint",
                "frame.settings.paint",
                "frame.settings",
                "frame.settings.input",
            ],
            [
                "frame.onboarding.layout",
                "frame.onboarding.prepaint",
                "frame.onboarding.paint",
                "frame.onboarding",
                "frame.onboarding.input",
            ],
            [
                "frame.little.layout",
                "frame.little.prepaint",
                "frame.little.paint",
                "frame.little",
                "frame.little.input",
            ],
        ];
        NAMES[self as usize][metric as usize]
    }
}

pub fn field_name(name: &str) -> String {
    name.replace('.', "_")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_are_unique_and_safe_as_telemetry_fields() {
        let mut seen = std::collections::HashSet::new();
        for span in Span::ALL {
            assert!(seen.insert(span.name()), "{} twice", span.name());
            assert!(
                span.name()
                    .chars()
                    .all(|c| c.is_ascii_lowercase() || c == '.' || c == '_')
            );
            assert_eq!(Span::from_index(*span as usize), Some(*span));
        }
        for slot in FrameSlot::ALL {
            for metric in FrameMetric::ALL {
                assert!(slot.trace_name(*metric).contains(slot.name()));
            }
        }
        assert_eq!(field_name("window.open.main"), "window_open_main");
    }
}
