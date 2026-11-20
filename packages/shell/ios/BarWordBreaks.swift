import AppKit
import ArdiaCore

enum BarWordBreaks {
  static let fieldId = "ardia.barField"

  private enum Edit {
    case delete(forward: Bool)
    case move(forward: Bool, extending: Bool)
    case moveVisually(right: Bool, extending: Bool)
  }

  private struct HeldExtension {
    let anchor: Int
    let range: NSRange
  }

  private static var extensionKey = 0
  private static var settingOwnSelection = false

  static let install: Void = {
    let edits: [(String, Edit)] = [
      ("deleteWordBackward:", .delete(forward: false)),
      ("deleteWordForward:", .delete(forward: true)),
      ("moveWordBackward:", .move(forward: false, extending: false)),
      ("moveWordForward:", .move(forward: true, extending: false)),
      ("moveWordBackwardAndModifySelection:", .move(forward: false, extending: true)),
      ("moveWordForwardAndModifySelection:", .move(forward: true, extending: true)),
      ("moveWordLeft:", .moveVisually(right: false, extending: false)),
      ("moveWordRight:", .moveVisually(right: true, extending: false)),
      ("moveWordLeftAndModifySelection:", .moveVisually(right: false, extending: true)),
      ("moveWordRightAndModifySelection:", .moveVisually(right: true, extending: true)),
    ]
    typealias Command = @convention(c) (NSTextView, Selector, Any?) -> Void
    for (name, edit) in edits {
      let selector = NSSelectorFromString(name)
      guard let method = class_getInstanceMethod(NSTextView.self, selector) else { continue }
      let original = unsafeBitCast(method_getImplementation(method), to: Command.self)
      let block: @convention(block) (NSTextView, Any?) -> Void = { view, sender in
        if !isBarField(view) || view.hasMarkedText() || !perform(edit, in: view) { original(view, selector, sender) }
      }
      let imp = imp_implementationWithBlock(block)
      if !class_addMethod(NSTextView.self, selector, imp, method_getTypeEncoding(method)) { method_setImplementation(method, imp) }
    }
    _ = NotificationCenter.default.addObserver(forName: NSTextView.didChangeSelectionNotification, object: nil, queue: nil) { note in
      guard !settingOwnSelection, let view = note.object as? NSTextView, heldExtension(of: view) != nil else { return }
      hold(nil, in: view)
    }
  }()

  private static func heldExtension(of view: NSTextView) -> HeldExtension? {
    objc_getAssociatedObject(view, &extensionKey) as? HeldExtension
  }

  private static func hold(_ held: HeldExtension?, in view: NSTextView) {
    objc_setAssociatedObject(view, &extensionKey, held, .OBJC_ASSOCIATION_RETAIN_NONATOMIC)
  }

  private static func isBarField(_ view: NSTextView) -> Bool {
    guard view.isFieldEditor, let host = (view.delegate as? NSTextField)?.superview,
          host.responds(to: NSSelectorFromString("nativeID"))
    else { return false }
    return host.value(forKey: "nativeID") as? String == fieldId
  }

  private static func perform(_ edit: Edit, in view: NSTextView) -> Bool {
    let text = view.string
    switch edit {
    case .delete(let forward):
      return delete(forward: forward, in: view, text: text)
    case .move(let forward, let extending):
      move(forward: forward, extending: extending, in: view, text: text)
    case .moveVisually(let right, let extending):
      guard !ChromeWordBreaks.containsRightToLeftText(text) else { return false }
      move(forward: right, extending: extending, in: view, text: text)
    }
    return true
  }

  private static func delete(forward: Bool, in view: NSTextView, text: String) -> Bool {
    let selection = view.selectedRange()
    guard selection.length == 0 else { return false }
    let caret = selection.location
    let stop = ChromeWordBreaks.stop(forward: forward, from: caret, in: text)
    guard stop != caret else { return true }
    let range = NSRange(location: min(caret, stop), length: abs(stop - caret))
    guard view.shouldChangeText(in: range, replacementString: "") else { return true }
    view.replaceCharacters(in: range, with: "")
    view.didChangeText()
    view.setSelectedRange(NSRange(location: range.location, length: 0))
    view.scrollRangeToVisible(view.selectedRange())
    noteEdit(.delete, changed: true, stop: stop, forward: forward, from: caret, in: text)
    return true
  }

  private static func move(forward: Bool, extending: Bool, in view: NSTextView, text: String) {
    let selection = view.selectedRange()
    let previous = selection.location..<NSMaxRange(selection)
    let from: Int, stop: Int, next: NSRange, activeEndBackward: Bool
    if extending {
      let kept = heldExtension(of: view).flatMap { NSEqualRanges($0.range, selection) ? $0.anchor : nil }
      let activeEndAtStart = selection.length > 0 && view.selectionAffinity == .upstream
      let extended = ChromeWordBreaks.extend(selection.location..<NSMaxRange(selection), keptAnchor: kept, activeEndAtStart: activeEndAtStart, forward: forward, in: text)
      from = extended.from
      stop = extended.stop
      next = NSRange(location: extended.range.lowerBound, length: extended.range.count)
      activeEndBackward = extended.stop < extended.anchor
      hold(HeldExtension(anchor: extended.anchor, range: next), in: view)
    } else {
      from = forward ? NSMaxRange(selection) : selection.location
      stop = ChromeWordBreaks.stop(forward: forward, from: from, in: text)
      next = NSRange(location: stop, length: 0)
      activeEndBackward = !forward
      hold(nil, in: view)
    }
    settingOwnSelection = true
    view.setSelectedRange(next, affinity: activeEndBackward ? .upstream : .downstream, stillSelecting: false)
    settingOwnSelection = false
    view.scrollRangeToVisible(NSRange(location: stop, length: 0))
    let changed = ChromeWordBreaks.countsAsWordMove(from: previous, to: next.location..<NSMaxRange(next))
    noteEdit(.move, changed: changed, stop: stop, forward: forward, from: from, in: text)
  }

  private enum EditKind: String {
    case delete
    case move
  }

  private static func noteEdit(_ kind: EditKind, changed: Bool, stop: Int, forward: Bool, from: Int, in text: String) {
    guard changed else { return }
    let splitAtDot = stop != ChromeWordBreaks.stop(forward: forward, from: from, in: text, splittingLetterStops: false)
    ShellEvents.send(.app, ArdiaConsentStamp.begin().onto(["type": "barWordEdit", "kind": kind.rawValue, "splitAtDot": splitAtDot]))
  }
}
