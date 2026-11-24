import CoreGraphics
import Foundation
import SwiftUI
import Testing

@testable import ArdiaDesign

struct ProfileThemeTests {
  static let three = ThemeLook(
    stops: [
      ThemeStop(color: ThemeColor(r: 0.85, g: 0.35, b: 0.45), x: 0.8, y: 0.3),
      ThemeStop(color: ThemeColor(r: 0.25, g: 0.45, b: 0.9), x: 0.2, y: 0.6),
      ThemeStop(color: ThemeColor(r: 0.95, g: 0.8, b: 0.3, a: 0.7), x: 0.5, y: 0.9),
    ],
    intensity: 0.7,
    grain: 0.6,
    texture: .sand,
    translucency: 0.4,
    angle: 30
  )

  static func pad(x: Double, y: Double) -> ThemeColor {
    let dx = x - 0.5, dy = y - 0.5
    var hue = atan2(dy, dx) / (2 * .pi)
    if hue < 0 { hue += 1 }
    let rgb = LookRGB(hue: hue, saturation: min(1, hypot(dx, dy) / 0.5), lightness: 0.6)
    return ThemeColor(r: rgb.red, g: rgb.green, b: rgb.blue)
  }

  static let two: ThemeLook = {
    let points = [(0.6867651002255772, 0.2652260718526649), (0.7999997836220454, 0.5003603147595244)]
    return ThemeLook(stops: points.map { ThemeStop(color: pad(x: $0.0, y: $0.1), x: $0.0, y: $0.1) })
  }()

  func close(_ a: Double, _ b: Double, _ tolerance: Double = 1e-9) -> Bool { abs(a - b) <= tolerance }

  func close(_ a: SIMD3<Double>, _ b: [Double], _ tolerance: Double = 1e-9) -> Bool {
    close(a.x, b[0], tolerance) && close(a.y, b[1], tolerance) && close(a.z, b[2], tolerance)
  }

  @Test func startingStopsMatchTheMac() {
    let first = Self.two.stops[0].color
    #expect(close(first.r, 0.84) && close(first.g, 0.36) && close(first.b, 0.7719790919613826) && first.a == 1)
    #expect(Self.two.angle == 135 && Self.two.intensity == 0.6 && Self.two.translucency == 1 && Self.two.grain == 0)
  }

  @Test func oklabMixingMatchesTheMac() {
    #expect(close(ThemeColor(r: 0.85, g: 0.35, b: 0.45).oklab, [0.6342669631577386, 0.15816010632539318, 0.02967621101834228]))
    let mixed = ThemeColor.mixOklab(Self.three.stops[0].color, Self.three.stops[1].color, 0.37)
    #expect(close(mixed, [0.6640033385200348, 0.4249352609571532, 0.628476087665928]))
  }

  @Test func areaMatchesTheMac() {
    let three: [(Double, Double, Double, Double, [Double])] = [
      (0, 0, 390, 844, [0.42984782627015944, 0.5399239073285269, 0.7458446992254132]),
      (195, 422, 390, 844, [0.6560055725379141, 0.5724541804524186, 0.5982575800995921]),
      (390, 844, 390, 844, [0.8287096591875482, 0.5799600600682695, 0.4490791206698485]),
      (100, 700, 390, 844, [0.7803316476860146, 0.4621141684249053, 0.5126164449642394]),
      (0.25, 0.75, 1, 1, [0.7250031641780748, 0.48779586212727066, 0.5615230531629298]),
    ]
    for (x, y, w, h, expected) in three {
      #expect(close(Self.three.area(x: x, y: y, width: w, height: h), expected), "\(x),\(y)")
    }
    let two: [(Double, Double, [Double])] = [
      (0, 0, [0.8400000028147513, 0.36000000184957637, 0.7719790322844164]),
      (300, 200, [0.8380683686041941, 0.37034812179843146, 0.5704921056415132]),
      (390, 844, [0.8400000045339554, 0.36055051231892243, 0.3599999247000699]),
    ]
    for (x, y, expected) in two {
      #expect(close(Self.two.area(x: x, y: y, width: 390, height: 844), expected, 1e-7), "\(x),\(y)")
    }
  }

