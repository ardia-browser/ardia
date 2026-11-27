use core::cmp::Ordering;

use crate::UpdateError;

pub const MAX_VERSION_BYTES: usize = 64;

const NIGHTLY: &str = "-nightly.";
const MAX_PART_DIGITS: usize = 9;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Channel {
    Stable,
    Nightly,
}

impl Channel {
    pub fn name(self) -> &'static str {
        match self {
            Channel::Stable => "stable",
            Channel::Nightly => "nightly",
        }
    }

    pub fn from_name(name: &str) -> Option<Self> {
        match name {
            "stable" => Some(Channel::Stable),
            "nightly" => Some(Channel::Nightly),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct Version {
    pub major: u32,
    pub minor: u32,
    pub patch: u32,
    pub nightly: Option<u32>,
}

fn number(text: &str) -> Result<u32, UpdateError> {
    if text.is_empty() || text.len() > MAX_PART_DIGITS || !text.bytes().all(|byte| byte.is_ascii_digit()) {
        return Err(UpdateError::Version);
    }
    text.parse().map_err(|_| UpdateError::Version)
}

impl Version {
    pub fn parse(text: &str) -> Result<Version, UpdateError> {
        if text.is_empty() || text.len() > MAX_VERSION_BYTES {
            return Err(UpdateError::Version);
        }
        let (core, nightly) = match text.find('-') {
            Some(dash) => {
                let suffix = &text[dash..];
                let digits = suffix.strip_prefix(NIGHTLY).ok_or(UpdateError::Version)?;
                (&text[..dash], Some(number(digits)?))
            }
            None => (text, None),
        };
        let mut parts = core.split('.');
        let major = number(parts.next().ok_or(UpdateError::Version)?)?;
        let minor = number(parts.next().ok_or(UpdateError::Version)?)?;
        let patch = number(parts.next().ok_or(UpdateError::Version)?)?;
        if parts.next().is_some() {
            return Err(UpdateError::Version);
        }
        Ok(Version {
            major,
            minor,
            patch,
            nightly,
        })
    }

    pub fn channel(&self) -> Channel {
        if self.nightly.is_some() {
            Channel::Nightly
        } else {
            Channel::Stable
        }
    }
}

impl Ord for Version {
    fn cmp(&self, other: &Self) -> Ordering {
        (self.major, self.minor, self.patch)
            .cmp(&(other.major, other.minor, other.patch))
            .then_with(|| match (self.nightly, other.nightly) {
                (Some(left), Some(right)) => left.cmp(&right),
                (Some(_), None) => Ordering::Less,
                (None, Some(_)) => Ordering::Greater,
                (None, None) => Ordering::Equal,
            })
    }
}

impl PartialOrd for Version {
    fn partial_cmp(&self, other: &Self) -> Option<Ordering> {
        Some(self.cmp(other))
    }
}

pub fn check_offer(candidate: &str, installed: &str, channel: Channel) -> Result<(), UpdateError> {
    let candidate = Version::parse(candidate)?;
    let installed = Version::parse(installed)?;
    if channel == Channel::Stable && candidate.channel() == Channel::Nightly {
        return Err(UpdateError::Channel);
    }
    if candidate <= installed {
        return Err(UpdateError::NotNewer);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_nightly_sorts_before_its_stable_and_after_the_previous_stable() {
        let order = [
            "0.2.47",
            "0.2.48-nightly.0",
            "0.2.48-nightly.9",
            "0.2.48-nightly.10",
            "0.2.48",
            "0.2.49",
        ];
        for pair in order.windows(2) {
            assert!(
                Version::parse(pair[0]).unwrap() < Version::parse(pair[1]).unwrap(),
                "{pair:?}"
            );
        }
    }

    #[test]
    fn leading_zeros_compare_by_value() {
        assert_eq!(
            Version::parse("01.02.003")
                .unwrap()
                .cmp(&Version::parse("1.2.3").unwrap()),
            Ordering::Equal
        );
    }

    #[test]
    fn a_part_has_one_to_nine_digits() {
        assert!(Version::parse("999999999.0.0").is_ok());
        assert_eq!(Version::parse("1000000000.0.0"), Err(UpdateError::Version));
        assert_eq!(Version::parse("0.2.48-nightly.1000000000"), Err(UpdateError::Version));
    }

    #[test]
    fn offers_follow_the_channel_and_refuse_downgrades() {
        assert_eq!(check_offer("0.2.48", "0.2.47", Channel::Stable), Ok(()));
        assert_eq!(
            check_offer("0.2.48-nightly.1", "0.2.47", Channel::Stable),
            Err(UpdateError::Channel)
        );
        assert_eq!(check_offer("0.2.48-nightly.1", "0.2.47", Channel::Nightly), Ok(()));
        assert_eq!(
            check_offer("0.2.47", "0.2.48-nightly.1", Channel::Nightly),
            Err(UpdateError::NotNewer)
        );
        assert_eq!(
            check_offer("0.2.48", "0.2.48", Channel::Stable),
            Err(UpdateError::NotNewer)
        );
        assert_eq!(
            check_offer("0.2.48", "garbage", Channel::Stable),
            Err(UpdateError::Version)
        );
    }
}
