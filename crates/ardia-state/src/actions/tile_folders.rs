use super::*;
use crate::model::TileFolder;

pub(super) fn folder_of(tab: &Tab) -> Option<&TileFolder> {
    match &tab.pin {
        Some(TabPin::Tile { folder }) => folder.as_ref(),
        _ => None,
    }
}

impl Tx<'_> {
    pub(super) fn add_to_tile_folder(
        &mut self,
        tabs: &[TabId],
        onto: &TabId,
        before: Option<&TabId>,
    ) -> Result<(), ActionError> {
        let target = self.require_listed_tab(onto)?;
        if !target.pin.as_ref().is_some_and(TabPin::is_tile) {
            return Err(ActionError::Invalid("only a pinned tile can hold a folder"));
        }
        let folder = folder_of(&target).cloned().unwrap_or_else(|| TileFolder {
            id: self.ids.tile_folder(),
            name: String::new(),
            renamed_at: None,
        });
        let moving: Vec<TabId> = tabs
            .iter()
            .filter(|id| *id != onto)
            .filter(|id| self.require_listed_tab(id).is_ok())
            .filter(|id| {
                self.s.tabs.get(*id).is_some_and(|t| {
                    t.window_id == target.window_id
                        && t.profile_id == target.profile_id
                        && !t.profile_id.is_incognito()
                })
            })
            .fold(Vec::new(), |mut out, id| {
                push_unique(&mut out, id);
                out
            });
        if folder_of(&target) != Some(&folder)
            && let Some(t) = self.tab_mut(onto)
        {
            t.pin = Some(TabPin::Tile {
                folder: Some(folder.clone()),
            });
        }
        if moving.is_empty() {
            self.reorder_window(&target.window_id);
            return Ok(());
        }
        let gone: HashSet<TabId> = moving.iter().cloned().collect();
        let left = groups::leave_groups(&self.s.groups, &gone);
        if left != *self.s.groups {
            self.set_groups(left);
        }
        for id in &moving {
            if let Some(split) = self.s.split_of(id.as_str()).cloned() {
                let rest = split.without_panes(&HashSet::from([id.clone()]));
                self.replace_split(&split.id, Some(rest));
            }
            let home = self.s.tabs.get(id).map(|t| {
                t.pinned_url
                    .clone()
                    .filter(|h| !h.is_empty())
                    .unwrap_or_else(|| t.url.clone())
            });
            if let Some(t) = self.tab_mut(id) {
                t.pin = Some(TabPin::Tile {
                    folder: Some(folder.clone()),
                });
                t.pinned_url = home.filter(|h| !h.is_empty());
            }
        }
        let window = target.window_id.clone();
        let order = self
            .s
            .windows
            .get(&window)
            .map(|w| w.tab_ids.clone())
            .unwrap_or_default();
        let mut rest: Vec<TabId> = order.into_iter().filter(|id| !gone.contains(id)).collect();
        let at = before
            .filter(|b| !gone.contains(*b))
            .and_then(|b| rest.iter().position(|id| id == b))
            .or_else(|| {
                rest.iter()
                    .rposition(|id| {
                        self.s
                            .tabs
                            .get(id)
                            .and_then(|t| folder_of(t))
                            .is_some_and(|f| f.id == folder.id)
                    })
                    .map(|last| last + 1)
            })
            .unwrap_or(rest.len());
        rest.splice(at..at, moving.iter().cloned());
        if let Some(w) = self.window_mut(&window) {
            w.tab_ids = rest;
        }
        self.reorder_window(&window);
        Ok(())
    }

    pub(super) fn leave_tile_folder(&mut self, tabs: &[TabId]) -> Result<(), ActionError> {
        let first = tabs
            .first()
            .map(|id| self.require_listed_tab(id))
            .transpose()?
            .ok_or(ActionError::Invalid("no tab to take out of a folder"))?;
        let folder = folder_of(&first)
            .cloned()
            .ok_or(ActionError::Invalid("this tab isn't in a folder"))?;
        let window = first.window_id.clone();
        let moving: Vec<TabId> = tabs
            .iter()
            .filter(|id| {
                self.s.tabs.get(*id).is_some_and(|t| {
                    t.window_id == window && folder_of(t).is_some_and(|f| f.id == folder.id)
                })
            })
            .fold(Vec::new(), |mut out, id| {
                push_unique(&mut out, id);
                out
            });
        let gone: HashSet<TabId> = moving.iter().cloned().collect();
        let order = self
            .s
            .windows
            .get(&window)
            .map(|w| w.tab_ids.clone())
            .unwrap_or_default();
        let last_member = order.iter().rposition(|id| {
            !gone.contains(id)
                && self.s.tabs.get(id).is_some_and(|t| {
                    t.profile_id == first.profile_id
                        && folder_of(t).is_some_and(|f| f.id == folder.id)
                })
        });
        for id in &moving {
            if let Some(t) = self.tab_mut(id) {
                t.pin = Some(TabPin::TILE);
            }
        }
        if let Some(last) = last_member {
            let anchor = order[last].clone();
            let mut rest: Vec<TabId> = order.into_iter().filter(|id| !gone.contains(id)).collect();
            let at = rest
                .iter()
                .position(|id| *id == anchor)
                .map_or(rest.len(), |p| p + 1);
            rest.splice(at..at, moving.iter().cloned());
            if let Some(w) = self.window_mut(&window) {
                w.tab_ids = rest;
            }
        }
        self.reorder_window(&window);
        Ok(())
    }

    pub(super) fn rename_tile_folder(
        &mut self,
        window: &WindowId,
        folder: &str,
        name: &str,
    ) -> Result<(), ActionError> {
        let members: Vec<(TabId, TileFolder)> = self
            .s
            .tabs
            .values()
            .filter(|t| &t.window_id == window)
            .filter_map(|t| {
                folder_of(t)
                    .filter(|f| f.id == folder)
                    .map(|f| (t.id.clone(), f.clone()))
            })
            .collect();
        let Some((_, current)) = members.first() else {
            return Err(ActionError::Invalid("there's no such folder"));
        };
        let name = name.trim();
        if current.name == name {
            return Ok(());
        }
        let renamed = TileFolder {
            id: folder.to_owned(),
            name: name.to_owned(),
            renamed_at: Some(self.now.max(current.renamed_at.unwrap_or(0) + 1)),
        };
        for (id, _) in &members {
            if let Some(t) = self.tab_mut(id) {
                t.pin = Some(TabPin::Tile {
                    folder: Some(renamed.clone()),
                });
            }
        }
        Ok(())
    }
}
