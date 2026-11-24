import AppKit
import Carbon.HIToolbox
import ExpoModulesCore

final class SavedKeyResponders {
  static let shared = SavedKeyResponders()

  private final class Saved {
    weak var window: NSWindow?
    weak var responder: NSView?
    let selection: NSRange?
    init(window: NSWindow, responder: NSView, selection: NSRange?) {
      self.window = window
      self.responder = responder
      self.selection = selection
    }
  }

  private var saved: [Int: Saved] = [:]
  private var resignTokens: [ObjectIdentifier: Int] = [:]
  private var next = 0
  private var installed = false

  func install() {
    guard !installed else { return }
    installed = true
    let center = NotificationCenter.default
    center.addObserver(self, selector: #selector(textDidEndEditing(_:)), name: NSText.didEndEditingNotification, object: nil)
    center.addObserver(self, selector: #selector(windowDidResignKey(_:)), name: NSWindow.didResignKeyNotification, object: nil)
    center.addObserver(self, selector: #selector(appWillResignActive(_:)), name: NSApplication.willResignActiveNotification, object: nil)
  }

  @objc private func appWillResignActive(_ notification: Notification) {
    guard let window = NSApp.keyWindow, WindowManager.shared.kind(of: window)?.isBrowser == true else { return }
    saveOnResign(window)
  }

  @objc private func textDidEndEditing(_ notification: Notification) {
    guard let editor = notification.object as? NSTextView, editor.isFieldEditor,
      let window = editor.window, !window.isKeyWindow,
      let field = editor.delegate as? NSView,
      let id = WindowManager.shared.id(of: window),
      WindowManager.shared.kind(of: window)?.isBrowser == true
    else { return }
    let key = ObjectIdentifier(window)
    if let previous = resignTokens.removeValue(forKey: key) { discard(previous) }
    next += 1
    saved[next] = Saved(window: window, responder: field, selection: editor.selectedRange())
    resignTokens[key] = next
    ShellEvents.send(.app, ["type": "windowResignedKey", "windowId": id])
  }

  @objc private func windowDidResignKey(_ notification: Notification) {
    guard let window = notification.object as? NSWindow,
      let id = WindowManager.shared.id(of: window),
      WindowManager.shared.kind(of: window)?.isBrowser == true
    else { return }
    ShellEvents.send(.app, ["type": "windowResignedKey", "windowId": id])
  }

  func saveOnResign(_ window: NSWindow?) {
    guard let window, Self.isTextInput(window.firstResponder) else { return }
    let key = ObjectIdentifier(window)
    if let previous = resignTokens.removeValue(forKey: key) { discard(previous) }
    let token = save(window)
    if token != 0 { resignTokens[key] = token }
  }

  func restoreOnBecomeKey(_ window: NSWindow) {
    let token = resignTokens.removeValue(forKey: ObjectIdentifier(window))
    for (_, other) in resignTokens { discard(other) }
    resignTokens.removeAll()
    if let token { _ = restore(token) }
  }

  func windowClosed(_ window: NSWindow) {
    if let token = resignTokens.removeValue(forKey: ObjectIdentifier(window)) { discard(token) }
  }

  private static func isTextInput(_ responder: NSResponder?) -> Bool {
    if let text = responder as? NSTextView, text.isFieldEditor { return true }
    return responder is NSTextField
  }

  func save(_ window: NSWindow?) -> Int {
    saved = saved.filter { $0.value.window != nil && $0.value.responder != nil }
    guard let window, let responder = Self.owner(of: window.firstResponder) else { return 0 }
    let editor = window.firstResponder as? NSTextView
    next += 1
    saved[next] = Saved(window: window, responder: responder, selection: editor?.isFieldEditor == true ? editor?.selectedRange() : nil)
    return next
  }

  func restore(_ token: Int) -> Bool {
    guard let entry = saved.removeValue(forKey: token), let window = entry.window, let view = entry.responder,
      view.window === window, !view.isHiddenOrHasHiddenAncestor, view.acceptsFirstResponder
    else { return false }
    guard window.makeFirstResponder(view) else { return false }
    if let selection = entry.selection, let editor = (view as? NSTextField)?.currentEditor() as? NSTextView,
      NSMaxRange(selection) <= (editor.string as NSString).length
    {
      editor.setSelectedRange(selection)
    }
    return true
  }

  func discard(_ token: Int) {
    saved.removeValue(forKey: token)
  }

  private static func owner(of responder: NSResponder?) -> NSView? {
    if let editor = responder as? NSTextView, editor.isFieldEditor, let field = editor.delegate as? NSView { return field }
    return responder as? NSView
  }
}
