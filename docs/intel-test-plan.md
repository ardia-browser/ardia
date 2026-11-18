# Testing Ardia on Intel Macs

An unofficial test build of Ardia for Intel Macs (x86_64), made from the `intel-build` branch of
[philigrin/ardia](https://github.com/philigrin/ardia) for issue
[ardia-browser/ardia#67](https://github.com/ardia-browser/ardia/issues/67). The goal is to find out whether Ardia
works on Intel Macs before an Intel build is proposed upstream. It isn't an official Ardia release.

**Build:** `Ardia-0.x-intel-test.2-x86_64.dmg`, Chromium 157.0.8103.50 (Helium 0.21.2), code from ardia `main` on
2026-11-13 (99ba14b). Signed with Developer ID (Filipp Grinevich, CF6CF6NWCF) and notarized by Apple.

## Before you start

1. Check the download: `shasum -a 256 Ardia-0.x-intel-test.2-x86_64.dmg` must print the checksum from the release.
2. If you already use Ardia, quit it first. This build stores its data in the same place as Ardia.
3. Write down your Mac's details for the report: model (Apple menu › About This Mac), CPU, graphics, memory and
   macOS version, and whether you use OpenCore Legacy Patcher.

## What isn't expected to work

Don't report these. They're known gaps of this test build:

- **Automatic updates.** There's no Intel update feed yet, so download new test builds by hand.
- **iCloud sync and passkeys.** Both are tied to the Ardia author's Apple team, which this build isn't signed with.
- **The `ardia` command-line tool.** It installs on Apple Silicon only.
- **Video upscaling** (Settings › Advanced). It needs Apple silicon, so the switch does nothing here.
- **Translation.** It needs macOS 26, so on macOS 14 and 15 it isn't offered.

## Test scenarios

Mark each one ✅ works, ⚠️ works with problems or ❌ broken, and say what you saw for every ⚠️ and ❌.

### 1. Install and first launch
- [ ] Open the DMG, drag Ardia to Applications and open it. It opens with no "unidentified developer" or "damaged"
      warning.
- [ ] The first-run screens show and you can finish them.
- [ ] Import from your current browser (Chrome, Safari, Arc or Firefox). Bookmarks and history arrive.

### 2. Everyday browsing
- [ ] Open 10–15 of the sites you use daily: Gmail, YouTube, GitHub, Google Docs, a news site. Pages draw fully,
      with no blank areas or flicker.
- [ ] Tabs: open with ⌘T, close with ⌘W, reopen with ⇧⌘T, drag to reorder, pin a tab.
- [ ] Sidebar: hide and show it, scroll a long tab list, create a tab group.
- [ ] Peek: ⇧-click a link and the page opens in a Peek window.
- [ ] Search from the address bar and type a URL.
- [ ] Downloads: download a file and open it from the downloads list.
- [ ] Upload: attach a file on any site.

### 3. Graphics, the most likely place for Intel problems
- [ ] Open `ardia://gpu`, click "Download report to file" at the top, and attach the saved file to your report.
- [ ] Scroll long pages (a news feed, a long GitHub file) for a minute. Note any stutter, tearing or black squares.
- [ ] Open a WebGL demo such as <https://webglsamples.org/aquarium/aquarium.html>. It renders and the FPS counter is
      steady.
- [ ] Sidebar and window animations look smooth. Note any visible lag on older Macs.
- [ ] Switch between light and dark mode and between full screen and a window.

### 4. Video and audio
- [ ] YouTube at 1080p, and at 4K if your screen allows: smooth playback with sound in sync.
- [ ] Twitch or another live stream plays.
- [ ] Netflix or Spotify Web plays (this needs Widevine DRM).
- [ ] Picture in Picture: pop a video out, switch tabs, bring it back.
- [ ] The mini player: play audio in one tab and switch to another. A player appears at the bottom of the sidebar.
- [ ] A video call (Google Meet or another): camera and microphone work after you allow them.

### 5. Extensions and blocking
- [ ] Ads are blocked on a site with heavy ads (uBlock Origin is built in).
- [ ] Install an extension from the Chrome Web Store, for example a password manager, and use it.

### 6. Performance and stability
- [ ] Keep Ardia open for at least an hour of normal use with 20+ tabs.
- [ ] Note fan noise, heat and battery drain compared with your usual browser.
- [ ] Note memory use (Activity Monitor › Memory, the Ardia processes together).
- [ ] Put the Mac to sleep and wake it. Ardia still works and pages reload as needed.
- [ ] Quit with ⌘Q and reopen. Your windows and tabs come back.

## How to report

Reply in [ardia-browser/ardia#67](https://github.com/ardia-browser/ardia/issues/67) with:

```
Mac: <model>, <CPU>, <graphics>, <RAM>
macOS: <version>, OpenCore Legacy Patcher: yes/no
Build: 0.x-intel-test.2

1. Install and first launch: ✅/⚠️/❌
2. Everyday browsing: ✅/⚠️/❌
3. Graphics: ✅/⚠️/❌ (attach the ardia://gpu report file)
4. Video and audio: ✅/⚠️/❌
5. Extensions and blocking: ✅/⚠️/❌
6. Performance and stability: ✅/⚠️/❌

Problems: what you did, what you expected, what happened.
```

If Ardia crashed, attach the crash report: open `~/Library/Logs/DiagnosticReports` in Finder (⇧⌘G) and attach the
newest file whose name starts with `Ardia` or `Chromium Helper`. Screenshots or a short screen recording help a lot
with drawing problems.
