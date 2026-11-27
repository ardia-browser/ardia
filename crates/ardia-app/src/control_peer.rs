use crate::control_approvals::StoredApproval;

pub const TEST_ENV: &str = "ARDIA_TEST";
pub const DOORBELL_TEST_KEY: &str = "controlDoorbell";
pub const DOORBELL_SHOWN_IN_BACKGROUND: &str = "shown";
pub const HALF_HOUR_SECONDS: f64 = 30.0 * 60.0;
const NAME_LIMIT: usize = 64;
const DEVELOPER_LIMIT: usize = 80;
pub const PATH_LIMIT: usize = 1024;

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Signer {
    Team(String),
    Apple,
    Other,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ControlPeer {
    pub pid: i32,
    pub path: Option<String>,
    pub identifier: Option<String>,
    pub signer: Signer,
    pub developer: Option<String>,
    pub cdhash: Option<String>,
    pub hardened: bool,
    pub bundle_name: Option<String>,
}

impl ControlPeer {
    pub fn unknown(pid: i32) -> Self {
        Self {
            pid,
            path: None,
            identifier: None,
            signer: Signer::Other,
            developer: None,
            cdhash: None,
            hardened: false,
            bundle_name: None,
        }
    }

    pub fn approval_key(&self) -> Option<String> {
        let identifier = self.identifier.as_deref().filter(|id| !id.is_empty());
        match &self.signer {
            Signer::Team(team) => identifier.map(|id| format!("team:{team}:{id}")),
            Signer::Apple => identifier.map(|id| format!("apple:{id}")),
            Signer::Other => match (&self.path, &self.cdhash) {
                (Some(path), Some(cdhash)) => Some(format!("code:{cdhash}:{path}")),
                _ => None,
            },
        }
    }

    pub fn name(&self) -> String {
        if let Some(bundle) = self.bundle_name.as_deref().filter(|b| !b.is_empty()) {
            return plain(bundle, NAME_LIMIT);
        }
        if let Some(path) = &self.path {
            let last = path
                .rsplit('/')
                .find(|part| !part.is_empty())
                .unwrap_or(path);
            return plain(last, NAME_LIMIT);
        }
        if let Some(identifier) = &self.identifier {
            return plain(identifier, NAME_LIMIT);
        }
        "An unknown program".to_owned()
    }

    pub fn signed_by(&self) -> String {
        match &self.signer {
            Signer::Team(team) => match self.developer.as_deref().filter(|d| !d.is_empty()) {
                Some(developer) => {
                    format!("Signed by {} ({team})", plain(developer, DEVELOPER_LIMIT))
                }
                None => format!("Signed by developer team {team}"),
            },
            Signer::Apple => "Part of macOS, signed by Apple".to_owned(),
            Signer::Other => "Not signed by an identified developer".to_owned(),
        }
    }

    pub fn same_code_as(&self, other: &ControlPeer) -> bool {
        self.cdhash.is_some() && self.cdhash == other.cdhash && self.path == other.path
    }

    pub fn approval(&self, key: &str, added: f64, until: Option<f64>) -> StoredApproval {
        StoredApproval {
            key: key.to_owned(),
            name: self.name(),
            signed_by: self.signed_by(),
            path: self.path.as_deref().map(|path| plain(path, PATH_LIMIT)),
            added,
            until,
        }
    }
}

fn is_format(c: char) -> bool {
    matches!(
        c,
        '\u{00AD}'
            | '\u{0600}'..='\u{0605}'
            | '\u{061C}'
            | '\u{06DD}'
            | '\u{070F}'
            | '\u{0890}'..='\u{0891}'
            | '\u{08E2}'
            | '\u{180E}'
            | '\u{200B}'..='\u{200F}'
            | '\u{202A}'..='\u{202E}'
            | '\u{2060}'..='\u{2064}'
            | '\u{2066}'..='\u{206F}'
            | '\u{FEFF}'
            | '\u{FFF9}'..='\u{FFFB}'
            | '\u{110BD}'
            | '\u{110CD}'
            | '\u{13430}'..='\u{1343F}'
            | '\u{1BCA0}'..='\u{1BCA3}'
            | '\u{1D173}'..='\u{1D17A}'
            | '\u{E0001}'
            | '\u{E0020}'..='\u{E007F}'
    )
}

fn is_noncharacter(c: char) -> bool {
    let code = u32::from(c);
    (0xFDD0..=0xFDEF).contains(&code) || code & 0xFFFE == 0xFFFE
}

pub fn plain(text: &str, limit: usize) -> String {
    let kept: Vec<char> = text
        .chars()
        .filter(|c| !c.is_control() && !is_format(*c) && !is_noncharacter(*c))
        .collect();
    if kept.len() > limit {
        let mut cut: String = kept[..limit.saturating_sub(1)].iter().collect();
        cut.push('…');
        cut
    } else {
        kept.into_iter().collect()
    }
}

pub fn developer_name(summary: &str) -> String {
    let mut name = summary;
    if let Some((_, after)) = name.split_once(": ") {
        name = after;
    }
    if name.ends_with(')')
        && let Some(open) = name.rfind(" (")
    {
        name = &name[..open];
    }
    name.to_owned()
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Verdict {
    Ardia,
    SameUser,
    Approved(String),
    Ask(Option<String>),
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Policy {
    pub own_team: Option<String>,
    pub own_code: Option<ControlPeer>,
    pub same_user_is_enough: bool,
    pub shown_in_background: bool,
}

impl Policy {
    pub fn for_launch(scratch: bool, test: Option<&str>) -> Self {
        let me = resolve_self();
        let test_instance = scratch && !signed_for_distribution();
        let doorbell_test = test
            .filter(|_| test_instance)
            .and_then(|text| test_value(text, DOORBELL_TEST_KEY));
        Self {
            own_team: match &me.signer {
                Signer::Team(team) => Some(team.clone()),
                _ => None,
            },
            own_code: Some(me),
            same_user_is_enough: test_instance && !doorbell_test.as_deref().is_some_and(truthy),
            shown_in_background: doorbell_test.as_deref() == Some(DOORBELL_SHOWN_IN_BACKGROUND),
        }
    }

    pub fn verdict(
        &self,
        peer: &ControlPeer,
        approvals: &[StoredApproval],
        now_seconds: f64,
    ) -> Verdict {
        if self.same_user_is_enough {
            return Verdict::SameUser;
        }
        if let (Some(own), Signer::Team(team)) = (&self.own_team, &peer.signer)
            && team == own
            && peer.hardened
        {
            return Verdict::Ardia;
        }
        if self
            .own_code
            .as_ref()
            .is_some_and(|me| me.same_code_as(peer))
        {
            return Verdict::Ardia;
        }
        let key = peer.approval_key();
        if let Some(key) = &key
            && approvals
                .iter()
                .any(|a| &a.key == key && a.live(now_seconds))
        {
            return Verdict::Approved(key.clone());
        }
        Verdict::Ask(key)
    }
}

pub fn truthy(value: &str) -> bool {
    !matches!(value, "0" | "off" | "false")
}

pub fn test_value(text: &str, wanted: &str) -> Option<String> {
    text.split(',').find_map(|piece| {
        let (key, value) = match piece.split_once('=') {
            Some((key, value)) => (key.trim(), value.trim()),
            None => (piece.trim(), "1"),
        };
        (key == wanted).then(|| value.to_owned())
    })
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct PeerToken(pub [u32; 8]);

impl PeerToken {
    pub fn pid(&self) -> i32 {
        self.0[5] as i32
    }

    pub fn process(&self) -> String {
        format!("{}:{}", self.0[5], self.0[7])
    }
}

#[cfg(target_os = "macos")]
pub use mac::{alive, peer_token, resolve, resolve_self, signed_for_distribution};

#[cfg(not(target_os = "macos"))]
pub fn peer_token(_: std::os::fd::RawFd) -> Option<PeerToken> {
    None
}

#[cfg(not(target_os = "macos"))]
pub fn alive(_: &PeerToken) -> bool {
    false
}

#[cfg(not(target_os = "macos"))]
pub fn resolve(token: &PeerToken) -> ControlPeer {
    ControlPeer::unknown(token.pid())
}

#[cfg(not(target_os = "macos"))]
pub fn resolve_self() -> ControlPeer {
    ControlPeer::unknown(std::process::id() as i32)
}

#[cfg(not(target_os = "macos"))]
pub fn signed_for_distribution() -> bool {
    false
}

#[cfg(target_os = "macos")]
mod mac {
    use std::ffi::c_void;

    use objc2::msg_send;
    use objc2::rc::Retained;
    use objc2::runtime::AnyObject;
    use objc2_foundation::{NSData, NSNumber, NSString, NSURL};

    use super::{ControlPeer, PeerToken, Signer, developer_name};

    type OSStatus = i32;
    type CFTypeRef = *const c_void;

    const SOL_LOCAL: libc::c_int = 0;
    const LOCAL_PEERTOKEN: libc::c_int = 6;
    const SIGNING_INFORMATION: u32 = 1 << 1;
    const DYNAMIC_INFORMATION: u32 = 1 << 3;
    const CODE_SIGNING_RUNTIME: u32 = 0x10000;
    const DISTRIBUTION: &str = "anchor apple generic and (certificate leaf[field.1.2.840.113635.100.6.1.9] exists or certificate 1[field.1.2.840.113635.100.6.2.6] exists and certificate leaf[field.1.2.840.113635.100.6.1.13] exists)";

    #[link(name = "Security", kind = "framework")]
    unsafe extern "C" {
        static kSecGuestAttributeAudit: CFTypeRef;
        static kSecCodeInfoMainExecutable: CFTypeRef;
        static kSecCodeInfoIdentifier: CFTypeRef;
        static kSecCodeInfoUnique: CFTypeRef;
        static kSecCodeInfoFlags: CFTypeRef;
        static kSecCodeInfoTeamIdentifier: CFTypeRef;
        static kSecCodeInfoPList: CFTypeRef;
        static kSecCodeInfoCertificates: CFTypeRef;
        fn SecCodeCopyGuestWithAttributes(
            host: CFTypeRef,
            attributes: CFTypeRef,
            flags: u32,
            guest: *mut CFTypeRef,
        ) -> OSStatus;
        fn SecCodeCopySelf(flags: u32, code: *mut CFTypeRef) -> OSStatus;
        fn SecCodeCopyStaticCode(code: CFTypeRef, flags: u32, out: *mut CFTypeRef) -> OSStatus;
        fn SecCodeCopySigningInformation(
            code: CFTypeRef,
            flags: u32,
            information: *mut CFTypeRef,
        ) -> OSStatus;
        fn SecCodeCopyPath(code: CFTypeRef, flags: u32, path: *mut CFTypeRef) -> OSStatus;
        fn SecRequirementCreateWithString(
            text: CFTypeRef,
            flags: u32,
            requirement: *mut CFTypeRef,
        ) -> OSStatus;
        fn SecCodeCheckValidity(code: CFTypeRef, flags: u32, requirement: CFTypeRef) -> OSStatus;
        fn SecCertificateCopySubjectSummary(certificate: CFTypeRef) -> CFTypeRef;
    }

    #[link(name = "CoreFoundation", kind = "framework")]
    unsafe extern "C" {
        fn CFRelease(object: CFTypeRef);
    }

    struct Owned(CFTypeRef);

    impl Owned {
        fn take(status: OSStatus, object: CFTypeRef) -> Option<Self> {
            (status == 0 && !object.is_null()).then_some(Self(object))
        }
    }

    impl Drop for Owned {
        fn drop(&mut self) {
            unsafe { CFRelease(self.0) };
        }
    }

    pub fn peer_token(fd: std::os::fd::RawFd) -> Option<PeerToken> {
        let mut token = [0u32; 8];
        let mut length = std::mem::size_of_val(&token) as libc::socklen_t;
        let got = unsafe {
            libc::getsockopt(
                fd,
                SOL_LOCAL,
                LOCAL_PEERTOKEN,
                token.as_mut_ptr().cast(),
                &mut length,
            )
        };
        (got == 0 && length as usize == std::mem::size_of_val(&token)).then_some(PeerToken(token))
    }

    fn guest(token: &PeerToken) -> Option<Owned> {
        let bytes: Vec<u8> = token.0.iter().flat_map(|v| v.to_ne_bytes()).collect();
        let data = NSData::with_bytes(&bytes);
        let attributes: Retained<AnyObject> = unsafe {
            let key = kSecGuestAttributeAudit as *const AnyObject;
            msg_send![objc2::class!(NSDictionary), dictionaryWithObject: &*data, forKey: key]
        };
        let mut code: CFTypeRef = std::ptr::null();
        let status = unsafe {
            SecCodeCopyGuestWithAttributes(
                std::ptr::null(),
                Retained::as_ptr(&attributes).cast(),
                0,
                &mut code,
            )
        };
        Owned::take(status, code)
    }

    pub fn alive(token: &PeerToken) -> bool {
        guest(token).is_some()
    }

    pub fn resolve(token: &PeerToken) -> ControlPeer {
        match guest(token) {
            Some(code) => resolve_code(&code, token.pid()),
            None => ControlPeer::unknown(token.pid()),
        }
    }

    pub fn resolve_self() -> ControlPeer {
        let mut code: CFTypeRef = std::ptr::null();
        let status = unsafe { SecCodeCopySelf(0, &mut code) };
        match Owned::take(status, code) {
            Some(code) => resolve_code(&code, std::process::id() as i32),
            None => ControlPeer::unknown(0),
        }
    }

    pub fn signed_for_distribution() -> bool {
        let mut code: CFTypeRef = std::ptr::null();
        let status = unsafe { SecCodeCopySelf(0, &mut code) };
        let Some(code) = Owned::take(status, code) else {
            return true;
        };
        let Some(requirement) = requirement(DISTRIBUTION) else {
            return true;
        };
        unsafe { SecCodeCheckValidity(code.0, 0, requirement.0) == 0 }
    }

    fn requirement(text: &str) -> Option<Owned> {
        let text = NSString::from_str(text);
        let mut requirement: CFTypeRef = std::ptr::null();
        let status = unsafe {
            SecRequirementCreateWithString(Retained::as_ptr(&text).cast(), 0, &mut requirement)
        };
        Owned::take(status, requirement)
    }

    fn satisfies(code: &Owned, text: &str) -> bool {
        requirement(text).is_some_and(|req| unsafe { SecCodeCheckValidity(code.0, 0, req.0) == 0 })
    }

    fn value(dict: &AnyObject, key: CFTypeRef) -> Option<&AnyObject> {
        unsafe {
            let found: *mut AnyObject = msg_send![dict, objectForKey: key as *const AnyObject];
            found.as_ref()
        }
    }

    fn text_value(dict: &AnyObject, key: CFTypeRef) -> Option<String> {
        value(dict, key)?
            .downcast_ref::<NSString>()
            .map(|s| s.to_string())
    }

    fn named(dict: &AnyObject, key: &str) -> Option<String> {
        let key = NSString::from_str(key);
        text_value(dict, Retained::as_ptr(&key).cast())
    }

    fn hex(bytes: &[u8]) -> String {
        bytes.iter().map(|b| format!("{b:02x}")).collect()
    }

    fn static_path(code: &Owned) -> Option<String> {
        let mut url: CFTypeRef = std::ptr::null();
        let status = unsafe { SecCodeCopyPath(code.0, 0, &mut url) };
        let url = Owned::take(status, url)?;
        let url = unsafe { &*(url.0 as *const NSURL) };
        url.path().map(|p| p.to_string())
    }

    fn resolve_code(code: &Owned, pid: i32) -> ControlPeer {
        let mut fixed: CFTypeRef = std::ptr::null();
        let status = unsafe { SecCodeCopyStaticCode(code.0, 0, &mut fixed) };
        let Some(fixed) = Owned::take(status, fixed) else {
            return ControlPeer::unknown(pid);
        };
        let mut info: CFTypeRef = std::ptr::null();
        let status = unsafe {
            SecCodeCopySigningInformation(
                fixed.0,
                SIGNING_INFORMATION | DYNAMIC_INFORMATION,
                &mut info,
            )
        };
        let info = Owned::take(status, info);
        let dict = info
            .as_ref()
            .and_then(|info| unsafe { (info.0 as *const AnyObject).as_ref() });
        let path = dict
            .and_then(|d| value(d, unsafe { kSecCodeInfoMainExecutable }))
            .and_then(|v| v.downcast_ref::<NSURL>())
            .and_then(|url| url.path())
            .map(|p| p.to_string())
            .or_else(|| static_path(&fixed));
        let identifier = dict.and_then(|d| text_value(d, unsafe { kSecCodeInfoIdentifier }));
        let declared_hash = dict
            .and_then(|d| value(d, unsafe { kSecCodeInfoUnique }))
            .and_then(|v| v.downcast_ref::<NSData>())
            .map(|data| hex(&data.to_vec()));
        let flags = dict
            .and_then(|d| value(d, unsafe { kSecCodeInfoFlags }))
            .and_then(|v| v.downcast_ref::<NSNumber>())
            .map_or(0, |n| n.as_u32());
        let team = dict.and_then(|d| text_value(d, unsafe { kSecCodeInfoTeamIdentifier }));
        let plist = dict.and_then(|d| value(d, unsafe { kSecCodeInfoPList }));
        let bundle_name = path
            .as_deref()
            .filter(|p| p.contains(".app/Contents/MacOS/"))
            .and(plist)
            .and_then(|plist| {
                named(plist, "CFBundleDisplayName").or_else(|| named(plist, "CFBundleName"))
            });
        let signer = match team.as_deref().filter(|t| !t.is_empty()) {
            Some(team)
                if satisfies(
                    code,
                    &format!("anchor apple generic and certificate leaf[subject.OU] = \"{team}\""),
                ) =>
            {
                Signer::Team(team.to_owned())
            }
            _ if satisfies(code, "anchor apple") => Signer::Apple,
            _ => Signer::Other,
        };
        let cdhash = declared_hash.filter(|hash| satisfies(code, &format!("cdhash H\"{hash}\"")));
        let developer = match signer {
            Signer::Team(_) => dict
                .and_then(|d| value(d, unsafe { kSecCodeInfoCertificates }))
                .and_then(|list| unsafe {
                    let first: *mut AnyObject = msg_send![list, firstObject];
                    first.as_ref()
                })
                .and_then(|leaf| unsafe {
                    let summary =
                        SecCertificateCopySubjectSummary((leaf as *const AnyObject).cast());
                    Retained::from_raw(summary as *mut NSString)
                })
                .map(|summary| developer_name(&summary.to_string())),
            _ => None,
        };
        ControlPeer {
            pid,
            path,
            identifier,
            signer,
            developer,
            cdhash,
            hardened: flags & CODE_SIGNING_RUNTIME != 0,
            bundle_name,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn peer(signer: Signer) -> ControlPeer {
        ControlPeer {
            pid: 42,
            path: Some("/usr/local/bin/agent".into()),
            identifier: Some("com.example.agent".into()),
            signer,
            developer: Some("Example Corp".into()),
            cdhash: Some("abc123".into()),
            hardened: true,
            bundle_name: None,
        }
    }

    fn stored(key: &str, until: Option<f64>) -> StoredApproval {
        StoredApproval {
            key: key.into(),
            name: "agent".into(),
            signed_by: "x".into(),
            path: None,
            added: 0.0,
            until,
        }
    }

    #[test]
    fn keys_names_and_signers_match_the_old_peer() {
        let team = peer(Signer::Team("TEAM1".into()));
        assert_eq!(
            team.approval_key().as_deref(),
            Some("team:TEAM1:com.example.agent")
        );
        assert_eq!(team.signed_by(), "Signed by Example Corp (TEAM1)");
        assert_eq!(team.name(), "agent");
        let apple = peer(Signer::Apple);
        assert_eq!(
            apple.approval_key().as_deref(),
            Some("apple:com.example.agent")
        );
        assert_eq!(apple.signed_by(), "Part of macOS, signed by Apple");
        let other = peer(Signer::Other);
        assert_eq!(
            other.approval_key().as_deref(),
            Some("code:abc123:/usr/local/bin/agent")
        );
        assert_eq!(other.signed_by(), "Not signed by an identified developer");
        let unhashed = ControlPeer {
            cdhash: None,
            ..other
        };
        assert_eq!(unhashed.approval_key(), None);
        let nameless = ControlPeer {
            developer: None,
            ..peer(Signer::Team("T".into()))
        };
        assert_eq!(nameless.signed_by(), "Signed by developer team T");
        let bundled = ControlPeer {
            bundle_name: Some("Claude".into()),
            ..peer(Signer::Other)
        };
        assert_eq!(bundled.name(), "Claude");
        assert_eq!(ControlPeer::unknown(1).name(), "An unknown program");
    }

    #[test]
    fn plain_text_drops_controls_and_cuts_with_an_ellipsis() {
        assert_eq!(plain("a\u{0007}b\u{200B}c\u{202E}d", 10), "abcd");
        assert_eq!(plain("abcdef", 4), "abc…");
        assert_eq!(plain("abcd", 4), "abcd");
        assert_eq!(
            developer_name("Developer ID Application: Example Corp (TEAM1)"),
            "Example Corp"
        );
        assert_eq!(developer_name("Plain"), "Plain");
    }

    #[test]
    fn verdicts_follow_the_old_policy() {
        let now = 1_000.0;
        let other = peer(Signer::Other);
        let key = other.approval_key().expect("key");
        let policy = Policy::default();
        assert_eq!(
            policy.verdict(&other, &[], now),
            Verdict::Ask(Some(key.clone()))
        );
        assert_eq!(
            policy.verdict(&other, &[stored(&key, None)], now),
            Verdict::Approved(key.clone())
        );
        assert_eq!(
            policy.verdict(&other, &[stored(&key, Some(now + 1.0))], now),
            Verdict::Approved(key.clone())
        );
        assert_eq!(
            policy.verdict(&other, &[stored(&key, Some(now))], now),
            Verdict::Ask(Some(key.clone()))
        );
        assert_eq!(
            policy.verdict(&other, &[stored("code:other:/x", None)], now),
            Verdict::Ask(Some(key))
        );
        let bypass = Policy {
            same_user_is_enough: true,
            ..Policy::default()
        };
        assert_eq!(bypass.verdict(&other, &[], now), Verdict::SameUser);
        let ours = Policy {
            own_team: Some("TEAM1".into()),
            ..Policy::default()
        };
        let sibling = peer(Signer::Team("TEAM1".into()));
        assert_eq!(ours.verdict(&sibling, &[], now), Verdict::Ardia);
        let soft = ControlPeer {
            hardened: false,
            ..sibling
        };
        assert!(matches!(
            ours.verdict(&soft, &[], now),
            Verdict::Ask(Some(_))
        ));
        let same_binary = Policy {
            own_code: Some(other.clone()),
            ..Policy::default()
        };
        assert_eq!(same_binary.verdict(&other, &[], now), Verdict::Ardia);
        let unkeyed = ControlPeer::unknown(9);
        assert_eq!(policy.verdict(&unkeyed, &[], now), Verdict::Ask(None));
    }

    #[test]
    fn the_test_variable_reads_like_launch_config() {
        assert_eq!(
            test_value("onboarding,controlDoorbell", DOORBELL_TEST_KEY).as_deref(),
            Some("1")
        );
        assert_eq!(
            test_value("controlDoorbell = shown", DOORBELL_TEST_KEY).as_deref(),
            Some("shown")
        );
        assert_eq!(test_value("onboarding=1", DOORBELL_TEST_KEY), None);
        assert!(truthy("1") && truthy("shown"));
        assert!(!truthy("0") && !truthy("off") && !truthy("false"));
        let token = PeerToken([0, 0, 0, 0, 0, 77, 0, 3]);
        assert_eq!(token.pid(), 77);
        assert_eq!(token.process(), "77:3");
    }

    #[test]
    fn half_hour_approvals_carry_the_old_expiry() {
        let approval = peer(Signer::Other).approval("k", 100.0, Some(100.0 + HALF_HOUR_SECONDS));
        assert_eq!(approval.until, Some(1_900.0));
        assert_eq!(approval.name, "agent");
        assert_eq!(approval.path.as_deref(), Some("/usr/local/bin/agent"));
    }
}
