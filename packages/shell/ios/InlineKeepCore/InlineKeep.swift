import AppKit

enum InlineKeep {
  static var fields = Set<Int>()
  private static weak var editor: NSTextView?
  private static var tag = 0
  private static var typedLength = 0
  private static var text = ""
  private static let lock = NSLock()
  private static var kept: [(tag: Int, typed: String, completion: String)] = []
  private static var installed = false
  private static var watcher: NSObjectProtocol?
  private static weak var suggesting: NSTextView?
  private static var historyLength = 0

  static func take(tag: Int, start: Int, end: Int) -> [String] {
    lock.lock()
    defer { lock.unlock() }
    let length = { (text: String) in (text as NSString).length }
    guard let at = kept.firstIndex(where: { $0.tag == tag && length($0.typed) == start && length($0.typed) + length($0.completion) == end }) else { return [] }
    let found = kept[at]
    kept = kept.enumerated().filter { $0.offset > at || $0.element.tag != tag }.map(\.element)
    return [found.typed, found.completion]
  }

  private static func noteKept(_ value: (tag: Int, typed: String, completion: String)) {
    lock.lock()
    kept.append(value)
    lock.unlock()
  }

  private static func forget(tag fieldTag: Int) {
    lock.lock()
    kept.removeAll { $0.tag == fieldTag }
    lock.unlock()
  }

  static func release(tag fieldTag: Int) {
    fields.remove(fieldTag)
    forget(tag: fieldTag)
    if fieldTag == tag { watch(nil) }
  }

  static func complete(_ field: NSTextView, tag fieldTag: Int, typed: String, completion: String) -> Int {
    guard !field.hasMarkedText() else { return 0 }
    let whole = field.string as NSString
    let typedCount = (typed as NSString).length
    let selection = field.selectedRange()
    guard whole.length >= typedCount, whole.substring(to: typedCount) == typed,
          selection.location == typedCount, NSMaxRange(selection) == whole.length
    else { return 0 }
    let tracked = suggesting === field && field.string == text
    let tail = NSRange(location: typedCount, length: whole.length - typedCount)
    var result = 1
    let silent = tracked || tail.length == 0
    if whole.substring(with: tail) != completion {
      guard silent ? editWithoutUndo(field, tail, completion) : edit(field, tail, completion) else { return 0 }
      result = 2
    }
    let known = tracked ? min(historyLength, typedCount) : result == 2 && silent ? typedCount : (field.string as NSString).length
    field.setSelectedRange(NSRange(location: typedCount, length: (completion as NSString).length))
    field.scrollRangeToVisible(NSRange(location: 0, length: 0))
    field.scrollRangeToVisible(NSRange(location: typedCount, length: 0))
    arm(field, tag: fieldTag, typedLength: typedCount, keeps: fields.contains(fieldTag) && !completion.isEmpty)
    historyLength = known
    suggesting = known < (field.string as NSString).length ? field : nil
    return result
  }

  static func settle(_ field: NSTextView) {
    _ = settle(field, typing: nil)
  }

  private static func settle(_ field: NSTextView, before replacement: NSRange) {
    let reachesSuggestion = replacement.location != NSNotFound && NSMaxRange(replacement) > typedLength
    _ = settle(field, typing: nil, keepingSuggestion: reachesSuggestion)
  }

  private static func settle(_ field: NSTextView, typing: String?, keepingSuggestion: Bool = false) -> Bool {
    guard suggesting === field else { return false }
    suggesting = nil
    guard field.string == text, !field.hasMarkedText() else { return false }
    let whole = field.string as NSString
    let selection = field.selectedRange()
    let suggestion = NSRange(location: typedLength, length: whole.length - typedLength)
    let shown = selection == suggestion && !keepingSuggestion
    let unknown = NSRange(location: historyLength, length: whole.length - historyLength)
    let restored = whole.substring(with: NSRange(location: historyLength, length: (shown ? typedLength : whole.length) - historyLength)) + (shown ? typing ?? "" : "")
    watch(nil)
    if restored.isEmpty {
      return editWithoutUndo(field, unknown, "") && shown
    }
    field.textStorage?.replaceCharacters(in: unknown, with: "")
    field.setSelectedRange(NSRange(location: historyLength, length: 0))
    field.insertText(restored, replacementRange: NSRange(location: NSNotFound, length: 0))
    if !shown { field.setSelectedRange(selection) }
    return shown
  }

  private static func editWithoutUndo(_ field: NSTextView, _ range: NSRange, _ replacement: String) -> Bool {
    guard let storage = field.textStorage else { return false }
    storage.replaceCharacters(in: range, with: replacement)
    field.didChangeText()
    return true
  }

  private static func edit(_ field: NSTextView, _ range: NSRange, _ replacement: String) -> Bool {
    guard field.shouldChangeText(in: range, replacementString: replacement) else { return false }
    field.replaceCharacters(in: range, with: replacement)
    field.didChangeText()
    return true
  }

  private static func suggestionShown(_ field: NSTextView) -> Bool {
    guard suggesting === field, field.string == text else { return false }
    return field.selectedRange() == NSRange(location: typedLength, length: (field.string as NSString).length - typedLength)
  }

  static func arm(_ field: NSTextView, tag fieldTag: Int, typedLength length: Int, keeps: Bool) {
    forget(tag: fieldTag)
    tag = fieldTag
    typedLength = length
    text = field.string
    watch(keeps ? field : nil)
  }

