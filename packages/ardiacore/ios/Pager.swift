import AppKit
import QuartzCore

private let trackingScale = 0.5
private let rubberDimension = 255.0
private let rubberCoefficient = 0.15
private let flickVelocity = 5.0
private let historyWindow = 0.1

private func rubberBand(_ value: Double, _ dimension: Double) -> Double {
  (1 - 1 / (value * rubberCoefficient / dimension + 1)) * dimension
}

private final class PagerFrames: NSObject {
  weak var pager: Pager?

  init(_ pager: Pager) { self.pager = pager }

  @objc func frame(_ link: CADisplayLink) {
    guard let pager, pager.frame(from: link) else { return link.invalidate() }
  }
}

final class Pager: PagerModelHost {
  private struct Drag {
    var start = 0.0, lo = 0, hi = 0, home = 0, detent = 0
    weak var area: SwipeArea?
  }

  private static var pagers: [String: Pager] = [:]
  private static let lock = NSLock()
  private static var snapshots: [String: [String: Any]] = [:]
  private static var counter = 0

  static func named(_ key: String) -> Pager {
    if let pager = pagers[key] { return pager }
    let pager = Pager(key: key)
    pagers[key] = pager
    return pager
  }

  static func existing(_ key: String) -> Pager? { pagers[key] }

  static func snapshot(_ key: String) -> [String: Any]? {
    lock.lock()
    defer { lock.unlock() }
    return snapshots[key]
  }

  let key: String
  private let model = PagerModel()
  private let areas = NSHashTable<SwipeArea>.weakObjects()
  private var drag = Drag()
  private var history: [(time: TimeInterval, position: Double)] = []
  private var link: CADisplayLink?
  private weak var linkWindow: NSWindow?
  private weak var linkArea: SwipeArea?
  private var frameWatch = FrameWatch()
  private var deadlineCheck: DispatchWorkItem?
  private var occlusion: NSObjectProtocol?
  private var morph: PagerMorph?
  private var currentFrame: MorphFrame?
  #if DEBUG
  private var lastInput: [String: Any] = [:]
  #endif

  private init(key: String) {
    self.key = key
    model.host = self
  }

  func attach(_ area: SwipeArea) {
    areas.add(area)
    if model.configured { area.onPagerPosition(positionEvent) }
  }

  func detach(_ area: SwipeArea) {
    areas.remove(area)
    if drag.area === area {
      if model.cancelTracking() { publish() } else { drag.area = nil }
    }
    areasChanged()
  }

  func areaLeftWindow(_ area: SwipeArea) {
    if drag.area === area, model.cancelTracking() { publish() }
    if linkArea === area { restartFrames() }
  }

  func areasChanged() {
    if model.phase == .tracking, drag.area == nil, model.cancelTracking() { publish() }
    if link != nil, !(linkArea.map { areas.contains($0) && $0.window === linkWindow } ?? false) { restartFrames() }
    prune()
  }

  func prune() {
    guard areas.allObjects.isEmpty, Pager.pagers[key] === self else { return }
    model.stop()
    stopFrames()
    morph?.release()
    morph = nil
    Pager.pagers[key] = nil
    Pager.lock.lock()
    Pager.snapshots[key] = nil
    Pager.lock.unlock()
  }

  func configure(selected: Int, count: Int, ack: Int, order: [String]?, leading: Bool, library: Bool) {
    model.configure(selected: selected, count: count, ack: ack, order: order, leading: leading, library: library)
    publish()
  }

  func switchTo(_ index: Int, order: [String]? = nil) -> Bool {
    defer { publish() }
    return model.switchTo(index, order: order)
  }

  func select(_ profileId: String, order ids: [String]) -> Bool {
    defer { publish() }
    return model.select(profileId, order: ids)
  }

  func step(_ delta: Int, wrap: Bool, order: [String]? = nil) -> Bool {
    defer { publish() }
    return model.step(delta, wrap: wrap, order: order)
  }

  func lead(_ open: Bool, animated: Bool = true) -> Bool {
    defer { publish() }
    return model.lead(open, animated: animated)
  }

  func input(from area: SwipeArea, phase input: String, distance: Double, direction: Int, timestamp: TimeInterval) {
    #if DEBUG
    lastInput = ["phase": input, "distance": distance, "direction": direction, "timestamp": timestamp]
    #endif
    defer { publish() }
    switch input {
    case "prepare":
      announceActivity { ArdiaWebView.wakeNeighbourPages(in: $0, seconds: 1, committed: false) }
      model.hold()
    case "abandon":
      if model.phase == .holding {
        model.settle(to: model.selected, velocity: 0)
      } else if model.phase == .tracking, drag.area === area {
        release(velocity: 0, cancelled: false)
      } else {
        announceActivity { ArdiaWebView.releaseNeighbourPages(in: $0) }
      }
    case "began":
      begin(area)
      track(distance, direction, timestamp, sample: true)
    case "changed":
      guard model.phase == .tracking, drag.area === area else { return }
      track(distance, direction, timestamp, sample: true)
    case "ended", "cancelled":
      guard model.phase == .tracking, drag.area === area else { return }
      track(distance, direction, timestamp, sample: false)
      release(velocity: releaseVelocity(at: timestamp), cancelled: input == "cancelled")
    default:
      break
    }
  }

