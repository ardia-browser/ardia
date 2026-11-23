import AppKit

final class VaultRevealedFieldEditor: NSTextView {
  private static let editingActions: Set<Selector> = [
    #selector(NSText.cut(_:)), #selector(NSText.copy(_:)), #selector(NSText.paste(_:)), #selector(NSText.selectAll(_:)),
    #selector(NSText.delete(_:)), #selector(NSTextView.pasteAsPlainText(_:)),
  ]

  private var copySecret: (String) -> Void = { _ in }

  convenience init(copySecret: @escaping (String) -> Void) {
    self.init(frame: .zero)
    self.copySecret = copySecret
  }

  override init(frame: NSRect) {
    super.init(frame: frame)
    stopAssisting()
  }

  override init(frame: NSRect, textContainer: NSTextContainer?) {
    super.init(frame: frame, textContainer: textContainer)
    stopAssisting()
  }

  @available(*, unavailable)
  required init?(coder: NSCoder) { fatalError("init(coder:) is not available") }

  private func stopAssisting() {
    isFieldEditor = true
    isRichText = false
    importsGraphics = false
    usesFindBar = false
    isIncrementalSearchingEnabled = false
    isContinuousSpellCheckingEnabled = false
    isGrammarCheckingEnabled = false
    isAutomaticSpellingCorrectionEnabled = false
    isAutomaticTextReplacementEnabled = false
    isAutomaticTextCompletionEnabled = false
    isAutomaticQuoteSubstitutionEnabled = false
    isAutomaticDashSubstitutionEnabled = false
    isAutomaticDataDetectionEnabled = false
    isAutomaticLinkDetectionEnabled = false
    smartInsertDeleteEnabled = false
    inlinePredictionType = .no
    if #available(macOS 15.0, *) { writingToolsBehavior = .none }
  }

  private var selectedSecret: String? {
    let range = selectedRange()
    guard range.length > 0 else { return nil }
    return (string as NSString).substring(with: range)
  }

  override func copy(_ sender: Any?) {
    guard let selectedSecret else { return }
    copySecret(selectedSecret)
  }

  override func cut(_ sender: Any?) {
    guard let selectedSecret else { return }
    copySecret(selectedSecret)
    delete(sender)
  }

  override func writeSelection(to pboard: NSPasteboard, types: [NSPasteboard.PasteboardType]) -> Bool { false }

  override func writeSelection(to pboard: NSPasteboard, type: NSPasteboard.PasteboardType) -> Bool { false }

  override func validRequestor(forSendType sendType: NSPasteboard.PasteboardType?, returnType: NSPasteboard.PasteboardType?) -> Any? {
    sendType == nil ? super.validRequestor(forSendType: sendType, returnType: returnType) : nil
  }

  override func menu(for event: NSEvent) -> NSMenu? {
    super.menu(for: event).map(Self.editingOnly)
  }

  static func editingOnly(_ menu: NSMenu) -> NSMenu {
    for item in menu.items.reversed() where !(item.action.map(editingActions.contains) ?? false) {
      menu.removeItem(item)
    }
    return menu
  }
}

final class VaultRevealedFieldCell: NSTextFieldCell {
  private var editor: VaultRevealedFieldEditor?
  var copySecret: (String) -> Void = { _ in }

  override func fieldEditor(for controlView: NSView) -> NSTextView? {
    if let editor { return editor }
    let made = VaultRevealedFieldEditor { [weak self] secret in self?.copySecret(secret) }
    editor = made
    return made
  }
}
