import AppKit
import ArdiaCore
import Carbon.HIToolbox
import ExpoModulesCore

let installTextFieldSelectAll: Void = {
  let block: @convention(block) (NSTextField, Any?) -> Void = { field, sender in
    if let editor = field.currentEditor() { editor.selectAll(sender) } else { field.selectText(sender) }
  }
  class_addMethod(NSTextField.self, #selector(NSText.selectAll(_:)), imp_implementationWithBlock(block), "v@:@")
}()

let installViewSelectAll: Void = {
  guard let viewClass = NSClassFromString("RCTView"), let handledKey = NSClassFromString("RCTHandledKey"),
        let matchesMethod = class_getClassMethod(handledKey, NSSelectorFromString("event:matchesFilter:")) else { return }
  typealias Matches = @convention(c) (AnyClass, Selector, NSEvent, NSArray?) -> ObjCBool
  let matches = unsafeBitCast(method_getImplementation(matchesMethod), to: Matches.self)
  let selectAll = #selector(NSText.selectAll(_:))
  let block: @convention(block) (NSView, Any?) -> Void = { view, sender in
    let key = view.window.flatMap { window in
      NSEvent.keyEvent(
        with: .keyDown, location: .zero, modifierFlags: .command, timestamp: ProcessInfo.processInfo.systemUptime,
        windowNumber: window.windowNumber, context: nil, characters: "a", charactersIgnoringModifiers: "a",
        isARepeat: false, keyCode: UInt16(kVK_ANSI_A))
    }
    if let key, matches(handledKey, NSSelectorFromString("event:matchesFilter:"), key, view.value(forKey: "keyDownEvents") as? NSArray).boolValue {
      view.keyDown(with: key)
    } else {
      view.nextResponder?.tryToPerform(selectAll, with: sender)
    }
  }
  class_addMethod(viewClass, selectAll, imp_implementationWithBlock(block), "v@:@")
}()

let installSubmenuAction: Void = {
  let submenuAction = NSSelectorFromString("submenuAction:")
  guard !NSMenu.instancesRespond(to: submenuAction) else { return }
  let block: @convention(block) (NSMenu, Any?) -> Void = { _, _ in }
  class_addMethod(NSMenu.self, submenuAction, imp_implementationWithBlock(block), "v@:@")
}()

let installInputSourceKeys: Void = {
  let keyDown = #selector(NSResponder.keyDown(with:))
  guard let method = class_getInstanceMethod(NSTextView.self, keyDown) else { return }
  typealias KeyDown = @convention(c) (NSTextView, Selector, NSEvent) -> Void
  let original = unsafeBitCast(method_getImplementation(method), to: KeyDown.self)
  let block: @convention(block) (NSTextView, NSEvent) -> Void = { view, event in
    if InputSourceKeys.consume(event) { return }
    original(view, keyDown, event)
  }
  let imp = imp_implementationWithBlock(block)
  if !class_addMethod(NSTextView.self, keyDown, imp, method_getTypeEncoding(method)) { method_setImplementation(method, imp) }
}()

let installScrollViewInsetFix: Void = {
  guard let cls = NSClassFromString("RCTCustomScrollView"),
        let method = class_getInstanceMethod(cls, #selector(NSView.init(frame:))) else { return }
  typealias Init = @convention(c) (AnyObject, Selector, NSRect) -> AnyObject
  let original = unsafeBitCast(method_getImplementation(method), to: Init.self)
  let block: @convention(block) (AnyObject, NSRect) -> AnyObject = { receiver, frame in
    let view = original(receiver, #selector(NSView.init(frame:)), frame)
    (view as? NSScrollView)?.automaticallyAdjustsContentInsets = false
    return view
  }
  let imp = imp_implementationWithBlock(block)
  if !class_addMethod(cls, #selector(NSView.init(frame:)), imp, method_getTypeEncoding(method)) {
    method_setImplementation(method, imp)
  }
}()

enum StripWheel {
  static let identifier = "ardia-top-strip"
  static let pointsPerLine: CGFloat = 40

  static func tagged(_ scroll: NSScrollView) -> Bool {
    scroll.accessibilityIdentifier() == identifier || scroll.superview?.accessibilityIdentifier() == identifier
  }

  static func redirect(_ event: NSEvent, in scroll: NSScrollView) -> Bool {
    guard event.phase.isEmpty, event.momentumPhase.isEmpty, !event.hasPreciseScrollingDeltas,
          !event.modifierFlags.contains(.shift), abs(event.scrollingDeltaY) > abs(event.scrollingDeltaX),
          tagged(scroll), let document = scroll.documentView else { return false }
    let clip = scroll.contentView
    let end = max(0, document.frame.width - clip.bounds.width)
    let x = min(end, max(0, clip.bounds.origin.x - event.scrollingDeltaY * pointsPerLine))
    if abs(x - clip.bounds.origin.x) >= 0.5 {
      clip.scroll(to: NSPoint(x: x, y: clip.bounds.origin.y))
      scroll.reflectScrolledClipView(clip)
    }
    return true
  }
}

let installStripWheel: Void = {
  guard let cls = NSClassFromString("RCTCustomScrollView"),
        let method = class_getInstanceMethod(cls, #selector(NSResponder.scrollWheel(with:))) else { return }
  typealias Wheel = @convention(c) (AnyObject, Selector, NSEvent) -> Void
  let original = unsafeBitCast(method_getImplementation(method), to: Wheel.self)
  let block: @convention(block) (AnyObject, NSEvent) -> Void = { receiver, event in
    if let scroll = receiver as? NSScrollView, StripWheel.redirect(event, in: scroll) { return }
    original(receiver, #selector(NSResponder.scrollWheel(with:)), event)
  }
  let imp = imp_implementationWithBlock(block)
  if !class_addMethod(cls, #selector(NSResponder.scrollWheel(with:)), imp, method_getTypeEncoding(method)) {
    method_setImplementation(method, imp)
  }
}()
