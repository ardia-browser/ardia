import ArdiaDesign
import Foundation
import Metal
import Testing

struct GlassReadabilityTests {
  private static func lens(over backdrop: [UInt8], dark: Bool, since: TimeInterval = .infinity) throws -> [Double]? {
    guard let device = MTLCreateSystemDefaultDevice(), let queue = device.makeCommandQueue() else { return nil }
    let library = try device.makeLibrary(source: LiquidGlassShader.source, options: nil)
    let descriptor = MTLRenderPipelineDescriptor()
    descriptor.vertexFunction = library.makeFunction(name: LiquidGlassShader.vertexName)
    descriptor.fragmentFunction = library.makeFunction(name: LiquidGlassShader.fragmentName)
    descriptor.colorAttachments[0].pixelFormat = .bgra8Unorm
    let pipeline = try device.makeRenderPipelineState(descriptor: descriptor)
    var frame = LiquidGlassShader.Frame(width: 120, height: 48, scale: 1, radius: 24, live: true, lens: true, rim: false, dark: dark, fill: GlassFrostStyle.glass.fallback(dark: dark))
    frame.toneLimit = LiquidGlassRules.toneLimit(dark: dark, since: since)
    let target = device.makeTexture(descriptor: { let made = MTLTextureDescriptor.texture2DDescriptor(pixelFormat: .bgra8Unorm, width: 120, height: 48, mipmapped: false); made.usage = [.renderTarget, .shaderRead]; made.storageMode = .shared; return made }())!
    let source = device.makeTexture(descriptor: MTLTextureDescriptor.texture2DDescriptor(pixelFormat: .bgra8Unorm, width: 1, height: 1, mipmapped: false))!
    var pixel = backdrop
    source.replace(region: MTLRegionMake2D(0, 0, 1, 1), mipmapLevel: 0, withBytes: &pixel, bytesPerRow: 4)
    let buffer = queue.makeCommandBuffer()!
    let pass = MTLRenderPassDescriptor()
    pass.colorAttachments[0].texture = target
    pass.colorAttachments[0].loadAction = .clear
    pass.colorAttachments[0].storeAction = .store
    let encoder = buffer.makeRenderCommandEncoder(descriptor: pass)!
    encoder.setRenderPipelineState(pipeline)
    frame.uniforms.withUnsafeBytes { encoder.setFragmentBytes($0.baseAddress!, length: $0.count, index: 0) }
    encoder.setFragmentTexture(source, index: 0)
    encoder.drawPrimitives(type: .triangle, vertexStart: 0, vertexCount: 3)
    encoder.endEncoding()
    buffer.commit()
    buffer.waitUntilCompleted()
    var out = [UInt8](repeating: 0, count: 4)
    target.getBytes(&out, bytesPerRow: 4 * 120, from: MTLRegionMake2D(60, 24, 1, 1), mipmapLevel: 0)
    return [Double(out[2]) / 255, Double(out[1]) / 255, Double(out[0]) / 255, Double(out[3]) / 255]
  }

  private static func luminance(_ color: [Double]) -> Double {
    LiquidGlassRules.luminance(red: color[0], green: color[1], blue: color[2])
  }

  private static func reads(_ glass: [Double], dark: Bool) -> Double {
    let ink = dark ? LiquidGlassRules.lightInk : LiquidGlassRules.darkInk
    return LiquidGlassRules.contrast(LiquidGlassRules.text(ink, over: (glass[0], glass[1], glass[2])), luminance(glass))
  }

  private static func gray(_ value: Double) -> [Double] { [value, value, value] }

