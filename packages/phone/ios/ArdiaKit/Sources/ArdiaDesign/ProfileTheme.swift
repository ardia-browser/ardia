import CoreFoundation
import Foundation

public struct ThemeColor: Hashable, Sendable {
  public var r: Double
  public var g: Double
  public var b: Double
  public var a: Double

  public init(r: Double, g: Double, b: Double, a: Double = 1) {
    self.r = r
    self.g = g
    self.b = b
    self.a = a
  }

  var oklab: SIMD3<Double> {
    let r = Self.decode(r), g = Self.decode(g), b = Self.decode(b)
    let l = cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b)
    let m = cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b)
    let s = cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b)
    return SIMD3(
      0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
      1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
      0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s
    )
  }

  static func fromOklab(_ lab: SIMD3<Double>) -> SIMD3<Double> {
    let l = pow3(lab.x + 0.3963377774 * lab.y + 0.2158037573 * lab.z)
    let m = pow3(lab.x - 0.1055613458 * lab.y - 0.0638541728 * lab.z)
    let s = pow3(lab.x - 0.0894841775 * lab.y - 1.291485548 * lab.z)
    return SIMD3(
      encode(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s),
      encode(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s),
      encode(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s)
    )
  }

  static func mixOklab(_ a: ThemeColor, _ b: ThemeColor, _ t: Double) -> SIMD3<Double> {
    let from = a.oklab
    return fromOklab(from + (b.oklab - from) * t)
  }

  static func decode(_ v: Double) -> Double {
    let size = abs(v)
    return sign(v) * (size <= 0.04045 ? size / 12.92 : pow((size + 0.055) / 1.055, 2.4))
  }

  static func encode(_ v: Double) -> Double {
    let size = abs(v)
    return sign(v) * (size <= 0.0031308 ? size * 12.92 : 1.055 * pow(size, 1 / 2.4) - 0.055)
  }

  private static func sign(_ v: Double) -> Double { v > 0 ? 1 : v < 0 ? -1 : 0 }
  private static func pow3(_ v: Double) -> Double { v * v * v }
}

public struct ThemeStop: Hashable, Sendable {
  public var color: ThemeColor
  public var x: Double
  public var y: Double

  public init(color: ThemeColor, x: Double, y: Double) {
    self.color = color
    self.x = x
    self.y = y
  }
}

public enum ThemeTexture: String, CaseIterable, Sendable {
  case grain, sand, denim, tweed

  public var strength: Double {
    switch self {
    case .grain: 0.8
    case .sand: 0.15
    case .denim: 0.6
    case .tweed: 0.4
    }
  }
}

public struct ThemeLook: Hashable, Sendable {
  public static let maxStops = 3
  public static let maxStopsRead = 16
  public static let defaultAngle = 135.0
  public static let defaultIntensity = 0.6
  public static let baseReach = 0.75

  public var stops: [ThemeStop]
  public var intensity: Double
  public var grain: Double
  public var texture: ThemeTexture
  public var translucency: Double
  public var angle: Double

  public init(
    stops: [ThemeStop],
    intensity: Double = ThemeLook.defaultIntensity,
    grain: Double = 0,
    texture: ThemeTexture = .grain,
    translucency: Double = 1,
    angle: Double = ThemeLook.defaultAngle
  ) {
    self.stops = stops
    self.intensity = intensity
    self.grain = grain
    self.texture = texture
    self.translucency = translucency
    self.angle = angle
  }

  public func area(x: Double, y: Double, width: Double, height: Double) -> SIMD3<Double> {
    guard let first = stops.first?.color else { return SIMD3(repeating: 0.5) }
    let second = stops.count > 1 ? stops[1].color : first
    let t = clamp01(Self.along(angle, x, y, width, height, half: Self.baseHalf) / Self.baseReach)
    let base = ThemeColor.mixOklab(first, second, t)
    guard stops.count > 2 else { return base }
    let third = stops[2].color
    let amount = clamp01(Self.along(angle + 45, x, y, width, height, half: Self.overlayHalf)) * third.a
    return base + (SIMD3(third.r, third.g, third.b) - base) * amount
  }

  static func direction(_ degrees: Double) -> (dx: Double, dy: Double) {
    let radians = degrees * .pi / 180
    return (sin(radians), -cos(radians))
  }