  @Test func layerAlphasMatchTheMac() {
    #expect(close(Self.three.layerAlpha, 0.834))
    #expect(close(Self.three.underlayAlpha(dark: false), 0.2))
    #expect(close(Self.three.underlayAlpha(dark: true), 0.07))
    #expect(close(Self.three.grainAlpha, 0.09))
    var tweed = Self.two
    tweed.grain = 0.7
    tweed.texture = .tweed
    #expect(close(tweed.grainAlpha, 0.28))
    #expect(Self.three.underColor(dark: false) == "#EFEFEF")
    #expect(Self.three.underColor(dark: true) == "#262626")
    #expect(Self.two.underColor(dark: false) == "#F5F5F5")
    #expect(Self.two.underColor(dark: true) == "#222222")
  }

  @Test func sanitizingMatchesTheMac() throws {
    let json = """
      {"stops":[{"color":{"r":1.5,"g":0.2,"b":0.1},"x":2,"y":-1},{"color":{"r":"x","g":0,"b":0}},
      {"color":{"r":0.1,"g":0.2,"b":0.3,"a":3},"x":0.4},{"color":{"r":0.3,"g":0.3,"b":0.3},"x":0.1,"y":0.1},
      {"color":{"r":0.9,"g":0.9,"b":0.9},"x":0.9,"y":0.9}],
      "intensity":5,"grain":-1,"texture":"velvet","translucency":0.3,"angle":-90}
      """
    let look = try #require(ThemeLook(json: Data(json.utf8)))
    #expect(look.stops == [
      ThemeStop(color: ThemeColor(r: 1.5, g: 0.2, b: 0.1), x: 1, y: 0),
      ThemeStop(color: ThemeColor(r: 0.1, g: 0.2, b: 0.3), x: 0.4, y: 0.5),
      ThemeStop(color: ThemeColor(r: 0.3, g: 0.3, b: 0.3), x: 0.1, y: 0.1),
    ])
    #expect(look.intensity == 1 && look.grain == 0 && look.texture == .grain && look.translucency == 0.3)
    #expect(look.angle == 270)
    #expect(ThemeLook(json: Data(#"{"stops":[]}"#.utf8)) == nil)
    #expect(ThemeLook(sanitizing: nil) == nil)
    #expect(ThemeLook(sanitizing: NSNull()) == nil)
    #expect(ThemeLook(sanitizing: ["stops": "red"]) == nil)
  }

  @Test func aMissingAngleIsTheMacsDefault() throws {
    let look = try #require(ThemeLook(json: Data(#"{"stops":[{"color":{"r":0.2,"g":0.4,"b":0.6}}],"grain":true,"texture":"denim"}"#.utf8)))
    #expect(look.angle == 135 && look.intensity == 0.6 && look.translucency == 1 && look.grain == 0 && look.texture == .denim)
    #expect(look.stops == [ThemeStop(color: ThemeColor(r: 0.2, g: 0.4, b: 0.6), x: 0.5, y: 0.5)])
  }

  @Test func aPropDictionaryRoundTrips() throws {
    let props: [String: Any] = [
      "stops": [["color": ["r": 0.85, "g": 0.35, "b": 0.45, "a": 1.0], "x": 0.8, "y": 0.3]],
      "intensity": 0.7, "grain": 0.6, "texture": "tweed", "translucency": 0.4, "angle": 30,
    ]
    let look = try #require(ThemeLook(sanitizing: props))
    #expect(look.texture == .tweed && look.angle == 30 && look.stops.count == 1)
    #expect(ThemeLook(sanitizing: look.dictionary) == look)
    #expect(ThemeLook(sanitizing: Self.three.dictionary) == Self.three)
  }

  @Test func texturesMatchTheMacTiles() {
    let expected: [ThemeTexture: (sum: Int, samples: [UInt8])] = [
      .grain: (287_662, [42, 33, 31, 52]),
      .sand: (1_429_150, [86, 80, 79, 92]),
      .denim: (653_735, [63, 25, 61, 25]),
      .tweed: (1_227_414, [74, 73, 73, 75]),
    ]
    for (texture, want) in expected {
      let alpha = ThemeTextureTile.alpha(texture)
      #expect(alpha.reduce(0) { $0 + Int($1) } == want.sum, "\(texture)")
      #expect([alpha[0], alpha[1000], alpha[7777], alpha[16383]] == want.samples, "\(texture)")
    }
    for texture in ThemeTexture.allCases {
      let tile = ThemeTextureTile.image(texture)
      #expect(tile.width == ThemeTextureTile.side && tile.height == ThemeTextureTile.side)
      #expect(ThemeTextureTile.image(texture) === tile)
    }
  }

  @MainActor @Test func gradientDrawsTheArea() throws {
    let size = CGSize(width: 120, height: 260)
    let renderer = ImageRenderer(content: ThemeGradientView(look: Self.three).frame(width: size.width, height: size.height))
    renderer.scale = 1
    let image = try #require(renderer.cgImage)
    let context = try #require(CGContext(
      data: nil, width: Int(size.width), height: Int(size.height), bitsPerComponent: 8, bytesPerRow: Int(size.width) * 4,
      space: CGColorSpace(name: CGColorSpace.sRGB)!, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
    ))
    context.draw(image, in: CGRect(origin: .zero, size: size))
    let pixels = try #require(context.data).assumingMemoryBound(to: UInt8.self)
    for (x, y) in [(5, 5), (60, 130), (114, 254), (20, 220), (100, 40)] {
      let want = Self.three.area(x: Double(x) + 0.5, y: Double(y) + 0.5, width: size.width, height: size.height)
      let i = (y * Int(size.width) + x) * 4
      let got = [pixels[i], pixels[i + 1], pixels[i + 2]].map { Double($0) / 255 }
      for (channel, value) in got.enumerated() {
        #expect(abs(value - min(1, max(0, want[channel]))) < 5.0 / 255, "\(x),\(y) channel \(channel)")
      }
    }
  }

  @MainActor @Test func theBackdropDrawsTheUnderColourGradientAndTexture() throws {
    let size = CGSize(width: 64, height: 64)
    var flat = ThemeLook(stops: [ThemeStop(color: ThemeColor(r: 1, g: 0, b: 0), x: 0.5, y: 0.5)], intensity: 0, grain: 0, translucency: 1)
    func pixel(_ look: ThemeLook, dark: Bool) throws -> [Double] {
      let renderer = ImageRenderer(content: ThemeBackdrop(look: look, dark: dark).frame(width: size.width, height: size.height))
      renderer.scale = 1
      let image = try #require(renderer.cgImage)
      let context = try #require(CGContext(
        data: nil, width: 1, height: 1, bitsPerComponent: 8, bytesPerRow: 4,
        space: CGColorSpace(name: CGColorSpace.sRGB)!, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
      ))
      context.draw(image, in: CGRect(x: -32, y: -32, width: size.width, height: size.height))
      let pixels = try #require(context.data).assumingMemoryBound(to: UInt8.self)
      return [pixels[0], pixels[1], pixels[2]].map { Double($0) / 255 }
    }
    for dark in [false, true] {
      let alpha = flat.layerAlpha
      let under = flat.underGrey(dark: dark)
      let got = try pixel(flat, dark: dark)
      let want = [alpha + (1 - alpha) * under, (1 - alpha) * under, (1 - alpha) * under]
      for channel in 0..<3 {
        #expect(abs(got[channel] - want[channel]) < 4.0 / 255, "dark \(dark) channel \(channel)")
      }
    }
    let plain = try pixel(flat, dark: false)
    flat.grain = 1
    flat.texture = .sand
    let textured = try pixel(flat, dark: false)
    #expect(textured[0] < plain[0])
  }
}
