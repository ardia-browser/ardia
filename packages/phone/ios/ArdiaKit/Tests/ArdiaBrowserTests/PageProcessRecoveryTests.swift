import Foundation
import Testing
@testable import ArdiaBrowser

@Suite struct PageProcessRecoveryTests {
  @Test func aShownPageReloadsAtOnceAndCountsItsRecovery() {
    var recovery = PageProcessRecovery()
    #expect(recovery.processEnded(shown: true, at: 0) == .reload)
    recovery.reloadStarted()
    #expect(recovery.loadFinished(at: 0) == .recovered)
    #expect(recovery.loadFinished(at: 0) == nil)
  }

  @Test func theReloadStaysPendingUntilItReallyStarts() {
    var recovery = PageProcessRecovery()
    #expect(recovery.processEnded(shown: true, at: 0) == .reload)
    #expect(recovery.awaitsReload && !recovery.isReloading)
    #expect(recovery.loadFinished(at: 0) == nil)
    #expect(recovery.processEnded(shown: true, at: 0) == .reload)
    recovery.reloadStarted()
    #expect(!recovery.awaitsReload && recovery.isReloading)
  }

  @Test func aHiddenPageWaitsUntilItIsShownAgain() {
    var recovery = PageProcessRecovery()
    #expect(recovery.processEnded(shown: false, at: 0) == .wait)
    #expect(recovery.awaitsReload)
    #expect(recovery.loadFinished(at: 0) == nil)
    #expect(recovery.pageShown() == .reload)
    recovery.reloadStarted()
    #expect(recovery.pageShown() == .wait)
    #expect(recovery.loadFinished(at: 0) == .recovered)
  }

  @Test func aSecondDeathWhileReloadingShowsTheFailure() {
    var recovery = PageProcessRecovery()
    #expect(recovery.processEnded(shown: true, at: 0) == .reload)
    recovery.reloadStarted()
    #expect(recovery.processEnded(shown: true, at: 0) == .showFailure)
    #expect(!recovery.awaitsReload && !recovery.isReloading)
    #expect(recovery.processEnded(shown: true, at: 0) == .reload)
  }

  @Test func aReloadEndedWhileHiddenWaitsInsteadOfFailing() {
    var recovery = PageProcessRecovery()
    #expect(recovery.processEnded(shown: true, at: 0) == .reload)
    recovery.reloadStarted()
    #expect(recovery.processEnded(shown: false, at: 0) == .wait)
    #expect(!recovery.isReloading && recovery.awaitsReload)
    #expect(recovery.pageShown() == .reload)
    recovery.reloadStarted()
    #expect(recovery.loadFinished(at: 0) == .recovered)
  }

  @Test func aDeathWhileHiddenNeverShowsTheFailurePage() {
    var recovery = PageProcessRecovery()
    #expect(recovery.processEnded(shown: false, at: 0) == .wait)
    #expect(recovery.processEnded(shown: false, at: 0) == .wait)
    #expect(recovery.pageShown() == .reload)
  }

  @Test func aReloadByThePersonCountsAsTheRecovery() {
    var recovery = PageProcessRecovery()
    #expect(recovery.processEnded(shown: false, at: 0) == .wait)
    recovery.reloadStarted()
    #expect(recovery.isReloading && !recovery.awaitsReload)
    #expect(recovery.loadFinished(at: 0) == .recovered)
  }

  @Test func aStartWithNothingPendingCountsNothing() {
    var recovery = PageProcessRecovery()
    recovery.reloadStarted()
    #expect(!recovery.isReloading)
    #expect(recovery.loadFinished(at: 0) == nil)
  }

  @Test func aPageThatKeepsDyingRightAfterItsRecoveryReloadsOnlyOnce() {
    var recovery = PageProcessRecovery()
    var reloads = 0
    var failures = 0
    for cycle in 0..<5 {
      let start = TimeInterval(cycle * 2)
      switch recovery.processEnded(shown: true, at: start) {
      case .reload:
        reloads += 1
        recovery.reloadStarted()
        _ = recovery.loadFinished(at: start + 1)
      case .showFailure:
        failures += 1
      case .wait:
        break
      }
      if failures > 0 { break }
    }
    #expect(reloads == 1)
    #expect(failures == 1)
    #expect(!recovery.awaitsReload && !recovery.isReloading)
  }

  @Test func aPageThatDiesElevenSecondsAfterEachRecoveryStillStopsAfterOneReload() {
    var recovery = PageProcessRecovery()
    #expect(recovery.processEnded(shown: true, at: 0) == .reload)
    recovery.reloadStarted()
    #expect(recovery.loadFinished(at: 1) == .recovered)
    #expect(recovery.processEnded(shown: true, at: 12) == .showFailure)
  }

  @Test func aDeathLongAfterTheRecoveryGetsItsOwnReload() {
    var recovery = PageProcessRecovery()
    #expect(recovery.processEnded(shown: true, at: 0) == .reload)
    recovery.reloadStarted()
    #expect(recovery.loadFinished(at: 1) == .recovered)
    #expect(recovery.processEnded(shown: true, at: 1 + PageProcessRecovery.retryWindow) == .reload)
  }

