#if DEBUG
import AppKit
import ExpoModulesCore
import ObjectiveC

final class DevPointerSweep: NSObject {
  private static var running: DevPointerSweep?
  private static var enters = 0
  private static var exits = 0
  private static var scrollSteps = 0
  private static var heldHovers = 0
  private static let countHover: Void = {
    swap("mouseEntered:") { DevPointerSweep.enters += 1 }
    swap("mouseExited:") { DevPointerSweep.exits += 1 }
    countScrollSteps()
    countHeldHovers()
  }()

  private static func sweeping(_ view: NSView?) -> Bool {
    guard let sweep = DevPointerSweep.running, let window = view?.window else { return false }
    return window === sweep.window
  }

  private static func countScrollSteps() {
    let selector = NSSelectorFromString("ardia_scrolled:")
    guard let cls = NSClassFromString("RCTView"), let method = class_getClassMethod(cls, selector) else { return }
    typealias Scrolled = @convention(c) (AnyClass, Selector, NSView?) -> Void
    let original = unsafeBitCast(method_getImplementation(method), to: Scrolled.self)
    let counted: @convention(block) (AnyClass, NSView?) -> Void = { receiver, moved in
      if DevPointerSweep.sweeping(moved) { DevPointerSweep.scrollSteps += 1 }
      original(receiver, selector, moved)
    }
    method_setImplementation(method, imp_implementationWithBlock(counted))
  }

  private static func countHeldHovers() {
    let selector = NSSelectorFromString("ardia_holdHoverForScroll")
    guard let cls = NSClassFromString("RCTView"), let method = class_getInstanceMethod(cls, selector) else { return }
    typealias Hold = @convention(c) (AnyObject, Selector) -> ObjCBool
    let original = unsafeBitCast(method_getImplementation(method), to: Hold.self)
    let counted: @convention(block) (AnyObject) -> ObjCBool = { view in
      let held = original(view, selector)
      if held.boolValue && DevPointerSweep.sweeping(view as? NSView) { DevPointerSweep.heldHovers += 1 }
      return held
    }
    method_setImplementation(method, imp_implementationWithBlock(counted))
  }

  private static func swap(_ name: String, _ bump: @escaping () -> Void) {
    let selector = NSSelectorFromString(name)
    guard let cls = NSClassFromString("RCTView"), let method = class_getInstanceMethod(cls, selector) else { return }
    typealias Handler = @convention(c) (AnyObject, Selector, NSEvent) -> Void
    let original = unsafeBitCast(method_getImplementation(method), to: Handler.self)
    let counted: @convention(block) (AnyObject, NSEvent) -> Void = { view, event in
      if DevPointerSweep.sweeping(view as? NSView) { bump() }
      original(view, selector, event)
    }
    method_setImplementation(method, imp_implementationWithBlock(counted))
  }

  private struct Scroll {
    let everyMs: Double
    let gestureMs: Double
    let delta: Double
    let momentumMs: Double
    let sign: Double
    let elastic: Bool
    let at: Double?
  }

  private let window: NSWindow
  private let y: CGFloat
  private let x0: CGFloat
  private let x1: CGFloat
  private let periodMs: Double
  private let started: CFTimeInterval
  private let until: CFTimeInterval
  private let override: Bool
  private let quiet: Bool
  private let flags: NSEvent.ModifierFlags
  private let scroll: Scroll?
  private let promise: Promise
  private var timer: Timer?
  private var lastTick: CFTimeInterval
  private var ticks: [[Double]] = []
  private var scrollEvents = 0
  private let direct: Bool
  private let track: Bool
  private let scrollFirst: Bool
  private var parked = false
  private var areas: [(NSView, NSTrackingArea)] = []
  private var areasAt: CFTimeInterval = 0
  private var inside = Set<ObjectIdentifier>()
  private var known = Set<ObjectIdentifier>()
  private var scrollsWithWindow = 0
  private var tracked = 0
  private var lastPoint: NSPoint?

