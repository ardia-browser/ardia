use crate::{BrowserState, ProfileId};

fn data_of(state: &BrowserState, id: &ProfileId) -> Option<String> {
    let profile = state.profiles.get(id)?;
    Some(
        profile
            .data_id
            .clone()
            .unwrap_or_else(|| profile.id.to_string()),
    )
}

pub fn sharing_profiles(state: &BrowserState, id: &ProfileId) -> Vec<ProfileId> {
    let Some(data) = data_of(state, id) else {
        return Vec::new();
    };
    state
        .profile_order
        .iter()
        .filter(|other| *other != id && data_of(state, other).as_deref() == Some(data.as_str()))
        .cloned()
        .collect()
}

pub fn shared_with(state: &BrowserState, id: &ProfileId) -> Vec<ProfileId> {
    let others = sharing_profiles(state, id);
    if others.is_empty() {
        return vec![id.clone()];
    }
    state
        .profile_order
        .iter()
        .filter(|other| *other == id || others.contains(other))
        .cloned()
        .collect()
}

pub fn data_sharing_profile_ids(state: &BrowserState) -> Vec<ProfileId> {
    state
        .profile_order
        .iter()
        .filter(|id| !sharing_profiles(state, id).is_empty())
        .cloned()
        .collect()
}

pub fn top_app_siblings(state: &BrowserState, id: &ProfileId) -> Vec<ProfileId> {
    let shares = |profile: &ProfileId| {
        state
            .profiles
            .get(profile)
            .is_some_and(|found| found.share_top_apps)
    };
    if !shares(id) {
        return Vec::new();
    }
    sharing_profiles(state, id)
        .into_iter()
        .filter(|other| shares(other))
        .collect()
}

pub fn list_of(names: &[String], joiner: &str) -> String {
    match names {
        [] => String::new(),
        [one] => one.clone(),
        [a, b] => format!("{a} {joiner} {b}"),
        [rest @ .., last] => format!("{}, {joiner} {last}", rest.join(", ")),
    }
}

pub fn top_apps_description(state: &BrowserState, id: &ProfileId) -> String {
    let name_of = |profile: &ProfileId| {
        state
            .profiles
            .get(profile)
            .map(|found| found.name.clone())
            .unwrap_or_default()
    };
    let own = !state
        .profiles
        .get(id)
        .is_some_and(|found| found.share_top_apps);
    if own {
        return "Keeps its own Top Apps.".to_owned();
    }
    let siblings: Vec<String> = top_app_siblings(state, id).iter().map(name_of).collect();
    if !siblings.is_empty() {
        return format!(
            "Same Top Apps as {}, one live page each.",
            list_of(&siblings, "and")
        );
    }
    let others: Vec<String> = shared_with(state, id)
        .iter()
        .filter(|other| *other != id)
        .map(name_of)
        .collect();
    format!("Shares once {} does.", list_of(&others, "or"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::actions::ProfilePatch;
    use crate::{Action, BrowserStore, IdGen};

    fn names(list: &[&str]) -> Vec<String> {
        list.iter().map(|s| (*s).to_owned()).collect()
    }

    #[test]
    fn lists_read_like_the_old_list_of() {
        assert_eq!(list_of(&names(&["A"]), "and"), "A");
        assert_eq!(list_of(&names(&["A", "B"]), "and"), "A and B");
        assert_eq!(list_of(&names(&["A", "B", "C"]), "or"), "A, B, or C");
    }

    fn three_profiles() -> (BrowserState, ProfileId, ProfileId, ProfileId) {
        let mut state = BrowserState::default();
        let ids: Vec<ProfileId> = ["work", "side", "home"]
            .iter()
            .map(|id| ProfileId::new(*id))
            .collect();
        let profiles = std::sync::Arc::make_mut(&mut state.profiles);
        profiles.clear();
        for (index, id) in ids.iter().enumerate() {
            let mut profile = crate::profiles::Profile::new(
                id.clone(),
                ["Work", "Side", "Home"][index],
                ardia_theme::ProfileColor::Plum,
                0,
            );
            profile.data_id = (index == 1).then(|| "work".to_owned());
            profiles.insert(id.clone(), std::sync::Arc::new(profile));
        }
        state.profile_order = std::sync::Arc::new(ids.clone());
        (state, ids[0].clone(), ids[1].clone(), ids[2].clone())
    }

    #[test]
    fn sharing_follows_the_data_id() {
        let (state, work, side, home) = three_profiles();
        assert_eq!(sharing_profiles(&state, &work), vec![side.clone()]);
        assert_eq!(shared_with(&state, &side), vec![work.clone(), side.clone()]);
        assert_eq!(shared_with(&state, &home), vec![home.clone()]);
        assert_eq!(data_sharing_profile_ids(&state), vec![work, side]);
    }

    #[test]
    fn top_apps_descriptions_match_the_old_copy() {
        let (state, work, side, _) = three_profiles();
        assert_eq!(
            top_apps_description(&state, &work),
            "Keeps its own Top Apps."
        );
        let store = BrowserStore::in_memory(state, IdGen::with_launch("t"));
        store
            .dispatch(Action::UpdateProfile {
                profile: work.clone(),
                patch: ProfilePatch {
                    share_top_apps: Some(true),
                    ..ProfilePatch::default()
                },
            })
            .unwrap();
        let state = store.snapshot();
        assert_eq!(
            top_apps_description(&state, &work),
            "Shares once Side does."
        );
        store
            .dispatch(Action::UpdateProfile {
                profile: side.clone(),
                patch: ProfilePatch {
                    share_top_apps: Some(true),
                    ..ProfilePatch::default()
                },
            })
            .unwrap();
        let state = store.snapshot();
        assert_eq!(
            top_apps_description(&state, &work),
            "Same Top Apps as Side, one live page each."
        );
        assert_eq!(top_app_siblings(&state, &side), vec![work]);
    }
}