  @Test func tryAgainGivesThePageAnotherAutomaticReload() {
    var recovery = PageProcessRecovery()
    #expect(recovery.processEnded(shown: true, at: 0) == .reload)
    recovery.reloadStarted()
    #expect(recovery.loadFinished(at: 1) == .recovered)
    #expect(recovery.processEnded(shown: true, at: 2) == .showFailure)
    recovery.personReloaded()
    #expect(recovery.processEnded(shown: true, at: 3) == .reload)
  }

  @Test func aHiddenPageThatDiesRightAfterItsRecoveryWaits() {
    var recovery = PageProcessRecovery()
    #expect(recovery.processEnded(shown: true, at: 0) == .reload)
    recovery.reloadStarted()
    #expect(recovery.loadFinished(at: 1) == .recovered)
    #expect(recovery.processEnded(shown: false, at: 2) == .wait)
    #expect(recovery.awaitsReload)
  }

  @Test func aPendingRecoveryLoadsOnlyForTheShownPage() {
    var recovery = PageProcessRecovery()
    #expect(recovery.loadsWhenMadeLive(shown: false))
    #expect(recovery.processEnded(shown: false, at: 0) == .wait)
    #expect(!recovery.loadsWhenMadeLive(shown: false))
    #expect(recovery.loadsWhenMadeLive(shown: true))
  }

  @Test func theFailurePageSurvivesARemountUntilThePersonActs() {
    var recovery = PageProcessRecovery()
    #expect(recovery.processEnded(shown: true, at: 0) == .reload)
    recovery.reloadStarted()
    #expect(recovery.loadFinished(at: 1) == .recovered)
    #expect(recovery.processEnded(shown: true, at: 2) == .showFailure)
    #expect(recovery.showsFailure)
    #expect(!recovery.loadsWhenMadeLive(shown: true))
    #expect(recovery.pageShown() == .wait)
    recovery.personReloaded()
    #expect(!recovery.showsFailure)
    #expect(recovery.loadsWhenMadeLive(shown: true))
  }

  @Test func aSuccessfulTryAgainCountsAsTheRecovery() {
    var recovery = PageProcessRecovery()
    #expect(recovery.processEnded(shown: true, at: 0) == .reload)
    recovery.reloadStarted()
    #expect(recovery.processEnded(shown: true, at: 1) == .showFailure)
    recovery.personReloaded()
    recovery.reloadStarted()
    #expect(recovery.isReloading)
    #expect(recovery.loadFinished(at: 2) == .recovered)
  }

  @Test func openingANewAddressFromTheFailurePageIsNotARecovery() {
    var recovery = PageProcessRecovery()
    #expect(recovery.processEnded(shown: true, at: 0) == .reload)
    recovery.reloadStarted()
    #expect(recovery.processEnded(shown: true, at: 1) == .showFailure)
    recovery.personOpened()
    #expect(!recovery.showsFailure)
    recovery.reloadStarted()
    #expect(recovery.loadFinished(at: 2) == nil)
  }

  @Test func aCommitOnAnotherHostStartsAFreshRetryWindow() {
    var recovery = PageProcessRecovery()
    recovery.pageCommitted(host: "www.a.com")
    #expect(recovery.processEnded(shown: true, at: 0) == .reload)
    recovery.reloadStarted()
    recovery.pageCommitted(host: "www.a.com")
    #expect(recovery.loadFinished(at: 1) == .recovered)
    recovery.pageCommitted(host: "news.a.com")
    #expect(recovery.processEnded(shown: true, at: 2) == .reload)
  }

  @Test func aCommitOnAnotherSiteStartsAFreshRetryWindow() {
    var recovery = PageProcessRecovery()
    recovery.pageCommitted(host: "a.com")
    #expect(recovery.processEnded(shown: true, at: 0) == .reload)
    recovery.reloadStarted()
    recovery.pageCommitted(host: "a.com")
    #expect(recovery.loadFinished(at: 1) == .recovered)
    recovery.pageCommitted(host: "b.org")
    #expect(recovery.processEnded(shown: true, at: 2) == .reload)
  }

  @Test func aCommitOnTheSameSiteKeepsTheRetryWindow() {
    var recovery = PageProcessRecovery()
    recovery.pageCommitted(host: "a.com")
    #expect(recovery.processEnded(shown: true, at: 0) == .reload)
    recovery.reloadStarted()
    recovery.pageCommitted(host: "a.com")
    #expect(recovery.loadFinished(at: 1) == .recovered)
    recovery.pageCommitted(host: "a.com")
    #expect(recovery.processEnded(shown: true, at: 2) == .showFailure)
  }

  @Test func aFailedLoadEndsTheRecoveryWithoutCountingIt() {
    var recovery = PageProcessRecovery()
    #expect(recovery.processEnded(shown: true, at: 0) == .reload)
    recovery.reloadStarted()
    recovery.loadFailed()
    #expect(recovery.loadFinished(at: 0) == nil)
    #expect(recovery.processEnded(shown: true, at: 0) == .reload)
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