  private init(window: NSWindow, spec: [String: Any], promise: Promise) {
    func number(_ key: String, _ fallback: Double) -> Double { (spec[key] as? NSNumber)?.doubleValue ?? fallback }
    self.window = window
    y = CGFloat(number("y", 0))
    x0 = CGFloat(number("x0", 0))
    x1 = CGFloat(number("x1", 0))
    periodMs = max(16, number("periodMs", 1200))
    started = CACurrentMediaTime()
    until = started + number("durationMs", 10000) / 1000
    override = (spec["override"] as? Bool) ?? true
    quiet = (spec["quiet"] as? Bool) ?? false
    flags = (spec["control"] as? Bool) ?? true ? [.control] : []
    if let s = spec["scroll"] as? [String: Any], let every = (s["everyMs"] as? NSNumber)?.doubleValue, every > 0 {
      scroll = Scroll(
        everyMs: max(16, every), gestureMs: (s["gestureMs"] as? NSNumber)?.doubleValue ?? 300,
        delta: min(1000, max(-1000, (s["delta"] as? NSNumber)?.doubleValue ?? 8)),
        momentumMs: (s["momentumMs"] as? NSNumber)?.doubleValue ?? 0,
        sign: ((s["sign"] as? NSNumber)?.doubleValue).map { $0 > 0 ? 1.0 : $0 < 0 ? -1.0 : 0.0 } ?? 0, elastic: (s["elastic"] as? Bool) ?? false, at: (s["at"] as? NSNumber)?.doubleValue)
    } else {
      scroll = nil
    }
    direct = (spec["direct"] as? Bool) ?? false
    track = (spec["track"] as? Bool) ?? false
    scrollFirst = ((spec["scrollFirst"] as? Bool) ?? false) && direct
    self.promise = promise
    lastTick = started
  }

  static func start(windowId: String, spec: [String: Any], promise: Promise) {
    _ = countHover
    let duration = (spec["durationMs"] as? NSNumber)?.doubleValue ?? 10000
    guard running == nil, duration.isFinite, duration >= 0, let window = WindowManager.shared.window(windowId) else {
      promise.resolve(nil)
      return
    }
    enters = 0
    exits = 0
    scrollSteps = 0
    heldHovers = 0
    let sweep = DevPointerSweep(window: window, spec: spec, promise: promise)
    running = sweep
    let timer = Timer(timeInterval: 1.0 / 60, repeats: true) { [weak sweep] _ in sweep?.tick() }
    RunLoop.main.add(timer, forMode: .common)
    sweep.timer = timer
  }

  private func tick() {
    let now = CACurrentMediaTime()
    let late = (now - lastTick) * 1000
    lastTick = now
    let elapsed = (now - started) * 1000
    let phase = elapsed.truncatingRemainder(dividingBy: periodMs) / periodMs
    let along = phase < 0.5 ? phase * 2 : 2 - phase * 2
    let x = x0 + (x1 - x0) * CGFloat(along)
    let windowPoint = SyntheticInput.windowPoint(x: x, top: y, in: window)
    if override {
      let screen = window.convertPoint(toScreen: windowPoint)
      SwitcherPointer.devLocation = screen
      let select = NSSelectorFromString(quiet ? "ardia_setPointerOverrideQuietly:" : "ardia_setPointerOverride:")
      if let view = NSClassFromString("RCTView") as AnyObject?, view.responds(to: select) { _ = view.perform(select, with: NSValue(point: screen)) }
    }
    let closing = now >= until
    if !closing, let moved = NSEvent.mouseEvent(
      with: .mouseMoved, location: windowPoint, modifierFlags: flags, timestamp: ProcessInfo.processInfo.systemUptime,
      windowNumber: window.windowNumber, context: nil, eventNumber: 0, clickCount: 0, pressure: 0)
    {
      NSApp.postEvent(moved, atStart: false)
    }
    let scrolls: Scroll? = closing && !direct ? nil : scroll
    if scrollFirst, let scrolls { postScroll(scrolls, elapsed: elapsed, at: windowPoint) }
    if track { trackAreas(at: windowPoint, now: now) }
    if !scrollFirst, let scrolls { postScroll(scrolls, elapsed: elapsed, at: windowPoint) }
    ticks.append([Date().timeIntervalSince1970 * 1000, Double(x), scrolledX(at: windowPoint), late])
    guard closing else { return }
    timer?.invalidate()
    timer = nil
    Self.running = nil
    if override {
      SwitcherPointer.devLocation = nil
      let select = NSSelectorFromString("ardia_setPointerOverride:")
      if let view = NSClassFromString("RCTView") as AnyObject?, view.responds(to: select) { _ = view.perform(select, with: nil) }
    }
    promise.resolve(["ticks": ticks, "enters": Self.enters, "exits": Self.exits, "scrolls": scrollEvents, "scrollsWithWindow": scrollsWithWindow, "tracked": tracked,
      "scrollSteps": Self.scrollSteps, "heldHovers": Self.heldHovers,
    ])
  }

