# Apple Passwords and Me card autofill

Status: proposed. Terms follow `docs/GLOSSARY.md`; the route to Apple Passwords follows `docs/adr/0001-apple-passwords-through-apples-helper.md`.

## Problem Statement

People who keep their logins in Apple Passwords can't use them in Ardia without copying them over. The only routes today are Apple's iCloud Passwords extension, which works only in Chromium tabs, asks for a code at every launch and saves unreliably, and the system Passwords panel, which shows every login they own rather than the site's and can't save. WebKit tabs, which Ardia uses for streaming and DRM sites, get neither in a useful form. So users keep two password stores, or give up and type passwords by hand.

The same people already keep their name, email, phone and addresses on their Me card in Contacts, yet Ardia only fills what was saved inside Ardia or imported from another Chromium browser.

## Solution

On a Mac, each profile can pick Apple Passwords as its Password manager. After a one-time Pairing with the code the Passwords app shows, clicking a sign-in field in any tab, Chromium or WebKit, opens Ardia's Login list with that site's Apple Passwords logins. Picking one fills it after Apple's own Touch ID check. New and changed passwords are offered for saving straight into Apple Passwords, strong passwords can be suggested in either engine, and the Passwords app's Verification codes fill code fields.

Separately, a profile can turn on "Use my Me card from Contacts". The Me card then appears among the saved addresses, marked as coming from Contacts, kept up to date when the card changes, and fills name, company, email, phone and address fields in both engines.

## User Stories

### Choosing Apple Passwords

1. As a Mac user who keeps logins in Apple Passwords, I want Apple Passwords offered in Settings › Profiles › Passwords' Password manager menu, so that I can make it the one place Ardia fills from and saves to.
2. As a user with a work and a personal profile, I want each profile to have its own Password manager, so that work logins and personal logins stay apart.
3. As a user whose profiles share browser data, I want those profiles to share one Password manager choice, so that the choice follows the data it applies to.
4. As a Linux or Windows user, I want no Apple Passwords option at all, so that Settings never offers something that can't work.
5. As a user of an Ardia build without Apple's browser entitlement, I want the Apple Passwords option hidden, so that I'm not offered something macOS will refuse.
6. As an existing Ardia user, I want my Password manager to stay Ardia after updating, so that nothing about my sign-ins changes without my say.
7. As a new user going through onboarding, I want one offer to use Apple Passwords, so that I find it without digging through Settings.
8. As a user who declines that onboarding offer, I want it never shown again, so that onboarding doesn't nag.
9. As a user who switches to Apple Passwords, I want the "Save and fill passwords" toggle and Ardia's saved-password list to explain they don't apply while Apple Passwords is picked, so that I understand where my logins now live.
10. As a user who switches back to Ardia, I want Ardia's own saved passwords exactly as I left them, so that switching is safe to try.

### Pairing

