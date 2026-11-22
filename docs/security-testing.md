# Security tests

These tests guard the places where data the user didn't type reaches a privileged part of the browser: a page's
messages and events, values a page returns from evaluated script, other devices' sync records, links from other apps,
plugin calls and the control socket. They run in the normal checks (`pnpm -C apps/browser test`, the packages'
portable tests and CI on every pull request) and add about 9 seconds.

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
   clearly right; otherwise open an issue and mark the case `{ todo: "<finding> open: ..." }` so it runs, shows up
   and turns green when fixed.

A regression case is named after the finding it guards (`A1`, `D5`) and should fail with the fix reverted. Check that
once by reverting the fix's lines in your checkout before you commit the case.

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
