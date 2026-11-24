import Foundation

public struct FieldGlowLook: Equatable {
  public var rgba: [Double] = [0, 0, 0, 1]
  public var glow: [[Double]] = []
  public var tailFade: [Double] = []
  public var capFade: [Double] = []
  public var tail: Double = 0
  public var cap: Double = 0
  public var frontShare: Double = 0
  public var tailCeiling: Double = 1
  public var line: Double = 0
  public var floor: Double = 0

  public init() {}

  public init(rgba: [Double], glow: [[Double]], tailFade: [Double], capFade: [Double], tail: Double, cap: Double, frontShare: Double, tailCeiling: Double, line: Double, floor: Double) {
    self.rgba = rgba
    self.glow = glow
    self.tailFade = tailFade
    self.capFade = capFade
    self.tail = tail
    self.cap = cap
    self.frontShare = frontShare
    self.tailCeiling = tailCeiling
    self.line = line
    self.floor = floor
  }
}

public struct FieldGlowColor: Equatable {
  public let red: Double
  public let green: Double
  public let blue: Double
  public let alpha: Double
}

public struct FieldGlowPlateStops: Equatable {
  public var colors: [FieldGlowColor] = []
  public var stops: [Double] = []
  public var fade: [Double] = []
  public var fadeStops: [Double] = []
  public var extra: Double = 0
}

public struct FieldGlowPlates: Equatable {
  public var tail = FieldGlowPlateStops()
  public var cap = FieldGlowPlateStops()
  public var comet = FieldGlowPlateStops()
}

public enum FieldGlowGeometry {
  public static func fronts(_ look: FieldGlowLook, width: Double) -> (tail: Double, cap: Double) {
    guard look.tail > 0 else { return (0, 0) }
    let scale = min(1, (width * look.frontShare) / look.tail)
    return (look.tail * scale, look.cap * scale)
  }

  public static func filled(progress: Double, look: FieldGlowLook, width: Double) -> Double {
    let tail = fronts(look, width: width).tail
    guard width > 0 else { return look.floor }
    return max(look.floor, min(progress, 1 - tail / width))
  }

  public static func plates(_ look: FieldGlowLook, width: Double, height: Double) -> FieldGlowPlates {
    let (tail, cap) = fronts(look, width: width)
    let glow = look.glow.compactMap { $0.count == 2 ? ($0[0], $0[1]) : nil }
    let tailGlow = glow.map { ($0.0, min($0.1, look.tailCeiling)) }
    let capGlow = glow.map { ($0.0, $0.1 - min($0.1, look.tailCeiling)) }
    let capFade = fadingPast(body: width, front: cap, falloff: look.capFade)
    var cometFade = capFade
    if !cometFade.isEmpty { cometFade[0] = (0, 0) }
    return FieldGlowPlates(
      tail: plate(look, tailGlow, fadingPast(body: width, front: tail, falloff: look.tailFade), extra: tail),
      cap: plate(look, lined(capGlow, line: look.line, height: height), capFade, extra: cap),
      comet: plate(look, lined(glow, line: look.line, height: height), cometFade, extra: cap)
    )
  }

  static func lined(_ glow: [(Double, Double)], line: Double, height: Double) -> [(Double, Double)] {
    let lineTop = height > 0 ? 1 - line / height : 1
    return glow.map { ($0.0 * lineTop, $0.1) } + [(lineTop, 1), (1, 1)]
  }

  static func fadingPast(body: Double, front: Double, falloff: [Double]) -> [(Double, Double)] {
    let span = body + front
    guard span > 0, falloff.count > 1 else { return [(0, 1)] }
    return [(0, 1)] + falloff.enumerated().map { i, alpha in ((body + front * Double(i) / Double(falloff.count - 1)) / span, alpha) }
  }

  static func plate(_ look: FieldGlowLook, _ stops: [(Double, Double)], _ fade: [(Double, Double)], extra: Double) -> FieldGlowPlateStops {
    let rgba = look.rgba.count == 4 ? look.rgba : [0, 0, 0, 1]
    let byte = { (v: Double) in min(255, max(0, v.rounded())) / 255 }
    return FieldGlowPlateStops(
      colors: stops.map { FieldGlowColor(red: byte(rgba[0]), green: byte(rgba[1]), blue: byte(rgba[2]), alpha: byte(rgba[3] * $0.1 * 255)) },
      stops: stops.map(\.0),
      fade: fade.map(\.1),
      fadeStops: fade.map(\.0),
      extra: extra
    )
  }
}
