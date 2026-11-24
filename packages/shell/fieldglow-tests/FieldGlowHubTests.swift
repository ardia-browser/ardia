import XCTest
@testable import ArdiaFieldGlowCore

private final class Recorder: FieldGlowTarget {
  var runs: [[FieldGlowMove]] = []
  var settled: [FieldGlowPhase] = []
  func run(_ moves: [FieldGlowMove], model: FieldGlowModel) { runs.append(moves) }
  func settle(at model: FieldGlowModel) { settled.append(model.phase) }
}

final class FieldGlowHubTests: XCTestCase {
  func testCallsBeforeTheViewMountsAreKeptAndTheViewSettlesIntoTheLoad() {
    let hub = FieldGlowHub()
    hub.show("a", timings: .standard)
    hub.progress("a", to: 0.4, still: false)
    let view = Recorder()
    hub.attach("a", view)
    XCTAssertEqual(view.settled, [.loading])
    XCTAssertEqual(view.runs.count, 0)
    XCTAssertEqual(hub.model("a")?.targets[.filled], 0.4)
    hub.progress("a", to: 0.6, still: false)
    XCTAssertEqual(view.runs.count, 1)
  }

  func testAViewMountedWithNothingLoadingSettlesIdle() {
    let hub = FieldGlowHub()
    let view = Recorder()
    hub.attach("b", view)
    XCTAssertEqual(view.settled, [.idle])
  }

  func testCallsAfterUnmountAreDroppedAndNothingIsKept() {
    let hub = FieldGlowHub()
    var view: Recorder? = Recorder()
    hub.attach("c", view!)
    hub.show("c", timings: .standard)
    hub.reset("c")
    XCTAssertEqual(hub.liveIds, [])
    hub.progress("c", to: 0.5, still: false)
    hub.finish("c", still: false)
    hub.finished("c", generation: 99)
    XCTAssertEqual(hub.liveIds, [])
    XCTAssertEqual(view?.runs.count, 2)
    view = nil
    hub.show("c", timings: .standard)
    XCTAssertEqual(hub.model("c")?.phase, .loading)
    hub.reset("c")
  }

  func testAViewThatWentAwayIsNotCalledAndADetachLeavesTheNewViewAlone() {
    let hub = FieldGlowHub()
    let first = Recorder()
    let second = Recorder()
    hub.attach("d", first)
    hub.attach("d", second)
    hub.detach("d", first)
    hub.show("d", timings: .standard)
    XCTAssertEqual(first.runs.count, 0)
    XCTAssertEqual(second.runs.count, 1)
  }

  func testAStaleFinishCompletionDoesNotEndANewLoad() {
    let hub = FieldGlowHub()
    hub.show("e", timings: .standard)
    hub.finish("e", still: false)
    let stale = hub.model("e")!.generation
    hub.show("e", timings: .standard)
    hub.finished("e", generation: stale)
    XCTAssertEqual(hub.model("e")?.phase, .loading)
    hub.finish("e", still: false)
    hub.finished("e", generation: hub.model("e")!.generation)
    XCTAssertEqual(hub.model("e")?.phase, .idle)
  }
}
