import QuartzCore
import XCTest
@testable import ArdiaFieldGlowCore

private struct Fixture: Decodable {
  struct Look: Decodable {
    let glow: [[Double]]
    let tailFade: [Double]
    let capFade: [Double]
    let tail: Double
    let cap: Double
    let frontShare: Double
    let tailCeiling: Double
    let line: Double
    let floor: Double
  }
  struct Plate: Decodable {
    let colors: [String]
    let stops: [Double]
    let fade: [Double]
    let fadeStops: [Double]
    let extra: Double
  }
  struct Case: Decodable {
    let color: String
    let rgba: [Double]
    let width: Double
    let height: Double
    let tail: Plate
    let cap: Plate
    let comet: Plate
    let clamps: [[Double]]
  }
  let look: Look
  let cases: [Case]
}

private func fixture() throws -> Fixture {
  let url = URL(fileURLWithPath: #filePath).deletingLastPathComponent().appendingPathComponent("fieldGlowFixture.json")
  return try JSONDecoder().decode(Fixture.self, from: Data(contentsOf: url))
}

private func look(_ f: Fixture, rgba: [Double]) -> FieldGlowLook {
  FieldGlowLook(rgba: rgba, glow: f.look.glow, tailFade: f.look.tailFade, capFade: f.look.capFade, tail: f.look.tail, cap: f.look.cap,
                frontShare: f.look.frontShare, tailCeiling: f.look.tailCeiling, line: f.look.line, floor: f.look.floor)
}

private func hex(_ c: FieldGlowColor) -> String {
  String(format: "#%02X%02X%02X%02X", Int((c.red * 255).rounded()), Int((c.green * 255).rounded()), Int((c.blue * 255).rounded()), Int((c.alpha * 255).rounded()))
}

final class FieldGlowGeometryTests: XCTestCase {
  func testTheNativePlatesAreTheSameStopsAndColoursTheJavaScriptGradientFillDraws() throws {
    let f = try fixture()
    XCTAssertFalse(f.cases.isEmpty)
    for c in f.cases {
      let plates = FieldGlowGeometry.plates(look(f, rgba: c.rgba), width: c.width, height: c.height)
      for (native, js) in [(plates.tail, c.tail), (plates.cap, c.cap), (plates.comet, c.comet)] {
        XCTAssertEqual(native.colors.map(hex), js.colors.map { $0.count == 7 ? $0 + "FF" : $0 }, "\(c.color) at \(c.width)")
        XCTAssertEqual(native.stops.count, js.stops.count)
        for (a, b) in zip(native.stops, js.stops) { XCTAssertEqual(a, b, accuracy: 1e-9) }
        for (a, b) in zip(native.fade, js.fade) { XCTAssertEqual(a, b, accuracy: 1e-9) }
        for (a, b) in zip(native.fadeStops, js.fadeStops) { XCTAssertEqual(a, b, accuracy: 1e-9) }
        XCTAssertEqual(native.extra, js.extra, accuracy: 1e-9)
      }
      for pair in c.clamps {
        XCTAssertEqual(FieldGlowGeometry.filled(progress: pair[0], look: look(f, rgba: c.rgba), width: c.width), pair[1], accuracy: 1e-9)
      }
    }
  }
}

final class FieldGlowLayersTests: XCTestCase {
  private func layers() throws -> FieldGlowLayers {
    let f = try fixture()
    let layers = FieldGlowLayers()
    layers.look = look(f, rgba: [74, 119, 212, 1])
    layers.resize(CGSize(width: 400, height: 30), flipped: true)
    return layers
  }

  func testRimUsesTheFieldRadiusAndStaysFixedDuringProgress() throws {
    let layers = try layers()
    layers.radius = 10
    let rim = layers.capPlate.rim
    XCTAssertEqual(rim.bounds.height, 10)
    XCTAssertEqual(rim.position.y, 20)
    XCTAssertEqual(rim.sublayers?.first?.cornerRadius, 10)
    XCTAssertEqual(rim.sublayers?.first?.borderWidth, CGFloat(layers.look.line))
    let taper = try XCTUnwrap(rim.mask as? CAGradientLayer)
    XCTAssertEqual(taper.startPoint.y, 0)
    XCTAssertEqual(taper.endPoint.y, 0.85, accuracy: 0.0001)
    XCTAssertEqual((taper.colors as? [CGColor])?.map(\.alpha), [0, 1])
    var model = FieldGlowModel()
    layers.run(model.show(), model: model)
    layers.run(model.progress(to: 0.4, still: false), model: model)
    XCTAssertEqual(rim.position.x + layers.slide.position.x, 0)
    let samples = (rim.animation(forKey: "filled") as? CAKeyframeAnimation)?.values as? [Double]
    let slide = (layers.slide.animation(forKey: "filled") as? CAKeyframeAnimation)?.values as? [Double]
    XCTAssertNotNil(samples)
    XCTAssertEqual(samples, slide?.map { -$0 })
    layers.resize(CGSize(width: 18, height: 20), flipped: false)
    XCTAssertEqual(rim.bounds.height, 9)
    XCTAssertEqual(rim.position.y, 0)
    XCTAssertEqual(taper.startPoint.y, 1)
    XCTAssertEqual(taper.endPoint.y, 1.5 / 9, accuracy: 0.0001)
    layers.cancel()
    XCTAssertNil(rim.animation(forKey: "filled"))
  }

  func testPulseChangesOnlyBrightnessAndEndsWithTheLoad() throws {
    let layers = try layers()
    let hub = FieldGlowHub()
    final class Target: FieldGlowTarget {
      let layers: FieldGlowLayers
      init(_ layers: FieldGlowLayers) { self.layers = layers }
      func run(_ moves: [FieldGlowMove], model: FieldGlowModel) { layers.run(moves, model: model) }
      func settle(at model: FieldGlowModel) { layers.settle(at: model) }
    }
    let target = Target(layers)
    hub.attach("field", target)
    hub.show("field", timings: .standard)
    hub.progress("field", to: 0.4, still: false)
    let position = layers.slide.position
    hub.pulse("field", FieldGlowPulse(period: 1.8, low: 0.87))
    let animation = try XCTUnwrap(layers.clip.animation(forKey: "pulse") as? CABasicAnimation)
    XCTAssertEqual(animation.keyPath, "opacity")
    XCTAssertEqual(animation.toValue as? Double, 0.87)
    XCTAssertEqual(animation.duration, 0.9)
    XCTAssertTrue(animation.autoreverses)
    XCTAssertTrue(animation.repeatCount.isInfinite)
    XCTAssertEqual(layers.slide.position, position)
    XCTAssertNotNil(layers.slide.animation(forKey: "filled"))
    hub.pulse("field", FieldGlowPulse(period: 2.4, low: 0.7))
    let updated = try XCTUnwrap(layers.clip.animation(forKey: "pulse") as? CABasicAnimation)
    XCTAssertEqual(updated.duration, 1.2)
    XCTAssertEqual(updated.toValue as? Double, 0.7)
    XCTAssertEqual(layers.slide.position, position)
    hub.finish("field", still: false)
    XCTAssertNil(layers.clip.animation(forKey: "pulse"))
    hub.pulse("field", FieldGlowPulse(period: 1.8, low: 0.87))
    XCTAssertNil(layers.clip.animation(forKey: "pulse"))
  }

  func testAResizeWhileIdleRepaintsWithoutAttachingAnAnimation() throws {
    let layers = try layers()
    layers.settle(at: FieldGlowModel())
    layers.resize(CGSize(width: 260, height: 30), flipped: true)
    XCTAssertEqual(layers.running, [])
    XCTAssertTrue(layers.slide.isHidden)
    XCTAssertEqual(layers.slide.bounds.width, 260 + FieldGlowGeometry.fronts(layers.look, width: 260).tail, accuracy: 1e-9)
  }

  func testAResizeWhileLoadingMovesTheFrontToTheNewClampAndKeepsTheSameAnimationsRunning() throws {
    let layers = try layers()
    let hub = FieldGlowHub()
    hub.attach("a", layers)
    hub.show("a", timings: .standard)
    hub.progress("a", to: 0.95, still: false)
    let running = layers.running.sorted()
    layers.resize(CGSize(width: 200, height: 30), flipped: true)
    XCTAssertEqual(layers.running.sorted(), running)
    let filled = FieldGlowGeometry.filled(progress: 0.95, look: layers.look, width: 200)
    XCTAssertEqual(Double(layers.slide.position.x), -200 * (1 - filled), accuracy: 1e-9)
    XCTAssertEqual(layers.slide.bounds.width, 200 + FieldGlowGeometry.fronts(layers.look, width: 200).tail, accuracy: 1e-9)
  }

  func testWithoutAWindowNothingAnimatesAndTheValuesLandAtOnce() throws {
    let layers = try layers()
    layers.animates = { false }
    let hub = FieldGlowHub()
    layers.onFinished = { hub.finished("b", generation: $0) }
    hub.attach("b", layers)
    hub.show("b", timings: .standard)
    hub.progress("b", to: 0.5, still: false)
    XCTAssertEqual(layers.running, [])
    XCTAssertEqual(layers.slide.opacity, 1)
    hub.finish("b", still: false)
    XCTAssertEqual(hub.model("b")?.phase, .idle)
    XCTAssertTrue(layers.slide.isHidden)
    XCTAssertEqual(layers.running, [])
  }

  func testAFinishAttachesItsCompletionToTheFadeOutAndAResetClearsEverything() throws {
    let layers = try layers()
    let hub = FieldGlowHub()
    layers.finishingGeneration = { hub.model("c")?.phase == .finishing ? hub.model("c")?.generation : nil }
    hub.attach("c", layers)
    hub.show("c", timings: .standard)
    hub.finish("c", still: false)
    let fade = layers.slide.animation(forKey: "opacity")
    XCTAssertNotNil(fade?.delegate)
    XCTAssertEqual(fade?.value(forKey: "glowGeneration") as? Int, hub.model("c")?.generation)
    XCTAssertEqual(fade?.duration ?? 0, 0.75, accuracy: 1e-9)
    hub.reset("c")
    XCTAssertEqual(layers.running, [])
    XCTAssertTrue(layers.slide.isHidden)
  }
}

final class FieldGlowReviewFixTests: XCTestCase {
  private func layers(clock: @escaping () -> CFTimeInterval) throws -> FieldGlowLayers {
    let f = try fixture()
    let layers = FieldGlowLayers()
    layers.now = clock
    layers.look = look(f, rgba: [74, 119, 212, 1])
    layers.resize(CGSize(width: 400, height: 30), flipped: true)
    return layers
  }

  private func values(_ layer: CALayer, _ key: String) -> [Double] {
    ((layer.animation(forKey: key) as? CAKeyframeAnimation)?.values as? [NSNumber] ?? []).map(\.doubleValue)
  }

  func testAResizeMidProgressRemapsTheRunningAnimationToTheNewWidthWithoutAJump() throws {
    var time: CFTimeInterval = 100
    let layers = try layers { time }
    let hub = FieldGlowHub()
    hub.attach("r", layers)
    hub.show("r", timings: .standard)
    hub.progress("r", to: 0.5, still: false)
    let before = values(layers.slide, "filled")
    time += 0.1
    let t = 0.1 / 0.25
    let onScreen = 0.0
    let target400 = FieldGlowGeometry.filled(progress: 0.5, look: layers.look, width: 400)
    let shownFilled = onScreen + (target400 - onScreen) * FieldGlowCurve.enter.eased(t)
    layers.resize(CGSize(width: 200, height: 30), flipped: true)
    let after = values(layers.slide, "filled")
    XCTAssertFalse(before.isEmpty)
    XCTAssertEqual(after.first ?? 0, -200 * (1 - shownFilled), accuracy: 1e-6)
    let target200 = FieldGlowGeometry.filled(progress: 0.5, look: layers.look, width: 200)
    XCTAssertEqual(after.last ?? 0, -200 * (1 - target200), accuracy: 1e-6)
    XCTAssertEqual((layers.slide.animation(forKey: "filled") as? CAKeyframeAnimation)?.duration ?? 0, 0.15, accuracy: 1e-6)
    XCTAssertEqual(Double(layers.slide.position.x), -200 * (1 - target200), accuracy: 1e-6)
  }

  func testAFinishDuringTheFadeInKeepsFadingInHoldsAtFullAndOnlyThenFadesOut() throws {
    var time: CFTimeInterval = 50
    let layers = try layers { time }
    let hub = FieldGlowHub()
    layers.finishingGeneration = { hub.model("f")?.phase == .finishing ? hub.model("f")?.generation : nil }
    hub.attach("f", layers)
    hub.show("f", timings: .standard)
    time += 0.02
    hub.finish("f", still: false)
    let animation = layers.slide.animation(forKey: "opacity") as! CAKeyframeAnimation
    let opacity = (animation.values as! [NSNumber]).map(\.doubleValue)
    let times = (animation.keyTimes ?? []).map(\.doubleValue)
    XCTAssertEqual(opacity.first ?? 0, FieldGlowCurve.enter.eased(0.1), accuracy: 1e-6)
    XCTAssertEqual(animation.duration, 0.75, accuracy: 1e-9)
    let holdIndex = times.firstIndex { abs($0 - 0.5 / 0.75) < 1e-9 }!
    XCTAssertEqual(opacity[holdIndex], 1, accuracy: 1e-9)
    XCTAssertTrue(zip(opacity, opacity.dropFirst()).prefix(holdIndex).allSatisfy { $0.0 <= $0.1 + 1e-12 })
    XCTAssertEqual(opacity.last ?? 1, 0, accuracy: 1e-9)
    XCTAssertNotNil(animation.delegate)
  }

  func testAReloadStartsTheFrontFromTheLeftNotFromThePreviousSweep() throws {
    var time: CFTimeInterval = 10
    let layers = try layers { time }
    let hub = FieldGlowHub()
    hub.attach("p", layers)
    hub.show("p", timings: .standard)
    hub.progress("p", to: 0.9, still: false)
    hub.finish("p", still: false)
    time += 0.1
    hub.show("p", timings: .standard)
    hub.progress("p", to: 0.3, still: false)
    let floorAt400: Double = -400
    XCTAssertEqual(values(layers.slide, "filled").first ?? 0, floorAt400, accuracy: 1e-6)
  }

  func testDetachingAViewDropsItsModelAndAGoneViewStillLetsGo() throws {
    let hub = FieldGlowHub()
    var view: FieldGlowLayers? = try layers { 0 }
    hub.attach("d", view!)
    hub.show("d", timings: .standard)
    hub.detach("d", view!)
    XCTAssertNil(hub.model("d"))
    hub.attach("e", view!)
    hub.show("e", timings: .standard)
    let gone = view!
    view = nil
    hub.detach("e", gone)
    XCTAssertNil(hub.model("e"))
    gone.cancel()
    XCTAssertEqual(gone.running, [])
  }
}
