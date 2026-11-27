use super::*;

pub fn can_move_group(
    groups: &groups::Groups,
    group: &GroupId,
    before: Option<&TabId>,
    parent: Option<&GroupId>,
) -> bool {
    let Some(g) = groups.get(group) else {
        return false;
    };
    if before.is_some_and(|b| g.tab_ids.contains(b)) {
        return false;
    }
    if let Some(parent) = parent {
        let Some(p) = groups.get(parent) else {
            return false;
        };
        if parent == group
            || p.window_id != g.window_id
            || p.profile_id != g.profile_id
            || groups::ancestors(groups, parent.as_str()).contains(group)
        {
            return false;
        }
    }
    let staying: HashSet<GroupId> = parent
        .map(|p| {
            let mut chain = groups::ancestors(groups, p.as_str());
            chain.push(p.clone());
            chain.into_iter().collect()
        })
        .unwrap_or_default();
    let moving: HashSet<&TabId> = g.tab_ids.iter().collect();
    groups::ancestors(groups, group.as_str()).iter().all(|a| {
        staying.contains(a)
            || groups
                .get(a)
                .is_some_and(|ag| ag.tab_ids.iter().any(|t| !moving.contains(t)))
    })
}

impl Tx<'_> {
    pub(super) fn move_group(
        &mut self,
        group: &GroupId,
        before: Option<&TabId>,
        pinned: bool,
        parent: Option<&GroupId>,
    ) -> Result<(), ActionError> {
        let was = Arc::clone(&self.s.groups);
        let g = was
            .get(group)
            .cloned()
            .ok_or_else(|| ActionError::NoGroup(group.to_string()))?;
        let window = self.require_window(&g.window_id)?;
        if !can_move_group(&was, group, before, parent) {
            return Err(ActionError::Invalid("the group can't move there"));
        }
        let parent_group = parent.and_then(|p| was.get(p)).cloned();
        let pinned = parent_group.as_ref().map_or(pinned, |p| p.pinned);
        let moving: HashSet<TabId> = g.tab_ids.iter().cloned().collect();
        let staying: HashSet<GroupId> = parent_group
            .as_ref()
            .map(|p| {
                let mut chain = groups::ancestors(&was, p.id.as_str());
                chain.push(p.id.clone());
                chain.into_iter().collect()
            })
            .unwrap_or_default();
        let mut next = (*was).clone();
        for a in groups::ancestors(&was, group.as_str()) {
            if staying.contains(&a) {
                continue;
            }
            if let Some(ag) = next.get_mut(&a) {
                Arc::make_mut(ag).tab_ids.retain(|t| !moving.contains(t));
            }
        }
        let moved_ids: Vec<GroupId> = std::iter::once(group.clone())
            .chain(groups::descendants(&was, group.as_str()))
            .collect();
        for id in &moved_ids {
            if let Some(mg) = next.get_mut(id) {
                Arc::make_mut(mg).pinned = pinned;
            }
        }
        if let Some(mg) = next.get_mut(group) {
            Arc::make_mut(mg).parent_id = parent_group.as_ref().map(|p| p.id.clone());
        }
        groups::reparent(&mut next, &was);
        let next = groups::nest_groups(&next);
        let rest: Vec<TabId> = window
            .tab_ids
            .iter()
            .filter(|t| !moving.contains(*t))
            .cloned()
            .collect();
        let at = if let Some(before) = before.filter(|b| rest.contains(b)) {
            let inner = groups::innermost_group_of(&next, before.as_str());
            let chain: Vec<GroupId> = inner
                .map(|i| {
                    let mut chain = vec![i.clone()];
                    chain.extend(groups::ancestors(&next, i.as_str()));
                    chain
                })
                .unwrap_or_default();
            let parent_id = parent_group.as_ref().map(|p| p.id.clone());
            let block = chain
                .iter()
                .filter_map(|id| next.get(id))
                .find(|x| x.parent_id == parent_id && Some(&x.id) != parent_id.as_ref());
            let anchor = block
                .and_then(|b| b.tab_ids.iter().find(|t| rest.contains(t)))
                .unwrap_or(before);
            rest.iter().position(|t| t == anchor).unwrap_or(rest.len())
        } else if let Some(p) = &parent_group {
            let kept: Vec<&TabId> = next
                .get(&p.id)
                .map(|pg| pg.tab_ids.iter().filter(|t| rest.contains(t)).collect())
                .unwrap_or_default();
            match kept.last() {
                Some(last) => rest
                    .iter()
                    .position(|t| t == *last)
                    .map_or(rest.len(), |i| i + 1),
                None => window
                    .tab_ids
                    .iter()
                    .position(|t| Some(t) == g.tab_ids.first())
                    .unwrap_or(rest.len())
                    .min(rest.len()),
            }
        } else if pinned {
            let pinned_group: HashSet<TabId> = next
                .values()
                .filter(|x| x.pinned && !x.tab_ids.first().is_some_and(|t| moving.contains(t)))
                .flat_map(|x| x.tab_ids.iter().cloned())
                .collect();
            rest.iter()
                .rposition(|t| {
                    self.s.tabs.get(t).is_some_and(|tab| tab.pin.is_some())
                        || pinned_group.contains(t)
                })
                .map_or(0, |i| i + 1)
        } else {
            rest.len()
        };
        let mut order = rest;
        order.splice(at..at, g.tab_ids.iter().cloned());
        self.set_groups(next);
        if let Some(w) = self.window_mut(&window.id) {
            w.tab_ids = order;
        }
        self.reorder_window(&window.id);
        Ok(())
    }
}