  private func begin(_ area: SwipeArea) {
    announceActivity()
    model.beginTracking {
      let home = model.selected
      let x = model.position
      let lo = max(model.floorIndex, min(home - 1, Int(x.rounded(.down))))
      let hi = min(model.count - 1, max(home + 1, Int(x.rounded(.up))))
      drag = Drag(start: x, lo: lo, hi: hi, home: home, detent: min(max(Int(x.rounded()), lo), hi), area: area)
      history = []
    }
  }

  private func track(_ distance: Double, _ direction: Int, _ timestamp: TimeInterval, sample: Bool) {
    guard let area = drag.area else { return }
    let width = area.pageWidth
    guard width > 0 else { return }
    let raw = drag.start + Double(direction > 0 ? -1 : 1) * distance * trackingScale / width
    let lo = Double(drag.lo), hi = Double(drag.hi)
    let x = raw > hi ? hi + rubberBand((raw - hi) * width, rubberDimension) / width
      : raw < lo ? lo - rubberBand((lo - raw) * width, rubberDimension) / width
      : raw
    if sample {
      let time = max(timestamp, history.last?.time ?? timestamp)
      history.append((time, x))
      history.removeAll { time - $0.time > historyWindow }
    }
    let nearest = min(max(Int(x.rounded()), drag.lo), drag.hi)
    if nearest != drag.detent {
      drag.detent = nearest
      ArdiaSwipe.performHaptic("alignment")
    }
    model.track(to: x)
  }

  private func releaseVelocity(at timestamp: TimeInterval) -> Double {
    let recent = history.filter { timestamp - $0.time <= historyWindow }
    guard recent.count >= 2, let first = recent.first, let last = recent.last, last.time > first.time else { return 0 }
    return (last.position - first.position) / (last.time - first.time)
  }

  private func release(velocity v: Double, cancelled: Bool) {
    let home = drag.home
    let width = drag.area?.pageWidth ?? 0
    drag.area = nil
    var target = home
    if !cancelled {
      let flick = abs(v * width) >= flickVelocity
      let position = model.position
      target = !flick ? Int(position.rounded()) : v > 0 ? Int(position.rounded(.down)) + 1 : Int(position.rounded(.up)) - 1
      target = max(model.floorIndex, home - 1, min(model.count - 1, home + 1, target))
    }
    model.settle(to: target, velocity: model.towards(target, v))
  }

  fileprivate func frame(from link: CADisplayLink) -> Bool {
    guard link === self.link else { return false }
    frameWatch.framed(at: CACurrentMediaTime())
    currentFrame = MorphFrame(link)
    model.frame(at: link.targetTimestamp)
    currentFrame = nil
    publish()
    return link === self.link
  }

  var now: TimeInterval { CACurrentMediaTime() }

  var reducesMotion: Bool { NSWorkspace.shared.accessibilityDisplayShouldReduceMotion || frameArea == nil }

  func nextSequence() -> Int {
    Pager.counter += 1
    return Pager.counter
  }

  private var frameArea: SwipeArea? {
    let seen = areas.allObjects.filter { $0.window?.occlusionState.contains(.visible) ?? false }
    if let dragged = drag.area, seen.contains(where: { $0 === dragged }) { return dragged }
    return seen.first
  }

