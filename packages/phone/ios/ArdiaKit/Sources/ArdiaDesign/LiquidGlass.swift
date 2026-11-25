import Foundation

public struct LiquidGlassParams: Equatable, Sendable {
  public var ior: Double
  public var dispersion: Double
  public var bezel: Double
  public var depth: Double
  public var maxSlope: Double
  public var lightAngle: Double
  public var specularWidth: Double
  public var specularStrength: Double
  public var oppositeStrength: Double
  public var specularFalloff: Double
  public var specularSharpness: Double
  public var specularOpacity: Double

  public static let defaults = LiquidGlassParams(
    ior: 1.5,
    dispersion: 0.04,
    bezel: 14,
    depth: 9,
    maxSlope: 5.67,
    lightAngle: -Double.pi / 4,
    specularWidth: 1.25,
    specularStrength: 1,
    oppositeStrength: 0.7,
    specularFalloff: 0.6,
    specularSharpness: 2,
    specularOpacity: 0.5
  )
}

public struct GlassInk: Equatable, Sendable {
  public var red: Double
  public var green: Double
  public var blue: Double
  public var alpha: Double

  public init(hex: UInt32, alpha: Double = 1) {
    red = Double((hex >> 16) & 0xFF) / 255
    green = Double((hex >> 8) & 0xFF) / 255
    blue = Double(hex & 0xFF) / 255
    self.alpha = alpha
  }

  public init(red: Double, green: Double, blue: Double, alpha: Double) {
    self.red = red
    self.green = green
    self.blue = blue
    self.alpha = alpha
  }

  public var premultiplied: [Float] { [Float(red * alpha), Float(green * alpha), Float(blue * alpha), Float(alpha)] }

  public static let clear = GlassInk(red: 0, green: 0, blue: 0, alpha: 0)
}

public struct GlassFrostStyle: Equatable, Sendable {
  public var blur: Double
  public var saturation: Double
  public var tint: (light: GlassInk, dark: GlassInk)
  public var fallback: (light: GlassInk, dark: GlassInk)
  public var clear: (light: GlassInk, dark: GlassInk)
  public var edge: (light: GlassInk, dark: GlassInk)
  public var edgeWidth: Double

  public func tint(dark: Bool) -> GlassInk { dark ? tint.dark : tint.light }
  public func fallback(dark: Bool) -> GlassInk { dark ? fallback.dark : fallback.light }
  public func edge(dark: Bool) -> GlassInk { dark ? edge.dark : edge.light }
  public func clear(dark: Bool) -> GlassInk { dark ? clear.dark : clear.light }

  public func opaqueFallback(dark: Bool) -> GlassInk {
    var ink = fallback(dark: dark)
    ink.alpha = 1
    return ink
  }

  public static let glass = GlassFrostStyle(
    blur: 12,
    saturation: 1.5,
    tint: (GlassInk(hex: 0xFFFFFF, alpha: 0.45), GlassInk(hex: 0xFFFFFF, alpha: 0.1)),
    fallback: (GlassInk(hex: 0xFFFFFF, alpha: 0.82), GlassInk(hex: 0x3A3A3C, alpha: 0.82)),
    clear: (GlassInk(hex: 0xFFFFFF, alpha: 0.66), GlassInk(hex: 0x1C1C1E, alpha: 0.62)),
    edge: (GlassInk(hex: 0x000000, alpha: 0.06), GlassInk(hex: 0xFFFFFF, alpha: 0.1)),
    edgeWidth: 0.5
  )

  public static func == (lhs: GlassFrostStyle, rhs: GlassFrostStyle) -> Bool {
    lhs.blur == rhs.blur && lhs.saturation == rhs.saturation && lhs.tint == rhs.tint && lhs.fallback == rhs.fallback && lhs.clear == rhs.clear && lhs.edge == rhs.edge && lhs.edgeWidth == rhs.edgeWidth
  }
}

public enum LiquidGlassRules {
  public static let circularCornerExponent = 2.0
  public static let edgeFeatherPixels = 1.0
  public static let bezelShareOfShortSide = 0.3
  public static let darkRimShare = 0.7
  public static let minLowResBlur = 6.0
  public static let maxFrostScale = 8.0
  public static let idleRefresh: TimeInterval = 3
  public static let pageCheckInterval: TimeInterval = 0.25
  public static let backdropRefresh: TimeInterval = 1
  public static let pageRefresh: TimeInterval = 0.5
  public static let settleFrames = 2
  public static let pressedLight = 0.08

