import CoreGraphics
import SwiftUI

public struct ThemeBackdrop: View {
  public var look: ThemeLook
  public var dark: Bool

  public init(look: ThemeLook, dark: Bool) {
    self.look = look
    self.dark = dark
  }

  public var body: some View {
    ZStack {
      look.underRGB(dark: dark).color
      ThemeGradientView(look: look)
        .opacity(look.layerAlpha)
      if look.grainAlpha > 0 {
        ThemeTextureView(texture: look.texture)
          .opacity(look.grainAlpha)
      }
    }
    .allowsHitTesting(false)
    .accessibilityHidden(true)
  }
}

public struct ThemeGradientView: View {
  static let samples = 16

  public var look: ThemeLook

  public init(look: ThemeLook) {
    self.look = look
  }

  public var body: some View {
    GeometryReader { proxy in
      let size = proxy.size
      ZStack {
        Rectangle().fill(baseShading(size))
        if look.stops.count > 2 {
          Rectangle().fill(overlayShading(size))
        }
      }
    }
    .allowsHitTesting(false)
  }

  private func baseShading(_ size: CGSize) -> some ShapeStyle {
    let first = look.stops.first?.color ?? ThemeColor(r: 0.5, g: 0.5, b: 0.5)
    let second = look.stops.count > 1 ? look.stops[1].color : first
    let steps = look.stops.count > 1 ? Self.samples : 1
    let from = first.oklab, to = second.oklab
    let colors = (0...steps).map { index in
      let t = Double(index) / Double(steps)
      return Self.color(ThemeColor.fromOklab(from + (to - from) * t), opacity: 1)
    }
    let (start, end) = Self.axis(size: size, degrees: look.angle, reach: ThemeLook.baseReach, half: ThemeLook.baseHalf)
    return .linearGradient(Gradient(colors: colors).colorSpace(.device), startPoint: start, endPoint: end)
  }

  private func overlayShading(_ size: CGSize) -> some ShapeStyle {
    let third = look.stops[2].color
    let rgb = SIMD3(third.r, third.g, third.b)
    let colors = [Self.color(rgb, opacity: 0), Self.color(rgb, opacity: clamp01(third.a))]
    let (start, end) = Self.axis(size: size, degrees: look.angle + 45, reach: 1, half: ThemeLook.overlayHalf)
    return .linearGradient(Gradient(colors: colors).colorSpace(.device), startPoint: start, endPoint: end)
  }

  static func axis(
    size: CGSize, degrees: Double, reach: Double, half: (Double, Double, Double, Double) -> Double
  ) -> (UnitPoint, UnitPoint) {
    let width = max(Double(size.width), 1), height = max(Double(size.height), 1)
    let (dx, dy) = ThemeLook.direction(degrees)
    let length = half(width, height, dx, dy)
    let startX = width / 2 - length * dx, startY = height / 2 - length * dy
    let span = 2 * length * reach
    return (
      UnitPoint(x: startX / width, y: startY / height),
      UnitPoint(x: (startX + span * dx) / width, y: (startY + span * dy) / height)
    )
  }

  static func color(_ rgb: SIMD3<Double>, opacity: Double) -> Color {
    Color(.sRGB, red: rgb.x, green: rgb.y, blue: rgb.z, opacity: opacity)
  }
}

public struct ThemeTextureView: View {
  public var texture: ThemeTexture

  public init(texture: ThemeTexture) {
    self.texture = texture
  }

  public var body: some View {
    Image(decorative: ThemeTextureTile.image(texture), scale: ThemeTextureTile.scale)
      .resizable(resizingMode: .tile)
      .interpolation(.none)
      .allowsHitTesting(false)
      .accessibilityHidden(true)
  }
}

public enum ThemeTextureTile {
  public static let side = 128
  static let scale: CGFloat = 2
  static let darkening: [ThemeTexture: (gain: Float, floor: Float)] = [
    .grain: (0.211, 0), .sand: (0.937, 0.132), .denim: (0.226, 0.068), .tweed: (0.23, 0.261),
  ]

  private static let tiles: [ThemeTexture: CGImage] = Dictionary(
    uniqueKeysWithValues: ThemeTexture.allCases.map { ($0, tile($0)) }
  )

  public static func image(_ texture: ThemeTexture) -> CGImage {
    tiles[texture] ?? GrainTexture.image
  }

  public static func alpha(_ texture: ThemeTexture) -> [UInt8] {
    let n = side
    var alpha = [Float](repeating: 0, count: n * n)
    var state: UInt32 = 0x9E37_79B9
    func random() -> Float {
      state ^= state << 13
      state ^= state >> 17
      state ^= state << 5
      return Float(state % 10_000) / 10_000
    }
    func add(_ x: Int, _ y: Int, _ v: Float) {
      let i = ((y % n + n) % n) * n + (x % n + n) % n
      alpha[i] = min(1, alpha[i] + v)
    }
    switch texture {
    case .sand:
      for i in 0..<(n * n) { alpha[i] = random() * 0.25 }
      for _ in 0..<(n * n / 18) {
        let x = Int(random() * Float(n)), y = Int(random() * Float(n)), v = 0.5 + random() * 0.5
        add(x, y, v)
        add(x + 1, y, v * 0.6)
        add(x, y + 1, v * 0.6)
        add(x + 1, y + 1, v * 0.4)
      }
    case .denim:
      for y in 0..<n {
        for x in 0..<n {
          let twill: Float = (x + y) % 4 < 2 ? 0.75 : 0.15
          alpha[y * n + x] = min(1, twill * (0.6 + random() * 0.4) + (y % 2 == 0 ? 0.08 : 0))
        }
      }
    case .tweed:
      for i in 0..<(n * n) { alpha[i] = random() * 0.15 }
      for _ in 0..<(n * n / 40) {
        let x = Int(random() * Float(n)), y = Int(random() * Float(n)), v = 0.4 + random() * 0.6
        let horizontal = random() < 0.5
        for k in 0..<(3 + Int(random() * 4)) {
          if horizontal { add(x + k, y, v) } else { add(x, y + k, v) }
        }
      }
    case .grain:
      for i in 0..<(n * n) {
        let u = random()
        alpha[i] = u * u
      }
    }
    let match = darkening[texture] ?? (0.211, 0)
    return alpha.map { UInt8(min(255, max(0, match.floor + match.gain * $0) * 255)) }
  }

  static func tile(_ texture: ThemeTexture) -> CGImage {
    let n = side
    let alpha = alpha(texture)
    var bytes = [UInt8](repeating: 0, count: n * n * 4)
    for i in 0..<(n * n) { bytes[i * 4 + 3] = alpha[i] }
    guard let provider = CGDataProvider(data: Data(bytes) as CFData),
      let image = CGImage(
        width: n, height: n, bitsPerComponent: 8, bitsPerPixel: 32, bytesPerRow: n * 4,
        space: CGColorSpace(name: CGColorSpace.sRGB)!,
        bitmapInfo: CGBitmapInfo(rawValue: CGImageAlphaInfo.premultipliedLast.rawValue),
        provider: provider, decode: nil, shouldInterpolate: false, intent: .defaultIntent
      )
    else { return GrainTexture.image }
    return image
  }
}
