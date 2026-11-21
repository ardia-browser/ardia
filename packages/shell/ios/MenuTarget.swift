import AppKit
import ArdiaCore

final class MenuTarget: NSObject, NSMenuItemValidation {
  static let shared = MenuTarget()
  var swallowsCommands = false

  func dispatch(_ command: String, _ arg: String?, windowId: String?) {
    guard !swallowsCommands else { return }
    if command == "closeTab", WindowManager.shared.closeForeignKeyWindow() { return }
    ShellEvents.send(.command, [
      "command": command, "arg": arg as Any, "windowId": windowId as Any, "focusGeneration": FocusHandoff.shared.takeBegun() as Any,
    ])
  }

  private static let focusMovingCommands: Set<String> = ["newTab", "focusCommandBar", "findInPage", "showHistory"]

  @objc(commandDispatch:) func performCommand(_ sender: NSMenuItem) {
    guard let item = sender as? CommandItem else { return }
    _ = FocusHandoff.shared.takeBegun()
    if Self.focusMovingCommands.contains(item.command) || FocusHandoff.shared.gatesKeyWindow, let window = NSApp.keyWindow {
      FocusHandoff.shared.begin(in: window)
    }
    dispatch(item.command, item.arg, windowId: item.windowless ? nil : WindowManager.shared.keyWindowId)
    if item.command == "tabSwitcher" { SwitcherHold.opened(by: item) }
  }

