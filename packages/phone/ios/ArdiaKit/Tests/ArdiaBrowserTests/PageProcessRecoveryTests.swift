import Testing
@testable import ArdiaBrowser

@Suite struct PageProcessRecoveryTests {
  @Test func aShownPageReloadsAtOnceAndCountsItsRecovery() {
    var recovery = PageProcessRecovery()
    #expect(recovery.processEnded(shown: true) == .reload)
    recovery.reloadStarted()
    #expect(recovery.loadFinished() == .recovered)
    #expect(recovery.loadFinished() == nil)
  }

  @Test func theReloadStaysPendingUntilItReallyStarts() {
    var recovery = PageProcessRecovery()
    #expect(recovery.processEnded(shown: true) == .reload)
    #expect(recovery.awaitsReload && !recovery.isReloading)
    #expect(recovery.loadFinished() == nil)
    #expect(recovery.processEnded(shown: true) == .reload)
    recovery.reloadStarted()
    #expect(!recovery.awaitsReload && recovery.isReloading)
  }

  @Test func aHiddenPageWaitsUntilItIsShownAgain() {
    var recovery = PageProcessRecovery()
    #expect(recovery.processEnded(shown: false) == .wait)
    #expect(recovery.awaitsReload)
    #expect(recovery.loadFinished() == nil)
    #expect(recovery.pageShown() == .reload)
    recovery.reloadStarted()
    #expect(recovery.pageShown() == .wait)
    #expect(recovery.loadFinished() == .recovered)
  }

  @Test func aSecondDeathWhileReloadingShowsTheFailure() {
    var recovery = PageProcessRecovery()
    #expect(recovery.processEnded(shown: true) == .reload)
    recovery.reloadStarted()
    #expect(recovery.processEnded(shown: true) == .showFailure)
    #expect(!recovery.awaitsReload && !recovery.isReloading)
    #expect(recovery.processEnded(shown: true) == .reload)
  }

  @Test func aReloadEndedWhileHiddenWaitsInsteadOfFailing() {
    var recovery = PageProcessRecovery()
    #expect(recovery.processEnded(shown: true) == .reload)
    recovery.reloadStarted()
    #expect(recovery.processEnded(shown: false) == .wait)
    #expect(!recovery.isReloading && recovery.awaitsReload)
    #expect(recovery.pageShown() == .reload)
    recovery.reloadStarted()
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
    recovery.reloadStarted()
    #expect(recovery.isReloading && !recovery.awaitsReload)
    #expect(recovery.loadFinished() == .recovered)
  }

  @Test func aStartWithNothingPendingCountsNothing() {
    var recovery = PageProcessRecovery()
    recovery.reloadStarted()
    #expect(!recovery.isReloading)
    #expect(recovery.loadFinished() == nil)
  }

  @Test func aFailedLoadEndsTheRecoveryWithoutCountingIt() {
    var recovery = PageProcessRecovery()
    #expect(recovery.processEnded(shown: true) == .reload)
    recovery.reloadStarted()
    recovery.loadFailed()
    #expect(recovery.loadFinished() == nil)
    #expect(recovery.processEnded(shown: true) == .reload)
  }
}

@MainActor
@Suite struct WebViewCallbackRouteTests {
  final class View {}
  final class Owner {
    var current: View?
    init(_ current: View?) { self.current = current }
  }

  @Test func aCallbackFromTheCurrentViewReachesItsOwner() {
    let view = View()
    let owner = Owner(view)
    #expect(WebViewCallbackRoute.owner(owner, of: view, current: { $0.current }) === owner)
  }

  @Test func aCallbackFromADiscardedViewIsDropped() {
    let discarded = View()
    let owner = Owner(View())
    #expect(WebViewCallbackRoute.owner(owner, of: discarded, current: { $0.current }) == nil)
  }

  @Test func aCallbackAfterTheOwnerLostItsViewIsDropped() {
    let discarded = View()
    let owner = Owner(nil)
    #expect(WebViewCallbackRoute.owner(owner, of: discarded, current: { $0.current }) == nil)
    #expect(WebViewCallbackRoute.owner(nil as Owner?, of: discarded, current: { $0.current }) == nil)
  }
}
