import AppKit
import ExpoModulesCore

final class VaultPasswordFieldView: ExpoView, NSTextFieldDelegate {
  let onEdit = EventDispatcher()
  let onSubmit = EventDispatcher()
  let onEscape = EventDispatcher()
  let onTab = EventDispatcher()
  let onFocusChange = EventDispatcher()
  private var responderWatch: NSKeyValueObservation?
  private var focused = false

  var draft = "" {
    didSet {
      guard draft != oldValue else { return }
      if !oldValue.isEmpty { VaultPasswordDrafts.drop(oldValue) }
      load()
    }
  }

  var entry = "" {
    didSet {
      guard entry != oldValue else { return }
      let value = VaultSecretEntries.value(entry) ?? ""
      secureField.stringValue = value
      shown.stringValue = value
      onEdit(["length": value.count])
    }
  }

  var revealed = false {
    didSet {
      guard revealed != oldValue else { return }
      swap()
    }
  }

  var placeholder = "" {
    didSet {
      let styled = NSAttributedString(
        string: placeholder, attributes: [.foregroundColor: NSColor.placeholderTextColor, .font: NSFont.systemFont(ofSize: NSFont.systemFontSize)])
      secureField.placeholderAttributedString = styled
      shown.placeholderAttributedString = styled
    }
  }

  var bordered = true {
    didSet {
      guard bordered != oldValue else { return }
      for field in [secureField, shown] { style(field) }
    }
  }

  var label = "" {
    didSet {
      secureField.setAccessibilityLabel(label.isEmpty ? nil : label)
      shown.setAccessibilityLabel(label.isEmpty ? nil : label)
    }
  }

  var autoFocus = false
  var tabs = false

  private let secureField = NSSecureTextField()
  private let shown = NSTextField()

  required init(appContext: AppContext? = nil) {
    super.init(appContext: appContext)
    let revealedCell = VaultRevealedFieldCell(textCell: "")
    revealedCell.isEditable = true
    revealedCell.copySecret = { secret in Task { _ = await VaultClipboard.copy(secret) } }
    shown.cell = revealedCell
    shown.isAutomaticTextCompletionEnabled = false
    for field in [secureField, shown] {
      style(field)
      field.font = .systemFont(ofSize: NSFont.systemFontSize)
      field.usesSingleLineMode = true
      field.lineBreakMode = .byClipping
      field.cell?.isScrollable = true
      field.delegate = self
      addSubview(field)
    }
    shown.isHidden = true
  }

  private func style(_ field: NSTextField) {
    field.bezelStyle = .roundedBezel
    field.isBezeled = bordered
    field.isBordered = bordered
    field.drawsBackground = bordered
    field.focusRingType = bordered ? .default : .none
  }

  override func layout() {
    super.layout()
    let height = bordered ? bounds.height : min(bounds.height, ceil(secureField.intrinsicContentSize.height))
    let frame = NSRect(x: 0, y: (bounds.height - height) / 2, width: bounds.width, height: height)
    secureField.frame = frame
    shown.frame = frame
  }

  override func viewDidMoveToWindow() {
    super.viewDidMoveToWindow()
    responderWatch = window?.observe(\.firstResponder, options: [.new]) { [weak self] _, _ in
      DispatchQueue.main.async { self?.noteFocus() }
    }
    noteFocus()
    guard window != nil else {
      if !draft.isEmpty, !VaultPasswordDrafts.outlivesField(draft) { draft = "" }
      return
    }
    if autoFocus { DispatchQueue.main.async { [weak self] in self?.focus() } }
  }

  private func noteFocus() {
    let editor = window?.firstResponder as? NSText
    let now = window != nil && [secureField, shown].contains { $0.currentEditor() != nil && $0.currentEditor() === editor }
    guard now != focused else { return }
    focused = now
    onFocusChange(["focused": now])
  }

  func focus() {
    guard let window else { return }
    window.makeFirstResponder(active)
  }

  private var active: NSTextField { revealed ? shown : secureField }

  private func load() {
    let value = VaultPasswordDrafts.value(draft) ?? ""
    secureField.stringValue = value
    shown.stringValue = value
    onEdit(["length": value.count])
  }

  private func swap() {
    let from = revealed ? secureField : shown
    let to = active
    let wasEditing = from.currentEditor() != nil
    to.stringValue = from.stringValue
    from.isHidden = true
    to.isHidden = false
    if wasEditing, let window, window.isKeyWindow {
      window.makeFirstResponder(to)
      to.currentEditor()?.selectedRange = NSRange(location: (to.stringValue as NSString).length, length: 0)
    }
  }

  func controlTextDidChange(_ notification: Notification) {
    guard let field = notification.object as? NSTextField, field === active else { return }
    let value = field.stringValue
    if !entry.isEmpty { VaultSecretEntries.set(entry, value) }
    if !draft.isEmpty { VaultPasswordDrafts.edit(draft, to: value) }
    onEdit(["length": value.count])
  }

  func control(_ control: NSControl, textView: NSTextView, doCommandBy selector: Selector) -> Bool {
    switch selector {
    case #selector(NSResponder.insertNewline(_:)):
      onSubmit([:])
      return true
    case #selector(NSResponder.cancelOperation(_:)):
      onEscape([:])
      return true
    case #selector(NSResponder.insertTab(_:)) where !entry.isEmpty || tabs:
      onTab(["back": false])
      return true
    case #selector(NSResponder.insertBacktab(_:)) where !entry.isEmpty || tabs:
      onTab(["back": true])
      return true
    default:
      return false
    }
  }
}

public class VaultPasswordFieldModule: Module {
  public func definition() -> ModuleDefinition {
    Name("ArdiaVaultPasswordField")

    Function("dropEntry") { (token: String) in VaultSecretEntries.drop(token) }

    View(VaultPasswordFieldView.self) {
      Events("onEdit", "onSubmit", "onEscape", "onTab", "onFocusChange")
      Prop("draft") { (view: VaultPasswordFieldView, value: String?) in view.draft = value ?? "" }
      Prop("entry") { (view: VaultPasswordFieldView, value: String?) in view.entry = value ?? "" }
      Prop("revealed") { (view: VaultPasswordFieldView, value: Bool?) in view.revealed = value ?? false }
      Prop("placeholder") { (view: VaultPasswordFieldView, value: String?) in view.placeholder = value ?? "" }
      Prop("bordered") { (view: VaultPasswordFieldView, value: Bool?) in view.bordered = value ?? true }
      Prop("label") { (view: VaultPasswordFieldView, value: String?) in view.label = value ?? "" }
      Prop("autoFocus") { (view: VaultPasswordFieldView, value: Bool?) in view.autoFocus = value ?? false }
      Prop("tabs") { (view: VaultPasswordFieldView, value: Bool?) in view.tabs = value ?? false }
      AsyncFunction("focus") { (view: VaultPasswordFieldView) in view.focus() }.runOnQueue(.main)
    }
  }
}
