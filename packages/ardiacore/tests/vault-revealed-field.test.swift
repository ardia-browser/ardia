import AppKit
import Testing

@MainActor
@Suite("Revealed secret field")
struct VaultRevealedFieldTests {
  let secret = "fixture-" + "pw-1"

  static func editor(_ text: String, copied: @escaping (String) -> Void) -> NSTextView {
    let editor = VaultRevealedFieldEditor(copySecret: copied)
    editor.string = text
    editor.setSelectedRange(NSRange(location: 0, length: (text as NSString).length))
    return editor
  }

  @Test func `AppKit's own field editor writes a selected secret as plain text`() {
    let board = NSPasteboard(name: NSPasteboard.Name("dev.ardia.tests.revealed-field-\(UUID().uuidString)"))
    defer { board.releaseGlobally() }
    let stock = NSTextView()
    stock.isFieldEditor = true
    stock.string = secret
    stock.setSelectedRange(NSRange(location: 0, length: (secret as NSString).length))
    board.clearContents()
    #expect(stock.writeSelection(to: board, types: stock.writablePasteboardTypes))
    #expect(board.string(forType: .string) == secret)
  }

  @Test func `the revealed field never writes its selection to a pasteboard or Services`() {
    let board = NSPasteboard(name: NSPasteboard.Name("dev.ardia.tests.revealed-field-\(UUID().uuidString)"))
    defer { board.releaseGlobally() }
    let revealed = Self.editor(secret) { _ in }
    board.clearContents()
    #expect(revealed.writeSelection(to: board, types: revealed.writablePasteboardTypes) == false)
    #expect(board.string(forType: .string) == nil)
    #expect(revealed.validRequestor(forSendType: .string, returnType: nil) == nil)
  }

  @Test func `Copy and Cut hand the selection to the vault clipboard`() {
    var copied: [String] = []
    let revealed = Self.editor(secret) { copied.append($0) }
    revealed.copy(nil)
    #expect(copied == [secret])
    #expect(revealed.string == secret)

    let length = (secret as NSString).length
    revealed.setSelectedRange(NSRange(location: 0, length: length - 1))
    revealed.cut(nil)
    #expect(copied == [secret, String(secret.dropLast())])
    #expect(revealed.string == String(secret.suffix(1)))

    revealed.setSelectedRange(NSRange(location: 1, length: 0))
    revealed.copy(nil)
    #expect(copied.count == 2)
  }

  @Test func `the editor turns off every typing assistant`() {
    let revealed = Self.editor("") { _ in }
    #expect(revealed.isFieldEditor)
    #expect(revealed.isContinuousSpellCheckingEnabled == false)
    #expect(revealed.isGrammarCheckingEnabled == false)
    #expect(revealed.isAutomaticSpellingCorrectionEnabled == false)
    #expect(revealed.isAutomaticTextReplacementEnabled == false)
    #expect(revealed.isAutomaticTextCompletionEnabled == false)
    #expect(revealed.isAutomaticQuoteSubstitutionEnabled == false)
    #expect(revealed.isAutomaticDashSubstitutionEnabled == false)
    #expect(revealed.isAutomaticDataDetectionEnabled == false)
    #expect(revealed.isAutomaticLinkDetectionEnabled == false)
    #expect(revealed.inlinePredictionType == .no)
    if #available(macOS 15.0, *) {
      #expect(revealed.writingToolsBehavior == .none)
    }
  }

  @Test func `the context menu keeps only editing commands`() {
    let menu = NSMenu()
    for action in [#selector(NSText.cut(_:)), #selector(NSText.copy(_:)), #selector(NSText.paste(_:)), #selector(NSText.selectAll(_:)),
                   NSSelectorFromString("_lookUpDefiniteRangeInDictionaryFromMenu:"), NSSelectorFromString("orderFrontSharingServicePicker:")] {
      menu.addItem(NSMenuItem(title: NSStringFromSelector(action), action: action, keyEquivalent: ""))
    }
    menu.addItem(NSMenuItem(title: "Services", action: nil, keyEquivalent: ""))
    let kept = VaultRevealedFieldEditor.editingOnly(menu).items.compactMap { $0.action.map(NSStringFromSelector) }
    #expect(kept == ["cut:", "copy:", "paste:", "selectAll:"])
  }

  @Test func `editing the revealed field uses the vault field editor and only there`() throws {
    _ = NSApplication.shared
    let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 200, height: 40), styleMask: [.borderless], backing: .buffered, defer: true)
    window.isReleasedWhenClosed = false
    defer { window.close() }
    var copied: [String] = []
    let cell = VaultRevealedFieldCell(textCell: "")
    cell.isEditable = true
    cell.copySecret = { copied.append($0) }
    let field = NSTextField(frame: NSRect(x: 0, y: 0, width: 200, height: 22))
    field.cell = cell
    field.stringValue = secret
    window.contentView?.addSubview(field)
    #expect(window.makeFirstResponder(field))
    let editing = try #require(field.currentEditor() as? VaultRevealedFieldEditor)
    #expect(editing.inlinePredictionType == .no)
    #expect(editing.isAutomaticSpellingCorrectionEnabled == false)
    editing.selectAll(nil)
    editing.copy(nil)
    #expect(copied == [secret])
    window.makeFirstResponder(nil)
    let other = NSTextField(frame: NSRect(x: 0, y: 0, width: 200, height: 22))
    window.contentView?.addSubview(other)
    window.makeFirstResponder(other)
    #expect((other.currentEditor() is VaultRevealedFieldEditor) == false)
  }
}
