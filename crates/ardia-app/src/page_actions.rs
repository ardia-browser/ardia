use std::path::{Path, PathBuf};

use ardia_engine::TabAction;
use ardia_state::actions::{Action, NewTab};
use ardia_state::windows::WindowKind;
use ardia_state::{TabId, WindowId};
use ardia_ui::PageCommand;

use crate::coordinator::AppCoordinator;
use crate::menu_bridge::{IDC_BASIC_PRINT, IDC_PRINT, IDC_SAVE_PAGE, focused_window};

pub const MAX_FILES_OPENED_AT_ONCE: usize = 20;

pub fn chrome_command_for(command: PageCommand) -> i32 {
    match command {
        PageCommand::Print => IDC_PRINT,
        PageCommand::PrintWithSystemDialog => IDC_BASIC_PRINT,
        PageCommand::SavePage => IDC_SAVE_PAGE,
    }
}

pub fn file_url(path: &Path) -> Option<String> {
    path.is_absolute()
        .then(|| url::Url::from_file_path(path).ok())
        .flatten()
        .map(String::from)
}

impl AppCoordinator {
    pub fn run_page_command(&self, tab: &TabId, command: PageCommand) -> Result<(), String> {
        if self.internal_page_of(tab).is_some() {
            return Err("Ardia's own pages can't be printed or saved".into());
        }
        let (Some(engine), Some(engine_tab)) = (self.engine(), self.engine_tab(tab)) else {
            return Err("the page isn't open in the engine".into());
        };
        let ran = engine
            .tab_action(
                engine_tab,
                TabAction::ExecuteChromeCommand {
                    command: chrome_command_for(command),
                },
            )
            .map_err(|problem| problem.to_string())?;
        if ran {
            Ok(())
        } else {
            Err("the page can't do that right now".into())
        }
    }

    pub fn choose_files_to_open(&self, window: Option<WindowId>) -> Result<(), String> {
        let engine = self.engine().ok_or("there's no engine")?;
        let state = self.store.snapshot();
        let window = window.or_else(|| focused_window(&state));
        let private = window
            .as_ref()
            .and_then(|id| state.window(id.as_str()))
            .is_some_and(|shown| {
                shown.kind == WindowKind::Incognito || shown.profile_id.is_incognito()
            });
        let parent = window
            .as_ref()
            .filter(|_| self.config.hosts_native_windows)
            .and_then(|id| self.engine_window(id));
        let reply = engine.choose_files_to_open(parent);
        let me = self.weak();
        self.spawn(async move {
            match reply.await {
                Ok(paths) => {
                    if let Some(me) = me.upgrade() {
                        me.open_chosen_files(window.as_ref(), private, paths);
                    }
                }
                Err(problem) => log::debug!("the open panel didn't answer: {problem}"),
            }
        });
        Ok(())
    }

    fn files_window(&self, requested: Option<&WindowId>, private: bool) -> Option<WindowId> {
        let state = self.store.snapshot();
        if let Some(requested) = requested.filter(|id| state.window(id.as_str()).is_some()) {
            return Some(requested.clone());
        }
        if private {
            return None;
        }
        let main = |id: &&WindowId| {
            state
                .window(id.as_str())
                .is_some_and(|w| w.kind != WindowKind::LittleArdia && w.kind.has_tabs())
        };
        state
            .focus_order
            .iter()
            .find(main)
            .or_else(|| state.window_order.iter().find(main))
            .cloned()
    }

    pub fn open_chosen_files(
        &self,
        requested: Option<&WindowId>,
        private: bool,
        paths: Vec<PathBuf>,
    ) {
        let mut urls = paths
            .iter()
            .take(MAX_FILES_OPENED_AT_ONCE)
            .filter_map(|path| file_url(path))
            .peekable();
        if urls.peek().is_none() {
            return;
        }
        let target = match self.files_window(requested, private) {
            Some(target) => target,
            None if private => {
                log::debug!("files chosen for a closed private window are dropped");
                return;
            }
            None => {
                let Some(first) = urls.next() else {
                    return;
                };
                match self.dispatch_action(Action::OpenWindow {
                    kind: WindowKind::Main,
                    profile: None,
                    url: Some(first),
                    frame: None,
                }) {
                    Ok(outcome) => match outcome.window {
                        Some(window) => window,
                        None => return,
                    },
                    Err(problem) => {
                        log::debug!("a chosen file didn't open: {problem}");
                        return;
                    }
                }
            }
        };
        let mut last = None;
        for url in urls {
            match self.dispatch_action(Action::NewTab {
                window: target.clone(),
                tab: NewTab {
                    url: Some(url),
                    ..NewTab::default()
                },
            }) {
                Ok(outcome) => last = outcome.tab.or(last),
                Err(problem) => log::debug!("a chosen file didn't open: {problem}"),
            }
        }
        if let Some(tab) = last {
            let _ = self.dispatch_action(Action::ActivateTab { tab });
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn files_become_file_urls() {
        assert_eq!(
            file_url(Path::new("/tmp/a b/c#d.html")).as_deref(),
            Some("file:///tmp/a%20b/c%23d.html")
        );
        assert_eq!(file_url(Path::new("relative.html")), None);
        assert_eq!(chrome_command_for(PageCommand::SavePage), IDC_SAVE_PAGE);
    }
}