  private static func watch(_ field: NSTextView?) {
    if let watcher { NotificationCenter.default.removeObserver(watcher) }
    watcher = nil
    editor = field
    guard let field else { return }
    watcher = NotificationCenter.default.addObserver(forName: NSTextView.didChangeSelectionNotification, object: field, queue: nil) { _ in
      guard editor === field, field.selectedRange() != armedSelection() else { return }
      watch(nil)
    }
  }

  private static func armedSelection() -> NSRange {
    NSRange(location: typedLength, length: (text as NSString).length - typedLength)
  }

  static func keeps(_ field: NSTextView, inserting value: Any, at replacement: NSRange) -> Bool {
    guard field === editor, replacement.location == NSNotFound, !field.hasMarkedText(), field.string == text else { return false }
    guard let typed = (value as? String) ?? (value as? NSAttributedString)?.string, !typed.isEmpty,
          typed.rangeOfCharacter(from: .whitespacesAndNewlines) == nil
    else { return false }
    let whole = field.string as NSString
    let selection = field.selectedRange()
    let typedCount = (typed as NSString).length
    guard selection.location == typedLength, NSMaxRange(selection) == whole.length, selection.length > typedCount,
          whole.substring(with: NSRange(location: typedLength, length: typedCount)) == typed
    else { return false }
    typedLength += typedCount
    noteKept((tag, whole.substring(to: typedLength), whole.substring(from: typedLength)))
    field.setSelectedRange(NSRange(location: typedLength, length: whole.length - typedLength))
    return true
  }

  static func install() {
    guard !installed, let editorClass = NSClassFromString("RCTUIPlainPasteFieldEditor") else { return }
    installed = true
    let insert = #selector(NSTextView.insertText(_:replacementRange:))
    if let method = class_getInstanceMethod(editorClass, insert) {
      typealias Insert = @convention(c) (NSTextView, Selector, AnyObject, NSRange) -> Void
      let original = unsafeBitCast(method_getImplementation(method), to: Insert.self)
      let kept: @convention(block) (NSTextView, AnyObject, NSRange) -> Void = { field, value, replacement in
        if keeps(field, inserting: value, at: replacement) { return }
        let typed = (value as? String) ?? (value as? NSAttributedString)?.string
        if replacement.location == NSNotFound, let typed, suggestionShown(field), settle(field, typing: typed) { return }
        settle(field, before: replacement)
        original(field, insert, value, replacement)
      }
      class_replaceMethod(editorClass, insert, imp_implementationWithBlock(kept), method_getTypeEncoding(method))
    }
    for action in removingActions { settleFirst(editorClass, action, removesSuggestion: true) }
    for action in editingActions { settleFirst(editorClass, action, removesSuggestion: false) }
    let mark = #selector(NSTextView.setMarkedText(_:selectedRange:replacementRange:))
    if let method = class_getInstanceMethod(editorClass, mark) {
      typealias Mark = @convention(c) (NSTextView, Selector, AnyObject, NSRange, NSRange) -> Void
      let original = unsafeBitCast(method_getImplementation(method), to: Mark.self)
      let marked: @convention(block) (NSTextView, AnyObject, NSRange, NSRange) -> Void = { field, value, selected, replacement in
        if !field.hasMarkedText() { settle(field, before: replacement) }
        original(field, mark, value, selected, replacement)
      }
      class_replaceMethod(editorClass, mark, imp_implementationWithBlock(marked), method_getTypeEncoding(method))
    }
  }

  private static let removingActions: [Selector] = [
    #selector(NSText.delete(_:)), #selector(NSResponder.deleteBackward(_:)), #selector(NSResponder.deleteForward(_:)),
    #selector(NSResponder.deleteWordBackward(_:)), #selector(NSResponder.deleteWordForward(_:)),
    #selector(NSResponder.deleteToBeginningOfLine(_:)), #selector(NSResponder.deleteToEndOfLine(_:)),
    #selector(NSResponder.deleteToBeginningOfParagraph(_:)), #selector(NSResponder.deleteToEndOfParagraph(_:)),
    #selector(NSResponder.deleteBackwardByDecomposingPreviousCharacter(_:)), #selector(NSResponder.deleteToMark(_:)),
  ]

  private static let editingActions: [Selector] = [
    #selector(NSText.paste(_:)), #selector(NSTextView.pasteAsPlainText(_:)), #selector(NSTextView.pasteAsRichText(_:)),
    #selector(NSResponder.yank(_:)), #selector(NSResponder.transpose(_:)), #selector(NSResponder.transposeWords(_:)),
    #selector(NSResponder.capitalizeWord(_:)), #selector(NSResponder.lowercaseWord(_:)), #selector(NSResponder.uppercaseWord(_:)),
  ]

  private static func settleFirst(_ editorClass: AnyClass, _ action: Selector, removesSuggestion: Bool) {
    guard let method = class_getInstanceMethod(editorClass, action) else { return }
    typealias Action = @convention(c) (NSTextView, Selector, AnyObject?) -> Void
    let original = unsafeBitCast(method_getImplementation(method), to: Action.self)
    let settled: @convention(block) (NSTextView, AnyObject?) -> Void = { field, sender in
      if removesSuggestion, suggestionShown(field), (field.string as NSString).length > typedLength, settle(field, typing: "") { return }
      settle(field)
      original(field, action, sender)
    }
    class_replaceMethod(editorClass, action, imp_implementationWithBlock(settled), method_getTypeEncoding(method))
  }
}
