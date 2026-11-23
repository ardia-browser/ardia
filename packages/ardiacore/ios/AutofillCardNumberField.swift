import AppKit
import ExpoModulesCore

final class AutofillCardNumberFieldView: ExpoView, NSTextFieldDelegate {
  let onEdit = EventDispatcher()
  let onSubmit = EventDispatcher()
  let onEscape = EventDispatcher()
  let onTab = EventDispatcher()
  let onFocusChange = EventDispatcher()
  private var responderWatch: NSKeyValueObservation?
  private var focused = false
  private let field = NSTextField()

  var entry = "" {
    didSet {
      guard entry != oldValue else { return }
      show(AutofillCardNumber.digits(VaultSecretEntries.value(entry) ?? ""), caretAfter: nil)
    }
  }

  var placeholder = "" {
    didSet {
      field.placeholderAttributedString = NSAttributedString(
        string: placeholder, attributes: [.foregroundColor: NSColor.placeholderTextColor, .font: Self.font])
    }
  }

  var label = "" {
    didSet { field.setAccessibilityLabel(label.isEmpty ? nil : label) }
  }

  var autoFocus = false

  private static let font = NSFont.monospacedDigitSystemFont(ofSize: NSFont.systemFontSize, weight: .regular)

  required init(appContext: AppContext? = nil) {
    super.init(appContext: appContext)
    field.isBezeled = false
    field.isBordered = false
    field.drawsBackground = false
    field.focusRingType = .none
    field.font = Self.font
    field.usesSingleLineMode = true
    field.lineBreakMode = .byClipping
    field.cell?.isScrollable = true
    field.contentType = .creditCardNumber
    if #available(macOS 15.2, *) { field.allowsWritingTools = false }
    if #available(macOS 15.4, *) { field.allowsWritingToolsAffordance = false }
    field.delegate = self
    addSubview(field)
  }

  override func layout() {
    super.layout()
    let height = min(bounds.height, ceil(field.intrinsicContentSize.height))
    field.frame = NSRect(x: 0, y: (bounds.height - height) / 2, width: bounds.width, height: height)
  }

  override func viewDidMoveToWindow() {
    super.viewDidMoveToWindow()
    responderWatch = window?.observe(\.firstResponder, options: [.new]) { [weak self] _, _ in
      DispatchQueue.main.async { self?.noteFocus() }
    }
    noteFocus()
    if window != nil, autoFocus { DispatchQueue.main.async { [weak self] in self?.focus() } }
  }

  private func noteFocus() {
    let editor = window?.firstResponder as? NSText
    let now = window != nil && field.currentEditor() != nil && field.currentEditor() === editor
    guard now != focused else { return }
    focused = now
    onFocusChange(["focused": now])
  }

  func focus() {
    window?.makeFirstResponder(field)
  }

  private func show(_ digits: String, caretAfter typed: Int?) {
    let text = AutofillCardNumber.formatted(digits)
    if field.stringValue != text { field.stringValue = text }
    if let typed, let editor = field.currentEditor() {
      let at = AutofillCardNumber.caret(afterDigits: typed, in: text)
      editor.selectedRange = NSRange(location: (String(text.prefix(at)) as NSString).length, length: 0)
    }
    if !entry.isEmpty { VaultSecretEntries.set(entry, digits) }
    onEdit(AutofillCardNumber.summary(digits))
  }

  func controlTextDidChange(_ notification: Notification) {
    let typed = field.stringValue
    let caret = field.currentEditor()?.selectedRange.location ?? (typed as NSString).length
    let before = AutofillCardNumber.digits((typed as NSString).substring(to: min(caret, (typed as NSString).length))).count
    show(AutofillCardNumber.digits(typed), caretAfter: before)
  }

  func control(_ control: NSControl, textView: NSTextView, doCommandBy selector: Selector) -> Bool {
    switch selector {
    case #selector(NSResponder.insertNewline(_:)):
      onSubmit([:])
      return true
    case #selector(NSResponder.cancelOperation(_:)):
      onEscape([:])
      return true
    case #selector(NSResponder.insertTab(_:)):
      onTab(["back": false])
      return true
    case #selector(NSResponder.insertBacktab(_:)):
      onTab(["back": true])
      return true
    default:
      return false
    }
  }
}

public class AutofillCardNumberFieldModule: Module {
  public func definition() -> ModuleDefinition {
    Name("ArdiaAutofillCardField")

    View(AutofillCardNumberFieldView.self) {
      Events("onEdit", "onSubmit", "onEscape", "onTab", "onFocusChange")
      Prop("entry") { (view: AutofillCardNumberFieldView, value: String?) in view.entry = value ?? "" }
      Prop("placeholder") { (view: AutofillCardNumberFieldView, value: String?) in view.placeholder = value ?? "" }
      Prop("label") { (view: AutofillCardNumberFieldView, value: String?) in view.label = value ?? "" }
      Prop("autoFocus") { (view: AutofillCardNumberFieldView, value: Bool?) in view.autoFocus = value ?? false }
      AsyncFunction("focus") { (view: AutofillCardNumberFieldView) in view.focus() }.runOnQueue(.main)
    }
  }
}