  private func scrolledX(at windowPoint: NSPoint) -> Double {
    guard let frame = window.contentView?.superview, let hit = frame.hitTest(windowPoint), let scrollView = hit.enclosingScrollView else { return -1 }
    return Double(scrollView.contentView.bounds.origin.x)
  }

  private func postScroll(_ scroll: Scroll, elapsed: Double, at windowPoint: NSPoint) {
    if let at = scroll.at { return park(at: at, windowPoint: windowPoint) }
    if scroll.elastic { return stretch(elapsed: elapsed, at: windowPoint) }
    let index = Int(elapsed / scroll.everyMs)
    let into = elapsed - Double(index) * scroll.everyMs
    let direction: Double = scroll.sign != 0 ? scroll.sign : index % 2 == 0 ? 1 : -1
    let left = scroll.gestureMs + scroll.momentumMs - into
    let delta: Double
    if into < scroll.gestureMs {
      delta = scroll.delta * direction
    } else if left > 0 && scroll.momentumMs > 0 {
      delta = scroll.delta * direction * left / scroll.momentumMs
    } else {
      return
    }
    send(delta: delta, at: windowPoint)
  }

  private func park(at x: Double, windowPoint: NSPoint) {
    guard !parked, let frame = window.contentView?.superview else { return }
    guard let scrollView = scrollViews(in: frame).first(where: { $0.accessibilityIdentifier() == "ardia-tab-switcher" || $0.superview?.accessibilityIdentifier() == "ardia-tab-switcher" }) else { return }
    parked = true
    scrollView.contentView.scroll(to: NSPoint(x: x, y: scrollView.contentView.bounds.origin.y))
    scrollView.reflectScrolledClipView(scrollView.contentView)
  }

  private func scrollViews(in view: NSView) -> [NSScrollView] {
    ((view as? NSScrollView).map { [$0] } ?? []) + view.subviews.flatMap { scrollViews(in: $0) }
  }

  private func stretch(elapsed: Double, at windowPoint: NSPoint) {
    guard let frame = window.contentView?.superview, let hit = frame.hitTest(windowPoint), let scrollView = hit.enclosingScrollView,
      let document = scrollView.documentView
    else { return }
    let clip = scrollView.contentView
    let end = max(0, document.frame.width - clip.bounds.width)
    let pull = 4 * abs(sin(elapsed / 90))
    scrollEvents += 1
    clip.setBoundsOrigin(NSPoint(x: end + pull, y: clip.bounds.origin.y))
  }

