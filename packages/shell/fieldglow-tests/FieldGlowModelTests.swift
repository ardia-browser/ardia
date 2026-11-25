import XCTest
@testable import ArdiaFieldGlowCore

final class FieldGlowModelTests: XCTestCase {
  private func target(_ model: FieldGlowModel, _ property: FieldGlowProperty) -> Double { model.targets[property] ?? -1 }

  func testALoadGoesIdleToLoadingToFinishingToIdle() {
    var model = FieldGlowModel()
    XCTAssertEqual(model.phase, .idle)
    XCTAssertFalse(model.animates)
    let shown = model.show()
    XCTAssertEqual(model.phase, .loading)
    XCTAssertEqual(shown, [.set(.filled, 0), .set(.comet, 0), FieldGlowMove(property: .opacity, to: 1, duration: 0.2, delay: 0, curve: .enter)])
    XCTAssertEqual(model.progress(to: 0.4, still: false), [FieldGlowMove(property: .filled, to: 0.4, duration: 0.25, delay: 0, curve: .enter, clamped: true)])
    XCTAssertEqual(model.progress, 0.4)
    let finishing = model.finish(still: false)
    XCTAssertEqual(model.phase, .finishing)
    XCTAssertEqual(finishing.map(\.property), [.filled, .comet, .opacity])
    XCTAssertEqual(finishing.last?.delay ?? 0, 0.5, accuracy: 1e-9)
    XCTAssertEqual(model.finishLasts, 0.75, accuracy: 1e-9)
    XCTAssertTrue(model.finished(generation: model.generation))
    XCTAssertEqual(model.phase, .idle)
    XCTAssertFalse(model.animates)
    XCTAssertEqual(target(model, .opacity), 0)
  }

  func testProgressIsIgnoredUnlessLoading() {
    var model = FieldGlowModel()
    XCTAssertEqual(model.progress(to: 0.5, still: false), [])
    _ = model.show()
    _ = model.finish(still: false)
    XCTAssertEqual(model.progress(to: 0.5, still: false), [])
    XCTAssertEqual(target(model, .filled), 1)
  }

  func testAFinishWithoutALoadDoesNothing() {
    var model = FieldGlowModel()
    XCTAssertEqual(model.finish(still: false), [])
    XCTAssertEqual(model.phase, .idle)
  }

  func testACancelledLoadFinishesLikeACompletedOne() {
    var model = FieldGlowModel()
    _ = model.show()
    let cancelled = model.finish(still: false)
    XCTAssertEqual(cancelled.map(\.to), [1, 1, 0])
    XCTAssertEqual(model.phase, .finishing)
  }

  func testAReloadDuringTheFinishStartsOverAndTheOldFinishCannotEndIt() {
    var model = FieldGlowModel()
    _ = model.show()
    _ = model.finish(still: false)
    let oldFinish = model.generation
    let again = model.show()
    XCTAssertEqual(model.phase, .loading)
    XCTAssertEqual(again.first, .set(.filled, 0))
    XCTAssertFalse(model.finished(generation: oldFinish))
    XCTAssertEqual(model.phase, .loading)
  }

  func testResetLeavesNothingRunning() {
    var model = FieldGlowModel()
    _ = model.show()
    _ = model.progress(to: 0.3, still: false)
    let reset = model.reset()
    XCTAssertEqual(reset, [.set(.opacity, 0)])
    XCTAssertEqual(model.phase, .idle)
    XCTAssertFalse(model.animates)
    XCTAssertFalse(model.finished(generation: model.generation))
  }

  func testReduceMotionSetsValuesAndOnlyFadesOut() {
    var model = FieldGlowModel()
    _ = model.show()
    XCTAssertEqual(model.progress(to: 0.6, still: true), [FieldGlowMove(property: .filled, to: 0.6, duration: 0, delay: 0, curve: .enter, clamped: true)])
    let finish = model.finish(still: true)
    XCTAssertEqual(finish.prefix(2), [.set(.filled, 1), .set(.comet, 1)])
    XCTAssertEqual(finish.last?.delay ?? 0, 0.2, accuracy: 1e-9)
  }

  func testTimingsComeFromTheTokensInMilliseconds() {
    let timings = FieldGlowTimings(milliseconds: [200, 250, 300, 200, 250])
    XCTAssertEqual(timings, .standard)
  }

  func testSamplesFollowTheSameCurvesAsTheJavaScriptEasing() {
    let enter = fieldGlowSamples(from: 0, to: 1, duration: 0.25, curve: .enter)
    XCTAssertEqual(enter.first, 0)
    XCTAssertEqual(enter.last ?? 0, 1, accuracy: 1e-12)
    XCTAssertEqual(enter.count, 31)
    XCTAssertEqual(enter[15], 1 - pow(0.5, 3), accuracy: 1e-12)
    let exit = fieldGlowSamples(from: 1, to: 0, duration: 0.25, curve: .exit)
    XCTAssertEqual(exit[15], 1 - 0.25, accuracy: 1e-12)
    let retarget = fieldGlowSamples(from: 0.3, to: 0.7, duration: 0.25, curve: .enter)
    XCTAssertEqual(retarget.first, 0.3)
  }
}
