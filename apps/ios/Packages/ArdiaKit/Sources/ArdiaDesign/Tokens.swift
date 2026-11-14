import SwiftUI

public enum Palette {
  public static let accent = Color.adaptive(light: Color(hex: 0x6395FC), dark: Color(hex: 0x4A77D4))
  public static let formAccent = Color.adaptive(light: Color(hex: 0x007AFF), dark: Color(hex: 0x0A84FF))
  public static let primaryAction = Color.adaptive(light: Color(hex: 0x0F182C), dark: Color(hex: 0xDCCBD8))
  public static let onPrimaryAction = Color.adaptive(light: .white, dark: .black)
  public static let success = Color.adaptive(light: Color(hex: 0x34C759), dark: Color(hex: 0x30D158))
  public static let panel = Color.adaptive(light: .white, dark: Color(hex: 0x2A2A2A))
  public static let panelBorder = Color.adaptive(light: .black.opacity(0.1), dark: .white.opacity(0.1))
  public static let toast = Color.adaptive(light: .white.opacity(0.92), dark: Color(hex: 0x2C2A2B, opacity: 0.9))
  public static let toastShadow = Color.adaptive(light: .black.opacity(0.18), dark: .black.opacity(0.5))
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
  public static let leave = Animation.spring(response: 0.14, dampingFraction: 1)
  public static let rise = Animation.timingCurve(0.2, 0, 0, 1, duration: 0.36)
  public static let snappy = Animation.spring(response: 0.2, dampingFraction: 1)
  public static let smooth = Animation.spring(response: 0.26, dampingFraction: 1)
  public static let fade = Animation.easeOut(duration: 0.15)
  public static let step = Animation.timingCurve(0.05, 0.7, 0.1, 1, duration: 0.3)
  public static let tabStack = Animation.spring(response: 0.22, dampingFraction: 1)
  public static let modeToggle = snappy

  public static func settle(distance: Double, velocity: Double, duration: Double = 0.26) -> Animation {
    let initial = abs(distance) > 0.001 ? velocity / distance : 0
    return .interpolatingSpring(duration: duration, bounce: 0, initialVelocity: max(min(initial, 30), -30))
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
