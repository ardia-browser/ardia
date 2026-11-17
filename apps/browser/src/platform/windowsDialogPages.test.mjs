import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mock, test } from "node:test";
import { notePageAsked, notePageSettled, watchDialogsWith, windowsDialogPages } from "../../../../packages/expo-windows/src/engine/dialogPages.ts";
import { takeDialogPageCounts } from "../state/telemetry/dialogPageCounts.ts";

test("a page asked while a dialog is open counts, and stalls only if it hasn't loaded 10 s later", () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    let open = false;
    watchDialogsWith(() => open);
    windowsDialogPages.takeDialogPages();
    notePageAsked("no-dialog");
    open = true;
    notePageAsked("loads");
    notePageAsked("stalls");
    notePageAsked("closed");
    mock.timers.tick(4000);
    notePageSettled("loads");
    notePageSettled("closed");
    mock.timers.tick(6001);
    assert.deepEqual(windowsDialogPages.takeDialogPages(), { asked: 3, stalled: 1 });
    assert.deepEqual(windowsDialogPages.takeDialogPages(), { asked: 0, stalled: 0 });
    watchDialogsWith(() => {
      throw new Error("no native module");
    });
    notePageAsked("throws");
    assert.deepEqual(windowsDialogPages.takeDialogPages(), { asked: 0, stalled: 0 });
  } finally {
    mock.timers.reset();
  }
});

test("the hourly extras name the counts, and the Mac sends zeros", () => {
  assert.deepEqual(takeDialogPageCounts(), { dialog_pages_asked: 0, dialog_pages_stalled: 0 });
});

