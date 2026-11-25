import QuartzCore
import XCTest
@testable import ArdiaFieldGlowCore

private struct Motion: Decodable {
  struct Step: Decodable {
    let duration: Double
    let curve: String?
    let samples: [Double]?
  }
  let motion: [String: Step]
  let look: Look
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
}

final class FieldGlowTimingTests: XCTestCase {
  private var motion: [String: Motion.Step] = [:]
  private var look = FieldGlowLook()

  override func setUpWithError() throws {
    let url = URL(fileURLWithPath: #filePath).deletingLastPathComponent().appendingPathComponent("fieldGlowFixture.json")
    let decoded = try JSONDecoder().decode(Motion.self, from: Data(contentsOf: url))
    motion = decoded.motion
    let l = decoded.look
    look = FieldGlowLook(rgba: [74, 119, 212, 1], glow: l.glow, tailFade: l.tailFade, capFade: l.capFade, tail: l.tail, cap: l.cap,
                         frontShare: l.frontShare, tailCeiling: l.tailCeiling, line: l.line, floor: l.floor)
  }

  private func seconds(_ step: String) -> Double { (motion[step]?.duration ?? -1) / 1000 }

  private func nativeCurve(_ step: String) -> FieldGlowCurve {
    motion[step]?.curve == "exit" ? .exit : .enter
  }

  private func assertCurve(_ native: FieldGlowCurve, matches step: String, file: StaticString = #filePath, line: UInt = #line) {
    let samples = motion[step]?.samples ?? []
    XCTAssertEqual(samples.count, 101, file: file, line: line)
    for (i, js) in samples.enumerated() {
      XCTAssertEqual(native.eased(Double(i) / 100), js, accuracy: 1e-12, "\(step) at \(i)%", file: file, line: line)
    }
  }

  private func keyframes(_ layer: CALayer, _ key: String) -> CAKeyframeAnimation? { layer.animation(forKey: key) as? CAKeyframeAnimation }

  private func values(_ a: CAKeyframeAnimation?) -> [Double] { (a?.values as? [NSNumber] ?? []).map(\.doubleValue) }

  private func assertFollows(_ a: CAKeyframeAnimation?, from: Double, to: Double, duration: Double, curve: FieldGlowCurve, file: StaticString = #filePath, line: UInt = #line) {
    guard let a else { return XCTFail("no animation", file: file, line: line) }
    XCTAssertEqual(a.duration, duration, accuracy: 1e-9, file: file, line: line)
    XCTAssertEqual(a.calculationMode, .linear, file: file, line: line)
    XCTAssertNil(a.timingFunction, file: file, line: line)
    let v = values(a)
    XCTAssertGreaterThanOrEqual(v.count, Int(duration * 120), file: file, line: line)
    for (i, value) in v.enumerated() {
      let t = Double(i) / Double(v.count - 1)
      XCTAssertEqual(value, from + (to - from) * curve.eased(t), accuracy: 1e-9, file: file, line: line)
    }
  }

  private func layers() -> (FieldGlowLayers, FieldGlowHub, () -> Void) {
    var time: CFTimeInterval = 1000
    let layers = FieldGlowLayers()
    layers.now = { time }
    layers.look = look
    layers.resize(CGSize(width: 400, height: 30), flipped: true)
    let hub = FieldGlowHub()
    layers.finishingGeneration = { hub.model("t")?.phase == .finishing ? hub.model("t")?.generation : nil }
    hub.attach("t", layers)
    return (layers, hub, { time += 0 })
  }

  private var timings: FieldGlowTimings {
    FieldGlowTimings(milliseconds: ["show", "progress", "finish", "hold", "hide"].map { motion[$0]?.duration ?? -1 })
  }

  func testClipKeepsContinuousCornersWhenTheFieldRadiusChanges() {
    let (layers, _, _) = layers()
    layers.radius = 10
    XCTAssertTrue(layers.clip.masksToBounds)
    XCTAssertEqual(layers.clip.cornerCurve, .continuous)
    XCTAssertEqual(layers.clip.cornerRadius, 10)
  }

  func testEachNativeCurveIsTheJavaScriptEasingItReplaces() {
    for step in ["show", "progress", "finish", "hide"] { assertCurve(nativeCurve(step), matches: step) }
    XCTAssertEqual(nativeCurve("show"), .enter)
    XCTAssertEqual(nativeCurve("hide"), .exit)
  }

  func testTheFadeInRunsTheShowDurationOnTheShowCurveFromZeroToFull() {
    let (layers, hub, _) = layers()
    hub.show("t", timings: timings)
    assertFollows(keyframes(layers.slide, "opacity"), from: 0, to: 1, duration: seconds("show"), curve: nativeCurve("show"))
  }

  func testAProgressMoveRunsTheProgressDurationOnItsCurveToTheClampedFront() {
    let (layers, hub, _) = layers()
    hub.show("t", timings: timings)
    hub.progress("t", to: 0.5, still: false)
    let target = FieldGlowGeometry.filled(progress: 0.5, look: look, width: 400)
    assertFollows(keyframes(layers.slide, "filled"), from: -400, to: -400 * (1 - target), duration: seconds("progress"), curve: nativeCurve("progress"))
  }

  func testTheFinishSweepsFrontAndCometOverTheFinishDurationThenHoldsThenFadesOverTheHideDuration() {
    let (layers, hub, _) = layers()
    hub.show("t", timings: timings)
    hub.progress("t", to: 0.5, still: true)
    for layer in [layers.slide, layers.steady, layers.comet] { layer.removeAllAnimations() }
    layers.settle(at: hub.model("t")!)
    hub.finish("t", still: false)
    let start = Double(layers.slide.position.x)
    XCTAssertEqual(start, 0, accuracy: 1e-9)
    let from = -400 * (1 - FieldGlowGeometry.filled(progress: 0.5, look: look, width: 400))
    assertFollows(keyframes(layers.slide, "filled"), from: from, to: 0, duration: seconds("finish"), curve: nativeCurve("finish"))
    assertFollows(keyframes(layers.comet, "comet"), from: 0, to: 1, duration: seconds("finish"), curve: nativeCurve("finish"))
    assertFollows(keyframes(layers.steady, "comet"), from: 1, to: 0, duration: seconds("finish"), curve: nativeCurve("finish"))
    let fade = keyframes(layers.slide, "opacity")!
    let total = seconds("finish") + seconds("hold") + seconds("hide")
    XCTAssertEqual(fade.duration, total, accuracy: 1e-9)
    let v = values(fade)
    let t = (fade.keyTimes ?? []).map { $0.doubleValue * total }
    let fadeStart = seconds("finish") + seconds("hold")
    for (time, value) in zip(t, v) where time <= fadeStart + 1e-9 { XCTAssertEqual(value, 1, accuracy: 1e-9) }
    let fading = zip(t, v).filter { $0.0 >= fadeStart - 1e-9 }
    XCTAssertGreaterThanOrEqual(fading.count, Int(seconds("hide") * 120))
    for (time, value) in fading {
      let u = (time - fadeStart) / seconds("hide")
      XCTAssertEqual(value, 1 - nativeCurve("hide").eased(u), accuracy: 1e-9)
    }
  }

  func testWithReduceMotionTheFinishOnlyHoldsAndFades() {
    let (layers, hub, _) = layers()
    hub.show("t", timings: timings)
    for layer in [layers.slide, layers.steady, layers.comet] { layer.removeAllAnimations() }
    layers.settle(at: hub.model("t")!)
    hub.finish("t", still: true)
    XCTAssertNil(layers.slide.animation(forKey: "filled"))
    XCTAssertNil(layers.comet.animation(forKey: "comet"))
    let fade = keyframes(layers.slide, "opacity")!
    XCTAssertEqual(fade.duration, seconds("hold") + seconds("hide"), accuracy: 1e-9)
  }
}
