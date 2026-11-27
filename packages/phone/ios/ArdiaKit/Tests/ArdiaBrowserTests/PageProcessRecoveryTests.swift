import Testing
@testable import ArdiaBrowser

@Suite struct PageProcessRecoveryTests {
  @Test func aShownPageReloadsAtOnceAndCountsItsRecovery() {
    var recovery = PageProcessRecovery()
    #expect(recovery.processEnded(shown: true) == .reload)
    #expect(recovery.loadFinished() == .recovered)
    #expect(recovery.loadFinished() == nil)
  }

  @Test func aHiddenPageWaitsUntilItIsShownAgain() {
    var recovery = PageProcessRecovery()
    #expect(recovery.processEnded(shown: false) == .wait)
    #expect(recovery.awaitsReload)
    #expect(recovery.loadFinished() == nil)
    #expect(recovery.pageShown() == .reload)
    #expect(!recovery.awaitsReload)
    #expect(recovery.pageShown() == .wait)
    #expect(recovery.loadFinished() == .recovered)
  }

  @Test func aSecondDeathWhileReloadingShowsTheFailure() {
    var recovery = PageProcessRecovery()
    #expect(recovery.processEnded(shown: true) == .reload)
    #expect(recovery.processEnded(shown: true) == .showFailure)
    #expect(!recovery.awaitsReload && !recovery.isReloading)
    #expect(recovery.processEnded(shown: true) == .reload)
  }

  @Test func aReloadEndedInTheBackgroundWaitsInsteadOfFailing() {
    var recovery = PageProcessRecovery()
    #expect(recovery.processEnded(shown: true) == .reload)
    #expect(recovery.processEnded(shown: false) == .wait)
    #expect(!recovery.isReloading && recovery.awaitsReload)
    #expect(recovery.pageShown() == .reload)
    #expect(recovery.loadFinished() == .recovered)
  }

  @Test func aDeathWhileHiddenNeverShowsTheFailurePage() {
    var recovery = PageProcessRecovery()
    #expect(recovery.processEnded(shown: false) == .wait)
    #expect(recovery.processEnded(shown: false) == .wait)
    #expect(recovery.pageShown() == .reload)
  }

  @Test func aReloadByThePersonCountsAsTheRecovery() {
    var recovery = PageProcessRecovery()
    #expect(recovery.processEnded(shown: false) == .wait)
    recovery.navigationAsked()
    #expect(recovery.isReloading && !recovery.awaitsReload)
    #expect(recovery.loadFinished() == .recovered)
  }

  @Test func aFailedLoadEndsTheRecoveryWithoutCountingIt() {
    var recovery = PageProcessRecovery()
    #expect(recovery.processEnded(shown: true) == .reload)
    recovery.loadFailed()
    #expect(recovery.loadFinished() == nil)
    #expect(recovery.processEnded(shown: true) == .reload)
  }
}
