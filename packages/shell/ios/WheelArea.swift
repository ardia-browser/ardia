import AppKit
import ExpoModulesCore

final class WheelArea: ExpoView {
  let onStep = EventDispatcher()
  private static let areas = NSHashTable<WheelArea>.weakObjects()
  private static let sectionCurve = CAMediaTimingFunction(controlPoints: 0.5, 1, 0.89, 1)
  private static let notchCurve = CAMediaTimingFunction(controlPoints: 0.25, 1, 0.5, 1)
  private static var glideCount = 0
  private var gesture = WheelSteer()
  private weak var column: NSScrollView?
  private var range: WheelRange?
  private var glideMs = 0.0

  required init(appContext: AppContext? = nil) {
    super.init(appContext: appContext)
    _ = installWheelMonitor
  }

  override func viewDidMoveToWindow() {
    super.viewDidMoveToWindow()
    if window != nil { Self.areas.add(self) } else { Self.areas.remove(self) }
  }

  private static var nowMs: Double { CACurrentMediaTime() * 1000 }

  private static func area(at location: NSPoint, in window: NSWindow) -> WheelArea? {
    guard let hit = window.contentView?.superview?.hitTest(location) else { return nil }
    return areas.allObjects.first { $0.window === window && !$0.isHiddenOrHasHiddenAncestor && hit.isDescendant(of: $0) }
  }

  static func owner(of view: NSView) -> WheelArea? {
    var next = view.superview
    while let view = next {
      if let area = view as? WheelArea { return area }
      next = view.superview
    }
    return nil
  }

  static func route(window: NSWindow?, location: NSPoint, input: WheelInput) -> Bool {
    guard let window, let owner = area(at: location, in: window) else { return false }
    owner.read(input)
    return true
  }

  static func phase(_ phase: NSEvent.Phase) -> WheelPhase {
    if phase.contains(.began) { return .began }
    if phase.contains(.changed) { return .changed }
    if phase.contains(.ended) { return .ended }
    if phase.contains(.cancelled) { return .cancelled }
    if phase.contains(.mayBegin) { return .mayBegin }
    return .none
  }

  private func read(_ input: WheelInput) {
    guard let column, let range else { return }
    switch gesture.read(input, at: Double(column.contentView.bounds.origin.y), range: range, now: Self.nowMs) {
    case .none: break
    case .place(let y): Self.glide(column, to: CGFloat(y), duration: 0)
    case .ease(let y): Self.glide(column, to: CGFloat(y), duration: glideMs > 0 ? gesture.tune.notchEaseMs : 0, curve: Self.notchCurve)
    case .settle: keep(column, in: range)
    case .move(let direction): onStep(["direction": direction])
    }
  }

  func steer(_ scroll: NSScrollView, range: WheelRange, glideMs: Double) {
    column = scroll
    self.range = range
    self.glideMs = glideMs
    keep(scroll, in: range)
  }

  func glided(ms: Double) {
    gesture.glideStarted(ms: ms, now: Self.nowMs)
  }

  private func keep(_ scroll: NSScrollView, in range: WheelRange) {
    let y = Double(scroll.contentView.bounds.origin.y)
    let kept = range.clamp(y)
    if abs(kept - y) > 0.5 { Self.glide(scroll, to: CGFloat(kept), duration: glideMs) }
  }

  static func scrollView(in view: NSView) -> NSScrollView? {
    if let scroll = view as? NSScrollView { return scroll }
    for child in view.subviews {
      if let scroll = scrollView(in: child) { return scroll }
    }
    return nil
  }

  static func glide(_ scroll: NSScrollView, to y: CGFloat, duration: Double, curve: CAMediaTimingFunction = sectionCurve) {
    CATransaction.begin()
    CATransaction.setDisableActions(true)
    defer { CATransaction.commit() }
    let clip = scroll.contentView
    let from = clip.bounds.origin.y
    let layerBefore = clip.layer?.bounds.origin.y
    clip.setBoundsOrigin(NSPoint(x: clip.bounds.origin.x, y: y))
    scroll.reflectScrolledClipView(clip)
    guard duration > 0, abs(y - from) > 0.5, let document = scroll.documentView else { return }
    document.wantsLayer = true
    guard let layer = document.layer else { return }
    let layerShift = layerBefore.flatMap { before in clip.layer.map { $0.bounds.origin.y - before } } ?? 0
    let shift = abs(layerShift) > 0.5 ? layerShift : (clip.isFlipped ? y - from : from - y)
    let glide = CABasicAnimation(keyPath: "transform.translation.y")
    glide.fromValue = shift
    glide.toValue = 0
    glide.isAdditive = true
    glide.duration = duration / 1000
    glide.timingFunction = curve
    glide.fillMode = .backwards
    glideCount += 1
    layer.add(glide, forKey: "ardia.glide.\(glideCount)")
  }

