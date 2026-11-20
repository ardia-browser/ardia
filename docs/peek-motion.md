# Peek motion: Genie in, Seamless after

The owner picked the hybrid from a prototype of three motions (2026-11-16): a Peek opens with a Genie warp out of the link it
came from, and everything after that (pinch, settle, close, Open as Tab) is Seamless, one uniform scale of a page that
is already laid out at the size it will have as a tab.

## Design

- **One native owner.** `PeekStage` (`packages/shell/ios/PeekStage.swift`) holds the scrim, the card chrome and the
  page in containers it owns, and one state machine (`PeekMotion.swift`) drives every frame from a display link:
  waiting, entrance, open, gesture, settle, close, promote. JS starts it (`begin`), asks it to close or promote, and hears
  back once per generation (`onPeekDone`). Nothing in React animates the card. Commands and gestures reset the motion's
  clock to the event, so nothing jumps after the card has rested.
- **Windows and Linux.** They have no native stage, so each registers a JS `ArdiaPeekStage`
  (`packages/expo-windows/src/views/PeekStage.tsx`, `apps/linux/src/shims/web/PeekStage.tsx`) with the same contract
  (`begin`, `close`, `promote`, the same state and done events) that replays the zoom they had before: the card grows
  out of the link on the snappy spring (0.2 s, damping 0.9), shrinks back into it in 150 ms (ease-in), and Open as Tab
  expands it to the tab's frame in 150 ms (ease-out) before the tab takes over; Reduce Motion fades, and a Peek that
  comes back with its tab appears at rest. There the card is the old frame (5.5 % inset, the page filling it under the
  bar, `nativePeekMotion` off in `lib/platformFeatures`), and the page hand-over between hosts (a Mac engine feature)
  is skipped. Pinch isn't there, as before (no trackpad gestures).
- **Fixed viewport.** The page is laid out from the first frame at the rectangle it will fill as a tab
  (`components/peek/peekGeometry.ts`: the card minus the toolbar row, the bookmarks bar when it shows and the share bar),
  and shown at one uniform scale `k` inside the card. Its rounded clip is a mask in the page's own (unscaled)
  coordinates, because a layer's mask is drawn through its `sublayerTransform`. Open as Tab springs the scale to 1 and the
  page origin to its tab position.
- **Hand-over.** Open as Tab keeps the Peek's host mounted (`state/peek/donors.ts`) until the tab's own host has the
  page: the tab's `ArdiaWebView` adopts it straight from the Peek's (`takeTransferredTab`, same window, once it has a
  size), leaving the page view in the window throughout, so Chrome sees no hide, no resize and no reload. The Peek's host
  stops issuing navigations and registering its handle once the tab has left the Peek, and its teardown leaves the page
  alone; its empty container is hidden in the same Core Animation commit as the adoption. If the tab's host never takes
  it within a second, the old park-and-take path runs.
- **Chrome fades on its own.** The card's bar, backdrop and rims follow the card's scale but fade by their own curve.
- **The toolbar fades to the tab's colour while the card grows.** When Open as Tab starts (the button, ⌘O or a spread
  pinch past the open threshold), the window's toolbar and bookmarks bar take the Peek tab's palette
  (`state/peek/toolbarPreview.ts`, read by `useSitePalette`) and ease into it with their usual 150 ms fade, so the
  colour is already right when the tab takes over. The preview ends at the hand-over, when the promote is refused, or
  when the Peek unmounts.
- **Pinch stays inside the window.** The spread follows the fingers up to 80 % of the way, then eases into exactly the
  tab's size with no overshoot; the card is clipped to the content area with its corner radius.
- **Genie, both ways.** Each mesh row moves straight between its place on the card and its place in the link's
  rectangle (28 × 18 pt around the click, widened to 12 % of the card) on its own critically damped spring, inspired
  by [DiaTweaks](https://github.com/JaceThings/DiaTweaks)' Peek. The rows' responses are staggered by the link's height on the card: 0.2 s at the middle row (0.17 s closing), from
  0.5× to 1.5× toward the edges, the rows nearest the link slowest on the way out and fastest on the way back in, and the
  stagger fades to nothing as the link nears the card's middle (75 % strength below it). An edge link bends the card
  like the Dock's Genie, a centred one zooms straight out, and no row ever passes another (each row's height is held at or below the next row's, since staggered springs alone can cross by a few points for links inside the card), so nothing folds. The card is
  opaque throughout the entrance; closing fades it as its last row nears the link. The scrim follows a 0.26 s spring.
  Close plays from whatever is on screen (a pinched card, a half-finished entrance), so pinch-in, ×, ⌘W and Escape all
  shrink back into the link.
- **Genie is a mesh on the card, checked at runtime, behind a kill switch.** `peekGenie` (`platform/killSwitches.ts`)
  is read before the mesh runtime is ever inspected. `ArdiaPeekMesh` (`packages/shell/ios/ArdiaPeekMesh.m`) checks
  the private `CAMeshTransform` factory's exact encoding, the layer property, a vertex round-trip and interpolation
  support, validates every vertex and face, and catches exceptions. Any failure plays the zoom instead (`affine`), and
  reduced motion fades (`fade`).
- **Interrupting the Genie.** A pinch, close or promote during the warp starts from the last committed frame's
  vertices and opacity, as a residual that springs away at the warp's own speed while the uniform scale follows the
  fingers.
- **Input.** Core Animation transforms don't move AppKit's geometry, so while the page is scaled the stage maps mouse
  events through the inverse of what is on screen before Chrome sees them. A wheel event that can't be rebuilt with its
  window goes through the hit-test route instead (it reaches the page, at the unscaled point). A press while the card is
  still opening, where the page will be at rest, ends the entrance at once (the card snaps to rest) and reaches the page;
  a press anywhere else on the warping card is swallowed, so opening never delays the
  page being usable; pinch and Escape interrupt it as before. The magnify monitor is installed by the stage itself.
- **Readiness.** `begin` waits for the page's compositor layers to be attached (`-[ArdiaWebView showsPaintedFrame]`,
  polled each display frame; this is layer presence, not a renderer acknowledgement of a presented frame), at most
  150 ms; then the entrance plays anyway over the card's own colour.
