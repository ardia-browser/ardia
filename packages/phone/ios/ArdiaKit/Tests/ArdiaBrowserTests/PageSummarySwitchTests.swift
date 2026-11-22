import Foundation
import Testing
@testable import ArdiaBrowser

@MainActor
@Suite struct PageSummarySwitchTests {
  private func freshDefaults() -> UserDefaults {
    let name = "page-summary-switch-\(UUID().uuidString)"
    let defaults = UserDefaults(suiteName: name)!
    defaults.removePersistentDomain(forName: name)
    return defaults
  }

  @Test func aFreshOrOlderInstallStartsWithPinchToSummarizeOff() {
    let defaults = freshDefaults()
    defaults.set("something else", forKey: "browsing.nightShade")
    #expect(!PageSummarySwitch(defaults: defaults).isOn)
  }

  @Test func turningItOnIsRememberedAcrossLaunchesAndOffSticksToo() {
    let defaults = freshDefaults()
    PageSummarySwitch(defaults: defaults).turn(true)
    let relaunched = PageSummarySwitch(defaults: defaults)
    #expect(relaunched.isOn)
    relaunched.turn(false)
    #expect(!PageSummarySwitch(defaults: defaults).isOn)
  }

  @Test func workStartedBeforeAnOffAndOnAgainIsNoLongerCurrent() {
    let summaries = PageSummarySwitch(defaults: freshDefaults())
    summaries.turn(true)
    let asked = summaries.revision
    #expect(summaries.isCurrent(asked))
    summaries.turn(false)
    #expect(!summaries.isCurrent(asked))
    summaries.turn(true)
    #expect(!summaries.isCurrent(asked))
    #expect(summaries.isCurrent(summaries.revision))
  }
}
