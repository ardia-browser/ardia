import ArdiaBrowser
import Foundation
import Testing
@testable import PhoneBlocking

private final class NetworkOff: URLProtocol {
  nonisolated(unsafe) static var requests = 0

  override class func canInit(with request: URLRequest) -> Bool { true }
  override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

  override func startLoading() {
    Self.requests += 1
    client?.urlProtocol(self, didFailWithError: URLError(.notConnectedToInternet))
  }

  override func stopLoading() {}
}

@MainActor
private struct Install {
  let root = FileManager.default.temporaryDirectory.appending(path: "phone-blocking-\(UUID().uuidString)", directoryHint: .isDirectory)
  let suite = "phone-blocking-\(UUID().uuidString)"
  let defaults: UserDefaults
  let session: URLSession

  init() {
    defaults = UserDefaults(suiteName: suite)!
    let configuration = URLSessionConfiguration.ephemeral
    configuration.protocolClasses = [NetworkOff.self]
    session = URLSession(configuration: configuration)
  }

  func blocker(isDemo: Bool) -> ContentBlocker {
    PhoneBlocking.blocker(isDemo: isDemo, defaults: defaults, directory: root.appending(path: "Blocking"), demoDirectory: root.appending(path: "DemoFilters"), session: session)
  }

  func cleanUp() {
    try? FileManager.default.removeItem(at: root)
    defaults.removePersistentDomain(forName: suite)
  }
}

@MainActor
@Suite(.serialized) struct PhoneBlockingTests {
  @Test func demoInstallShowsMainsListsWithRuleCountsAtOnceAndNeverDownloads() async {
    let install = Install()
    defer { install.cleanUp() }
    NetworkOff.requests = 0
    let blocker = install.blocker(isDemo: true)
    #expect(blocker.filterLists.isDemo)
    #expect(blocker.filterLists.list("easylist")?.ruleCount == 84792)
    #expect(blocker.filterLists.lists.filter(\.isEnabled).allSatisfy { $0.ruleCount > 0 && $0.updatedAt != nil && $0.state == .ready })
    await blocker.prepare()
    await blocker.refreshIfDue()
    #expect(NetworkOff.requests == 0)
    #expect(blocker.filterLists.list("easylist")?.ruleCount == 84792)
    #expect(blocker.blocksRequest(toHost: "doubleclick.net"))
  }

  @Test func realInstallWithTheNetworkOffStillBlocksFromTheFirstPage() async {
    let install = Install()
    defer { install.cleanUp() }
    NetworkOff.requests = 0
    let blocker = install.blocker(isDemo: false)
    #expect(!blocker.filterLists.isDemo)
    #expect(blocker.filterLists.lists.filter(\.isEnabled).allSatisfy { $0.ruleCount == 0 && $0.updatedAt == nil })
    await blocker.prepare()
    #expect(blocker.blocksRequest(toHost: "doubleclick.net"))
    #expect(blocker.blocksRequest(toHost: "ads.google-analytics.com"))
    #expect(!blocker.blocksRequest(toHost: "example.com"))
    await blocker.refreshIfDue()
    #expect(NetworkOff.requests > 0)
    #expect(blocker.filterLists.isOffline)
    #expect(blocker.blocksRequest(toHost: "doubleclick.net"))
  }
}