- **Source.** The page script reports the click point, not the link's bounds, so the Genie targets a 28 × 18 pt
  rectangle centred on that point, widened to 12 % of the card.
- **Test keys.** `ARDIA_TEST=peekMesh=unavailable|throws`, `peekReady=never`, `peekReduceMotion`, `peekSlow=<n>`;
  `ARDIA_SWITCHES=peekGenie=off`.
- **Known limits.** Chrome's own popups, context menus, autofill and IME candidate window are placed by the engine from
  the page's unscaled position while the Peek is at rest; fixing that needs an engine change (a visual transform in the
  render widget's view-to-screen conversions).

## Failure scenarios

Written before the implementation. Each names how it breaks and the check in `apps/browser/scripts/peek-hybrid-test.mjs`
that catches it. Every check writes its geometry, identity and frame trace to the run's `peek-hybrid.json`.

| # | Failure | How it shows | Check |
| --- | --- | --- | --- |
| P1 | The Peek's page is laid out smaller than the tab it becomes and reflows on promotion | the page's `innerWidth`/`innerHeight` differ between Peek and tab; a resize event fires in the page | `viewport`: inner size before, during and after Open as Tab are equal; the page's resize counter stays 0 |
| P2 | The card scales unevenly (x ≠ y) or the page scale disagrees with its rectangle | trace frames with `sx ≠ sy`, or the page's shown rect isn't `k ×` the tab rect | `uniform`: every trace frame has one scale; at rest `shown = k · tab`, at the last promote frame `shown = tab` exactly |
| P3 | The page lands at a different origin than its tab and jumps at handoff | the last promote frame's page origin differs from the tab pane's web view origin | `handoff`: last frame origin equals the tab's native web view frame within 0.5 pt |
| P4 | Promotion reloads or swaps the document | a nonce set in the page is gone; history length, form text, scroll offset or media time reset; the Chrome tab id changes | `identity`: nonce, `history.length`, an input's value, `scrollY` and a playing audio element's `currentTime` survive; `browserId` is unchanged |
| P5 | A pinch that starts during the Genie jumps (snaps to full size or loses the warp) | the first gesture frame's vertices differ from the last entrance frame's | `regrab-genie`: at 3 timestamps (40, 90, 150 ms) a zero-delta pinch keeps every vertex within 1e-6 and the opacity unchanged |
| P6 | The warp never settles after an interrupted entrance | `residual` stays above 0 | `regrab-genie`: residual reaches 0 within 400 ms of the pinch's start while the scale follows the pinch |
| P7 | A reversed pinch (spread then pinch back) or a regrab mid-settle jumps | the scale's first value after a regrab differs from the last before it | `reversal`: spread to 0.2, back to −0.1, release, regrab during the settle at zero delta: no frame-to-frame jump above the spring's own step |
| P8 | Close and Open as Tab racing both run (two outcomes, or the tab promoted after closing) | two `onPeekDone`, or a tab added after close | `race`: close then promote in the same tick, and promote then close: exactly one outcome per generation, the first one asked |
| P9 | A new Peek replacing one mid-animation gets the old one's completion | the new Peek closes or promotes by itself | `replacement`: open A, open B during A's entrance: A's generation never reports, B opens and stays open |
| P10 | Navigating the source page or switching tabs mid-entrance leaves a card or a stale callback | a card over the wrong page, a late promote | `navigation`: source navigates during the entrance; the Peek is gone, no outcome is reported after its unmount |
| P11 | Resizing the window mid-animation leaves the page at the old size or the card mid-warp | the page's layout size isn't the new tab rect; mesh still applied | `resize`: resize during entrance, settle and promote: entrance snaps to rest at the new geometry, promote finishes at the new tab rect |
| P12 | The Peek page going full screen keeps the card transform | page drawn scaled in full screen | `fullscreen`: page requests full screen: identity transform, chrome and scrim at 0, no remap |
| P13 | The Genie path calls the private API with the wrong layout or crashes on failure | crash, or a warp drawn wrong | `fallback`: `ARDIA_TEST=peekMesh=unavailable` and `peekMesh=throws` both play `affine`, report the reason, and still open, pinch and promote |
| P14 | A page that never paints holds the Peek invisible | nothing shows | `timeout`: `ARDIA_TEST=peekReady=never`: the entrance starts at 150 ms ± one frame |
| P15 | Reduced motion still scales or moves | a trace frame with scale ≠ rest or translation during entrance or close | `reduced`: entrance and close change only opacity; promote jumps once and fades the chrome |
| P16 | A click during the warp waits for the Genie, or clicks at rest land at the wrong spot | the page takes a click later than main's Peek did, or at the wrong coordinates at rest | `input`: a click during the warp ends the entrance and reaches the page; a click at rest on a target's shown centre hits that target in the page |
| P17 | A pinch or Esc during the warp is ignored | the Peek stays | `input`: Esc and a pinch-in during the entrance close it |
| P18 | The delayed focus after promotion steals focus from a tab picked in between | another tab selected within 50 ms loses focus | `focus`: promote, select another tab at once: the promoted page doesn't take focus |
| P19 | A stale `onPeekDone` after unmount closes a newer Peek or a tab | a later Peek closes on its own | covered by `replacement` and `race` (generation guard) |
| P20 | Any run logs a native exception, JS error or page error | console output | every check reads the app's console and the trace's `errors` |

