import Foundation

protocol PagerModelHost: AnyObject {
  var now: TimeInterval { get }
  var reducesMotion: Bool { get }
  func nextSequence() -> Int
  func startFrames()
  func stopFrames()
  func pagerMoved(page: Double, lead: Double)
  func pagerState(_ event: PagerModel.StateEvent)
  func pagerEndedTracking()
  func pagerShifted(by shift: Int)
}

final class PagerModel {
  enum Phase: String { case idle, tracking, holding, settling }

  struct StateEvent: Equatable {
    var phase: String
    var sequence: Int
    var position: Double
    var selected: Int
    var velocity: Double
    var leading: Bool
    var profileId: String??
  }

  struct Snapshot: Equatable {
    var sequence: Int
    var selectionSequence: Int
    var position: Double
    var selected: Int
    var phase: Phase
    var velocity: Double
    var count: Int
    var leading: Bool
    var lead: Double
    var profileId: String??
  }

  private struct Spring {
    var from: Double
    var target: Int
    var velocity: Double
    let start: TimeInterval
  }

  static let omega = 2 * Double.pi / 0.25
  static let restDisplacement = 0.003
  static let restSpeed = 0.1

  static func spring(from: Double, to target: Double, velocity: Double, after seconds: Double) -> (offset: Double, velocity: Double, rested: Bool) {
    let x0 = from - target
    let b = velocity + omega * x0
    let decay = exp(-omega * seconds)
    let offset = (x0 + b * seconds) * decay
    let speed = (velocity - omega * b * seconds) * decay
    return (offset, speed, abs(offset) < restDisplacement && abs(speed) < restSpeed)
  }

  weak var host: PagerModelHost?
  private(set) var configured = false
  private(set) var leading = false
  private(set) var anchor: Int?
  private(set) var count = 1
  private(set) var order: [String]?
  private(set) var selected = 0
  private(set) var position = 0.0
  private(set) var velocity = 0.0
  private(set) var phase = Phase.idle
  private(set) var sequence = 0
  private(set) var selectionSequence = 0
  private(set) var propSelected = 0
  private(set) var propAck = 0
  private(set) var propLibrary = false
  private(set) var leadOnRest = false
  private var spring: Spring?

  init(host: PagerModelHost? = nil) { self.host = host }

  var atLeading: Bool { anchor.map { selected == $0 - 1 } ?? false }
  var home: Int { atLeading ? anchor ?? selected : selected }
  var floorIndex: Int { anchor.map { leading ? $0 - 1 : $0 } ?? 0 }
  var pagePosition: Double { anchor.map { max(position, Double($0)) } ?? position }
  var leadProgress: Double { anchor.map { max(0, Double($0) - position) } ?? 0 }
  var moving: Bool { spring != nil }

  var snapshot: Snapshot {
    Snapshot(
      sequence: sequence, selectionSequence: selectionSequence, position: position, selected: atLeading ? -1 : home, phase: phase,
      velocity: velocity, count: count, leading: atLeading, lead: leadProgress, profileId: order == nil ? .none : .some(selectedId)
    )
  }

  func configure(selected newSelected: Int, count newCount: Int, ack: Int, order newOrder: [String]?, leading newLeading: Bool, library: Bool) {
    let count = max(1, newCount)
    propSelected = min(max(newSelected, 0), count - 1)
    propAck = max(propAck, ack)
    leading = newLeading
    propLibrary = newLeading && library
    if !configured {
      configured = true
      self.count = count
      order = newOrder
      jump(to: propSelected, leadingAt: propLibrary ? propSelected : nil)
      emitState("selected")
      return
    }
    if count != self.count || (newOrder != nil && newOrder != order) {
      var index = propSelected
      let old = order
      let oldHome = home
      let stayLeading = atLeading && leading
      self.count = count
      order = newOrder
      if propAck < selectionSequence, let old, oldHome >= 0, oldHome < old.count, let moved = newOrder?.firstIndex(of: old[oldHome]) {
        index = moved
      }
      cancelMotion()
      place(index, leadingAt: stayLeading ? index : nil)
      return reconcile()
    }
    if !leading { leadOnRest = false }
    if !leading, anchor != nil, phase != .tracking {
      if atLeading { return settle(to: home, velocity: towards(home, coasting)) }
      if phase == .idle { anchor = nil }
    }
    reconcile()
  }

