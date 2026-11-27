use std::sync::atomic::{AtomicU64, Ordering};

static EDITED: AtomicU64 = AtomicU64::new(0);
static RESET: AtomicU64 = AtomicU64::new(0);

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct ThemePresetCounts {
    pub theme_presets_edited: u64,
    pub theme_presets_reset: u64,
}

pub fn note(event: ardia_ui::ThemePresetEvent) {
    let counter = match event {
        ardia_ui::ThemePresetEvent::Edited => &EDITED,
        ardia_ui::ThemePresetEvent::Reset => &RESET,
    };
    counter.fetch_add(1, Ordering::Relaxed);
}

pub fn take() -> ThemePresetCounts {
    ThemePresetCounts {
        theme_presets_edited: EDITED.swap(0, Ordering::Relaxed),
        theme_presets_reset: RESET.swap(0, Ordering::Relaxed),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn counts_accumulate_and_reset_when_taken() {
        let _ = take();
        note(ardia_ui::ThemePresetEvent::Edited);
        note(ardia_ui::ThemePresetEvent::Edited);
        note(ardia_ui::ThemePresetEvent::Reset);
        assert_eq!(
            take(),
            ThemePresetCounts {
                theme_presets_edited: 2,
                theme_presets_reset: 1
            }
        );
        assert_eq!(take(), ThemePresetCounts::default());
    }
}
