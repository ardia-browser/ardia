# Autofill: addresses and cards

Chrome keeps the data (its `PersonalDataManager`, per profile) and does the field-type prediction and the fill. Ardia
draws the profile's Addresses and Cards settings and, once the engine supports it, the fill menu on web pages. Passwords are in
`docs/password-managers.md`.

## Settings › Profiles › <profile>

- **Switches**: Save and fill addresses and Save and fill cards in the profile's Passwords and autofill section
  (Chrome's `autofill.profile_enabled` and `autofill.credit_card_enabled`, through `autofill.setSettings`). Off stops
  both filling and Chrome's save offers. Saved addresses and Saved cards open the profile's sub-pages.
- **Sub-pages** (`components/settings/panes/ProfileAutofill.tsx`, `AddressesPage` and `CardsPage`): a header with Add
  Address… or Add Card… and, from 7 entries, a search field. The lists grow as you scroll (`useGrowingRows`, 100 rows
  at a time). An address row shows
  its name (else organization, street, email, phone) over a one-line place in the country's order (`addressLocality`:
  `Cupertino, CA 95014`, `London NW1 6XE`, `10117 Berlin`). A card row shows its network badge, `Visa •••• 1111`, the
  name on the card, and the expiry on the right (`Expired` in red); expired cards sort last. Empty lists say
  `No saved addresses` / `No saved cards`; a search with no hits says `No addresses match` / `No cards match`.
- **Address sheet** (`components/autofill/AddressSheet.tsx`): the password form's borderless rows
  (`VaultFormFields`), focus ring and inline errors. Contact group (Name, Organization, Phone, Email), then address
  group (Street, a second street line, City with Region, Postal Code with Country). Region and postal labels follow the
  country (`regionLabels`: State, Province, County, Prefecture; ZIP Code, Postcode, PIN Code). A two-letter country is
  stored upper case. Save needs a name or some address; a malformed email or phone is flagged on its row. An edited
  sheet with nothing changed just closes. Delete asks "Delete Jordan Avery?" first. Tab and Shift-Tab move between
  fields, Return saves, Escape cancels. The body scrolls past 380 pt.
- **Card sheet** (`components/autofill/CardSheet.tsx`): Number, Name, Expires (month and year menus; the year list
  is this year and 15 more, plus a saved year outside it). A new card types its number into a native field
  (`ArdiaAutofillCardField`, `packages/ardiacore/ios/AutofillCardNumberField.swift`, typed as a card number for AppKit with Writing Tools off): digits only, at most 19, grouped
  as printed (4-6-5 for American Express, 4-6-4 for 14-digit Diners), and the header badge follows the network as you
  type. JS only learns `{digits, network, complete, luhn}`. Save needs a complete number (network length and Luhn),
  checked again natively (`ERR_INVALID_NUMBER`). A saved card shows `•••• •••• •••• 1111` with Show Number and Copy
  Number; both run Chrome's reauth (`ac_autofill_card_number`, Touch ID or the Mac password, every time), then the
  number is put into a native secret entry and shown in the same native field, editable. Copy goes through
  `VaultClipboard` (concealed, cleared after 90 s). A declined check says "Showing the number needs Touch ID or your
  password." A past expiry is refused only on a new card.
- **The number never enters JS.** `autofill.revealCard {id, entry}` answers `{revealed, network, digits, complete}` or
  `{revealed: false, declined}`; `autofill.saveCard` takes an entry token, not a number; `autofill.copyCard {entry}`
  copies the entry's digits. The Mac has no `autofill.cardNumber` verb. Entries are dropped when the sheet closes.
- **Linux and Windows** have no native secret fields, so the same sheet takes its number from a plain field
  (`components/autofill/CardNumberEntry.tsx` picks `usePlainCardNumber` where `vaultsSupported` is false): the number is
  typed and formatted in JS with the same network, length and Luhn rules (`cardNumberSummary`, `formatCardNumber` in
  `state/autofill/cards.ts`), Show Number asks the host's `autofill.cardNumber` (the system password on Linux, the
  engine's reauth on Windows), Copy uses the plain clipboard, and Save sends the digits to `autofill.saveCard`. The fill
  menu doesn't open there (`noteAutofillField` ignores fields without password managers).

## The fill menu on web pages

Written, waiting on an engine build. Until an engine with the calls below ships, nothing reports address or card
fields, so nothing claims Chrome's dropdown and Chrome's own list keeps working as before.

