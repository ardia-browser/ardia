pub use ardia_update_core::{Channel as UpdateChannel, UpdateError, Version};

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Offer {
    Install(String),
    Skip(&'static str),
}

pub fn evaluate_offer(candidate: &str, installed: &str, channel: UpdateChannel) -> Offer {
    match ardia_update_core::check_offer(candidate, installed, channel) {
        Ok(()) => Offer::Install(candidate.to_owned()),
        Err(error) => Offer::Skip(error.code()),
    }
}

pub fn channel_of(version: &str) -> Option<UpdateChannel> {
    Version::parse(version).ok().map(|v| v.channel())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stable_skips_nightlies_and_nightly_takes_both() {
        assert_eq!(
            evaluate_offer("0.3.1", "0.3.0", UpdateChannel::Stable),
            Offer::Install("0.3.1".into())
        );
        assert!(matches!(
            evaluate_offer("0.3.1-nightly.2", "0.3.0", UpdateChannel::Stable),
            Offer::Skip(_)
        ));
        assert_eq!(
            evaluate_offer("0.3.1-nightly.2", "0.3.0", UpdateChannel::Nightly),
            Offer::Install("0.3.1-nightly.2".into())
        );
        assert!(matches!(
            evaluate_offer("0.2.0", "0.3.0", UpdateChannel::Nightly),
            Offer::Skip(_)
        ));
        assert!(matches!(
            evaluate_offer("garbage", "0.3.0", UpdateChannel::Stable),
            Offer::Skip(_)
        ));
        assert_eq!(channel_of("0.2.49-nightly.1"), Some(UpdateChannel::Nightly));
        assert_eq!(channel_of("0.2.49"), Some(UpdateChannel::Stable));
        assert_eq!(channel_of("x"), None);
    }
}
