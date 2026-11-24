import Foundation
import Testing
@testable import PhonePageVisuals

private final class Clock: @unchecked Sendable {
  var now: CFTimeInterval = 1
}

private final class Heard: @unchecked Sendable {
  var reports: [String] = []
}

@Suite struct PageVisualsTests {
  private let clock = Clock()

  private func visuals(_ heard: Heard? = nil) -> PageVisuals {
    let clock = clock
    return PageVisuals(clock: { clock.now }, onNoLongerCurrent: heard.map { heard in { pageID, change, milliseconds in heard.reports.append("\(pageID) \(change.rawValue) \(milliseconds)") } })
  }

  @Test func noPictureTakenThisLaunchIsUnknown() {
    let visuals = visuals()
    #expect(visuals.isCurrent("a") == nil)
    visuals.changed("a", .state)
    #expect(visuals.isCurrent("a") == nil)
  }

  @Test func aPictureStaysCurrentUntilThePageChanges() {
    let visuals = visuals()
    visuals.changed("a", .state)
    visuals.captured("a", generation: visuals.generation("a"))
    #expect(visuals.isCurrent("a") == true)
    visuals.changed("b", .scrolled)
    #expect(visuals.isCurrent("a") == true)
    visuals.changed("a", .scrolled)
    #expect(visuals.isCurrent("a") == false)
    visuals.captured("a", generation: visuals.generation("a"))
    #expect(visuals.isCurrent("a") == true)
  }

  @Test func aChangeDuringTheCaptureLeavesItStale() {
    let visuals = visuals()
    let before = visuals.generation("a")
    visuals.changed("a", .laidOut)
    visuals.captured("a", generation: before)
    #expect(visuals.isCurrent("a") == false)
  }

  @Test func theFirstChangeAfterACaptureIsReportedOnceWithItsDelay() {
    let heard = Heard()
    let visuals = visuals(heard)
    visuals.changed("a", .state)
    #expect(heard.reports.isEmpty)
    visuals.captured("a", generation: visuals.generation("a"))
    clock.now += 0.42
    visuals.changed("a", .resized)
    visuals.changed("a", .state)
    #expect(heard.reports == ["a resized 420"])
  }

  @Test func forgettingThePagesPicturesMakesItUnknown() {
    let visuals = visuals()
    visuals.captured("a", generation: visuals.generation("a"))
    visuals.forget("a")
    #expect(visuals.isCurrent("a") == nil)
  }

  @Test func readsFromAnotherThreadSeeTheLatestChange() async {
    let visuals = visuals()
    visuals.captured("a", generation: visuals.generation("a"))
    await withTaskGroup(of: Void.self) { group in
      for _ in 0..<8 { group.addTask { for _ in 0..<500 { visuals.changed("a", .scrolled) } } }
      for _ in 0..<8 { group.addTask { for _ in 0..<500 { _ = visuals.isCurrent("a") } } }
    }
    #expect(visuals.generation("a") == 4000)
    #expect(visuals.isCurrent("a") == false)
  }
}
