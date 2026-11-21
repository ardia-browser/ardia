import SwiftUI

public enum Palette {
  public static let accent = Color.adaptive(light: Color(hex: 0x6395FC), dark: Color(hex: 0x4A77D4))
  public static let formAccent = Color.adaptive(light: Color(hex: 0x007AFF), dark: Color(hex: 0x0A84FF))
  public static let primaryAction = Color.adaptive(light: Color(hex: 0x0F182C), dark: Color(hex: 0xDCCBD8))
  public static let onPrimaryAction = Color.adaptive(light: .white, dark: .black)
  public static let success = Color.adaptive(light: Color(hex: 0x34C759), dark: Color(hex: 0x30D158))
  public static let panel = Color.adaptive(light: .white, dark: Color(hex: 0x2A2A2A))
  public static let toast = Color.adaptive(light: .white.opacity(0.92), dark: Color(hex: 0x2C2A2B, opacity: 0.9))
}

public enum Spacing {
  public static let hairline: CGFloat = 4
  public static let tight: CGFloat = 8
  public static let small: CGFloat = 12
  public static let page: CGFloat = 16
  public static let medium: CGFloat = 20
  public static let large: CGFloat = 24
  public static let section: CGFloat = 32
}

public enum Radius {
  public static let field: CGFloat = 16
  public static let card: CGFloat = 20
  public static let sheet: CGFloat = 32
}

public enum Motion {
  public static let arrive = Animation.timingCurve(0.05, 0.7, 0.1, 1, duration: 0.19)
  public static let expand = Animation.spring(response: 0.18, dampingFraction: 1)
  public static let leaveSpring = Spring(response: 0.14, dampingRatio: 1)
  public static let leave = Animation.spring(leaveSpring)
  public static let riseCurve = MotionCurve(0.2, 0, 0, 1, duration: 0.36)
  public static let rise = riseCurve.animation
  public static let snappy = Animation.spring(response: 0.2, dampingFraction: 1)
  public static let smoothSpring = Spring(response: 0.26, dampingRatio: 1)
  public static let smooth = Animation.spring(smoothSpring)
  public static let fadeCurve = MotionCurve.easeOut(duration: 0.15)
  public static let fade = fadeCurve.animation
  public static let step = Animation.timingCurve(0.05, 0.7, 0.1, 1, duration: 0.3)
  public static let tabStack = Animation.spring(response: 0.22, dampingFraction: 1)
  public static let modeToggle = snappy

  public static func settle(distance: Double, velocity: Double, duration: Double = 0.26) -> Animation {
    .interpolatingSpring(duration: duration, bounce: 0, initialVelocity: relativeVelocity(velocity, over: distance))
  }

  public static func relativeVelocity(_ velocity: Double, over distance: Double) -> Double {
    let initial = abs(distance) > 0.001 ? velocity / distance : 0
    return max(min(initial, 30), -30)
  }
}

public struct MotionCurve: Sendable {
  public let start: CGPoint
  public let end: CGPoint
  public let duration: Double

  public init(_ x1: Double, _ y1: Double, _ x2: Double, _ y2: Double, duration: Double) {
    start = CGPoint(x: x1, y: y1)
    end = CGPoint(x: x2, y: y2)
    self.duration = duration
  }

  public static func easeOut(duration: Double) -> MotionCurve {
    MotionCurve(0, 0, 0.58, 1, duration: duration)
  }

  public var animation: Animation {
    .timingCurve(start.x, start.y, end.x, end.y, duration: duration)
  }
}

extension Spring {
  static let fullyThere: CGFloat = 0.98
  static let progressSearchStep: Double = 0.002

  public func criticalProgress(at time: Double) -> Double {
    let omega = 2 * Double.pi / duration
    return 1 - (1 + omega * time) * exp(-omega * time)
  }

  public func time(toReach progress: CGFloat) -> CFTimeInterval {
    let target = min(max(progress, 0), Self.fullyThere)
    guard target > 0 else { return 0 }
    var time = 0.0
    while time < settlingDuration {
      if criticalProgress(at: time) >= Double(target) { return time }
      time += Self.progressSearchStep
    }
    return settlingDuration
  }
}

public enum Layout {
  public static let swipeParallax: CGFloat = -0.33
  public static let swipeCommit: CGFloat = 75
  public static let swipeFlickCommit: CGFloat = 50
}

public extension View {
  func primaryActionColors() -> some View {
    tint(Palette.primaryAction).foregroundStyle(Palette.onPrimaryAction)
  }
}

public extension Color {
  init(hex: UInt32, opacity: Double = 1) {
    self.init(
      .sRGB,
      red: Double((hex >> 16) & 0xFF) / 255,
      green: Double((hex >> 8) & 0xFF) / 255,
      blue: Double(hex & 0xFF) / 255,
      opacity: opacity
    )
  }
}
