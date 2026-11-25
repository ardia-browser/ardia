import AppKit

struct ThemeGradient: Equatable {
  var colors: [SIMD4<Float>] = []
  var opacity: CGFloat = 1
  var baseAlpha: CGFloat = 0
  var grain: CGFloat = 0
  var texture = "grain"
  var appearance = "auto"
  var angle: CGFloat = ArcGradientLayer.defaultAngle

  var isEmpty: Bool { colors.isEmpty }

  static func parse(_ flat: [Double]) -> [SIMD4<Float>] {
    stride(from: 0, to: flat.count - 3, by: 4).prefix(3).map { (i: Int) -> SIMD4<Float> in
      SIMD4<Float>(Float(flat[i]), Float(flat[i + 1]), Float(flat[i + 2]), Float(flat[i + 3]))
    }
  }

  var forcedAppearance: NSAppearance? {
    switch appearance {
    case "dark": return NSAppearance(named: .darkAqua)
    case "light": return NSAppearance(named: .aqua)
    default: return nil
    }
  }
}