  func switchTo(_ index: Int, order newOrder: [String]? = nil) -> Bool {
    guard configured else { return false }
    sync(order: newOrder)
    let target = min(max(index, 0), count - 1)
    if let anchor, target != anchor, position < Double(anchor) { reanchor(at: target) }
    host?.pagerEndedTracking()
    settle(to: target, velocity: towards(target, coasting))
    return true
  }

  func step(_ delta: Int, wrap: Bool, order newOrder: [String]? = nil) -> Bool {
    guard configured else { return false }
    sync(order: newOrder)
    if wrap {
      let target = ((home + delta) % count + count) % count
      return target == home || switchTo(target)
    }
    let floor = leading && anchor == nil && selected == 0 ? -1 : floorIndex
    let target = min(max(selected + delta, floor), count - 1)
    if target == selected { return true }
    return target < 0 || (anchor.map { target == $0 - 1 } ?? false) ? lead(true) : switchTo(target)
  }

  func lead(_ open: Bool, animated: Bool = true) -> Bool {
    guard configured, leading || !open else { return false }
    if !open, !animated {
      leadOnRest = false
      guard anchor != nil else { return true }
      let target = home
      cancelMotion()
      jump(to: target, selection: true)
      emitState("selected")
      return true
    }
    host?.pagerEndedTracking()
    let v = coasting
    if !open {
      leadOnRest = false
      if let anchor { settle(to: anchor, velocity: towards(anchor, v)) }
      return true
    }
    if anchor == nil {
      if position < Double(selected) {
        settle(to: selected, velocity: towards(selected, v), leadOnRest: true)
        return true
      }
      anchor = selected
    }
    let target = floorIndex
    settle(to: target, velocity: towards(target, v))
    return true
  }

  func select(_ profileId: String, order ids: [String]) -> Bool {
    guard configured, let index = ids.firstIndex(of: profileId) else { return false }
    if let anchor, position < Double(anchor) {
      count = ids.count
      order = ids
      reanchor(at: index)
      emitPosition()
      emitState("selected")
      return true
    }
    cancelMotion()
    count = ids.count
    order = ids
    jump(to: index, selection: true)
    emitState("selected")
    return true
  }

  func frame(at time: TimeInterval) {
    guard let s = spring else { return }
    let state = Self.spring(from: s.from, to: Double(s.target), velocity: s.velocity, after: max(0, time - s.start))
    if state.rested {
      stopSpring()
      return rest(at: s.target)
    }
    position = Double(s.target) + state.offset
    velocity = state.velocity
    emitPosition()
  }

  func finishMotion() {
    guard let s = spring else { return }
    stopSpring()
    rest(at: s.target)
  }

  func stop() {
    stopSpring()
    leadOnRest = false
  }

  func hold() {
    guard phase == .settling else { return }
    stopSpring()
    leadOnRest = false
    phase = .holding
  }

  func beginTracking(_ measure: () -> Void) {
    stopSpring()
    leadOnRest = false
    if anchor == nil, leading, selected == 0 { anchor = 0 }
    measure()
    velocity = 0
    phase = .tracking
    sequence = nextSequence()
    emitState("began")
  }

  func cancelTracking() -> Bool {
    guard phase == .tracking else { return false }
    host?.pagerEndedTracking()
    settle(to: selected, velocity: 0)
    return true
  }

  func track(to x: Double) {
    position = x
    emitPosition()
  }

  func settle(to target: Int, velocity v: Double, leadOnRest thenLead: Bool = false) {
    if target != selected {
      selected = target
      sequence = nextSequence()
      selectionSequence = sequence
      emitState("selected")
    }
    stopSpring()
    leadOnRest = thenLead
    if host?.reducesMotion ?? false { return rest(at: target) }
    phase = .settling
    velocity = v
    spring = Spring(from: position, target: target, velocity: v, start: host?.now ?? 0)
    host?.startFrames()
  }