- **Engine** (`engine/ardiacore/src/ardia/core/ac_autofill_fill.mm`, `ac_autofill_trigger.mm`): `FocusedField`
  reports each focus and each ask-for-values on a field Chrome predicts as an address (`kName`, `kEmail`, `kPhone`,
  `kCompany`, `kAddress`) or card (`kCreditCard`) field to `-[ArdiaCoreTabDelegate tab:didFocusAutofillField:]` with
  `{kind, part, trigger: focus|ask, rect}` (rect in view points), and `{focused: false}` on a non-form focus.
  `-[ArdiaCoreTab fillAutofillEntry:kind:]` fills the focused form from a profile or local card GUID through
  `BrowserAutofillManager::FillOrPreviewForm` (Chrome's prediction and fill). `-[ArdiaCoreTab claimAutofillMenuKeys:]`
  adds a key-press callback on the focused frame's widget that eats ↑ ↓ Return Escape (Tab passes) and reports them to
  `tab:didPressAutofillMenuKey:`. Needs compiling: the `FillOrPreviewForm` payload overload and the key callback types
  were written against Chromium 157 without a tree on hand.
- **App**: `ArdiaWebView+Autofill.mm` turns both into `autofill.field` and `autofill.menuKey` events;
  `autofill.fill {tabId, kind, id}` asks the owner check for a card (`VaultOwnerCheck.confirm`, scope
  `VaultTouchGrants.card`, `autofill-card\n<id>\n<tab>`, so the menu's Touch ID glyph grants it) and calls the engine;
  `autofill.claimMenuKeys`. A card fill is pinned to the field the request started on: `ArdiaVaultCapture` counts every
  field report for the tab and keeps its frame, the field's origin (the engine's `frame` and `origin` when it sends
  them, else the tab's) and the tab's origin at the time. The pin holds while the tab's origin stays the same, so a
  card field in a cross-origin payment frame (Stripe, Adyen) fills; the fill answers `{filled: false, moved: true}`
  without filling if, after the check, another field was reported, the field blurred or the tab's origin changed.
- **JS** (`state/autofill/fieldMenu.ts`, `menuModel.ts`, `components/autofill/AutofillMenu.tsx`): on focus, if the
  profile has something to offer for that field, it claims Chrome's dropdown for that kind
  (`claimChromeDropdowns(tabId, "autofillField", [kind])`, pm-overlap's mechanism); on ask (a click, as Chrome's own
  list) it opens Ardia's menu from data already in memory (the Settings resources, refreshed on every focus). Rows:
  addresses that have a value for the focused part, titled with that value; every card, expired last and marked; then
  Manage Addresses… / Manage Cards…. The panel is the password menu's (`MenuSurface`, `SelectionPlate`, `RowShell`,
  `Trailing`, the same open and close motion, Reduce Motion fades only). A card row carries the Touch ID glyph. Escape
  closes and hands that field back to Chrome until it's focused again; after a fill the field stays quiet 1.5 s.
- **Field icon** (follow-up): `VaultFieldBadge` can show for these fields by reading `autofillFieldOf(tabId)` and
  calling `toggleAutofillMenuFromBadge(tabId)`; use zoom 1 in `badgeFrameOf`, since the engine's rect is in view points.

## Telemetry

`usage_counts`: `autofill_address_fills_menu`, `autofill_card_fills_menu`, `autofill_fills_failed`,
`autofill_card_reauth_declined` (a card fill or a card number view stopped at the owner check),
`autofill_card_fills_moved` (a card fill stopped because the page, frame or field changed during Touch ID; the menu
closes without an error),
`autofill_menu_opens`, `autofill_addresses_added`, `autofill_addresses_edited`, `autofill_cards_added`,
`autofill_cards_edited`, `autofill_card_numbers_shown`. Counts only.

## Tests

`state/autofill/{addresses,cards,menuModel,fieldMenu}.test.mjs` and `packages/ardiacore/tests/autofill-card.test.swift`
(network, grouping, Luhn, caret).

The engine side of this (autofill menu fill and key routing, and Chrome dropdown suppression at the source) is kept unapplied in `docs/engine-pending/password-autofill-menu.patch`, so `engine/` matches a prebuilt engine and `build-app` keeps fetching it. To land it: apply the patch with `git apply`, build the engine (`docs/engine-build.md`), and commit both together.