  static func devWheel(windowId: String, x: Double, y: Double, steps: [[String: Any]], promise: Promise) {
    guard let window = WindowManager.shared.window(windowId) else { return promise.resolve(["error": "no window \(windowId)"]) }
    let location = SyntheticInput.windowPoint(x: x, top: y, in: window)
    let phases: [String: WheelPhase] = ["began": .began, "changed": .changed, "ended": .ended, "cancelled": .cancelled, "mayBegin": .mayBegin, "none": .none]
    let post = { (step: [String: Any]) in
      route(
        window: window, location: location,
        input: WheelInput(
          dy: step["dy"] as? Double ?? 0, phase: phases[step["phase"] as? String ?? "none"] ?? .none, momentum: step["momentum"] as? Bool ?? false,
          precise: step["precise"] as? Bool ?? true))
    }
    let owner = area(at: location, in: window)
    guard steps.contains(where: { $0["afterMs"] != nil }), let scroll = owner?.column ?? owner.flatMap({ scrollView(in: $0) }) else {
      return promise.resolve(["claimed": steps.map(post)])
    }
    DevWheelTrace(scroll: scroll, steps: steps, post: post, promise: promise).start()
  }
}

private final class DevWheelTrace {
  private let scroll: NSScrollView
  private let steps: [[String: Any]]
  private let post: ([String: Any]) -> Bool
  private let promise: Promise
  private let began = CACurrentMediaTime()
  private var claimed: [Bool] = []
  private var inputs: [[String: Double]] = []
  private var frames: [[String: Double]] = []
  private var sampler: Timer?
  private static let tailMs = 1000.0

  init(scroll: NSScrollView, steps: [[String: Any]], post: @escaping ([String: Any]) -> Bool, promise: Promise) {
    self.scroll = scroll
    self.steps = steps
    self.post = post
    self.promise = promise
  }

  private var elapsedMs: Double { (CACurrentMediaTime() - began) * 1000 }

  func start() {
    let timer = Timer(timeInterval: 1.0 / 240, repeats: true) { [self] _ in sample() }
    RunLoop.main.add(timer, forMode: .common)
    sampler = timer
    sample()
    var at = 0.0
    for step in steps {
      at += step["afterMs"] as? Double ?? 0
      DispatchQueue.main.asyncAfter(deadline: .now() + at / 1000) { [self] in
        inputs.append(["t": elapsedMs, "dy": step["dy"] as? Double ?? 0])
        claimed.append(post(step))
      }
    }
    DispatchQueue.main.asyncAfter(deadline: .now() + (at + Self.tailMs) / 1000) { [self] in
      sampler?.invalidate()
      sampler = nil
      promise.resolve(["claimed": claimed, "inputs": inputs, "frames": frames])
    }
  }

  private func sample() {
    let model = scroll.contentView.bounds.origin.y
    let layer = scroll.documentView?.layer
    let lifted = (layer?.presentation()?.transform.m42 ?? 0) - (layer?.transform.m42 ?? 0)
    frames.append(["t": elapsedMs, "model": model, "shown": model - lifted])
  }
}

let installWheelMonitor: Void = {
  _ = NSEvent.addLocalMonitorForEvents(matching: [.scrollWheel]) { event in
    let window = event.window ?? NSApp.orderedWindows.first { $0.isVisible && $0.frame.contains(event.locationInWindow) }
    let location = event.window == nil ? window.map { $0.convertPoint(fromScreen: event.locationInWindow) } ?? event.locationInWindow : event.locationInWindow
    let input = WheelInput(
      dy: Double(event.scrollingDeltaY), phase: WheelArea.phase(event.phase), momentum: !event.momentumPhase.isEmpty, precise: event.hasPreciseScrollingDeltas)
    return WheelArea.route(window: window, location: location, input: input) ? nil : event
  }
}()