  func towards(_ target: Int, _ v: Double) -> Double {
    let d = Double(target) - position
    return d != 0 && v != 0 && (d > 0) == (v > 0) ? v : 0
  }

  private var coasting: Double { phase == .settling ? velocity : 0 }

  private func sync(order newOrder: [String]?) {
    guard let ids = newOrder, !ids.isEmpty, ids != order else { return }
    let current = order.flatMap { home >= 0 && home < $0.count ? $0[home] : nil }
    let id = current.flatMap { ids.contains($0) ? $0 : nil } ?? ids[min(max(propSelected, 0), ids.count - 1)]
    _ = select(id, order: ids)
  }

  private func reconcile() {
    guard phase == .idle, propAck >= selectionSequence else { return }
    if home != propSelected {
      place(propSelected, leadingAt: propLibrary ? propSelected : nil)
    } else if propLibrary != atLeading {
      _ = lead(propLibrary)
    }
  }

  private func place(_ index: Int, leadingAt newAnchor: Int?) {
    let wasLeading = atLeading
    jump(to: index, leadingAt: newAnchor)
    if atLeading != wasLeading { emitState("selected") }
  }

  private func jump(to index: Int, selection: Bool = false, leadingAt newAnchor: Int? = nil) {
    anchor = newAnchor
    let target = newAnchor.map { $0 - 1 } ?? index
    selected = target
    position = Double(target)
    velocity = 0
    sequence = nextSequence()
    if selection { selectionSequence = sequence }
    emitPosition()
  }

  private func reanchor(at index: Int) {
    guard let old = anchor else { return }
    let shift = index - old
    anchor = index
    position += Double(shift)
    selected += shift
    if var s = spring {
      s.from += Double(shift)
      s.target += shift
      spring = s
    }
    host?.pagerShifted(by: shift)
    sequence = nextSequence()
    selectionSequence = sequence
  }

  private func rest(at target: Int) {
    position = Double(target)
    velocity = 0
    phase = .idle
    if let anchor, selected >= anchor { self.anchor = nil }
    sequence = nextSequence()
    emitPosition()
    emitState("settled")
    if leadOnRest {
      leadOnRest = false
      if lead(true) { return }
    }
    reconcile()
  }

  private func stopSpring() {
    let wasMoving = spring != nil
    spring = nil
    if wasMoving { host?.stopFrames() }
  }

  private func cancelMotion() {
    stopSpring()
    host?.pagerEndedTracking()
    leadOnRest = false
    phase = .idle
    velocity = 0
  }

  private func nextSequence() -> Int { host?.nextSequence() ?? sequence + 1 }

  private func emitPosition() {
    host?.pagerMoved(page: pagePosition, lead: leadProgress)
  }

  private func emitState(_ name: String) {
    host?.pagerState(
      StateEvent(
        phase: name, sequence: sequence, position: position, selected: atLeading ? -1 : home, velocity: velocity, leading: atLeading,
        profileId: order == nil ? .none : .some(selectedId)
      )
    )
  }

  private var selectedId: String? {
    guard !atLeading, let ids = order, selected >= 0, selected < ids.count else { return nil }
    return ids[selected]
  }
}

struct FrameWatch {
  enum Verdict: Equatable {
    case waiting(recheckIn: Double)
    case restart
    case finish
  }

  static let deadline = 0.1
  private var lastFrame = 0.0
  private var missed = 0

  mutating func started(at time: Double) { lastFrame = time }

  mutating func framed(at time: Double) {
    lastFrame = time
    missed = 0
  }

  mutating func forget() { missed = 0 }

  mutating func check(at time: Double) -> Verdict {
    let quiet = time - lastFrame
    if quiet < Self.deadline { return .waiting(recheckIn: Self.deadline - quiet) }
    missed += 1
    guard missed > 1 else { return .restart }
    missed = 0
    return .finish
  }
}