  func startFrames() {
    announceActivity()
    guard link == nil else { return }
    guard let area = frameArea, let window = area.window else { return model.finishMotion() }
    let link = area.displayLink(target: PagerFrames(self), selector: #selector(PagerFrames.frame(_:)))
    let fps = Float(max(60, NSScreen.screens.map(\.maximumFramesPerSecond).max() ?? 60))
    link.preferredFrameRateRange = CAFrameRateRange(minimum: 60, maximum: fps, preferred: fps)
    link.add(to: .main, forMode: .common)
    self.link = link
    linkWindow = window
    linkArea = area
    frameWatch.started(at: CACurrentMediaTime())
    checkFrames(after: FrameWatch.deadline)
    occlusion = NotificationCenter.default.addObserver(forName: NSWindow.didChangeOcclusionStateNotification, object: window, queue: .main) {
      [weak self] _ in
      MainActor.assumeIsolated { self?.windowSightChanged() }
    }
  }

  func stopFrames() {
    link?.invalidate()
    link = nil
    linkWindow = nil
    linkArea = nil
    frameWatch.forget()
    deadlineCheck?.cancel()
    deadlineCheck = nil
    if let occlusion { NotificationCenter.default.removeObserver(occlusion) }
    occlusion = nil
  }

  private func restartFrames() {
    let watch = frameWatch
    stopFrames()
    frameWatch = watch
    guard model.moving else { return }
    startFrames()
    publish()
  }

  private func checkFrames(after seconds: Double) {
    deadlineCheck?.cancel()
    let check = DispatchWorkItem { [weak self] in self?.frameDeadlinePassed() }
    deadlineCheck = check
    DispatchQueue.main.asyncAfter(deadline: .now() + seconds, execute: check)
  }

  private func frameDeadlinePassed() {
    deadlineCheck = nil
    guard link != nil, model.moving else { return }
    switch frameWatch.check(at: CACurrentMediaTime()) {
    case .waiting(let seconds):
      checkFrames(after: seconds)
    case .restart:
      restartFrames()
    case .finish:
      stopFrames()
      model.finishMotion()
      publish()
    }
  }

  private func windowSightChanged() {
    guard model.moving, let linkWindow, !linkWindow.occlusionState.contains(.visible) else { return }
    restartFrames()
  }

  func pagerMoved(page: Double, lead: Double) {
    publish()
    let area = model.phase == .tracking ? drag.area : nil
    let all = areas.allObjects
    (area ?? all.first { $0.window != nil } ?? all.first)?.onPagerPosition(["position": page, "leading": lead])
    morph?.follow(lead: lead, leading: model.atLeading, moving: model.phase != .idle, frame: currentFrame)
  }

  func pagerState(_ event: PagerModel.StateEvent) {
    publish()
    var payload: [String: Any] = [
      "phase": event.phase, "sequence": event.sequence, "position": event.position, "selected": event.selected, "velocity": event.velocity,
      "leading": event.leading,
    ]
    if case .some(let id) = event.profileId { payload["profileId"] = id ?? NSNull() }
    for area in areas.allObjects { area.onPagerState(payload) }
    morph?.follow(lead: model.leadProgress, leading: model.atLeading, moving: model.phase != .idle)
  }

  func pagerEndedTracking() {
    drag.area = nil
  }

  func pagerShifted(by shift: Int) {
    history = history.map { ($0.time, $0.position + Double(shift)) }
    guard model.phase == .tracking else { return }
    drag.start += Double(shift)
    drag.lo += shift
    drag.hi = min(model.count - 1, drag.hi + shift)
    drag.home += shift
    drag.detent += shift
  }

  private var positionEvent: [String: Any] { ["position": model.pagePosition, "leading": model.leadProgress] }

  func configureMorph(_ config: MorphConfig?, uiManager: AnyObject?) {
    guard let config else {
      morph?.release()
      morph = nil
      return
    }
    let view = areas.allObjects.first { $0.window != nil }
    if let morph {
      morph.update(config, uiManager: uiManager, from: view)
    } else {
      let made = PagerMorph(config: config, uiManager: uiManager, view: view)
      morph = made
      made.follow(lead: model.leadProgress, leading: model.atLeading, moving: false)
    }
  }

  #if DEBUG
  func morphDebug(clear: Bool) -> [String: Any]? {
    defer { if clear { morph?.clearLog() } }
    return morph?.debug()
  }
  #endif

  private func announceActivity(_ tell: (NSWindow) -> Void = { ArdiaWebView.wakeNeighbourPages(in: $0) }) {
    var windows: [NSWindow] = []
    for case let window? in areas.allObjects.map(\.window) where !windows.contains(where: { $0 === window }) { windows.append(window) }
    windows.forEach(tell)
  }

  private func publish() {
    let s = model.snapshot
    var state: [String: Any] = [
      "sequence": s.sequence, "selectionSequence": s.selectionSequence, "position": s.position, "selected": s.selected,
      "phase": s.phase.rawValue, "velocity": s.velocity, "count": s.count, "leading": s.leading, "lead": s.lead,
    ]
    if case .some(let id) = s.profileId { state["profileId"] = id ?? NSNull() }
    Pager.lock.lock()
    Pager.snapshots[key] = state
    Pager.lock.unlock()
  }

  #if DEBUG
  func debug() -> [String: Any] {
    var out = Pager.snapshot(key) ?? [:]
    out["areas"] = areas.allObjects.count
    out["propSelected"] = model.propSelected
    out["propAck"] = model.propAck
    out["propLibrary"] = model.propLibrary
    out["leadingOn"] = model.leading
    out["anchor"] = model.anchor ?? NSNull()
    out["pagePosition"] = model.pagePosition
    out["home"] = model.home
    out["leadOnRest"] = model.leadOnRest
    out["history"] = history.count
    out["lastInput"] = lastInput
    out["frames"] = link == nil ? "idle" : "display link"
    if model.phase == .tracking {
      out["drag"] = ["start": drag.start, "lo": drag.lo, "hi": drag.hi, "home": drag.home, "detent": drag.detent]
    }
    return out
  }
  #endif
}