  @objc(cut:) func cutEdit(_ sender: Any?) {
    let field = NSApp.keyWindow?.firstResponder
    guard let url = FieldCopy.url(for: field) else { return forwardEdit(#selector(NSText.cut(_:)), from: sender) }
    Self.writeToPasteboard(url)
    (field as? NSText)?.delete(sender)
  }
  @objc(copy:) func copyEdit(_ sender: Any?) {
    guard let url = FieldCopy.url(for: NSApp.keyWindow?.firstResponder) else { return forwardEdit(#selector(NSText.copy(_:)), from: sender) }
    Self.writeToPasteboard(url)
  }

  private static func writeToPasteboard(_ text: String) {
    NSPasteboard.general.clearContents()
    NSPasteboard.general.setString(text, forType: .string)
  }
  @objc(paste:) func pasteEdit(_ sender: Any?) { forwardEdit(#selector(NSText.paste(_:)), from: sender) }
  @objc(selectAll:) func selectAllEdit(_ sender: Any?) { forwardEdit(#selector(NSText.selectAll(_:)), from: sender) }

  static let undoAction = Selector(("undo:"))
  static let redoAction = Selector(("redo:"))

  @objc(undo:) func undoOrReopenClosedTab(_ sender: Any?) {
    if Self.undoReopensClosedTab {
      dispatch("reopenClosedTab", nil, windowId: WindowManager.shared.keyWindowId)
    } else if let edits = Self.focusedTextEdits {
      edits.undo()
    } else {
      NSApp.sendAction(Self.undoAction, to: nil, from: sender)
    }
  }

  @objc(redo:) func redoEdit(_ sender: Any?) {
    if let edits = Self.focusedTextEdits {
      edits.redo()
    } else {
      NSApp.sendAction(Self.redoAction, to: nil, from: sender)
    }
  }

  private static var focusedTextEdits: UndoManager? {
    guard let text = NSApp.keyWindow?.firstResponder as? NSTextView, text.allowsUndo else { return nil }
    return text.undoManager
  }

  private static var undoReopensClosedTab: Bool {
    let state = MenuState.current
    guard state.undoReopensClosedTab, !state.disabled.contains("reopenClosedTab"),
      WindowManager.shared.keyWindowKind != .settings, let window = WindowManager.shared.keyBrowserWindow
    else { return false }
    return !MainMenu.editsText(window.firstResponder)
  }

  private static var pageIsCovered: Bool { ArdiaWebView.refusesInputAheadOfSwitch(NSApp.keyWindow?.firstResponder) }

  private func forwardEdit(_ action: Selector, from sender: Any?) {
    if Self.pageIsCovered { return }
    if FocusHandoff.shared.defers(action) {
      PasteRefusal.reportMenuPaste(action, .deferred)
      return
    }
    FocusHandoff.shared.noteForwarded(action)
    if !NSApp.sendAction(action, to: nil, from: sender) { PasteRefusal.reportMenuPaste(action, .refused) }
  }

  private static func validateForwarded(_ menuItem: NSMenuItem, _ action: Selector) -> Bool {
    guard let target = NSApp.target(forAction: action) as? NSObject, !ArdiaWebView.refusesInputAheadOfSwitch(target) else { return false }
    typealias Validate = @convention(c) (AnyObject, Selector, NSMenuItem) -> ObjCBool
    for name in ["validateMenuItem:", "validateUserInterfaceItem:"] {
      let validate = NSSelectorFromString(name)
      if target.responds(to: validate) {
        return unsafeBitCast(target.method(for: validate), to: Validate.self)(target, validate, menuItem).boolValue
      }
    }
    return true
  }

  func validateMenuItem(_ menuItem: NSMenuItem) -> Bool {
    if let action = menuItem.action, FocusHandoff.editActions.contains(action), Self.pageIsCovered { return false }
    if let action = menuItem.action, FocusHandoff.editActions.contains(action), FocusHandoff.shared.gatesKeyWindow { return true }
    if let action = menuItem.action, FocusHandoff.editActions.contains(action), !(menuItem is CommandItem),
      action != #selector(pasteAndMatchStyle(_:)) {
      return Self.validateForwarded(menuItem, action)
    }
    if menuItem.action == #selector(closeWindow(_:)) { return WindowManager.shared.closableWindow != nil }
    if menuItem.action == #selector(toggleKeepOnTop(_:)) {
      guard let window = WindowManager.shared.keyBrowserWindow else { return false }
      menuItem.state = window.level == .floating ? .on : .off
      return true
    }
    if menuItem.action == Self.undoAction {
      let reopens = Self.undoReopensClosedTab
      let title = reopens ? "Undo Close Tab" : (menuItem as? StandardItem)?.defaultTitle ?? menuItem.title
      if menuItem.title != title { menuItem.title = title }
      if reopens { return true }
      return Self.focusedTextEdits.map(\.canUndo) ?? Self.validateForwarded(menuItem, Self.undoAction)
    }
    if menuItem.action == Self.redoAction {
      return Self.focusedTextEdits.map(\.canRedo) ?? Self.validateForwarded(menuItem, Self.redoAction)
    }
    guard let item = menuItem as? CommandItem else { return true }
    let state = MenuState.current
    if item.tracksChecked { item.state = state.checked.contains(item.stateKey) ? .on : .off }
    let title = state.titles[item.stateKey] ?? item.defaultTitle
    if item.title != title { item.title = title }
    if item.keyEquivalent == "\r", NSApp.keyWindow?.firstResponder is NSText { return false }
    if MainMenu.movesCaret(item), NSApp.currentEvent?.type == .keyDown, MainMenu.editsText(NSApp.keyWindow?.firstResponder) { return false }
    if item.command == "findInPage", WindowManager.shared.keyWindowKind == .settings { return true }
    let enabled = !state.disabled.contains(item.stateKey) && !state.disabled.contains(item.command)
    if item.hidesWhenDisabled, item.isHidden == enabled { item.isHidden = !enabled }
    return enabled
  }

  @objc func quit(_ sender: Any?) { QuitFlow.shared.confirm() }
  @objc func arrangeWindowsInFront(_ sender: Any?) { NSApp.arrangeInFront(sender) }
  @objc func toggleKeepOnTop(_ sender: Any?) { WindowManager.shared.toggleKeepOnTop() }
  @objc func closeWindow(_ sender: Any?) { WindowManager.shared.closableWindow?.performClose(sender) }

  @objc func pasteAndMatchStyle(_ sender: Any?) {
    let web = Selector(("pasteAndMatchStyle:"))
    FocusHandoff.shared.countPasteAndMatchStyleKey(NSApp.currentEvent)
    if Self.pageIsCovered { return }
    if FocusHandoff.shared.defers(web) {
      PasteRefusal.reportMenuPaste(web, .deferred)
      return
    }
    let handled =
      NSApp.target(forAction: web) != nil
      ? NSApp.sendAction(web, to: nil, from: sender)
      : NSApp.sendAction(#selector(NSTextView.pasteAsPlainText(_:)), to: nil, from: sender)
    if !handled { PasteRefusal.reportMenuPaste(web, .refused) }
  }
}