test("every native modal runs through RunModal off the UI thread, and the app stops them before the UI queue goes", () => {
  const native = (name) => readFileSync(new URL(`../../windows/Ardia/${name}`, import.meta.url), "utf8").replace(/\r\n/g, "\n");
  const module = native("DialogsModule.h");
  for (const shown of ["ShowConfirm(owner, title", "ShowPrompt(owner,", "ShowOpenFiles(owner)", "ShowSaveFile(owner,", "ShowOpenFolder(owner,"]) {
    const at = module.indexOf(shown);
    assert.ok(at > 0, shown);
    assert.ok(module.lastIndexOf("DialogParts::RunModal(owner,", at) > module.lastIndexOf("REACT_METHOD(", at), `${shown} isn't inside RunModal`);
  }
  for (const [file, count] of [["NativeDialogs.h", 4], ["SaveDialog.h", 1]]) {
    assert.equal(native(file).split("ModalOverWindow modal(owner,").length - 1, count, file);
    const shown = native(file).split("ModalOverWindow modal(owner,").slice(1);
    for (const body of shown) assert.match(body.split(/\n\}\n/)[0], /ModalWatch::OnAbandon\(|FileDialogWatch watch\(/, `${file}: a dialog with nothing to cancel it at quit`);
  }
  assert.match(module, /  ModalWatch watch;\n  OpenDialogScope open;\n  HeldPageWindows pages;\n  ModalParent parent;\n\};/);
  for (const file of ["NativeDialogs.h", "SaveDialog.h"]) {
    const source = native(file);
    for (const call of [/hwndParent = (\w+)/g, /MessageBoxW\((\w+)/g, /builder\.words\.data\(\)\), (\w+(?:\.Parent\(\))?)/g, /->Show\(([\w.()]+)\)/g]) {
      for (const [, parent] of source.matchAll(call)) assert.ok(parent.startsWith("modal"), `${file} gives ${parent} to a dialog: a window on another thread must never own it`);
    }
  }
  assert.match(module, /ModalWatch::OnTick\(\[this\] \{\n      pages\.Refresh\(\);\n      if \(!ModalWatch::Cancelled\(\)\) parent\.KeepDialogAboveOwner\(\);\n    \}\);/);
  assert.match(native("ModalThread.h"), /SetThreadDpiAwarenessContext\(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2\);/);
  const windows = native("WindowManager.h");
  assert.match(windows, /if \(message == WM_ACTIVATE && LOWORD\(wParam\) != WA_INACTIVE && DialogParts::BringModalForward\(hwnd\)\) return 0;/);
  assert.match(windows, /if \(!DialogParts::BringModalForward\(entry->hwnd\)\) SetForegroundWindow\(entry->hwnd\);/);
  assert.match(native("NativeDialogs.h"), /else if \(HWND fallback = modal\.parent\.Dialog\(\)\) PostMessageW\(fallback, WM_COMMAND, IDCANCEL, 0\);/);
  assert.match(native("Ardia.cpp"), /void ArdiaAppStop\(void\) \{\n  int dialogsOpen = Ardia::DialogParts::ModalRegistry::Shared\(\)\.threads\.load\(\);\n  int waited = Ardia::DialogParts::StopAllModals\(\);/);
  assert.match(native("ModalThread.h"), /while \(registry\.threads\.load\(\) > 0 && GetTickCount64\(\) - began < StopWaitMs\) DeliverSentMessages\(10\);/);
  assert.match(native("ModalThread.h"), /PeekMessageW\(&message, nullptr, 0, 0, PM_NOREMOVE \| PM_QS_SENDMESSAGE\);/);
  assert.match(native("Ardia.cpp"), /host\.engine = nullptr;\n  SetFocus\(nullptr\);\n  if \(host\.queue\) host\.queue\.ShutdownQueue\(\);/);
  assert.match(module, /parent\(owner, !Background\(\)\)/);
  const thread = native("ModalThread.h");
  assert.match(thread, /!m_ownerWasEnabled \|\| Stopping\(\)\) return;\n    bool hadFocus = m_givesFocusBack && DialogInFront\(\);/);
  assert.doesNotMatch(thread, /OursInFront/);
  assert.match(module, /void Release\(\) noexcept \{\n    if \(Stopping\(\)\) \{\n      m_pages\.clear\(\);\n      return;\n    \}/);
});

test("a file dialog cancelled at quit closes through Close and, if still open, through its own window, and says how long it took", () => {
  const source = (path) => readFileSync(new URL(path, import.meta.url), "utf8").replace(/\r\n/g, "\n");
  const native = (name) => readFileSync(new URL(`../../windows/Ardia/${name}`, import.meta.url), "utf8").replace(/\r\n/g, "\n");
  const dialogs = native("NativeDialogs.h");
  assert.match(dialogs, /NoteCancel\(timing\.kind, L"cancelled \(Close: " \+ HexResult\(dialog->Close\(HRESULT_FROM_WIN32\(ERROR_CANCELLED\)\)\) \+ L"\)"\);\n\s+CancelThroughWindow\(dialog\);\n\s+ModalWatch::OnStubborn\(\[this, dialog\] \{ CancelThroughWindow\(dialog\); \}\);/, "Close and the window's Cancel go together, and the Cancel is sent again until the dialog returns");
  assert.match(dialogs, /if \(!PostMessageW\(window, WM_COMMAND, IDCANCEL, 0\)\) return;/);
  assert.match(dialogs, /L"closed " \+ std::to_wstring\(GetTickCount64\(\) - cancelledAt\) \+ L" ms after its cancel"/);
  for (const [file, kind] of [["NativeDialogs.h", "file picker"], ["NativeDialogs.h", "folder picker"], ["SaveDialog.h", "save panel"]]) assert.ok(native(file).includes(`FileDialogWatch watch(dialog.get(), "${kind}");`), kind);
  const thread = native("ModalThread.h");
  assert.match(thread, /abandon\(\);\n\s+if \(state\.stubborn && !state\.stubbornTimer\) state\.stubbornTimer = SetTimer\(nullptr, 0, StubbornEveryMs, &AfterAbandon\);/);
  assert.match(thread, /if \(state\.stubbornTimer\) KillTimer\(nullptr, state\.stubbornTimer\);/);
  assert.match(dialogs, /~FileDialogWatch\(\) noexcept \{\n\s+ModalWatch::Disarm\(\);\n\s+if \(m_events\) m_dialog->Unadvise\(m_events\);/);
  assert.match(source("../../../../packages/expo-windows/src/selfCheck/heldDialogs.ts") , /await Promise\.race\(\[held, settled\(GIVE_UP_MS\)\]\);/);
  const held = source("../../../../packages/expo-windows/src/selfCheck/heldDialogs.ts");
  assert.match(held, /const settledAfter = when === "shown" \? await dialogSettled\(SETTLED_ON_A_COLD_RUNNER_MS\) : null;/, "the shown case waits until the dialog's window shows and its thread settles, not only for the dialog thread to start");
  assert.match(held, /const SETTLED_ON_A_COLD_RUNNER_MS = 20000;/, "a cold runner's first file picker showed its window 12.3 s after its thread started (#1956)");
  assert.match(held, /if \(dialogs\(\)\.settledCount\(\) > 0\) return Date\.now\(\) - began;/);
  assert.match(held, /run: \(\) => heldFileDialogCancels\(false, "atOnce"\),/);
  assert.doesNotMatch(held, /while it is still starting/, "no check claims a cancel during startup it can't force");
  assert.match(held, /\$\{shownAtCancel \? "its window shown" : "still starting"\} at its cancel/);
  assert.match(native("ModalThread.h"), /if \(dialog && IsWindowVisible\(dialog\)\) shown\+\+;/);
  assert.match(native("DialogsModule.h"), /int shownCount\(\) noexcept \{ return DialogParts::ShownDialogCount\(\); \}/);
  assert.match(thread, /if \(Stopping\(\)\) LaunchLog::Write\(L"dialog", L"a dialog's thread ended "/);
  assert.match(native("DialogsModule.h"), /REACT_METHOD\(devHoldFileDialog\)\n\s+void devHoldFileDialog\(std::string windowId, bool save, [^)]*\) noexcept \{\n\s+if \(!AppLaunch::Shared\(\)\.testInstance\) return promise\.Reject/);
});

test("every dialog's thread logs when it started, when its window showed, when a file dialog opened its first folder, and how late it took a cancel", () => {
  const native = (name) => readFileSync(new URL(`../../windows/Ardia/${name}`, import.meta.url), "utf8").replace(/\r\n/g, "\n");
  const thread = native("ModalThread.h");
  assert.match(thread, /LaunchLog::Write\(L"dialog", state\.kind \+ L" thread started"\);/);
  assert.match(thread, /NoteModalDialog\(m_owner, dialog\);\n\s+ModalWatch::NoteShown\(\);/, "shown is noted where the shown count learns of the window");
  assert.match(thread, /state\.cancelTakenAt = GetTickCount64\(\);\n\s+state\.askedAt = released \|\| Stopping\(\) \? AskedToCloseAt\(\) : 0;\n\s+abandon\(\);/);
  assert.match(thread, /LaunchLog::Write\(L"dialog", DialogLifetime\(state\)\);/);
  assert.match(thread, /ModalRegistry::Shared\(\)\.releasedAt = GetTickCount64\(\);/);
  const dialogs = native("NativeDialogs.h");
  assert.match(dialogs, /HRESULT __stdcall OnFolderChange\(IFileDialog \*\) noexcept override \{\n\s+ModalWatch::NoteFirstFolder\(\);/);
  assert.match(dialogs, /dialog->Advise\(events\.get\(\), &m_events\)/);
  assert.ok(native("DialogsModule.h").includes("watch(owner, kind)"), "each dialog's watch knows its kind");
  const smoke = readFileSync(new URL("../../../../scripts/windows/launch-smoke.ps1", import.meta.url), "utf8").replace(/\r\n/g, "\n");
  assert.ok(smoke.includes('-Pattern "self-check|webgl2 probe|^dialog |^(js-error|fatal|error) "'), "CI prints the dialog lines beside the self-check's");
});

test("a cancel reaches each dialog's thread at once, not at its next 250 ms check, and a cancelled dialog is no longer brought forward", () => {
  const native = (name) => readFileSync(new URL(`../../windows/Ardia/${name}`, import.meta.url), "utf8").replace(/\r\n/g, "\n");
  const thread = native("ModalThread.h");
  assert.match(thread, /registry\.stopping = true;\n\s+registry\.freed\.notify_all\(\);\n\s+WakeModals\(\);/, "a quit wakes every dialog thread");
  assert.match(thread, /ModalRegistry::Shared\(\)\.releases\+\+;\n\s+WakeModals\(\);/, "so does the self-check's release");
  assert.match(thread, /for \(HWND parent : registry\.parents\) PostMessageW\(parent, ModalCancelMessage, 0, 0\);/);
  assert.match(thread, /if \(message != ModalCancelMessage\) return DefWindowProcW\(window, message, wParam, lParam\);\n\s+WatchOwner\(nullptr, 0, 0, 0\);/, "the dialog thread's own parent window runs the same check as its timer");
  assert.match(thread, /type\.lpfnWndProc = ModalParentProcedure;/);
  assert.match(thread, /if \(m_window\) Listed\(true\);/);
  assert.match(thread, /Listed\(false\);\n\s+DestroyWindow\(m_window\);/, "a parent leaves the list before its window goes");
  assert.match(thread, /inline void CALLBACK AfterAbandon\(HWND, UINT, UINT_PTR, DWORD\) noexcept \{\n\s+std::function<void\(\)> stubborn = WatchState\(\)\.stubborn;/, "the window Cancel repeats until the dialog returns and Disarm stops it");
  assert.match(native("DialogsModule.h"), /if \(!ModalWatch::Cancelled\(\)\) parent\.KeepDialogAboveOwner\(\);/);
});

test("a dialog counts as settled only once its window shows and its thread's last two checks came on time, the sign the shell's startup work is done", () => {
  const native = (name) => readFileSync(new URL(`../../windows/Ardia/${name}`, import.meta.url), "utf8").replace(/\r\n/g, "\n");
  const thread = native("ModalThread.h");
  assert.match(thread, /bool onTime = state\.lastTickAt && now - state\.lastTickAt <= OwnerWatchMs \+ LateTickSlackMs;/, "a timer message only comes when the thread's queue is empty, so a late one means the thread was busy");
  assert.match(thread, /state\.idleTicks = state\.shownAt && onTime \? state\.idleTicks \+ 1 : 0;/);
  assert.match(thread, /if \(timer\) NoteTick\(state\);/, "only the timer counts, not the wake message");
  assert.match(thread, /constexpr int SettledAfterIdleTicks = 2;/);
  assert.match(thread, /ModalWatch::NoteShown\(\);\n\s+if \(ModalWatch::SettledNow\(\)\) NoteModalSettled\(m_owner\);/);
  assert.match(thread, /if \(!dialog\) dialogs\.settled\.erase\(owner\);/, "a closed dialog leaves the settled count");
  assert.match(native("DialogsModule.h"), /REACT_SYNC_METHOD\(settledCount\)\n\s+int settledCount\(\) noexcept \{ return DialogParts::SettledDialogCount\(\); \}/);
  assert.match(native("AppModule.h"), /const int windowsApiVersion = 24;/);
  assert.match(readFileSync(new URL("./nativeApi.ts", import.meta.url), "utf8"), /export const WINDOWS_NATIVE_API_VERSION = 24;/);
});

test("a switcher whose key was let go while a menu was open commits when the menu closes, read from the keyboard on the UI thread", () => {
  const native = (name) => readFileSync(new URL(`../../windows/Ardia/${name}`, import.meta.url), "utf8");
  const module = native("MenusModule.h");
  const shown = module.slice(module.indexOf("REACT_METHOD(showMenu)"), module.indexOf("REACT_SYNC_METHOD(openCount)"));
  assert.match(shown, /RunOnUI\(context, \[context, popup, promise\]\(\) noexcept \{\n\s+if \(DialogParts::ModalRegistry::Shared\(\)\.withheldResign[^\n]*\n\s+Menus::MenuKeyboard::Shared\(\)\.ReconcileAfterMenu\(\);/, "the menu's completion reconciles on the UI thread, after the resign it held back");
  const worker = shown.slice(shown.indexOf("Menus::TrackOnThisThread"), shown.indexOf("RunOnUI(context, [context, popup, promise]"));
  assert.doesNotMatch(worker, /MenuKeyboard/, "the menu thread never reads or writes the switcher's state");
  const keyboard = native("MenuKeyboard.h");
  const reconcile = keyboard.slice(keyboard.indexOf("void ReconcileAfterMenu()"), keyboard.indexOf("void SetEscapeCapture("));
  assert.match(reconcile, /\(PhysicallyHeldModifiers\(\) & switcherHeld\) == switcherHeld\) return;\n\s+switcherHeld = 0;/, "a modifier still held keeps the switcher open, and a release is sent once");
  assert.match(reconcile, /EmitSwitcherReleased\(true\);/);
  assert.doesNotMatch(reconcile, /HeldModifiers\(\)[^;]*GetKeyState|\bHeldModifiers\(\)/, "the thread's key state is stale after the menu took the key-up");
  assert.match(native("MenuKeys.h"), /inline bool PhysicallyDown\(int virtualKey\) noexcept \{\n\s+return \(GetAsyncKeyState\(virtualKey\) & 0x8000\) != 0;/);
  assert.match(readFileSync(new URL("../state/sidebar/effects.ts", import.meta.url), "utf8"), /e\.type === "switcherReleased" && e\.afterMenu && sidebarUi\(\)\.switcher\) noteTabSwitcherReleasedInMenu\(\);/);
});

test("a right-click that took the keyboard from a page gives it back when its menu is dismissed, on the UI thread, never to a window that is not in front", () => {
  const native = (name) => readFileSync(new URL(`../../windows/Ardia/${name}`, import.meta.url), "utf8");
  const manager = native("WindowManager.h");
  const activated = manager.slice(manager.indexOf("void Activated(HWND hwnd, HWND previous)"), manager.indexOf("static bool LeftButtonDown()"));
  assert.match(activated, /ClearPageLeftBySecondaryPress\(\);\n\s+if \(fromPage && SecondaryButtonDown\(\)\)/, "only a right press from its own page is remembered, and any other activation forgets it");
  assert.match(activated, /PageLeft\{hwnd, previous, GetTickCount64\(\), 0\};\n\s+if \(!StartSecondaryPressWatch\(\)\) ClearPageLeftBySecondaryPress\(\);/, "the press is followed from the moment it took the keyboard, and forgotten if it cannot be");
  assert.doesNotMatch(activated, /SetWindowsHookExW|WH_MOUSE/, "WinUI's sidebar presses never reach a thread mouse hook, so the release is read from the buttons");
  const follow = activated.slice(activated.indexOf("void FollowSecondaryPress()"), activated.indexOf("static bool ButtonOtherThanSecondaryDown()"));
  assert.match(follow, /if \(ButtonOtherThanSecondaryDown\(\) \|\| \(left\.releasedAt && secondary\)\) return ClearPageLeftBySecondaryPress\(\);/, "another button, or a new right press after the release, forgets the page");
  assert.match(follow, /if \(!secondary\) \{\n\s+left\.releasedAt = now;\n\s+\} else if \(now - left\.pressedAt > kSecondaryHoldLimitMs\) \{\n\s+ClearPageLeftBySecondaryPress\(\);/, "the release is stamped when the button comes up, and a press held past its limit is forgotten");
  assert.match(follow, /if \(now - left\.releasedAt > kPageLeftKeptAfterReleaseMs\) ClearPageLeftBySecondaryPress\(\);/, "the watch ends once the page could no longer be taken");
  assert.match(manager, /HWND TakePageLeftBySecondaryPress\(HWND app, ULONGLONG withinMs\) noexcept \{\n\s+FollowSecondaryPress\(\);/, "a release since the last tick counts when the menu asks");
  const module = native("MenusModule.h");
  const shown = module.slice(module.indexOf("REACT_METHOD(showMenu)"), module.indexOf("REACT_SYNC_METHOD(openCount)"));
  assert.match(shown, /if \(!popup\) return promise\.Resolve\(JSValue\{nullptr\}\);\n\s+popup->pageLeft = Menus::MenuKeyboard::Shared\(\)\.PageTheMenuPressLeft\(popup->owner\);\n\s+bool started = DialogParts::RunModal\(/, "the page is read on the UI thread before the menu's thread starts");
  const done = shown.slice(shown.indexOf("RunOnUI(context, [context, popup, promise]"));
  const worker = shown.slice(shown.indexOf("Menus::TrackOnThisThread"), shown.indexOf("RunOnUI(context, [context, popup, promise]"));
  assert.doesNotMatch(worker, /pageLeft/, "the menu's thread never reads the remembered page");
  assert.match(done, /ReconcileAfterMenu\(\);\n\s+std::optional<std::string> chosen = Menus::ChoiceOf\(\*popup\);\n\s+if \(popup->pageLeft\) Menus::MenuKeyboard::Shared\(\)\.GivePageBackAfterMenu\(\*popup->pageLeft, chosen\.has_value\(\)\);\n\s+promise\.Resolve/, "the keyboard goes back on the UI thread, after the switcher's release is read and before the menu answers");
  const keyboard = native("MenuKeyboard.h");
  const keeps = keyboard.slice(keyboard.indexOf("std::wstring_view WhyTheAppKeepsTheKeyboard("), keyboard.indexOf("void GivePageBackAfterMenu("));
  for (const rule of [
    /if \(chosen\) return/,
    /if \(!IsWindow\(left\.app\) \|\| !IsWindow\(left\.page\)\) return/,
    /WindowManager::Shared\(\)\.Hwnd\(left\.windowId\) != left\.app \|\| HostOfPage\(left\.page\)\.hwnd != left\.app\) return/,
    /if \(foreground != left\.app\) return/,
    /DialogParts::ModalDialogOf\(left\.app\)\) return/,
    /if \(switcherCaptured \|\| switcherHeld \|\| escapeCaptured\) return/,
    /if \(windowsKeyHold \|\| FocusHold::Shared\(\)\.active \|\| recording\) return/,
  ]) assert.match(keeps, rule);
  const gives = keyboard.slice(keyboard.indexOf("void GivePageBackAfterMenu("), keyboard.indexOf("bool HandleKey("));
  assert.match(gives, /\{"type", "snapKeyHandedBack"\}, \{"windowId", left\.windowId\}/, "it uses the follow path the Windows key gives a page back through");
  assert.doesNotMatch(gives, /SetForegroundWindow|SetFocus|SetActiveWindow/, "the shell never forces the foreground itself");
  assert.match(readFileSync(new URL("../state/app/nativeSync.ts", import.meta.url), "utf8"), /if \(e\.type === "snapKeyHandedBack" && e\.afterMenu\) notePageFocusReturnRequestAfterMenu\(\);/);
});

test("a pop-up menu tracks on a RunModal thread, owned by that thread's own window, so pages keep loading while it is open (#1687)", () => {
  const native = (name) => readFileSync(new URL(`../../windows/Ardia/${name}`, import.meta.url), "utf8");
  const module = native("MenusModule.h");
  const shown = module.slice(module.indexOf("REACT_METHOD(showMenu)"), module.indexOf("REACT_SYNC_METHOD(openCount)"));
  assert.match(shown, /DialogParts::RunModal\(popup->owner, \[context, popup, promise\]\(bool usable\) noexcept \{\n\s+if \(usable\) Menus::TrackOnThisThread\(\*popup, true\);/);
  assert.doesNotMatch(shown, /TrackPopup\(/, "showMenu tracks the menu on the UI thread");
  const popup = native("MenuPopup.h");
  assert.equal(popup.split("TrackPopupMenuEx(").length - 1, 1);
  assert.match(popup, /DialogParts::ModalParent parent\(popup\.owner, takesForeground, false\);\n\s+HWND window = parent\.Handle\(\);/);
  assert.match(popup, /TrackPopupMenuEx\(popup\.menu, popup\.flags, popup\.point\.x, popup\.point\.y, window, nullptr\)/, "the menu's owner is the menu thread's own window");
  assert.match(popup, /DialogParts::ModalWatch::OnAbandon\(\[\] \{ EndMenu\(\); \}\);/, "a menu closes when its window goes or the app stops");
  assert.match(native("ModalThread.h"), /if \(m_disablesOwner\) EnableWindow\(m_owner, TRUE\);/, "a menu's parent never enables a window it didn't disable");
  assert.match(popup, /if \(!SetForegroundWindow\(window\) \|\| !ForegroundIsOurs\(\)\) \{[^}]*return;/, "a menu that can't take the foreground isn't tracked");
  assert.match(native("WindowManager.h"), /if \(DialogParts::ActivatesMenuThread\(static_cast<DWORD>\(lParam\)\)\) DialogParts::ModalRegistry::Shared\(\)\.withheldResign = true;\n\s+else \{\n\s+DialogParts::ModalRegistry::Shared\(\)\.withheldResign = false;\n\s+manager->EmitApp\("resignActive"\);/, "a normal resignActive replaces the one a menu held back");
  assert.match(shown, /withheldResign\.exchange\(false\) && !Menus::ForegroundIsOurs\(\)\) EmitEvent/, "the menu sends only the resignActive it held back");
  const held = readFileSync(new URL("../../../../packages/expo-windows/src/selfCheck/heldMenus.ts", import.meta.url), "utf8");
  assert.match(held, /loadWhileMenuHeld\(false, "held-menu-own-thread", LOAD_MS\)/);
  assert.match(held, /held = menus\(\)\.devHoldMenu\(MENU_OWNER, onUiThread\);/, "the menu is held in a window of its own, so the page loads in another window");
  assert.match(held, /!\(await loadWhileMenuHeld\(true, "held-menu-ui-thread", STALLED_MS\)\)/);
  assert.match(readFileSync(new URL("../../../../packages/expo-windows/src/modules.ts", import.meta.url), "utf8"), /Pick<MenusModule, "openCount">>\("ArdiaMenus"\)\?\.openCount\(\)/, "pages asked while a menu is open count in dialog_pages_asked");
});
