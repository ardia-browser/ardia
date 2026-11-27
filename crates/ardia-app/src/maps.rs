use std::collections::HashMap;
use std::hash::Hash;

use ardia_engine::EngineProfileId;
use ardia_state::ProfileId;

#[derive(Clone, Debug)]
pub struct BiMap<A, B> {
    forward: HashMap<A, B>,
    backward: HashMap<B, A>,
}

impl<A, B> Default for BiMap<A, B> {
    fn default() -> Self {
        Self {
            forward: HashMap::new(),
            backward: HashMap::new(),
        }
    }
}

impl<A: Clone + Eq + Hash, B: Clone + Eq + Hash> BiMap<A, B> {
    pub fn insert(&mut self, a: A, b: B) {
        if let Some(old) = self.forward.insert(a.clone(), b.clone())
            && old != b
        {
            self.backward.remove(&old);
        }
        if let Some(old) = self.backward.insert(b, a.clone())
            && old != a
        {
            self.forward.remove(&old);
        }
    }

    pub fn by_left(&self, a: &A) -> Option<&B> {
        self.forward.get(a)
    }

    pub fn by_right(&self, b: &B) -> Option<&A> {
        self.backward.get(b)
    }

    pub fn remove_left(&mut self, a: &A) -> Option<B> {
        let b = self.forward.remove(a)?;
        self.backward.remove(&b);
        Some(b)
    }

    pub fn remove_right(&mut self, b: &B) -> Option<A> {
        let a = self.backward.remove(b)?;
        self.forward.remove(&a);
        Some(a)
    }

    pub fn len(&self) -> usize {
        self.forward.len()
    }

    pub fn is_empty(&self) -> bool {
        self.forward.is_empty()
    }

    pub fn iter(&self) -> impl Iterator<Item = (&A, &B)> {
        self.forward.iter()
    }

    pub fn lefts(&self) -> Vec<A> {
        self.forward.keys().cloned().collect()
    }

    pub fn clear(&mut self) {
        self.forward.clear();
        self.backward.clear();
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ProfileOwner {
    Regular(ProfileId),
    Private(ProfileId),
}

impl ProfileOwner {
    pub fn of(profile: &ProfileId) -> Self {
        if profile.is_incognito() {
            ProfileOwner::Private(profile.incognito_original())
        } else {
            ProfileOwner::Regular(profile.clone())
        }
    }

    pub fn is_private(&self) -> bool {
        matches!(self, ProfileOwner::Private(_))
    }

    pub fn original(&self) -> &ProfileId {
        match self {
            ProfileOwner::Regular(profile) | ProfileOwner::Private(profile) => profile,
        }
    }
}

#[derive(Clone, Debug, Default)]
pub struct ProfileMap {
    engine: HashMap<ProfileId, EngineProfileId>,
    owners: HashMap<EngineProfileId, ProfileOwner>,
}

impl ProfileMap {
    pub fn insert(&mut self, profile: ProfileId, engine_profile: EngineProfileId) {
        let owner = ProfileOwner::of(&profile);
        if let Some(known) = self.owners.get(&engine_profile)
            && known.is_private() != owner.is_private()
        {
            log::warn!("{engine_profile} is private to one profile and regular to another");
        }
        self.engine.insert(profile, engine_profile);
        let keep = owner.is_private() && self.owners.contains_key(&engine_profile);
        if !keep {
            self.owners.insert(engine_profile, owner);
        }
    }

    pub fn alias(&mut self, profile: ProfileId, engine_profile: EngineProfileId) {
        self.engine.insert(profile, engine_profile);
    }

    pub fn note_owner(&mut self, engine_profile: EngineProfileId, owner: ProfileOwner) {
        self.owners.entry(engine_profile).or_insert(owner);
    }

    pub fn forget(&mut self, profile: &ProfileId) {
        if let Some(engine_profile) = self.engine.remove(profile)
            && !self.engine.values().any(|other| *other == engine_profile)
        {
            self.owners.remove(&engine_profile);
        }
    }

    pub fn engine_of(&self, profile: &ProfileId) -> Option<EngineProfileId> {
        self.engine.get(profile).copied()
    }

    pub fn owner(&self, engine_profile: EngineProfileId) -> Option<&ProfileOwner> {
        self.owners.get(&engine_profile)
    }

    pub fn engine_profiles(&self) -> Vec<EngineProfileId> {
        self.owners.keys().copied().collect()
    }

    pub fn retain_private(&mut self, keep: impl Fn(&ProfileId) -> bool) {
        self.engine
            .retain(|profile, _| !profile.is_incognito() || keep(profile));
    }

    pub fn len(&self) -> usize {
        self.engine.len()
    }

    pub fn is_empty(&self) -> bool {
        self.engine.is_empty()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn engine_profile(raw: u64) -> EngineProfileId {
        EngineProfileId::from_raw(raw).unwrap()
    }

    #[test]
    fn private_windows_share_one_engine_profile() {
        let mut map = ProfileMap::default();
        let regular = ProfileId::new("p-1");
        let first = ProfileId::incognito(&ardia_state::WindowId::new("w-1"), &regular);
        let second = ProfileId::incognito(&ardia_state::WindowId::new("w-2"), &regular);
        map.insert(regular.clone(), engine_profile(1));
        map.insert(first.clone(), engine_profile(2));
        map.insert(second.clone(), engine_profile(2));
        assert_eq!(map.engine_of(&first), Some(engine_profile(2)));
        assert_eq!(map.engine_of(&second), Some(engine_profile(2)));
        assert_eq!(
            map.owner(engine_profile(2)),
            Some(&ProfileOwner::Private(regular.clone()))
        );
        assert_eq!(
            map.owner(engine_profile(1)),
            Some(&ProfileOwner::Regular(regular.clone()))
        );
        map.retain_private(|profile| profile == &second);
        assert_eq!(map.engine_of(&first), None);
        assert_eq!(map.engine_of(&second), Some(engine_profile(2)));
        assert_eq!(map.engine_of(&regular), Some(engine_profile(1)));
        let mut owners = map.engine_profiles();
        owners.sort();
        assert_eq!(owners, vec![engine_profile(1), engine_profile(2)]);
        let stranger = ProfileId::incognito(&ardia_state::WindowId::new("w-3"), &regular);
        map.alias(stranger.clone(), engine_profile(4));
        assert_eq!(map.engine_of(&stranger), Some(engine_profile(4)));
        assert_eq!(
            map.owner(engine_profile(4)),
            None,
            "an alias never claims an owner"
        );
        map.note_owner(engine_profile(3), ProfileOwner::Private(regular.clone()));
        map.note_owner(engine_profile(3), ProfileOwner::Regular(regular));
        assert!(
            map.owner(engine_profile(3))
                .is_some_and(ProfileOwner::is_private)
        );
    }

    #[test]
    fn both_sides_stay_one_to_one() {
        let mut map: BiMap<&str, u32> = BiMap::default();
        map.insert("a", 1);
        map.insert("b", 2);
        map.insert("a", 3);
        assert_eq!(map.by_left(&"a"), Some(&3));
        assert_eq!(map.by_right(&1), None, "a's old partner is forgotten");
        map.insert("c", 2);
        assert_eq!(map.by_left(&"b"), None, "b lost 2 to c");
        assert_eq!(map.by_right(&2), Some(&"c"));
        assert_eq!(map.len(), 2);
        assert_eq!(map.remove_right(&3), Some("a"));
        assert_eq!(map.remove_left(&"c"), Some(2));
        assert!(map.is_empty());
    }
}
