# Edit shortcuts right after a focus move

A browser command like ⌘T runs on the JS thread, so for 30–150 ms after the shortcut the old responder still has AppKit's focus. Before the fix, a ⌘V pressed in that window landed in the old page, even when that page was a now-hidden tab. The user then had to press ⌘V again ("sometimes I need to hit ⌘V twice").

## Fixed: ⌘T, ⌘L and ⌘F pressed while a page or docked DevTools is focused
The fix is `FocusHandoff` in packages/shell/ios/FocusHandoff.swift.

**How a handoff runs**
- The command resigns the page's RenderWidgetHostViewCocoa synchronously.
- A gate opens for that window and holds keys and edit actions for up to 3 s while the command's field mounts and takes focus. A newer command while the gate is open starts a newer generation and gives it the full 3 s again. The gate used to last 400 ms, so with the JS thread busy for 450 ms or more the first keys after ⌘T beeped or went back into the old page (#816).
- Edit › Cut, Copy, Paste, Paste and Match Style and Select All wait on the newest generation.

**Delivery: one path only.** The field that generation's command focuses (the New Tab box, the command bar, Find, or the page a new tab opens on) claims the generation and is verified as first responder. Only then are the waiting actions performed, and only on it.

**Every other ending drops the waiting actions with a beep and opens the gate:**
- the deadline;
- a cancel: the command did nothing, or its destination closed before it mounted;
- a newer generation;
- a click;
- window close or resign-key.

The page that had focus gets it back, but only while its tab is still the one shown. A dropped action never goes anywhere else.

**A key window never stays without a responder.** When the gate ends and the window's first responder is still nil or the window itself, the next UI pass focuses the page that is shown (`ArdiaWebView.focusVisiblePage`), so ⌘A and the arrow keys don't chime and hover keeps reaching the page. The same holds for the other places that resign the page: the lingering New Tab pane (`takeFocusFromLingeringPane`, run once `applyPainting` has unhidden the page, so the page can take the focus) refocuses the page it hands over to, and `lendPageToSuccessor` asks the holder to take focus back. The hover probe covers what is left: a click on the page while the key window has no responder makes the page under the pointer first responder (`responderLost` heal).

**Acks from the page:** edit keys a page passes back are tagged with their window and its key epoch, and stale ones are dropped with a beep. The epoch (`KeyEpochs`) moves only when another window took key, and it moves in step with `didBecomeKey` (the observer has no queue). The same window becoming key again after another app handed focus back (Raycast's clipboard, dictation tools, emoji pickers) keeps it, so a ⌘V sent right then is not dropped.

## Parked (behaves as before)
Codex reviews r1–r8 found these not to be safely fixable inside this scope:
- **⌘1–9, closeTab, the tab switcher and profile switch** as the first command. They can be no-ops (⌘1 on the current tab), and resigning the page would then lose typed keys.
- **Same-tab closes** (closeFind, closeNewTabBar) as the first command.
- **Services and text-system edit commands** (DefaultKeyBinding `paste:`, a Services `insertText:`). They bypass the Edit menu.
- **A chrome field (Find, the address field) as the source.** Nothing is resigned and nothing is gated.
- **Plain keystrokes typed during the handoff.** A resigned page drops them.
- **Edit actions while the destination is slower than 3 s** (a very busy JS thread). They're dropped with a beep, and the next press works.
- **Selection timing.** RN applies a text input's selection in a later UI block than its focus. The claim hops through the UIManager queue first, but a selection queued after that hop can still land after the paste.

## Diagnostics: the `paste_refused` event
Every beep in `FocusHandoff` goes through `FocusHandoff.refuse(_:_:)` with a `Refusal` reason, and the address field's `pasteFrom:` (the react-native-macos patch) and `MenuTarget` report to `PasteRefusal` (packages/shell/ios/PasteRefusal.swift). It sends a `pasteRefused` app event, and `apps/browser/src/state/telemetry/pasteRefused.ts` turns it into one `paste_refused` telemetry event. Nothing about behaviour changed: the beep, the drop and the refusal are the same as before.

**Properties**
- `reason`: `deadline`, `cancelled`, `superseded`, `stale_epoch`, `queue_full`, `no_origin`, `late_acknowledgement`, `focus_lost`, `mouse_down`, `window_left`, `no_text` (the address field found no text on the pasteboard), `deferred` (a forwarded Paste the focus gate held back, including one it dropped at once) or `refused` (no responder took a forwarded Paste for a text field).
- `type_ids`: the pasteboard's type names for `no_text`, at most 24. Only names on a fixed list in `pasteRefused.ts` are kept, each matched exactly: the standard text, rich text, HTML, URL, file, image and PDF types (`public.utf8-plain-text`, `public.html`, `public.file-url`, `public.png`, `com.adobe.pdf`, `com.apple.webarchive` and the like, Chromium's `org.chromium.web-custom-data` and `org.chromium.source-url`), the legacy names AppKit reports beside them (`NSStringPboardType`, `NeXT TIFF v4.0 pasteboard type`, `Apple HTML pasteboard type`, the `CorePasteboardFlavorType` codes for text, URLs, files and JPEG), and nine MIME types (`text/plain`, `text/html`, `text/uri-list`, `image/png`, `image/jpeg`, `image/gif`, `image/webp`, `application/pdf`, `application/rtf`). Dynamic `dyn.` types collapse to `dyn`, and any other name, even one that looks standard (`public.acme-secret-doc`, `text/x-customer-1234`, an app's own `com.apple.` name), is recorded as `other`, since an app's own type could carry a document or account id.
- `type_count`: how many types the pasteboard offered, so a pasteboard whose types were all collapsed reads differently from an empty one.
- `responder`: the first responder's class name for `deferred` and `refused`, on the first one of a session only. Later ones are still recorded, without it.
- `gate_open`: whether the key window had a focus gate open.
- `keyboard_layout`: the current keyboard layout's input source id.
- `$os_version`: the macOS version, from the common context.
- `dropped`: how many inputs were dropped, including ones rejected before they entered a gate.

A gate drop is reported only when a Paste action (Paste, Paste and Match Style) or ⌘V is among the dropped inputs; Cut, Copy and Select All alone are not reported. Plain keystrokes still beep as before and are not reported.

The telemetry never reads or sends what is on the clipboard: it takes the type names the pasteboard lists and nothing else. At most 50 events are reported per session. The "Usage" list in Settings › Privacy says the same.
