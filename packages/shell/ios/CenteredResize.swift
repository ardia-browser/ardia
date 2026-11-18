import AppKit

let installCenteredResize: Void = {
  let selector = #selector(NSWindowDelegate.windowWillResize(_:to:))
  guard let cls = NSClassFromString("ViewsNSWindowDelegate"), let method = class_getInstanceMethod(cls, selector),
        let types = method_getTypeEncoding(method), String(cString: types).hasPrefix("{CGSize=")
  else { return }
  typealias WillResize = @convention(c) (AnyObject, Selector, NSWindow, NSSize) -> NSSize
  let original = unsafeBitCast(method_getImplementation(method), to: WillResize.self)
  let block: @convention(block) (AnyObject, NSWindow, NSSize) -> NSSize = { delegate, window, size in
    guard CenteredResize.appKitResizes(window) else { return original(delegate, selector, window, size) }
    CenteredResize.noteCentered()
    return size
  }
  method_setImplementation(method, imp_implementationWithBlock(block))
  NotificationCenter.default.addObserver(forName: NSWindow.willStartLiveResizeNotification, object: nil, queue: nil) { _ in
    CenteredResize.counted = false
  }
}()

enum CenteredResize {
  #if DEBUG
  static var bypassed = false
  #else
  static let bypassed = false
  #endif

  static var counted = false

  static func noteCentered() {
    guard !counted else { return }
    counted = true
    ShellEvents.send(.app, ["type": "centeredResize"])
  }

  static func appKitResizes(_ window: NSWindow) -> Bool {
    !bypassed && window.inLiveResize && NSEvent.modifierFlags.contains(.option) && WindowManager.shared.id(of: window) != nil
  }
}
