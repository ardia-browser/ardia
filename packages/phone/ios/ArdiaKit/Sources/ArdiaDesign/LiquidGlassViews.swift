import SwiftUI

public extension Color {
  init(glassInk ink: GlassInk) {
    self.init(.sRGB, red: ink.red, green: ink.green, blue: ink.blue, opacity: ink.alpha)
  }
}

public struct LiquidGlassFill<S: Shape>: View {
  private let shape: S
  private let tint: Color?
  private let fill: AnyShapeStyle?

  @Environment(\.colorScheme) private var scheme
  @Environment(\.accessibilityReduceTransparency) private var reduceTransparency

  public init(_ shape: S, tint: Color? = nil, fill: AnyShapeStyle? = nil) {
    self.shape = shape
    self.tint = tint
    self.fill = fill
  }

  public var body: some View {
    let dark = scheme == .dark
    let style = GlassFrostStyle.glass
    let params = LiquidGlassParams.defaults
    ZStack {
      shape.fill(fill ?? AnyShapeStyle(Color(glassInk: reduceTransparency ? style.opaqueFallback(dark: dark) : style.fallback(dark: dark))))
      if let tint { shape.fill(tint) }
      shape.stroke(Color(glassInk: style.edge(dark: dark)), lineWidth: style.edgeWidth * 2).clipShape(shape)
      if !reduceTransparency {
        shape.stroke(Self.rim(dark: dark), lineWidth: params.specularWidth * 2).clipShape(shape).blendMode(.plusLighter)
      }
    }
    .allowsHitTesting(false)
    .accessibilityHidden(true)
  }

  static func rim(dark: Bool) -> AngularGradient {
    let stops = LiquidGlassRules.rimStops(dark: dark).map { Gradient.Stop(color: .white.opacity($0.alpha), location: $0.location) }
    return AngularGradient(stops: stops, center: .center, startAngle: .zero, endAngle: .degrees(360))
  }
}

public struct LiquidGlassButtonStyle: ButtonStyle {
  public enum Outline: Sendable {
    case capsule
    case circle
  }

  private let prominent: Bool
  private let outline: Outline
  private let label: Color?

  public init(prominent: Bool = false, outline: Outline = .capsule, label: Color? = nil) {
    self.prominent = prominent
    self.outline = outline
    self.label = label ?? (prominent ? .white : nil)
  }

  public func makeBody(configuration: Configuration) -> some View {
    let padded = configuration.label
      .padding(.horizontal, outline == .circle ? 0 : Spacing.small + 2)
      .padding(.vertical, outline == .circle ? 0 : 7)
    return Group {
      if let label {
        padded.foregroundStyle(label)
      } else {
        padded
      }
    }
    .background {
      switch outline {
      case .capsule: LiquidGlassFill(Capsule(), fill: prominent ? AnyShapeStyle(.tint) : nil)
      case .circle: LiquidGlassFill(Circle(), fill: prominent ? AnyShapeStyle(.tint) : nil)
      }
    }
    .contentShape(outline == .circle ? AnyShape(Circle()) : AnyShape(Capsule()))
    .opacity(configuration.isPressed ? 0.75 : 1)
  }
}
