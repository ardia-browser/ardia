import Foundation

public enum FieldGlowPhase: Equatable {
  case idle, loading, finishing
}

public enum FieldGlowCurve: Equatable {
  case enter, exit

  public func eased(_ t: Double) -> Double {
    let t = min(max(t, 0), 1)
    switch self {
    case .enter: return 1 - pow(1 - t, 3)
    case .exit: return t * t
    }
  }
}

public enum FieldGlowProperty: Hashable, CaseIterable {
  case filled, opacity, comet
}

public struct FieldGlowMove: Equatable {
  public let property: FieldGlowProperty
  public let to: Double
  public let duration: Double
  public let delay: Double
  public let curve: FieldGlowCurve
  public var clamped = false

  public init(property: FieldGlowProperty, to: Double, duration: Double, delay: Double, curve: FieldGlowCurve, clamped: Bool = false) {
    self.property = property
    self.to = to
    self.duration = duration
    self.delay = delay
    self.curve = curve
    self.clamped = clamped
  }

  public static func set(_ property: FieldGlowProperty, _ to: Double) -> FieldGlowMove {
    FieldGlowMove(property: property, to: to, duration: 0, delay: 0, curve: .enter)
  }
}

public struct FieldGlowTimings: Equatable {
  public var show: Double
  public var progress: Double
  public var finish: Double
  public var hold: Double
  public var hide: Double

  public init(show: Double, progress: Double, finish: Double, hold: Double, hide: Double) {
    self.show = show
    self.progress = progress
    self.finish = finish
    self.hold = hold
    self.hide = hide
  }

  public init(milliseconds: [Double]) {
    let at = { (i: Int, fallback: Double) in (i < milliseconds.count ? milliseconds[i] : fallback) / 1000 }
    self.init(show: at(0, 200), progress: at(1, 250), finish: at(2, 300), hold: at(3, 200), hide: at(4, 250))
  }

  public static let standard = FieldGlowTimings(milliseconds: [])
}

public struct FieldGlowModel {
  public private(set) var phase: FieldGlowPhase = .idle
  public private(set) var generation = 0
  public private(set) var targets: [FieldGlowProperty: Double] = [.filled: 0, .opacity: 0, .comet: 0]
  public private(set) var progress: Double?
  public var timings: FieldGlowTimings

  public init(timings: FieldGlowTimings = .standard) {
    self.timings = timings
  }

  public var animates: Bool { phase != .idle }

  public mutating func show() -> [FieldGlowMove] {
    begin(.loading)
    progress = nil
    return record([.set(.filled, 0), .set(.comet, 0), FieldGlowMove(property: .opacity, to: 1, duration: timings.show, delay: 0, curve: .enter)])
  }

  public mutating func progress(to: Double, still: Bool) -> [FieldGlowMove] {
    guard phase == .loading else { return [] }
    progress = to
    return record([FieldGlowMove(property: .filled, to: to, duration: still ? 0 : timings.progress, delay: 0, curve: .enter, clamped: true)])
  }

  public mutating func finish(still: Bool) -> [FieldGlowMove] {
    guard phase == .loading else { return [] }
    begin(.finishing)
    progress = nil
    if still {
      return record([.set(.filled, 1), .set(.comet, 1), FieldGlowMove(property: .opacity, to: 0, duration: timings.hide, delay: timings.hold, curve: .exit)])
    }
    return record([
      FieldGlowMove(property: .filled, to: 1, duration: timings.finish, delay: 0, curve: .enter),
      FieldGlowMove(property: .comet, to: 1, duration: timings.finish, delay: 0, curve: .enter),
      FieldGlowMove(property: .opacity, to: 0, duration: timings.hide, delay: timings.finish + timings.hold, curve: .exit),
    ])
  }

  public var finishLasts: Double { timings.finish + timings.hold + timings.hide }

  @discardableResult
  public mutating func finished(generation done: Int) -> Bool {
    guard phase == .finishing, done == generation else { return false }
    begin(.idle)
    return true
  }

  public mutating func reset() -> [FieldGlowMove] {
    begin(.idle)
    progress = nil
    return record([.set(.opacity, 0)])
  }

  private mutating func begin(_ next: FieldGlowPhase) {
    phase = next
    generation += 1
  }

  private mutating func record(_ moves: [FieldGlowMove]) -> [FieldGlowMove] {
    for move in moves { targets[move.property] = move.to }
    return moves
  }
}

public func fieldGlowSamples(from: Double, to: Double, duration: Double, curve: FieldGlowCurve, perSecond: Double = 120) -> [Double] {
  let count = max(2, Int((duration * perSecond).rounded(.up)) + 1)
  return (0..<count).map { i in from + (to - from) * curve.eased(Double(i) / Double(count - 1)) }
}
