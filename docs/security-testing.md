# Security tests

These tests guard the places where data the user didn't type reaches a privileged part of the browser: a page's
messages and events, values a page returns from evaluated script, other devices' sync records, links from other apps,
plugin calls and the control socket. They run in the normal checks (`pnpm -C apps/browser test`, the packages'
portable tests and CI on every pull request) and add about 9 seconds. [Outbound secrets](#outbound-secrets) covers
the reverse: secrets Ardia holds never leaving through telemetry, logs, sync files or the control socket.

0.2.48 fixed a picked selector with a line break in it, which the content blocker stored as an extra filter line. The
value had passed a check that was right for the input it expected. These tests check what the privileged
sink finally receives, for every input shape in one shared list, so a check that is right for the expected input but
wrong for an awkward one fails here and not in a release.

## The layers

| Layer | File | What it checks |
| --- | --- | --- |
| Boundary table | `apps/browser/src/boundaries.json`, `apps/browser/src/boundaries.test.mjs` | Entry points written in the forms listed under [What the table detects](#what-the-table-detects), plus hand-kept rows for native gates. Each row names its source and its guard, and the files and symbols it cites must still exist. A new entry point in a detected form with no row fails, so does a changed call count, and so does a page script listening for a custom DOM event |
| Hostile inputs | `scripts/security/hostile-inputs.mjs` | One shared list: CR, LF, CRLF, FF, VT, NEL, U+2028/2029, NUL, BOM, lone surrogates, overlong strings, uBlock filter syntax (scriptlets, exceptions, HTML and header filters, network options, preparser directives, procedural and action operators), script, data, file and engine URL schemes, path traversal, Object prototype keys and wrong types |
| Validators and sinks | `apps/browser/src/hostileInputs.test.mjs`, `packages/core/src/hostileInputs.test.ts` | Every hostile value through each guard, checked at the sink: a hiding rule is one line that the app, the Mac write guard and the Linux guards all accept, or nothing; a link from another app opens only a web, file, blank or listed Ardia address; plugin URLs are http(s) only, checked at tab creation through the plugin's own `open` and `apply` in `state/plugins/pluginsV2.test.mjs`; no settings write, sync write or synced record leaves a setting outside its spec; search templates stay http(s); Reader and Find take nothing from a page that changes settings; typed text never becomes a script URL. One case per finding id from the 0.2.48 review, named after it |
| uBlock compile | `apps/browser/src/state/site/hidingRuleSink.test.mjs`, `scripts/lib/ublock-pinned.mjs` | Uses the uBlock Origin release `packages/ardiacore/scripts/ubo.sh` pins. It appends each rule the picker could save to a user list as `appendUserFilters` does, runs Ardia's shipped cleanup from `ubo.sh` in Chromium, then parses as a trusted source (as uBlock treats My filters) and compiles with uBlock's own cosmetic engine. Each rule adds exactly one host-specific plain cosmetic record, or one line uBlock refuses that the blockers' own `querySelector` check refuses too; existing rules compile as before |
| Real browser | `apps/browser/src/state/site/elementPicker.test.mjs`, `packages/ardiacore/tests/page-script-synthetic-input.test.mjs` | Headless Chromium. Every element the real picker picks on a varied page (ids, test ids, classes, custom and non-ASCII tag names, tables, deep paths) saves; the picker refuses a planted picker object and ignores synthetic input; a page that rewrites the helpers the picker calls still gets only inert rules saved. The real `page_script.js`, with the screen-share picker shim on, sends no gesture-gated message (new-tab link notes, Peek, link drops, screen share) or Hide Element message for dispatched events, scripted clicks, `window.open` or `getDisplayMedia` without activation, or the old Hide Element event; the same harness sees a real click, a real share request and a real link drag get through |

`scripts/lib/test-chromium.mjs` finds the browser: Playwright's own download, `ARDIA_TEST_CHROMIUM`, or the system
Chrome GitHub's Linux runners ship. `scripts/lib/ublock-pinned.mjs` keeps only the uBlock zip in its cache (CI caches
the same zip), checks its SHA-256 on every run, unpacks it into a fresh temporary folder that the test removes when it
ends, and retries a download that fails on the network. Locally, a missing browser or no network skips those cases. A
checksum mismatch, a broken archive or an import error fails everywhere, and in CI everything fails.

## What the table detects

The table catches entry points added in the forms below, the way this codebase writes them. It's a tripwire for review,
not a proof: code written to slip past the detector is a review problem, not something the test tries to win.

Anything written another way isn't guaranteed to be found: give it a hand-kept row (`"detected": false`) or rewrite it
in a detected form. `boundaries.test.mjs` has one fixture per form below; each must raise a missing row, a changed
count or a grammar failure, and the shadowing fixture must raise nothing.

**Kind grammar.** A message kind, a literal event name and a plugin method name are one or more of `A–Z a–z 0–9 _ . : -`.
The test fails, naming the value, when a detected kind is outside that, including an empty kind or one with a space.

**TypeScript in `apps/browser/src`**, parsed by `scripts/security/boundary-detectors.mjs` with the TypeScript compiler,
which also resolves each name to its declaration, so a local that happens to share an alias's name doesn't count.
Generics (including an instantiation expression held in a variable), optional chaining, casts and parentheses don't
matter. Calls to `evaluate` as a member (`web.evaluate(…)`, `web?.evaluate(…)`, `web.evaluate?.(…)`,
`web["evaluate"](…)`), through `.call`/`.apply`, and through an alias bound in the same file: a variable set to
`….evaluate`, a destructured `{ evaluate }` or `{ evaluate: run }`, a property of a locally declared object literal
(`kit.look(…)`, or destructured from it), or a key of an object literal passed elsewhere and destructured by that key.
Counted per file.

**`page_script.js`, parsed the same way:**
- listeners: `addEventListener` called as a member, optionally, as the global `addEventListener(…)`, or through an
  alias bound as above (for example `const { addEventListener: listen } = EventTarget.prototype`), called directly, with
  `.call`, or with `apply(alias, target, [name, …])`/`Reflect.apply`. A literal event name gets its own row; every call,
  computed names included, counts toward the pinned total.
- messages: calls to a function named `send` or `post`, or to an alias of one bound as above, including a property of
  a locally declared object (`const bridge = { publish: send }; bridge.publish(…)`). A literal kind (string or template
  literal without substitutions) gets its own row; every call counts toward the pinned total.

**Objective-C++ (`.mm` files that receive page messages), by pattern:** `[kind isEqualToString:@"…"]` on one line.

**Swift, by pattern** (WebKit's page scripts are JavaScript inside Swift strings, so they aren't parsed):
`post(`/`send(` with a single- or double-quoted kind on one line in `WebKit*.swift`; `case "…":` in
`WebKitTab.pageMessage`, `WebKitTab+Site.swift` and `WebKitTab+FieldProviders.swift`; a per-script count of
`addEventListener(` and of `apply(alias, …)` for the aliases a script binds to `EventTarget.prototype.addEventListener` by
assignment (plus `listen` and `addListener`); every `userContentController(` handler. Names here are matched by text, not
resolved, and destructured aliases and computed names in these scripts are not guaranteed.

**Other tables, by pattern:** `ShellEvents.Channel` cases, exported sync adapters, `case "…":` in the plugin channel,
`SOCKET_FAMILIES`, and spreads of the settings object outside the settings writer.

## Adding an entry point

When code starts taking data from a page, a frame, another device, another app, a plugin or the socket in one of the
detected forms, the boundary test names it. Anything else needs a hand-kept row. Then:

1. Add its row to `apps/browser/src/boundaries.json`: `id` as the failure printed it, `source` (one of `sources`),
   `guard` (what refuses bad input, in a sentence) and `checks` (`path#symbol` of the guard, so the row can't outlive
   it). Keep `count` equal to the call count the test reports. Rows for entry points no detector finds carry
   `"detected": false`.
2. Run the shared list through the new guard in `hostileInputs.test.mjs` and assert on what the sink receives, not on
   the guard's return value alone. A guard that should refuse everything in a class needs a positive control too, so
   the test can't pass because nothing ran.
3. If the guard lets something through, write the failing case. Fix it in the same change when the fix is small and
   clearly right; otherwise open an issue and mark the case `{ todo: "@<owner> until <YYYY-MM-DD>: <finding> open, #<issue>" }` so it
   runs, shows up and turns green when fixed; once the date passes the conventions check warns about it
   (`docs/conventions.md` › Skips and accepted risks carry an expiry).

A regression case is named after the finding it guards (`A1`, `D5`) and should fail with the fix reverted. Check that
once by reverting the fix's lines in your checkout before you commit the case.

## Outbound secrets

The table above guards what comes in. Secrets need the opposite guard: a password, a token or a recovery phrase that
Ardia holds must never go out through telemetry, a log line, a crash report, a sync file or the control socket.

**The rule.** Plaintext a secret is made of lives in JS only as a `Secret<kind>` from `@ardia/core`
(`packages/core/src/secret.ts`), made with `asSecret(kind, text)` where it enters and turned back into text with
`reveal(secret)` only at a sink that needs the plaintext: the Keychain, Chrome's password store, the native sync
module, an Authorization header or token request to the account's own provider, the plugin that owns the secret, and
the settings sheet that shows it to the user. The kinds are `SECRET_KINDS`: saved passwords, OAuth tokens and grants
(access and refresh tokens, authorization codes, PKCE verifiers, device codes), OAuth client secrets, API tokens,
plugin secrets and the sync recovery phrase. Sealed logins in sync files are
ciphertext and stay plain strings.

**What refuses a secret.**

| Where | Compile time | Run time |
| --- | --- | --- |
| Any `JSON.stringify` (sync payloads, the telemetry queue, socket and plugin lines) | | `Secret.toJSON` leaves it out |
| Any string it is put into (log text, error messages, template strings) | `Secret` isn't a `string` | `toString` gives `<secret>` |
| Telemetry events (`capture`) | `props` and `raw` are `SecretFree` | `cleanProperties` and `raw` leave it out; a Linux follower window strips secrets before it relays to the leader |
| Log attributes (`queueLog`), `recordLog` arguments | attributes are text, numbers or flags | left out |
| Control socket replies and events (`fittedReply`, `fittedEvent`) | `SecretFree` | `toJSON` |
| Sync writes (`Transport.write`, `SyncNative.write`) | payload is text | `toJSON` |

Each refusal is counted. In the app a refused secret is dropped and counted in `usage_counts` as
`secret_values_dropped` (a count while sharing is on, never the value or its kind). Under `node --test` the browser's
test loader switches `@ardia/core` to throw `SecretEscapeError` instead, so a leak fails the test that caused it.
`apps/browser/src/state/telemetry/secretSinkTypes.ts` holds the `@ts-expect-error` cases the typecheck proves.

**Token shapes.** A secret that was revealed for its sink and then echoed back, say in a provider's error message, is
plain text again. The telemetry scrubber (`state/telemetry/sanitize.ts`) takes out GitHub, GitLab, OpenAI and Anthropic
(`sk-`), Stripe, Slack, Google (`AIza`, `ya29.`, `1//0`) and AWS keys, JWTs, Bearer and Basic credentials,
`password=`/`token:`-style pairs, private key blocks and long random base64 or base64url runs, with one case per shape
in `sanitize.test.mjs`. Passwords, plugin secrets and recovery phrases have no shape, so for them the brand is the
guard.

**The containment test** (`apps/browser/src/secretContainment.test.mjs`) plants a canary of every kind in its real
source (the password store, the Keychain for plugin secrets and live accounts, the stored Google tokens, the native
recovery words), takes the branded value the source hands out, and drives it through the real telemetry client and
queue, the local telemetry store, the network send, `recordLog`, the console hook, `captureException`, `fittedReply`,
`fittedEvent` and a real sync cycle with its files. Each sink must produce its own output, carrying a marker, without
the canary, and must count the drop; a positive control checks each legitimate sink still gets the plaintext, and
token-shaped kinds are also checked once revealed. A provider that echoes a credential in an error body is driven
through a real Live refresh into folder status, which `live.list` returns: Live errors carry only the status code or an
app-owned message (GitHub's GraphQL errors keep at most a validated github.com settings link), and the status message
goes through the token scrubber. Google's sign-in callback, whose address holds the authorization code, is taken by a
callback consumer (`state/tabs/callbackUrls.ts`) the moment the page reports it, before tab state, tab events, the
omnibox or `closed.list` can see it; the tab closes without a recently closed entry, and a sign-in another one replaces closes
its tab the same way. Nothing listens on the loopback callback port, so the page is an error page, which Chromium never
adds to history; Ardia doesn't delete it either, since a deletion would announce the address in `history.removed`. Its registry, read with the TypeScript parser so aliased and
namespace imports count, fails when:

- a kind in `SECRET_KINDS` has no source and canary in the test;
- a file starts making secrets (`asSecret`) without a `WRAP_SITES` row naming the kinds it makes;
- a file calls `reveal` more or fewer times than its `REVEAL_SINKS` row says, or has no row saying why it needs the
  plaintext;
- `asSecret` or `reveal` is passed around as a value instead of called, so a call site can't be counted.

A new secret: add its kind to `SECRET_KINDS`, brand it where it enters JS, reveal it only at its sink, and add its
source, canary and rows to the test.

**Linux.** Sync runs in one window; the others forward their calls over a `BroadcastChannel`, which would clone a
`Secret` into an empty object. `apps/desktop/src/syncAuthority.ts` carries only the phrase argument of
`enterRecoveryPhrase` across, as its kind and text, and brands it again on arrival only in that position; a secret in
any other argument is refused before it is sent (`hostSync.test.mjs`). The channel reaches every window of the app's
own origin, as it did before secrets were branded; moving the phrase to a host route bound to the sync window is left
for later.

**Not covered.** Native code (Swift `SecretBytes`, Rust `Zeroize`, `callWithSecret`) keeps its own handling; this
guard starts where a secret reaches JS. Plaintext a user types sits in a text field's state until it is branded, and
JS can't wipe a string from memory.

## What it doesn't cover

These need a running app or a native build and are left to `docs/testing.md`'s acceptance runs and the Swift and C++
tests:

- Native gates: the Mac's pick confirmation (`ArdiaWebView+ContextMenu.mm`), main-frame and origin checks in
  `ArdiaWebView+PageMessages.mm`, WebKit's `frameInfo` checks, the control socket's peer check, plugin pin and archive
  verification (`packages/shell/plugin-tests`), import readers (`packages/import`), native messaging cleanup and the
  launch environment. The boundary table lists them so a change there is still reviewed.
- Linux's and Windows' native sinks. The Linux C++ guard has its own scenarios in `engine/ardiacore-linux/tests`;
  Windows has none yet.
- Anything that needs a real origin, such as the Chrome Web Store helper, or an OS prompt.
- Timing: races between a check and a use, and stale state across navigations.

Open findings from the 0.2.48 review that these tests mark but don't fix are listed in the rows that cite them
(`findings`) and as `todo` cases.
