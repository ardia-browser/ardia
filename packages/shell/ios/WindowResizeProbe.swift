import AppKit

#if DEBUG
enum WindowResizeProbe {
  private static var buttonsDown = false
  private static var heldModifiers: NSEvent.ModifierFlags = []
  private static var running = false
  private static let getters = [#selector(getter: NSEvent.pressedMouseButtons), #selector(getter: NSEvent.modifierFlags)]

  private static func getterImplementations() -> [IMP?] { getters.map { class_getClassMethod(NSEvent.self, $0).map(method_getImplementation) } }

  private static func replaceClassGetter(_ selector: Selector, _ block: Any) -> (() -> Void)? {
    guard let method = class_getClassMethod(NSEvent.self, selector) else { return nil }
    let original = method_getImplementation(method)
    method_setImplementation(method, imp_implementationWithBlock(block))
    return { method_setImplementation(method, original) }
  }

  private static func mouse(_ type: NSEvent.EventType, _ window: NSWindow, screen: NSPoint) -> NSEvent? {
    NSEvent.mouseEvent(
      with: type, location: NSPoint(x: screen.x - window.frame.minX, y: screen.y - window.frame.minY), modifierFlags: heldModifiers, timestamp: ProcessInfo.processInfo.systemUptime,
      windowNumber: window.windowNumber, context: nil, eventNumber: 0, clickCount: 1, pressure: type == .leftMouseUp ? 0 : 1)
  }

  private static func rect(_ r: NSRect) -> [Double] { [r.minX, r.minY, r.width, r.height] }

  static func resize(
    _ window: NSWindow, edgeInset: CGFloat, count: Int, dx: CGFloat, interval: TimeInterval, modifiers: NSEvent.ModifierFlags,
    bypassFix: Bool, failEvents: Bool, done: @escaping ([String: Any]) -> Void
  ) {
    guard !running else { return done(["error": "probe already running"]) }
    running = true
    let realGetters = getterImplementations()
    var restores: [() -> Void] = []
    var observers: [NSObjectProtocol] = []
    func finish() {
      observers.forEach(NotificationCenter.default.removeObserver)
      buttonsDown = false
      heldModifiers = []
      CenteredResize.bypassed = false
      restores.reversed().forEach { $0() }
      running = false
    }
    func inputRestored() -> Bool { getterImplementations() == realGetters && !CenteredResize.bypassed && !buttonsDown && heldModifiers.isEmpty }
    func fail(_ error: String) {
      finish()
      done(["error": error, "inputRestored": inputRestored()])
    }
    let buttonsBlock: @convention(block) (AnyClass) -> Int = { _ in buttonsDown ? 1 : 0 }
    let modifiersBlock: @convention(block) (AnyClass) -> UInt = { _ in heldModifiers.rawValue }
    guard let restoreButtons = replaceClassGetter(getters[0], buttonsBlock) else { return fail("no NSEvent getters") }
    restores.append(restoreButtons)
    guard let restoreModifiers = replaceClassGetter(getters[1], modifiersBlock) else { return fail("no NSEvent getters") }
    restores.append(restoreModifiers)
    let start = window.frame
    var changes: [[Double]] = []
    var liveResizeSeen = false
    observers = [NSWindow.didResizeNotification, NSWindow.didMoveNotification].map { name in
      NotificationCenter.default.addObserver(forName: name, object: window, queue: nil) { _ in
        if window.inLiveResize { liveResizeSeen = true }
        changes.append(rect(window.frame))
      }
    }
    buttonsDown = true
    heldModifiers = modifiers
    CenteredResize.bypassed = bypassFix
    let pointer = NSPoint(x: start.maxX - edgeInset, y: start.midY)
    guard !failEvents, let down = mouse(.leftMouseDown, window, screen: pointer) else { return fail("no event") }
    NSApp.postEvent(down, atStart: false)
    var step = 0
    var perStep: [[Double]] = []
    let timer = Timer(timeInterval: interval, repeats: true) { timer in
      perStep.append(rect(window.frame))
      step += 1
      let at = NSPoint(x: pointer.x + dx * CGFloat(step), y: pointer.y)
      if step <= count, let drag = mouse(.leftMouseDragged, window, screen: at) { return NSApp.postEvent(drag, atStart: false) }
      timer.invalidate()
      buttonsDown = false
      if let up = mouse(.leftMouseUp, window, screen: at) { NSApp.postEvent(up, atStart: false) }
      DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) {
        finish()
        let end = window.frame
        var widthReversals = 0
        var lastDelta = 0.0
        for (a, b) in zip(changes, changes.dropFirst()) {
          let delta = b[2] - a[2]
          if delta != 0, lastDelta != 0, (delta > 0) != (lastDelta > 0) { widthReversals += 1 }
          if delta != 0 { lastDelta = delta }
        }
        let midX = start.midX
        let drift = changes.map { abs($0[0] + $0[2] / 2 - midX) }.max() ?? 0
        window.setFrame(start, display: true)
        done([
          "start": rect(start), "end": rect(end), "liveResizeSeen": liveResizeSeen, "frameChanges": changes.count,
          "widthReversals": widthReversals, "maxCentreDrift": drift, "changes": changes, "perStep": perStep,
          "pointerTravel": dx * CGFloat(count), "fixBypassed": bypassFix, "inputRestored": inputRestored(),
        ])
      }
    }
    RunLoop.main.add(timer, forMode: .common)
  }
}
#endif
