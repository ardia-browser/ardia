import ArdiaDesign
import Foundation
import Testing

struct GlassToneTests {
  @Test func `the bar's tone follows what is under it after a short settle, with a band where it holds`() {
    var gate = GlassToneGate()
    var flips: [Bool] = []
    func see(_ luminance: Double, at now: TimeInterval) {
      if gate.observe(luminance: luminance, now: now), let dark = gate.dark { flips.append(dark) }
    }
    see(0.05, at: 0)
    #expect(flips == [true], "the first look decides at once")
    see(0.9, at: 1)
    see(0.9, at: 1.2)
    #expect(flips == [true], "light for 200 ms is not enough")
    see(0.9, at: 1.31)
    #expect(flips == [true, false])
    see(0.3, at: 2)
    see(0.3, at: 5)
    #expect(flips == [true, false], "between 0.2 and 0.4 it holds")
  }

  @Test func `content that flickers across an edge never flips the bar`() {
    var gate = GlassToneGate()
    var flips = 0
    for frame in 0..<240 {
      let luminance = frame % 6 < 3 ? 0.1 : 0.9
      if gate.observe(luminance: luminance, now: Double(frame) / 120) { flips += 1 }
    }
    #expect(flips == 1, "only the first look, at load")
  }

  @Test func `the luminance under the bar is the mean of the picture's rows it covers`() {
    let rows: [Float] = [1, 1, 0, 0, 0.5, 0.5, 1, 1]
    #expect(GlassToneRows.mean(rows, from: 0.25, to: 0.5) == 0)
    #expect(GlassToneRows.mean(rows, from: 0.5, to: 0.75) == 0.5)
    #expect(GlassToneRows.mean(rows, from: 0, to: 1) == 0.625)
    #expect(GlassToneRows.mean(rows, from: 0.9, to: 0.8) == nil)
    var pixels: [UInt8] = [255, 255, 255, 255, 255, 255, 255, 255, 0, 0, 0, 255, 0, 0, 0, 255]
    let made = pixels.withUnsafeMutableBytes { GlassToneRows.rows(UnsafeRawPointer($0.baseAddress!), width: 2, height: 2, bytesPerRow: 8) }
    #expect(abs(made[0] - 1) < 0.001 && made[1] == 0, "white row then black row, in memory order")
  }

  @Test func `a tone change starts at the readable edge nearest the old look and eases away in 180 ms`() {
    let light = LiquidGlassRules.toneLimit(dark: false, since: 0)
    #expect(abs(light.ceiling - (LiquidGlassRules.readableFloor + 0.02)) < 0.0001 && light.floor == 0)
    #expect(LiquidGlassRules.toneLimit(dark: false, since: 0.18) == (1, 0))
    let dark = LiquidGlassRules.toneLimit(dark: true, since: 0)
    #expect(dark.ceiling == 1 && abs(dark.floor - (LiquidGlassRules.readableCeiling - 0.005)) < 0.0001)
    #expect(LiquidGlassRules.toneLimit(dark: true, since: 1) == (1, 0))
    let middle = LiquidGlassRules.toneLimit(dark: false, since: 0.09)
    #expect(middle.ceiling > light.ceiling && middle.ceiling < 1)
  }

  @Test func `a bar tone that clears is sent as a reset, even when the page has no tone colours`() {
    #expect(GlassToneSend.needed(toneChanged: false, hasColors: false, barDark: nil, sentBarDark: true), "the old barDark must not stay in JS")
    #expect(!GlassToneSend.needed(toneChanged: false, hasColors: false, barDark: nil, sentBarDark: nil))
    #expect(GlassToneSend.needed(toneChanged: false, hasColors: false, barDark: false, sentBarDark: true))
    #expect(!GlassToneSend.needed(toneChanged: false, hasColors: true, barDark: true, sentBarDark: true))
    #expect(GlassToneSend.needed(toneChanged: true, hasColors: true, barDark: nil, sentBarDark: nil))
  }
}
