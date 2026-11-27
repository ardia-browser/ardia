use std::sync::Arc;

use ardia_state::BrowserState;
use ardia_state::ids::{ProfileId, WindowId};
use ardia_state::model::EffectiveLayout;
use ardia_state::settings::AddressBar;
use ardia_state::windows::{BrowserWindow, WindowKind};

fn with_windows(minimalism: bool) -> BrowserState {
    let mut state = BrowserState::default();
    let settings = Arc::make_mut(&mut state.settings);
    settings.minimalism_mode = minimalism;
    settings.address_bar = AddressBar::Toolbar;
    settings.borderless_mode = false;
    let profile = ProfileId::from(ardia_state::ids::DEFAULT_PROFILE_ID);
    let windows = Arc::make_mut(&mut state.windows);
    for (id, kind) in [
        ("main", WindowKind::Main),
        ("little", WindowKind::LittleArdia),
    ] {
        windows.insert(
            WindowId::from(id),
            Arc::new(BrowserWindow::new(
                WindowId::from(id),
                kind,
                profile.clone(),
                0,
            )),
        );
    }
    state
}

#[test]
fn minimalism_puts_the_address_in_the_sidebar_and_drops_the_frame_but_not_in_little_ardia() {
    let plain = with_windows(false);
    assert!(!plain.minimalism_in("main"));
    assert_eq!(plain.effective_layout("main"), EffectiveLayout::Sidebar);
    assert!(plain.page_frame_inset_in("main", false) > 0.0);

    let minimal = with_windows(true);
    assert!(minimal.minimalism_in("main"));
    assert_eq!(
        minimal.effective_layout("main"),
        EffectiveLayout::ArcSidebar
    );
    assert_eq!(minimal.page_frame_inset_in("main", false), 0.0);
    assert_eq!(minimal.page_frame("main", 10.0, 10.0).inset, 0.0);

    assert!(!minimal.minimalism_in("little"));
    assert_eq!(
        minimal.page_frame_inset_in("little", false),
        plain.page_frame_inset_in("little", false)
    );
}