### Round 2 (2026-11-16, owner's test and the post-change review), written before the fixes

| # | Failure | How it shows | Check |
| --- | --- | --- | --- |
| P21 | A real trackpad pinch never reaches the Peek: the magnify monitor was only installed by `MagnifyArea`, which Peek no longer uses, and the synthetic test called the router directly | pinching zooms the page instead | `pinch-monitor`: a magnify event posted through `NSApp` (not the router) with no Little Ardia window open moves the card |
| P22 | The page is drawn at `k²` inside a card sized for `k`, so a wide border shows around it | WindowServer capture: page rect ≠ the card's page slot | `rest-capture`: the drawn page edge sits `inset` from the card edge (±2 pt) in a WindowServer capture |
| P23 | The Genie collapses to a 28 × 18 pt point or folds where rows cross | neck size, fold at the link's row | `genie-shape`: the narrowest warped card is ≥ 10 % of the card's width and the entrance settles in ≤ 500 ms; WindowServer captures show one smooth funnel edge |
| P24 | Closing doesn't retrace the entrance | close plays a zoom while open played a Genie | `close-genie`: close by ×, Esc and pinch-in all warp back into the link; with the mesh off it zooms back |
| P25 | An interruption recomputes the warp at the event's time instead of starting from what was last on screen | first frame after a pinch differs from the last drawn frame | `regrab-genie-*`: the frame at the freeze equals the last committed frame, and no vertex moves more per frame after the freeze than the fastest one did before it |
| P26 | Promotion parks the page outside the window between the two hosts | the page sees `visibilitychange` hidden → visible and a `resize` | `handoff-direct`: no `visibilitychange`, no `resize`, same `browserId`, the Peek host keeps the tab until the tab's host has it, and neither host's teardown closes or clears it |
| P27 | Cancelling the hand-over (the tab closes, the window closes) leaks or closes the wrong page | a page left parked, or the donor's page closed | `handoff-cancel`: close the promoted tab within the hand-over: the tab is gone, no page is left parked |
| P28 | With auto-hide toolbars the tab's first frame lays the page out under a different toolbar state | inner height changes after the hand-over | `handoff-autohide`: `hideToolbarWhileScrolling` on: inner size constant |
| P29 | Chrome's popups and IME rect use the unscaled page position while the page is scaled | a `<select>` menu or IME candidate window opens away from the field | `outgoing-coords`: the field's on-screen rect from the engine matches the drawn rect |
| P30 | The Genie runs without a way to turn it off remotely, or the private API is inspected before the switch is read | no switch, or an inspection with the switch off | `kill-switch`: `ARDIA_SWITCHES=peekGenie=off`: `affine`, and the mesh runtime was never inspected |
| P31 | Scroll and hover over the scaled page land at the wrong point | the page reports wheel/mousemove at unscaled coords | `input`: wheel scrolls the page under the pointer; mousemove over a target fires its `mouseover` |
| P32 | Esc is tested through ⌘W instead of the Escape key | the test passes while Escape is broken | `escape-during-warp`: a real Escape key press |
| P33 | Focus checks read the store, not the window's first responder | the page takes key focus after another tab was picked | `focus`: first responder after the pick isn't the promoted page's view |
| P34 | The tests overclaim the blip's length (assertion time, not hidden time) | wrong evidence | `handoff-direct` records the page's own `visibilitychange` timestamps |
| P35 | A residual mesh failure mid-interruption leaves a warped card | mesh stays applied after a failed apply | `fallback-throws` also pinches during the entrance: no mesh after |
| P36 | Full screen during the entrance or a pinch leaves warp or gesture state | warped full-screen page | `fullscreen`: full screen requested during the entrance: identity, no mesh |