  public enum Render: String, Sendable {
    case lens
    case frost
    case clear
    case solid
    case classic
  }

  public enum Path: String, Sendable {
    case live
    case clear
    case solid
    case fallback
    case classic

    public var isGlassy: Bool { self == .live || self == .clear }
  }

  public struct Choice: Equatable, Sendable {
    public var path: Path
    public var reason: String
    public var lens: Bool
    public var rim: Bool
  }

  public static func render(classic: Bool, flat: Bool, metal: Bool, lensFailed: Bool) -> Render {
    if classic { return .classic }
    if !metal { return .solid }
    if lensFailed { return .clear }
    if flat { return .frost }
    return .lens
  }

  public enum Backdrop: String, Sendable {
    case source
    case beneath
  }

  public static func backdrop(hasSource: Bool, insideSource: Bool) -> Backdrop {
    hasSource && !insideSource ? .source : .beneath
  }

  public static func choose(
    classic: Bool,
    metal: Bool,
    flat: Bool,
    lensFailed: Bool,
    rimFailed: Bool,
    holdsPage: Bool,
    solidPageAsked: Bool = false,
    overBudget: Bool = false,
    clearAsked: Bool = false,
    onScreen: Bool = true
  ) -> Choice {
    let rim = metal && !classic && !flat && !rimFailed
    func pick(_ path: Path, _ reason: String) -> Choice {
      Choice(path: path, reason: reason, lens: path == .live && metal && !flat && !lensFailed, rim: path == .classic ? false : rim)
    }
    if classic { return pick(.classic, "classic or reduce transparency") }
    if !metal { return pick(.fallback, "no Metal") }
    if !onScreen { return pick(.fallback, "off screen: nothing to refract until it is seen") }
    if overBudget { return pick(.clear, "capture over budget: clear glass until it cools down") }
    if clearAsked { return pick(.clear, "clear glass asked in the lab") }
    if holdsPage, solidPageAsked { return pick(.solid, "page under the glass, solid page asked in the lab") }
    if holdsPage { return pick(.live, "page under the glass, captured as it changes") }
    return pick(.live, "no page under the glass")
  }

  public static let budgetWindow: TimeInterval = 2
  public static let captureBudgetShare = 0.12
  public static let coldCapMs = 50.0
  public static let backdropWalkDepth = 3

