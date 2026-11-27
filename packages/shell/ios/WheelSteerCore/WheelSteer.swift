import Foundation

enum WheelPhase: String {
  case none, mayBegin, began, changed, ended, cancelled
}

struct WheelInput: Equatable {
  var dy: Double
  var phase: WheelPhase = .none
  var momentum = false
  var precise = true
}

struct WheelRange: Equatable {
  var lo: Double
  var hi: Double
  var forward = true
  var back = true

  var tall: Bool { hi > lo }

  func allows(_ by: Double) -> Bool { by > 0 ? forward : back }

  func clamp(_ y: Double) -> Double { min(hi, max(lo, y)) }
}

enum WheelAction: Equatable {
  case none
  case place(Double)
  case ease(Double)
  case move(Int)
  case settle
}

struct WheelTuning: Equatable {
  var commit = 28.0
  var follow = 0.4
  var followMax = 26.0
  var gestureGapMs = 220.0
  var line = 40.0
  var notchPendingMs = 360.0
  var glideHoldShare = 0.7
  var notchEaseMs = 200.0
  var edgeRestMs = 300.0

  static let standard = WheelTuning()
}

struct WheelSteer {
  let tune: WheelTuning
  private var accum = 0.0
  private var committed = false
  private var scrolledInside = false
  private var lastAt = -Double.infinity
  private var insideAt = -Double.infinity
  private var holdUntil = -Double.infinity
  private var pendingSince = -Double.infinity

  init(tune: WheelTuning = .standard) {
    self.tune = tune
  }

  mutating func glideStarted(ms: Double, now: Double) {
    guard now - pendingSince < tune.notchPendingMs else { return }
    holdUntil = max(holdUntil, now + ms * tune.glideHoldShare)
    pendingSince = -Double.infinity
  }

  mutating func read(_ input: WheelInput, at: Double, range: WheelRange, now: Double) -> WheelAction {
    let ending = input.phase == .ended || input.phase == .cancelled
    let starting = input.precise && !input.momentum && (input.phase == .began || input.phase == .mayBegin)
    if starting { restart() }
    guard input.dy.isFinite, input.dy != 0 || ending else { return .none }
    return input.precise ? swipe(input, ending: ending, starting: starting, at: at, range: range, now: now) : notch(input.dy, at: at, range: range, now: now)
  }

  private mutating func restart() {
    accum = 0
    committed = false
    scrolledInside = false
  }

  private func inside(_ by: Double, at: Double, range: WheelRange) -> Double? {
    guard range.tall else { return nil }
    let within = range.clamp(at)
    let atEdge = by > 0 ? within >= range.hi - 0.01 : within <= range.lo + 0.01
    return atEdge ? nil : range.clamp(within + by)
  }

  private mutating func notch(_ dy: Double, at: Double, range: WheelRange, now: Double) -> WheelAction {
    let by = -dy * tune.line
    if now < holdUntil { return .none }
    if let next = inside(by, at: at, range: range) {
      insideAt = now
      return .ease(next)
    }
    if now - insideAt < tune.edgeRestMs || !range.allows(by) { return .none }
    return commit(by, now: now)
  }

  private mutating func commit(_ by: Double, now: Double) -> WheelAction {
    holdUntil = now + tune.notchPendingMs
    pendingSince = now
    return .move(by > 0 ? 1 : -1)
  }

  private mutating func swipe(_ input: WheelInput, ending: Bool, starting: Bool, at: Double, range: WheelRange, now: Double) -> WheelAction {
    let by = -input.dy
    if input.momentum {
      guard !committed, let next = inside(by, at: at, range: range) else { return .none }
      return .place(next)
    }
    if ending { return committed || scrolledInside ? .none : .settle }
    let phaseless = input.phase == .none
    let paused = phaseless && now - lastAt > tune.gestureGapMs
    let spent = phaseless && committed && now >= holdUntil
    let rested = phaseless && scrolledInside && now - insideAt >= tune.edgeRestMs
    if !starting && (paused || spent || rested) { restart() }
    lastAt = now
    if committed { return .none }
    if let next = inside(by, at: at, range: range) {
      scrolledInside = true
      insideAt = now
      return .place(next)
    }
    if scrolledInside { return .none }
    guard range.allows(accum + by) else {
      let pulled = accum
      accum = 0
      return pulled == 0 ? .none : .place(pulled > 0 ? range.hi : range.lo)
    }
    accum += by
    if abs(accum) >= tune.commit {
      committed = true
      return commit(accum, now: now)
    }
    let pull = max(-tune.followMax, min(tune.followMax, accum * tune.follow))
    return .place((accum > 0 ? range.hi : range.lo) + pull)
  }
}
