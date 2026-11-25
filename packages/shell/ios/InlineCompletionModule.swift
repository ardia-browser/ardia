import AppKit
import ExpoModulesCore

public final class InlineCompletionModule: Module, InlineCompletionNative {
  func complete(_ tag: Int, _ typed: String, _ completion: String) -> Int {
    guard let host = self.appContext?.findView(withTag: tag, ofType: NSView.self),
          let field = textField(in: host),
          let editor = field.currentEditor() as? NSTextView,
          !editor.hasMarkedText()
    else { return 0 }
    let text = editor.string as NSString
    let typedLength = (typed as NSString).length
    let selection = editor.selectedRange()
    guard text.length >= typedLength, text.substring(to: typedLength) == typed,
          selection.location == typedLength, NSMaxRange(selection) == text.length
    else { return 0 }
    let tail = NSRange(location: typedLength, length: text.length - typedLength)
    var result = 1
    if text.substring(with: tail) != completion {
      guard editor.shouldChangeText(in: tail, replacementString: completion) else { return 0 }
      editor.replaceCharacters(in: tail, with: completion)
      editor.didChangeText()
      result = 2
    }
    editor.setSelectedRange(NSRange(location: typedLength, length: (completion as NSString).length))
    editor.scrollRangeToVisible(NSRange(location: 0, length: 0))
    editor.scrollRangeToVisible(NSRange(location: typedLength, length: 0))
    InlineKeep.arm(editor, tag: tag, typedLength: typedLength, keeps: InlineKeep.fields.contains(tag) && !completion.isEmpty)
    return result
  }

  static func keepWhileTyping(_ tag: Int, _ on: Bool) {
    InlineKeep.install()
    if on { InlineKeep.fields.insert(tag) } else { InlineKeep.release(tag: tag) }
  }

  static func takeKept(_ tag: Int, _ start: Int, _ end: Int) -> [String] { InlineKeep.take(tag: tag, start: start, end: end) }

  static func copyFieldAs(_ shown: String?, _ url: String?) { FieldCopy.target = shown.flatMap { shown in url.map { (shown, $0) } } }

  public func definition() -> ModuleDefinition {
    Name(Self.moduleName)

    completeFunction

    Self.keepWhileTypingFunction

    Self.takeKeptFunction

    Self.copyFieldAsFunction
  }
}

enum FieldCopy {
  static var target: (shown: String, url: String)?

  static func url(for responder: NSResponder?) -> String? {
    guard let target, let editor = responder as? NSTextView, !editor.hasMarkedText(), editor.string == target.shown,
          editor.selectedRange() == NSRange(location: 0, length: (editor.string as NSString).length)
    else { return nil }
    return target.url
  }
}

private func textField(in view: NSView) -> NSTextField? {
  if let field = view as? NSTextField { return field }
  for sub in view.subviews {
    if let field = textField(in: sub) { return field }
  }
  return nil
}
