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
    guard let method = class_getInstanceMethod(editorClass, insert) else { return }
    typealias Insert = @convention(c) (NSTextView, Selector, AnyObject, NSRange) -> Void
    let original = unsafeBitCast(method_getImplementation(method), to: Insert.self)
    let kept: @convention(block) (NSTextView, AnyObject, NSRange) -> Void = { field, value, replacement in
      if keeps(field, inserting: value, at: replacement) { return }
      original(field, insert, value, replacement)
    }
    class_replaceMethod(editorClass, insert, imp_implementationWithBlock(kept), method_getTypeEncoding(method))
  }
}