  static func baseHalf(_ width: Double, _ height: Double, _ dx: Double, _ dy: Double) -> Double {
    hypot(width * dx, height * dy) * hypot(width, height) / (2 * max(width, height))
  }

  static func overlayHalf(_ width: Double, _ height: Double, _ dx: Double, _ dy: Double) -> Double {
    (width * abs(dx) + height * abs(dy)) / 2
  }

  static func along(
    _ degrees: Double, _ x: Double, _ y: Double, _ width: Double, _ height: Double,
    half: (Double, Double, Double, Double) -> Double
  ) -> Double {
    let (dx, dy) = direction(degrees)
    return ((x - width / 2) * dx + (y - height / 2) * dy) / (2 * half(width, height, dx, dy)) + 0.5
  }

  static func arcLayerAlpha(_ intensity: Double) -> Double {
    0.2 + 0.55 * clamp01(intensity)
  }

  public var layerAlpha: Double {
    1 - clamp01(translucency) * (1 - Self.arcLayerAlpha(intensity))
  }

  public func underlayAlpha(dark: Bool) -> Double {
    let arc = min(Self.arcLayerAlpha(intensity), 0.5)
    return clamp01(translucency) * (dark ? 0.35 * arc : arc)
  }

  public var grainAlpha: Double {
    clamp01(grain) * texture.strength
  }

  func underGrey(dark: Bool) -> Double {
    let underlay = underlayAlpha(dark: dark)
    let blur = dark ? 0.16 : 0.92
    return (dark ? 0 : 1) * underlay + blur * (1 - underlay)
  }

  func underRGB(dark: Bool) -> LookRGB {
    let grey = underGrey(dark: dark)
    return LookRGB(red: grey, green: grey, blue: grey).snapped
  }

  public func underColor(dark: Bool) -> String {
    underRGB(dark: dark).hexString
  }
}

public extension ThemeLook {
  init?(sanitizing value: Any?) {
    guard let raw = value as? [String: Any], let rawStops = raw["stops"] as? [Any] else { return nil }
    var kept: [ThemeStop] = []
    for rawStop in rawStops.prefix(Self.maxStopsRead) {
      guard kept.count < Self.maxStops else { break }
      guard let stop = rawStop as? [String: Any], let color = Self.sanitizedColor(stop["color"]) else { continue }
      kept.append(ThemeStop(color: color, x: clamp01(Self.number(stop["x"]) ?? 0.5), y: clamp01(Self.number(stop["y"]) ?? 0.5)))
    }
    guard !kept.isEmpty else { return nil }
    self.init(
      stops: kept,
      intensity: clamp01(Self.number(raw["intensity"]) ?? Self.defaultIntensity),
      grain: clamp01(Self.number(raw["grain"]) ?? 0),
      texture: (raw["texture"] as? String).flatMap(ThemeTexture.init(rawValue:)) ?? .grain,
      translucency: clamp01(Self.number(raw["translucency"]) ?? 1),
      angle: Self.number(raw["angle"]).map { ($0.truncatingRemainder(dividingBy: 360) + 360).truncatingRemainder(dividingBy: 360) } ?? Self.defaultAngle
    )
  }

  init?(json: Data) {
    self.init(sanitizing: try? JSONSerialization.jsonObject(with: json))
  }

  var dictionary: [String: Any] {
    [
      "stops": stops.map { stop -> [String: Any] in
        ["color": ["r": stop.color.r, "g": stop.color.g, "b": stop.color.b, "a": stop.color.a], "x": stop.x, "y": stop.y]
      },
      "intensity": intensity,
      "grain": grain,
      "texture": texture.rawValue,
      "translucency": translucency,
      "angle": angle,
    ]
  }

  private static func sanitizedColor(_ value: Any?) -> ThemeColor? {
    guard let raw = value as? [String: Any], let r = number(raw["r"]), let g = number(raw["g"]), let b = number(raw["b"]),
      [r, g, b].allSatisfy({ abs($0) < 4 })
    else { return nil }
    return ThemeColor(r: r, g: g, b: b, a: clamp01(number(raw["a"]) ?? 1))
  }

  private static func number(_ value: Any?) -> Double? {
    guard let number = value as? NSNumber, CFGetTypeID(number) != CFBooleanGetTypeID() else { return nil }
    let double = number.doubleValue
    return double.isFinite ? double : nil
  }
}

func clamp01(_ v: Double) -> Double { min(1, max(0, v)) }