  private func send(delta: Double, at windowPoint: NSPoint) {
    guard delta.isFinite, abs(delta.rounded()) <= Double(Int32.max), let cg = CGEvent(scrollWheelEvent2Source: nil, units: .pixel, wheelCount: 2, wheel1: 0, wheel2: Int32(delta.rounded()), wheel3: 0) else { return }
    cg.setDoubleValueField(.scrollWheelEventPointDeltaAxis2, value: delta)
    cg.setDoubleValueField(.scrollWheelEventFixedPtDeltaAxis2, value: delta)
    cg.flags = CGEventFlags(rawValue: UInt64(flags.rawValue))
    let screen = window.convertPoint(toScreen: windowPoint)
    let top = NSScreen.screens.first?.frame.maxY ?? 0
    cg.location = CGPoint(x: screen.x, y: top - screen.y)
    PeekInputRoute.setWindowLocation?(cg, CGPoint(x: windowPoint.x, y: window.frame.height - windowPoint.y))
    cg.setIntegerValueField(.mouseEventWindowUnderMousePointer, value: Int64(window.windowNumber))
    cg.setIntegerValueField(.mouseEventWindowUnderMousePointerThatCanHandleThisEvent, value: Int64(window.windowNumber))
    if let windowNumberField = CGEventField(rawValue: 51) { cg.setIntegerValueField(windowNumberField, value: Int64(window.windowNumber)) }
    guard let event = NSEvent(cgEvent: cg) else { return }
    scrollEvents += 1
    if event.window === window { scrollsWithWindow += 1 }
    if !direct { return NSApp.postEvent(event, atStart: false) }
    guard let frame = window.contentView?.superview, let hit = frame.hitTest(windowPoint) else { return }
    hit.scrollWheel(with: event)
  }

  private func collectAreas(in view: NSView, into found: inout [(NSView, NSTrackingArea)]) {
    for area in view.trackingAreas where area.options.contains(.mouseEnteredAndExited) { found.append((view, area)) }
    for child in view.subviews { collectAreas(in: child, into: &found) }
  }

  private func trackAreas(at windowPoint: NSPoint, now: CFTimeInterval) {
    if let frame = window.contentView?.superview {
      var found: [(NSView, NSTrackingArea)] = []
      collectAreas(in: frame, into: &found)
      for (_, area) in found where !known.contains(ObjectIdentifier(area)) {
        known.insert(ObjectIdentifier(area))
        if area.options.contains(.assumeInside) { inside.insert(ObjectIdentifier(area)) }
      }
      areas = found
      tracked = found.count
      areasAt = now
    }
    var nowInside = Set<ObjectIdentifier>()
    var entered: [(NSView, NSTrackingArea)] = []
    var exited: [(NSView, NSTrackingArea)] = []
    for (view, area) in areas {
      let id = ObjectIdentifier(area)
      guard view.window === window, !view.isHiddenOrHasHiddenAncestor, view.trackingAreas.contains(where: { $0 === area }) else { continue }
      let rect = view.convert(area.options.contains(.inVisibleRect) ? view.visibleRect : area.rect, to: nil)
      if rect.contains(windowPoint) {
        nowInside.insert(id)
        if !inside.contains(id) { entered.append((view, area)) }
      } else if inside.contains(id) {
        exited.append((view, area))
      }
    }
    inside = nowInside
    defer { lastPoint = windowPoint }
    if lastPoint != windowPoint {
      for (_, area) in areas where area.options.contains(.mouseMoved) && nowInside.contains(ObjectIdentifier(area)) {
        guard let owner = area.owner as? NSResponder,
          let event = NSEvent.mouseEvent(
            with: .mouseMoved, location: windowPoint, modifierFlags: flags, timestamp: ProcessInfo.processInfo.systemUptime,
            windowNumber: window.windowNumber, context: nil, eventNumber: 0, clickCount: 0, pressure: 0)
        else { continue }
        owner.mouseMoved(with: event)
      }
    }
    for (type, list) in [(NSEvent.EventType.mouseExited, exited), (.mouseEntered, entered)] {
      for (_, area) in list {
        guard let owner = area.owner as? NSResponder,
          let event = NSEvent.enterExitEvent(
            with: type, location: windowPoint, modifierFlags: flags, timestamp: ProcessInfo.processInfo.systemUptime,
            windowNumber: window.windowNumber, context: nil, eventNumber: 0, trackingNumber: 0, userData: nil)
        else { continue }
        if type == .mouseEntered {
          owner.mouseEntered(with: event)
        } else {
          owner.mouseExited(with: event)
        }
      }
    }
  }
}
#endif
