use std::sync::Arc;

use parking_lot::{Mutex, RwLock};

#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub struct Consent(Arc<str>);

impl Consent {
    pub fn epoch(&self) -> &str {
        &self.0
    }

    pub fn from_epoch(epoch: &str) -> Option<Consent> {
        (!epoch.is_empty()).then(|| Consent(Arc::from(epoch)))
    }
}

type Listener = Arc<dyn Fn() + Send + Sync>;

static PERIOD: RwLock<Option<Consent>> = RwLock::new(None);
static LISTENERS: Mutex<Vec<Listener>> = Mutex::new(Vec::new());

pub fn consent_now() -> Option<Consent> {
    PERIOD.read().clone()
}

pub fn consent_epoch() -> String {
    PERIOD
        .read()
        .as_ref()
        .map(|consent| consent.epoch().to_owned())
        .unwrap_or_default()
}

pub fn still_valid(consent: Option<&Consent>) -> bool {
    match (consent, PERIOD.read().as_ref()) {
        (Some(token), Some(current)) => token == current,
        _ => false,
    }
}

pub fn counted(consent: Option<&Consent>, count: impl FnOnce()) -> bool {
    let valid = still_valid(consent);
    if valid {
        count();
    }
    valid
}

pub fn native_consent(epoch: Option<&str>) -> Option<Consent> {
    epoch.and_then(Consent::from_epoch)
}

pub fn on_period_change(listener: impl Fn() + Send + Sync + 'static) {
    LISTENERS.lock().push(Arc::new(listener));
}

pub(crate) fn set_period(sharing: bool, epoch: Option<&str>) {
    let next = if sharing {
        epoch.and_then(Consent::from_epoch)
    } else {
        None
    };
    let changed = {
        let mut current = PERIOD.write();
        let changed = *current != next;
        *current = next;
        changed
    };
    if changed {
        let listeners: Vec<Listener> = LISTENERS.lock().clone();
        for listener in listeners {
            listener();
        }
    }
}