11. As a user picking Apple Passwords in Settings, I want to be asked right there for the six-digit code the Passwords app shows, so that Pairing happens while I'm already setting things up.
12. As a user typing the Pairing code, I want a clear message when the code is wrong, so that I can try again.
13. As a user who cancels Pairing in Settings, I want the Password manager left as it was, so that a half-finished choice never leaves me with no logins.
14. As a user whose Pairing ended (after a restart or when the Mac ended Apple's side), I want a "Connect Apple Passwords" row at the top of the Login list the next time I click a sign-in field, so that I can pair again where I need it.
15. As a user, I want Pairing never to pop up when a page loads, so that browsing is never interrupted by it.
16. As a user, I want Settings to show whether Apple Passwords is Connected or Not connected, with a Connect button when it isn't, so that I can see and fix the state at a glance.
17. As a user who chose "Not now" on the Connect row for a site, I want that row to stay away for that site until the next Pairing ends, so that it doesn't reappear on every click.

### Filling logins

18. As a user, I want the Login list to open the moment I click a username or password field on a sign-in form, so that filling is one click away.
19. As a user, I want the Login list to look the same in Chromium and WebKit tabs, so that I never have to learn two lists.
20. As a user, I want only the current site's Apple Passwords logins in the Login list, so that I pick from a handful instead of everything I own.
21. As a user, I want each row to show the account name and a small Apple key icon, so that I know which login and which Password manager it is.
22. As a user, I want arrow keys, Enter, Escape and Tab to work in the Login list, so that I can fill without the mouse.
23. As a user, I want the Login list's last row to be "Open Passwords app", so that I can find or fix a login that isn't offered.
24. As a user picking a login, I want Apple's own Touch ID or Mac password check before the password is filled, so that a stranger at my Mac can't fill my passwords.
25. As a user, I want the username and password filled into the fields the page actually uses, with the page told about the change, so that sign-in buttons enable and the form submits.
26. As a user, I want the fill to land only in the field and frame I clicked, and only if the page is still the same site, so that a page that navigated away in the meantime never receives my password.
27. As a user whose Password manager is Apple Passwords, I want Chrome's own password list never to appear on top of Ardia's, so that I see one list.
28. As a user on a site with a subdomain login (accounts.example.com vs example.com), I want logins for the same registrable site offered, so that a login saved on one subdomain works on its siblings.
29. As a user who has no saved login for a site, I want the Login list to say so and offer "Open Passwords app", so that I know the list isn't broken.
30. As a user, I want the Login list never to appear with no clear reason (a newsletter box, a search field), so that it doesn't get in the way.

### Saving

31. As a user who signs in with a new login, I want Ardia's existing save prompt to ask "Save to Apple Passwords?", so that new logins land in the place I chose.
32. As a user who changed a password on a site, I want the prompt to offer to update the Apple Passwords login, so that my saved password stays right.
33. As a user, I want "Never on This Site" and "Not Now" to work as they do today, so that saving behaves as I already know it.
34. As a user, I want no save prompt when the password I typed is the one already saved, so that I'm not asked to save what's already there.
35. As a user whose sign-in failed, I want no save prompt, so that a mistyped password isn't stored.
36. As a user whose Apple Passwords is locked or refuses a save, I want the prompt to say the save didn't happen, so that I'm not left believing it did.

### Strong passwords

37. As a user on a sign-up or change-password form, I want a "Suggest strong password" row in the Login list in both engines, so that I get a strong password even in WebKit tabs.
38. As a user who accepts a suggested password, I want it filled into the new-password fields and offered for saving to Apple Passwords, so that I never have to remember it.

### Verification codes

39. As a user on a code field of a site I have a Verification code for, I want one row "Code for example.com" in the Login list, so that I fill the current code with one click.
40. As a user, I want Verification codes offered only on secure (https) pages, so that a code is never handed to an insecure page.
41. As a user with several accounts on a site, I want the code for the account I just typed listed first, so that the likely code is on top.
42. As a user, I want a code filled only into an empty, visible code field, so that it never overwrites what I typed or lands somewhere hidden.

### When Apple Passwords can't be reached

43. As a user on a macOS too old for Apple's helper, I want the Login list and Settings to say "Needs macOS 15.4 or later", so that I know why it doesn't work.
44. As a user without the Passwords app's helper installed, I want a plain row saying so with how to fix it, so that I'm not left guessing.
45. As a user whose Mac refused Apple's helper, I want one plain row saying Apple Passwords isn't available, so that I know it's not my fault.
46. As a user with Apple Passwords picked, I want Ardia never to quietly fill from or save to its own store instead, so that my logins stay where I chose.

### Safety

47. As a user in a private window, I want the Login list to work but no save prompt to appear, so that private browsing leaves nothing behind.
48. As a user on a page that shows another site's login box inside it, I want no Apple Passwords rows in that box, so that a phishing frame can't harvest my logins.
49. As a user on a plain http site, I want only logins saved for http sites offered there, each marked "Not secure", so that I know the risk and an https login is never sent over http.
50. As a user, I want the site Ardia matches against to come from the browser itself, never from what the page claims, so that a page can't pretend to be another site.
51. As a user, I want no password or code ever written to a log or sent in usage counts, so that my secrets never leave the fill.

### Me card

52. As a Mac user, I want a "Use my Me card from Contacts" switch under "Save and fill addresses", so that I can fill forms from the card I already keep up to date.
53. As a user, I want macOS to ask for Contacts access only when I turn that switch on or accept the onboarding offer, so that Ardia never asks out of nowhere.
54. As a user who denies Contacts access, I want the switch to turn back off and explain how to allow it in System Settings, so that I'm not stuck.
55. As a user, I want my Me card to appear among my saved addresses, marked "From Contacts", so that I see it next to what I saved in Ardia.
56. As a user with several street addresses on my Me card, I want one saved entry per address, each with my main email and phone, so that I can pick home or work.
57. As a user whose Me card has no street address, I want one entry with my name, email and phone, so that sign-up forms still fill.
58. As a user who edits my Me card in Contacts, I want Ardia's copy to update, so that I never fill an old phone number.
59. As a user, I want the Me card's entries to be edited in Contacts, not in Ardia, so that there's one place to change them.
60. As a user who turns the switch off, I want the Me card's entries removed from Ardia, so that turning it off really stops it.
61. As a user, I want Me card entries to fill in both Chromium and WebKit tabs, so that the engine doesn't matter.
62. As a Linux or Windows user, I want no Me card switch, so that Settings never offers something that can't work.

### Usage counts

63. As the maintainer, I want counts of Pairings, fills, saves, Verification codes filled, Me card fills, and each kind of failure, sent only when the user shares usage, so that I can see the feature working and catch it breaking.
64. As a user, I want those counts listed in "What's Sent", so that I know exactly what is shared.

## Implementation Decisions

- **Route to Apple Passwords.** Ardia's Mac native layer launches the helper Apple ships for its iCloud Passwords extension, found through the native-messaging manifest Ardia already reads, and speaks its framed messages over the child's stdin and stdout. It pairs with SRP-6a (the RFC 5054 3072-bit group, SHA-256) using the six-digit code, then seals each message with AES-GCM under the session key. Requests used: hello and capabilities, the two pairing rounds, list login names for a URL, get the password for a login name, set a password for a login name and URL, list Verification codes for a URL, get one code. Pairing state lives only in memory and ends with the helper process. Yab's client is the reference for the protocol.
- **Apple Passwords client module.** One deep native module owns the helper process, Pairing, the serialized request queue, timeouts and the mapping of helper statuses to a small set of outcomes (paired, needs pairing, wrong code, locked, refused, helper missing, macOS too old, not entitled). Callers see logins, a password fill, a save outcome and codes; they never see protocol details. A launch-time environment override points it at a fake helper; release builds refuse the override.
- **Entitlement gate.** Apple Passwords is offered only when the running app carries `com.apple.developer.web-browser.public-key-credential`, read from the process at launch, and only on macOS 15.4 or later.
- **Password manager choice.** The per-profile choice gains an `apple` value next to `ardia`, `none` and plugin choices, stored and shared the same way. The native password gate gains the matching state, so both engines stop Chrome's and Ardia's own fill and save when it is picked. Chrome's own password list is suppressed for such profiles with the engine hook already drafted for vault profiles.
- **One Login list for both engines.** The WebKit login list becomes the Login list for both engines. Chromium tabs feed it through the same page-script relay the WebKit path uses, with the frame origin supplied by the engine. Rows: login rows (account name, Apple key icon, "Not secure" on http), a Connect row, a failure row, a Suggest strong password row, a Code row, and an "Open Passwords app" footer. It opens on a trusted click, typing in a username field, or ArrowDown, never on page load, with no animation.
- **Fill.** A picked row re-checks at fill time that the target frame's scheme, host and port and the focused field are unchanged, then fills through the native value setter with input and change events. Credentials cross into the page as encoded data, never spliced into script source, and stay a `Secret` in JS.
- **Matching.** Logins match on registrable domain (public-suffix aware). Cross-site frames get no Apple Passwords rows. http pages get only http logins; codes only on https.
- **Saving.** The existing save prompt and its sign-in-settled check are reused for both engines; when the profile's Password manager is Apple Passwords the title, the target and the outcome text change, and the save goes through the client. "Already saved" counts as success. Private profiles never offer saving.
- **Strong passwords.** Ardia's own generator backs the Suggest strong password row in both engines; Chrome's generation popup is suppressed for Apple Passwords profiles so only one offer shows.
- **Verification codes.** The code row lists codes for the page's registrable domain, the typed account first, and fills only an empty, visible code field after the user picks it.
- **Me card.** A native Me card reader requests Contacts access only from the Settings switch or the onboarding offer, reads the unified Me contact, and writes one Chrome address entry per postal address (or one with no address) into the profile's address store through the existing address calls, tagged as from Contacts. It refreshes on the Contacts change notification and removes its entries when switched off. Ardia's address editor shows tagged entries read-only with "Edit in Contacts". The app gains the Contacts entitlement and a Contacts usage description.
- **Onboarding.** One step offers Apple Passwords (entitled Macs only) and the Me card, each declinable once.
- **Platforms.** Everything here is Mac only and hidden through the platform feature table on Linux and Windows; shared UI copy needs no Linux or Windows wording because it never shows there.
- **Telemetry.** Counters added to the existing password-manager and WebKit autofill count events: pairing started, paired, pairing failed; login list shown, filled; saved, save failed; strong password used; code filled; Me card on, Me card fill; failure kind enum. No sites, names or text.

## Testing Decisions

- **Good tests** drive Ardia the way a user does and check what the user sees and what the page receives: a row appears, a field holds a value, a prompt says a thing. They never assert on protocol bytes, internal queues or private functions, and expected values come from fixtures, not from the code under test.
- **Seam 1, fake Mac sources (new).** A hidden instance launched with an override that points the Apple Passwords client at a fake helper program and the Me card reader at a fixture card. The fake helper speaks the real framing and SRP, holds fixture logins and codes, and can be told to answer wrong code, locked, refused, die at launch, or end the pairing. An end-to-end check opens fixture sign-in, sign-up, code, cross-site frame and http pages in a Chromium tab and a WebKit tab and covers Pairing, the Login list, fill, save and update, strong passwords, codes, every failure row, private windows and Me card fills. Prior art: the hidden-instance checks run through `scripts/lib/instance.mjs`, and the import end-to-end check that uses a fake Chrome home.
- **Seam 2, Settings against native fakes (existing).** `apps/browser` tests under the test loader cover the new Password manager option, its entitlement and platform gates, the Pairing flow in Settings, the status line, the Me card switch and its permission outcomes. Prior art: the existing settings and password-manager choice tests.
- **Seam 3, page boundary (existing).** Every new page-to-native message gets a row in the boundary table and runs the shared hostile inputs through its guard. Prior art: the WebKit autofill and field-provider rows.
- **Not automated.** The real Apple helper only runs under a build signed with Apple's entitlement, so one hand check on the owner's signed build confirms Pairing, fill, save and a code against real Apple Passwords.

### Test list

Each test is one red → green cycle, written and run one at a time in the order below. "Both engines" means the same check runs once in a Chromium tab and once in a WebKit tab. Fixture logins, codes and the Me card are known literals; no expected value is computed by the code under test.

**Slice 1: choosing and Pairing**

| # | Seam | Behavior | Catches | Misses |
| --- | --- | --- | --- | --- |
| S1 | 2 | The Password manager menu lists Apple Passwords on an entitled Mac | the option and its value are wired | the real entitlement read |
| S2 | 2 | It is absent on an unentitled build, on Linux and on Windows | an option offered where it can't work | — |
| S3 | 2 | Picking it asks for the code; the right code saves the choice and the status reads Connected | the Settings Pairing flow | the real helper's answer |
| S4 | 2 | A wrong code shows an error, allows a retry and leaves the choice unchanged | a half-saved choice | — |
| S5 | 2 | Cancel leaves the choice unchanged | losing the old Password manager | — |
| S6 | 2 | When Pairing has ended, the status reads Not connected with a Connect button that asks for the code again | a dead status line | — |
| E1 | 1 | In a hidden instance pointed at the fake helper, Pairing with the fixture code reads Connected | the client's framing, SRP and sealing against a peer that checks them | how Apple's helper differs from Yab's reading of it |
| E2 | 1 | A fake helper that is killed at launch shows "Apple Passwords isn't available" | the refused path | — |
| E3 | 1 | With no helper manifest, Settings shows how to install it | the missing path | — |
| E4 | 1 | A Release build ignores the fake-helper override (the fake writes a marker file when started; none appears) | a shipped way to swap Apple's helper | — |

**Slice 2: the Login list and fill**

| # | Seam | Behavior | Catches | Misses |
| --- | --- | --- | --- | --- |
| E5 | 1 | Clicking the username field on a fixture sign-in page lists only that site's logins, each with the Apple key icon, ending in "Open Passwords app" (both engines) | the list, its source and site filtering | the list's exact look (checked by eye) |
| E6 | 1 | Picking a row fills username and password, and the page records input and change events and enables its button (both engines) | fills the page never notices | — |
| E7 | 1 | ArrowDown opens the list, Down and Enter fill, Escape closes it (both engines) | keyboard handling | — |
| E8 | 1 | On an Apple Passwords profile, Chrome's own password list never appears over a sign-in field | two lists at once | — |
| E9 | 1 | A login saved for example.test is offered on accounts.example.test | registrable-site matching | — |
| E10 | 1 | A site with no logins shows "No saved logins" and "Open Passwords app" | an empty list that looks broken | — |
| E11 | 1 | A search box and a newsletter box open no list | a list in the way | every field shape on the web |
| E12 | 1 | A page that navigates to another site between opening the list and picking a row receives nothing | a password delivered to the wrong site | — |
| E13 | 1 | A login box inside another site's frame gets no Apple Passwords rows (both engines) | phishing frames | — |
| E14 | 1 | An http page offers only http logins, each marked "Not secure", and never an https login | downgrade leaks | — |
| E15 | 1 | When the fake ends Pairing, the next click shows "Connect Apple Passwords" first; Pairing there brings the rows back; "Not now" keeps it away on that site | re-Pairing in place | — |
| E16 | 1 | A locked or refused password fetch shows a failure row and fills nothing | silent failure | — |
| E17 | 1 | An Apple Passwords profile with a login for the site in Ardia's own store lists only the Apple Passwords login | quietly falling back to Ardia's store | — |

**Slice 3: saving and strong passwords**

| # | Seam | Behavior | Catches | Misses |
| --- | --- | --- | --- | --- |
| E18 | 1 | Signing in with a new login asks "Save to Apple Passwords?"; Save puts it in the fake, and Ardia's own store is unchanged (both engines) | saves landing in the wrong place | — |
| E19 | 1 | Signing in with a changed password offers Update; Update changes the fake's login | stale saved passwords | — |
| E20 | 1 | Signing in with the password already saved shows no prompt | needless prompts | — |
| E21 | 1 | A failed sign-in (the form comes back) shows no prompt | saving a mistyped password | — |
| E22 | 1 | A fake that refuses the save makes the prompt say it wasn't saved | a false "saved" | — |
| E23 | 1 | In a private window the list fills but no save prompt appears | private browsing leaving logins behind | — |
| E24 | 1 | A sign-up form shows "Suggest strong password"; picking it fills both new-password fields, and the save prompt targets Apple Passwords (both engines) | WebKit missing the generator; two generator offers in Chromium | password strength (fixed by the generator's own rules) |

**Slice 4: Verification codes**

| # | Seam | Behavior | Catches | Misses |
| --- | --- | --- | --- | --- |
| E25 | 1 | An https code field shows "Code for example.test"; picking it fills the fixture code (both engines) | the code path end to end | Apple's own code timing |
| E26 | 1 | With two accounts on the site, the typed account's code is first | the wrong code on top | — |
| E27 | 1 | An http code field shows no code row, and a code field that already holds text is not overwritten | codes on insecure pages; clobbered input | — |

**Slice 5: Me card**

| # | Seam | Behavior | Catches | Misses |
| --- | --- | --- | --- | --- |
| S7 | 2 | The "Use my Me card from Contacts" switch shows under "Save and fill addresses" on Mac only | the switch and its gate | — |
| S8 | 2 | Turning it on asks for Contacts; a denial turns it back off with the System Settings hint | a stuck switch | macOS's real permission sheet |
| S9 | 2 | Entries from Contacts are listed as "From Contacts", read-only, with "Edit in Contacts" | editing a copy that Contacts overwrites | — |
| E28 | 1 | The fixture Me card with two street addresses becomes two saved entries; one with no address becomes one entry | the card-to-entries mapping | — |
| E29 | 1 | A Me card entry fills name, company, email, phone and address on a fixture form (both engines) | the fill in each engine | — |
| E30 | 1 | Changing the fixture Me card updates the entries; turning the switch off removes them | stale or orphaned entries | — |

**Slice 6: page boundary, secrets and counts**

| # | Seam | Behavior | Catches | Misses |
| --- | --- | --- | --- | --- |
| B1 | 3 | Every new page-to-native message has a boundary row and survives the shared hostile inputs | malformed page data reaching native | inputs outside the shared set |
| B2 | 3 | A page message that names another site's origin has no effect on which logins are listed | a page pretending to be another site | — |
| E31 | 1 | After the whole end-to-end run, no fixture password or code appears in the app's or the engine's logs | secrets in logs | logs written outside the instance's data dir |
| S10 | 2 | The new counts are recorded only while sharing is on, carry no site or text, and are listed in "What's Sent" | telemetry outside the consent model | — |

**Setup the end-to-end check needs:** the fake helper (real framing and SRP, fixture logins and codes, and switches for wrong code, killed at launch, locked, refused, Pairing ended), fixture pages served from two sites plus an http site (sign-in, sign-up, change-password, code, search and newsletter boxes, a cross-site frame, a page that navigates away), and a fixture Me card the reader loads in place of Contacts.

## Out of Scope

- The iPhone and Android apps.
- Linux and Windows.
- Copying Ardia's saved passwords into Apple Passwords (planned as a follow-up).
- Filling from any contact other than the Me card.
- Passkeys, which Ardia already supports through Apple's public passkey API.
- Codes delivered by text message or email.
- Editing or deleting Apple Passwords logins from inside Ardia.
- Replacing Apple's iCloud Passwords extension; it keeps working for whoever installed it.

## Further Notes

- The helper's protocol is not public; a macOS update can change it. The failure rows and counts exist so a break is visible to users and to the maintainer at once.
- Needs the owner's call before merging: trusting the author for a feature, base browser versus a first-party plugin on the existing Password manager extension point, adding the Contacts entitlement to the signing setup, and a signed build for the hand check.
- An open stack of password-manager PRs from another contributor adds its own fill menu; its fill-menu PRs are read before the Login list work starts, and the list is built so both can use it.
- Yab's open-source Apple Passwords client is the protocol reference; its pairing, list, fill, save and code flows map one to one onto this spec.