  @Test func `the inks are the page bar's own, read from the app's tokens`() throws {
    let tokens = try String(contentsOf: URL(fileURLWithPath: #filePath).deletingLastPathComponent().appendingPathComponent("../../../../../../apps/phone/src/components/ui/tokens.ts").standardizedFileURL, encoding: .utf8)
    let start = try #require(tokens.range(of: "export const chromeInk"))
    let line = String(tokens[start.lowerBound...].prefix(600))
    #expect(line.contains("foreground: \"rgba(14,15,16,0.9)\""), "dark ink on light glass")
    #expect(line.contains("foreground: \"rgba(255,255,255,0.8)\""), "light ink on dark glass")
    #expect(LiquidGlassRules.darkInk == GlassInk(hex: 0x0E0F10, alpha: 0.9))
    #expect(LiquidGlassRules.lightInk == GlassInk(red: 1, green: 1, blue: 1, alpha: 0.8))
  }

  @Test func `the bounds leave the inks at five to one, as they sit over the glass`() {
    #expect(LiquidGlassRules.readableCeiling > 0.08 && LiquidGlassRules.readableCeiling < 0.13)
    #expect(LiquidGlassRules.readableFloor > 0.2 && LiquidGlassRules.readableFloor < 0.32)
    let ceiling = pow(LiquidGlassRules.readableCeiling, 1 / 2.2)
    let floor = pow(LiquidGlassRules.readableFloor, 1 / 2.2)
    #expect(Self.reads(Self.gray(ceiling), dark: true) >= 4.9)
    #expect(Self.reads(Self.gray(floor), dark: false) >= 4.9)
  }

  @Test func `white ink keeps 4.5 to 1 on a lens that samples white, and dark ink on one that samples black`() throws {
    guard let overWhite = try Self.lens(over: [255, 255, 255, 255], dark: true), let overBlack = try Self.lens(over: [0, 0, 0, 255], dark: false) else { return }
    #expect(Self.luminance(overWhite) <= LiquidGlassRules.readableCeiling + 0.01)
    #expect(Self.reads(overWhite, dark: true) >= 4.5)
    #expect(Self.luminance(overBlack) >= LiquidGlassRules.readableFloor - 0.01)
    #expect(Self.reads(overBlack, dark: false) >= 4.5)
    guard let overRed = try Self.lens(over: [16, 0, 122, 255], dark: true) else { return }
    #expect(Self.reads(overRed, dark: true) >= 4.5, "a deep red route under white ink")
    guard let calm = try Self.lens(over: [40, 40, 40, 255], dark: true) else { return }
    #expect(Self.luminance(calm) < LiquidGlassRules.readableCeiling, "a lens that is already dark is left alone")
  }

  @Test func `clear glass keeps 4.5 to 1 over the worst page, whatever the profile tint`() {
    let tints = [GlassInk.clear, GlassInk(hex: 0xF4D7E0, alpha: 0.35), GlassInk(hex: 0xFFFFFF, alpha: 0.5), GlassInk(hex: 0x6B2D5C, alpha: 0.4)]
    for tint in tints {
      for dark in [true, false] {
        let veil = LiquidGlassRules.readableVeil(tint.over(GlassFrostStyle.glass.clear(dark: dark)), dark: dark)
        for backdrop in [0.0, 0.5, 1.0] {
          let seen = [veil.red, veil.green, veil.blue].map { $0 * veil.alpha + backdrop * (1 - veil.alpha) }
          #expect(Self.reads(seen, dark: dark) >= 4.5, "dark \(dark), tint \(tint), backdrop \(backdrop)")
        }
      }
    }
  }

  @Test func `every frame of the crossfade between lens and clear glass stays readable`() throws {
    guard let lens = try Self.lens(over: [255, 255, 255, 255], dark: true) else { return }
    let veil = LiquidGlassRules.readableVeil(GlassFrostStyle.glass.clear(dark: true), dark: true)
    let clear = [veil.red, veil.green, veil.blue].map { $0 * veil.alpha + 1 * (1 - veil.alpha) }
    for step in 0...10 {
      let shown = Double(step) / 10
      let mixed = (0..<3).map { lens[$0] * shown + clear[$0] * (1 - shown) }
      #expect(Self.reads(mixed, dark: true) >= 4.5, "at \(shown)")
    }
  }

  @Test func `every frame of a tone change keeps the new ink readable, over white and over black`() throws {
    for dark in [true, false] {
      for backdrop: [UInt8] in [[255, 255, 255, 255], [0, 0, 0, 255], [16, 0, 122, 255]] {
        for step in 0...6 {
          guard let shown = try Self.lens(over: backdrop, dark: dark, since: Double(step) * 0.03) else { return }
          #expect(Self.reads(shown, dark: dark) >= 4.5, "dark \(dark) backdrop \(backdrop) at \(Double(step) * 30) ms")
        }
      }
    }
  }
}

extension GlassInk {
  fileprivate func over(_ under: GlassInk) -> GlassInk {
    let alpha = self.alpha + under.alpha * (1 - self.alpha)
    guard alpha > 0 else { return .clear }
    func mix(_ top: Double, _ bottom: Double) -> Double { (top * self.alpha + bottom * under.alpha * (1 - self.alpha)) / alpha }
    return GlassInk(red: mix(red, under.red), green: mix(green, under.green), blue: mix(blue, under.blue), alpha: alpha)
  }
}
