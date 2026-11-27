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
  private var appResigning = false
  private let blurs = FieldBlurLog()

  struct BecameKey {
    let restored: Bool
    let field: Int?
  }

  func install() {
    guard !installed else { return }
    installed = true
    let center = NotificationCenter.default
    center.addObserver(self, selector: #selector(fieldDidEndEditing(_:)), name: NSControl.textDidEndEditingNotification, object: nil)
    center.addObserver(self, selector: #selector(appWillResignActive(_:)), name: NSApplication.willResignActiveNotification, object: nil)
    center.addObserver(self, selector: #selector(appActivityChanged(_:)), name: NSApplication.didResignActiveNotification, object: nil)
    center.addObserver(self, selector: #selector(appActivityChanged(_:)), name: NSApplication.didBecomeActiveNotification, object: nil)
  }

  func fieldBlurCause(_ fieldTag: Int) -> String { blurs.take(field: fieldTag) ? "keyLoss" : "inWindow" }

  func watchFieldBlurs(_ fieldTag: Int, _ watch: Bool) {
    if watch { blurs.watch(field: fieldTag) } else { blurs.unwatch(field: fieldTag) }
  }

  private static func reactTagged(_ view: NSView?) -> (view: NSView, tag: Int)? {
    var current = view
    while let candidate = current {
      if candidate.responds(to: NSSelectorFromString("reactTag")), let tag = candidate.value(forKey: "reactTag") as? NSNumber { return (candidate, tag.intValue) }
      current = candidate.superview
    }
    return nil
  }

  private static func reactTag(of view: NSView?) -> Int? { reactTagged(view)?.tag }

  private static func flag(_ object: AnyObject, _ name: String) -> Bool? {
    guard let type = object_getClass(object), let ivar = class_getInstanceVariable(type, name), let encoding = ivar_getTypeEncoding(ivar),
      ["B", "c"].contains(String(cString: encoding))
    else { return nil }
    return Unmanaged.passUnretained(object).toOpaque().load(fromByteOffset: ivar_getOffset(ivar), as: UInt8.self) != 0
  }

  private static func reactSendsBlur(_ field: NSTextField, input: NSView) -> Bool {
    flag(field, "_isUpdatingPlaceholderText") == false && flag(input, "_isCurrentlyEditing") == true
  }

  private static func isSyntheticEnd(_ field: NSTextField, input: NSView?) -> Bool {
    flag(field, "_isUpdatingPlaceholderText") == true || input.flatMap { flag($0, "_isCurrentlyEditing") } == false
  }

  @objc private func appWillResignActive(_ notification: Notification) {
    appResigning = true
    guard let window = NSApp.keyWindow, WindowManager.shared.kind(of: window)?.isBrowser == true else { return }
    saveOnResign(window)
  }

  @objc private func appActivityChanged(_ notification: Notification) {
    appResigning = false
  }

  @objc private func fieldDidEndEditing(_ notification: Notification) {
    guard let field = notification.object as? NSTextField, let window = field.window,
      let id = WindowManager.shared.id(of: window),
      WindowManager.shared.kind(of: window)?.isBrowser == true
    else { return }
    let input = Self.reactTagged(field)
    guard !Self.isSyntheticEnd(field, input: input?.view) else { return }
    let keyLoss = appResigning || !NSApp.isActive || !window.isKeyWindow
    if let input, Self.reactSendsBlur(field, input: input.view) {
      blurs.record(field: input.tag, windowId: id, keyLoss: keyLoss) { [weak view = input.view] in view?.window != nil }
    }
    guard keyLoss else { return }
    let editor = notification.userInfo?["NSFieldEditor"] as? NSTextView
    let key = ObjectIdentifier(window)
    if let previous = resignTokens.removeValue(forKey: key) { discard(previous) }
    next += 1
    saved[next] = Saved(window: window, responder: field, selection: editor?.selectedRange())
    resignTokens[key] = next
  }

  func saveOnResign(_ window: NSWindow?) {
    guard let window, Self.isTextInput(window.firstResponder) else { return }
    let key = ObjectIdentifier(window)
    if let previous = resignTokens.removeValue(forKey: key) { discard(previous) }
    let token = save(window)
    if token != 0 { resignTokens[key] = token }
  }

  func restoreOnBecomeKey(_ window: NSWindow, id: String) -> BecameKey {
    let token = resignTokens.removeValue(forKey: ObjectIdentifier(window))
    for (_, other) in resignTokens { discard(other) }
    resignTokens.removeAll()
    blurs.settle { $0 != id }
    let view = token.flatMap { saved[$0]?.responder }
    let field = Self.reactTag(of: view)
    let restored: Bool
    if let token, let view, Self.owner(of: window.firstResponder) === view {
      discard(token)
      restored = true
    } else {
      restored = token.map(restore) ?? false
    }
    if !restored { blurs.settle { $0 == id } }
    return BecameKey(restored: restored, field: restored ? field : nil)
  }

  func windowReplaced(_ window: NSWindow) {
    if let token = resignTokens.removeValue(forKey: ObjectIdentifier(window)) { discard(token) }
  }

  func windowClosed(_ window: NSWindow, id: String) {
    windowReplaced(window)
    blurs.forget { $0 == id }
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
