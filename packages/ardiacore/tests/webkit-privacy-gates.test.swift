import Foundation
import Testing

private final class View {}

@Test func aClearMakesEveryEarlierViewAndSavedStateStaleAndNewViewsCurrent() {
  let gate = WebKitHistoryGate()
  let before = View()
  gate.stamp(before, profile: "work")
  let discarded = gate.generation(of: before)
  #expect(gate.isCurrent(view: before, profile: "work"))
  gate.advance("work")
  #expect(!gate.isCurrent(view: before, profile: "work"), "a view that holds a pre-clear back list never saves it")
  #expect(!gate.isCurrent(discarded, profile: "work"), "a discarded page's pre-clear state never restores or saves")
  let after = View()
  gate.stamp(after, profile: "work")
  #expect(gate.isCurrent(view: after, profile: "work"))
  gate.stamp(before, profile: "work")
  #expect(!gate.isCurrent(view: before, profile: "work"), "adopting an old view doesn't make it current")
}

@Test func aClearInOneProfileLeavesAnotherAlone() {
  let gate = WebKitHistoryGate()
  let home = View()
  gate.stamp(home, profile: "home")
  gate.advance("work")
  #expect(gate.isCurrent(view: home, profile: "home"))
}

@Test func aDeletedProfileNeverKeepsHistoryAgain() {
  let gate = WebKitHistoryGate()
  gate.forget("temp")
  let view = View()
  gate.stamp(view, profile: "temp")
  #expect(!gate.keepsHistory("temp"))
  #expect(!gate.isCurrent(view: view, profile: "temp"))
  #expect(!gate.isCurrent(gate.generation("temp"), profile: "temp"))
}

@Test func anUnstampedViewOrNoGenerationIsNeverCurrent() {
  let gate = WebKitHistoryGate()
  #expect(!gate.isCurrent(view: View(), profile: "work"))
  #expect(!gate.isCurrent(view: nil, profile: "work"))
  #expect(!gate.isCurrent(nil, profile: "work"))
}

@Test func stampingAViewDoesntKeepItAlive() {
  let gate = WebKitHistoryGate()
  weak var gone: View?
  do {
    let view = View()
    gone = view
    gate.stamp(view, profile: "work")
  }
  #expect(gone == nil)
}

@Test func webKitIsToldAnOriginIsAllowedOnlyWhenEveryProfileUsingItAllows() {
  let origin = "https://news.example"
  #expect(WebKitNotificationPolicy.shared(["work": [origin: true], "home": [origin: false]], origin: origin, profiles: ["work", "home"]) == false)
  #expect(WebKitNotificationPolicy.shared(["work": [origin: true]], origin: origin, profiles: ["work", "home"]) == false, "a profile that never decided isn't handed another's grant")
  #expect(WebKitNotificationPolicy.shared(["work": [origin: true], "home": [origin: true]], origin: origin, profiles: ["work", "home"]) == true)
  #expect(WebKitNotificationPolicy.shared(["work": [origin: true]], origin: origin, profiles: ["work"]) == true)
  #expect(WebKitNotificationPolicy.shared(["work": ["https://other.example": true]], origin: origin, profiles: ["work"]) == nil)
}