  public static func median(_ samples: [Double]) -> Double {
    guard !samples.isEmpty else { return 0 }
    let sorted = samples.sorted()
    let middle = sorted.count / 2
    return sorted.count % 2 == 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle]
  }

  public struct CaptureSample: Equatable, Sendable {
    public var at: TimeInterval
    public var ms: Double
    public var cold: Bool

    public init(at: TimeInterval, ms: Double, cold: Bool = false) {
      self.at = at
      self.ms = ms
      self.cold = cold
    }
  }

  public static func recentSamples(_ samples: [CaptureSample], now: TimeInterval) -> [CaptureSample] {
    samples.filter { now - $0.at <= budgetWindow }
  }

  public static func overBudget(_ samples: [CaptureSample], now: TimeInterval) -> Bool {
    let recent = recentSamples(samples, now: now)
    guard let oldest = recent.map(\.at).min(), now - oldest >= budgetWindow * 0.75 else { return false }
    let spent = recent.reduce(0) { $0 + $1.ms }
    return spent > budgetWindow * 1000 * captureBudgetShare
  }

  public static func overBudget(_ samples: [CaptureSample], now: TimeInterval, frameMs: Double, strikes: Int = 1) -> Bool {
    let slow = recentSamples(samples, now: now).filter { ($0.cold ? $0.ms > coldCapMs : true) && GlassFlowRules.overFrame(captureMs: $0.ms, frameMs: frameMs) }
    return overBudget(samples, now: now) || slow.count >= max(strikes, 1)
  }

  public static let backdropStrikes = 2
  public static let lightInk = GlassInk(red: 1, green: 1, blue: 1, alpha: 0.8)
  public static let darkInk = GlassInk(hex: 0x0E0F10, alpha: 0.9)
  public static let readableContrast = 5.0
  public static let readableCeiling = readableBound(ink: lightInk, dark: true)
  public static let readableFloor = readableBound(ink: darkInk, dark: false)

  public static let toneEase: TimeInterval = 0.18

  public static func toneLimit(dark: Bool, since: TimeInterval) -> (ceiling: Double, floor: Double) {
    let progress = min(max(since / toneEase, 0), 1)
    let eased = 1 - (1 - progress) * (1 - progress)
    if dark { return (1, (readableCeiling - 0.005) * (1 - eased)) }
    let start = readableFloor + 0.02
    return (start + (1 - start) * eased, 0)
  }

  public static func text(_ ink: GlassInk, over glass: (red: Double, green: Double, blue: Double)) -> Double {
    luminance(red: ink.red * ink.alpha + glass.red * (1 - ink.alpha), green: ink.green * ink.alpha + glass.green * (1 - ink.alpha), blue: ink.blue * ink.alpha + glass.blue * (1 - ink.alpha))
  }

  public static func readableBound(ink: GlassInk, dark: Bool) -> Double {
    func reads(_ gray: Double) -> Bool { contrast(text(ink, over: (gray, gray, gray)), luminance(red: gray, green: gray, blue: gray)) >= readableContrast }
    var low = 0.0
    var high = 1.0
    for _ in 0..<30 {
      let middle = (low + high) / 2
      if reads(middle) == dark { low = middle } else { high = middle }
    }
    let gray = dark ? low : high
    return luminance(red: gray, green: gray, blue: gray)
  }

  public static func luminance(red: Double, green: Double, blue: Double) -> Double {
    0.2126 * pow(red, 2.2) + 0.7152 * pow(green, 2.2) + 0.0722 * pow(blue, 2.2)
  }

  public static func contrast(_ one: Double, _ other: Double) -> Double {
    (max(one, other) + 0.05) / (min(one, other) + 0.05)
  }

  public static func veil(_ ink: GlassInk, over backdrop: Double) -> Double {
    func channel(_ value: Double) -> Double { value * ink.alpha + backdrop * (1 - ink.alpha) }
    return luminance(red: channel(ink.red), green: channel(ink.green), blue: channel(ink.blue))
  }

  public static func readableVeil(_ ink: GlassInk, dark: Bool) -> GlassInk {
    let worst = dark ? 1.0 : 0.0
    func fits(_ candidate: GlassInk) -> Bool {
      let light = veil(candidate, over: worst)
      return dark ? light <= readableCeiling : light >= readableFloor
    }
    var made = ink
    if fits(made) { return made }
    made.alpha = 1
    if !fits(made) {
      let target = dark ? 0.12 : 0.9
      made = GlassInk(red: target, green: target, blue: target, alpha: 1)
    }
    var low = ink.alpha
    var high = 1.0
    for _ in 0..<24 {
      let middle = (low + high) / 2
      var trial = made
      trial.alpha = middle
      if fits(trial) { high = middle } else { low = middle }
    }
    made.alpha = high
    return made
  }
  public static let budgetCooldownBase: TimeInterval = 3
  public static let budgetCooldownLongest: TimeInterval = 30
  public static let budgetTripMemory: TimeInterval = 60

  public static func budgetCooldown(trips: Int) -> TimeInterval {
    guard trips > 0 else { return 0 }
    return min(budgetCooldownBase * pow(2, Double(min(trips - 1, 16))), budgetCooldownLongest)
  }

  public static func acceptsCapture(_ path: Path) -> Bool { path == .live }

  public static let captureRetryBase: TimeInterval = 0.05
  public static let captureRetryLongest: TimeInterval = 1

  public static func captureRetryDelay(failures: Int) -> TimeInterval {
    guard failures > 0 else { return 0 }
    return min(captureRetryBase * pow(2, Double(min(failures - 1, 16))), captureRetryLongest)
  }

  public static let framesInFlight = 2

  public static func bezel(_ params: LiquidGlassParams = .defaults, width: Double, height: Double) -> Double {
    min(params.bezel, max(min(width, height), 0) * bezelShareOfShortSide)
  }

  public static func profile(_ progress: Double) -> Double {
    let u = 1 - min(max(progress, 0), 1)
    return (max(1 - pow(u, 4), 0.0001)).squareRoot()
  }

  public static func slope(_ progress: Double, maxSlope: Double) -> Double {
    let u = 1 - min(max(progress, 0), 1)
    let inside = max(1 - pow(u, 4), 0.0001)
    return min(2 * pow(u, 3) / inside.squareRoot(), maxSlope)
  }

  public static func shiftRatio(slope: Double, ior: Double) -> Double {
    let length = (slope * slope + 1).squareRoot()
    let eta = 1 / max(ior, 1.0001)
    let cosine = 1 / length
    let k = 1 - eta * eta * (1 - cosine * cosine)
    if k < 0 { return 0 }
    let along = eta * cosine - k.squareRoot()
    let sideways = -along * slope / length
    let down = eta - along / length
    return sideways / max(down, 0.0001)
  }

  public static func maxShift(_ params: LiquidGlassParams = .defaults, bezel: Double) -> Double {
    var most = 0.0
    let steps = 64
    for step in 0...steps {
      let progress = Double(step) / Double(steps)
      let height = params.depth + profile(progress) * bezel
      let slope = slope(progress, maxSlope: params.maxSlope)
      most = max(most, shiftRatio(slope: slope, ior: params.ior + params.dispersion) * height)
      most = max(most, shiftRatio(slope: slope, ior: params.ior) * height)
      most = max(most, shiftRatio(slope: slope, ior: max(params.ior - params.dispersion, 1.0001)) * height)
    }
    return most
  }

  public static func marginPixels(blurPixels: Double, shiftPixels: Double) -> Double {
    (max(blurPixels * 2, shiftPixels + edgeFeatherPixels)).rounded(.up)
  }

  public static func frostScale(blurPixels: Double) -> Double {
    min(max((blurPixels / minLowResBlur).rounded(.towardZero), 1), maxFrostScale)
  }

  public static func blurSigma(radius: Double) -> Double {
    radius > 0 ? radius * 0.57735 + 0.5 : 0
  }

  public static func light(_ angle: Double) -> (x: Double, y: Double) { (sin(angle), -cos(angle)) }

  public static func radius(capsule: Bool, cornerRadius: Double, width: Double, height: Double) -> Double {
    let half = max(min(width, height), 0) / 2
    return capsule ? half : min(max(cornerRadius, 0), half)
  }

  public static func rimOpacity(_ params: LiquidGlassParams = .defaults, dark: Bool) -> Double {
    params.specularOpacity * (dark ? darkRimShare : 1)
  }

  public static func rimAlpha(normalAngle: Double, _ params: LiquidGlassParams = .defaults, dark: Bool, progress: Double = 0) -> Double {
    let light = light(params.lightAngle)
    let normal = (x: cos(normalAngle), y: sin(normalAngle))
    let fade = params.specularFalloff * progress * progress
    let facing = normal.x * light.x + normal.y * light.y
    let lit = min(max(pow(max(facing, 0), params.specularSharpness) * (params.specularStrength - fade), 0), 1)
    let back = min(max(pow(max(-facing, 0), params.specularSharpness) * (params.oppositeStrength - fade), 0), 1)
    return min(max(lit + back, 0), 1) * rimOpacity(params, dark: dark)
  }

  public static func rimStops(_ params: LiquidGlassParams = .defaults, dark: Bool, count: Int = 24) -> [(location: Double, alpha: Double)] {
    (0...count).map { index in
      let location = Double(index) / Double(count)
      return (location, rimAlpha(normalAngle: location * 2 * Double.pi, params, dark: dark))
    }
  }
}

public struct LiquidGlassBound: Equatable, Sendable {
  public private(set) var bezel = 0.0
  public private(set) var shift = 0.0
  public private(set) var computed = 0
  private var width = -1.0
  private var height = -1.0
  private let params: LiquidGlassParams

  public init(params: LiquidGlassParams = .defaults) {
    self.params = params
  }

  public mutating func measure(width: Double, height: Double) {
    if width == self.width, height == self.height { return }
    self.width = width
    self.height = height
    bezel = LiquidGlassRules.bezel(params, width: width, height: height)
    shift = LiquidGlassRules.maxShift(params, bezel: bezel)
    computed += 1
  }
}
