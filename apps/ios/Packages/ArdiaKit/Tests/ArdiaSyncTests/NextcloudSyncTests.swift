import ArdiaSyncCore
import Foundation
import Testing
@testable import ArdiaSync

@MainActor
final class NextcloudRig {
  static let scope = SyncEndToEndTests.scope

  let sandbox: Sandbox
  let entropy: Data
  let mac: FakeMac
  let server: FakeNextcloud
  let source = FakeSource()
  let clock = TestClock()
  let timeout: TimeInterval
  var service: SyncService
  var passwordsDirectory: URL { sandbox.root.appendingPathComponent("NextcloudKeys", isDirectory: true) }
  var phrase: String { RecoveryPhrase.words(for: entropy).joined(separator: " ") }

  init(timeout: TimeInterval = 0.5) throws {
    sandbox = try Sandbox()
    entropy = RecoveryPhrase.generateEntropy()
    mac = try SyncEndToEndTests().seededMac(sandbox, entropy: entropy)
    mac.clock = clock
    try mac.put("app", "dev:\(mac.device)", #"{"n":"MacBook Pro","k":"mac","f":["send"]}"#)
    try mac.sync(["app", Self.scope])
    server = FakeNextcloud(filesRoot: sandbox.root)
    self.timeout = timeout
    source.tabs = [LocalTabRecord(url: "https://phone.example/", title: "Phone", lastActive: .now, profileSyncId: nil)]
    service = SyncService(directory: sandbox.state, keyStore: FileKeyStore(directory: sandbox.keys), coordinationTimeout: timeout, nextcloudPasswords: FileKeyStore(directory: sandbox.root.appendingPathComponent("NextcloudKeys", isDirectory: true)), nextcloudTransport: server.transport(timeout: timeout), now: { [clock] in clock.now })
    service.source = source
  }

  func relaunch() {
    service = SyncService(directory: sandbox.state, keyStore: FileKeyStore(directory: sandbox.keys), coordinationTimeout: timeout, nextcloudPasswords: FileKeyStore(directory: passwordsDirectory), nextcloudTransport: server.transport(timeout: timeout), now: { [clock] in clock.now })
    service.source = source
  }

  func connect(path: String? = nil, password: String = "app-password-1") async -> ConnectResult {
    await service.connect(phrase: phrase, to: .nextcloud(server.account(password: password), path: path))
  }

  func joined() async throws {
    try #require(await connect() == .connected)
    await service.syncNow()
    try #require(service.phase == .updated)
  }

  var me: String? { service.snapshot.devices.first { $0.isCurrent }?.id }

  func phoneBookmarks() -> Set<String> {
    SyncThroughICloudTests.titles(service.snapshot.defaultProfile?.bookmarks ?? []).subtracting(["Bookmarks Bar", "Other Bookmarks"])
  }

  func macBookmarkURLs() throws -> [String] {
    try mac.store(Self.scope).filter { $0.key.hasPrefix("bm:") }.compactMap { ($0.value as? [String: Any])?["u"] as? String }
  }

  var savedPasswords: [String] { sandbox.contents(passwordsDirectory) }
  var metaJSON: String { (try? String(contentsOf: sandbox.state.appendingPathComponent("sync.json"), encoding: .utf8)) ?? "" }

  func chainMadeByPhone() -> Bool {
    server.log.contains { $0.method == "MKCOL" && WebDAV.normalized($0.path).hasSuffix("/" + mac.keys.chainTag) }
  }

  func finish() async {
    await service.stopSyncing()
    for revoking in service.revocations { await revoking.value }
    server.shutDown()
    sandbox.remove()
  }
}

@MainActor
@Suite(.serialized) struct NextcloudSyncTests {
  static let scope = SyncEndToEndTests.scope

  @Test func macAndPhoneConvergeThroughNextcloud() async throws {
    let rig = try NextcloudRig()
    #expect(await rig.connect() == .connected)
    #expect(rig.service.usesNextcloud)
    #expect(rig.service.folderName == "Ardia Sync")
    #expect(rig.service.nextcloudHost == rig.server.host)
    await rig.service.syncNow()
    #expect(rig.service.phase == .updated)
    #expect(rig.service.snapshot.defaultProfile?.deviceTabs.first?.tabs.map(\.url) == ["https://news.example/", "https://mail.example/"])
    #expect(rig.phoneBookmarks().contains("Docs"))
    #expect(rig.server.log.contains { $0.method == "SEARCH" })
    #expect(rig.server.log.allSatisfy { !$0.path.contains(rig.server.loginName) })

    let me = try #require(rig.me)
    try rig.mac.sync(["app", Self.scope])
    let tabs = try #require(try rig.mac.store(Self.scope)["tabs:\(me)"] as? [String: Any])
    #expect((tabs["tabs"] as? [[String: String]])?.map { $0["u"] } == ["https://phone.example/"])
    #expect(try rig.mac.store("app")["dev:\(me)"] != nil)

    try rig.mac.put(Self.scope, "bm:late", #"{"k":"u","p":"bar","t":"Late","u":"https://late.example/","a":3,"pos":"3"}"#)
    try rig.mac.sync([Self.scope])
    #expect(await rig.service.addBookmark(url: URL(string: "https://pinned.example/")!, title: "Pinned") == .pinned)
    await rig.service.syncNow()
    #expect(rig.phoneBookmarks().isSuperset(of: ["Docs", "Late", "Pinned"]))
    try rig.mac.sync([Self.scope])
    #expect(try rig.macBookmarkURLs().filter { $0 == "https://pinned.example/" }.count == 1)

    let target = try #require(rig.service.devicesThatReceiveTabs.first)
    #expect(await rig.service.send(url: URL(string: "https://to-mac.example/")!, title: "To Mac", to: target))
    await rig.service.syncNow()
    try rig.mac.sync([Self.scope])
    #expect(try rig.mac.store(Self.scope).values.contains { ($0 as? [String: Any])?["u"] as? String == "https://to-mac.example/" })
    let seqs = rig.mac.logs(Self.scope, device: me).map(\.seq)
    #expect(Set(seqs).count == seqs.count)
    #expect(!rig.chainMadeByPhone())

    rig.relaunch()
    rig.service.start()
    await rig.service.syncNow()
    #expect(rig.service.phase == .updated)
    #expect(rig.service.usesNextcloud)
    #expect(rig.me == me)
    await rig.finish()
  }

  @Test(arguments: [
    FakeNextcloud.Fault.refused, .hang, .status(403), .status(404), .status(423), .status(500), .status(503),
    .captivePortal, .truncatedXML, .emptyMultiStatus, .failedRoot(503), .failedRoot(404), .hrefOnlyRoot, .foreignRoot, .otherHostRoot,
  ])
  func aServerProblemIsOfflineAndNeverAReset(_ fault: FakeNextcloud.Fault) async throws {
    let rig = try NextcloudRig(timeout: 0.3)
    try await rig.joined()
    rig.server.fail(fault)
    for _ in 0..<3 {
      rig.clock.advance(61)
      await rig.service.syncNow()
      #expect(rig.service.phase == .offline, "\(fault)")
      #expect(rig.service.statusText == "Offline", "\(fault)")
      #expect(rig.service.isEnabled, "\(fault)")
    }
    #expect(!rig.metaJSON.contains("\"outOfSync\":true"), "\(fault)")
    #expect(!rig.sandbox.contents(rig.sandbox.state).contains { $0.hasPrefix("sync-state.reset") }, "\(fault)")
    rig.server.fail(nil)
    rig.clock.advance(61)
    await rig.service.syncNow()
    #expect(rig.service.phase == .updated, "\(fault)")
    #expect(rig.service.snapshot.defaultProfile != nil, "\(fault)")
    await rig.finish()
  }

  @Test func aMissingRootOnAHealthyServerIsOfflineNotMissing() async throws {
    let rig = try NextcloudRig()
    try await rig.joined()
    let root = WebDAV.normalized(rig.server.davPrefix + "/Ardia Sync")
    rig.server.setFault { WebDAV.normalized($0.path) == root ? .status(404) : nil }
    for _ in 0..<3 {
      rig.clock.advance(61)
      await rig.service.syncNow()
      #expect(rig.service.phase == .offline)
    }
    rig.server.setFault(nil)
    await rig.service.syncNow()
    #expect(rig.service.phase == .updated)
    await rig.finish()
  }

  @Test func aProblemPartWayThroughACycleIsOfflineAndTheNextCycleFinishes() async throws {
    let rig = try NextcloudRig(timeout: 0.3)
    try await rig.joined()
    let scopeTag = rig.mac.keys.scopeTag(Self.scope)
    for fault: FakeNextcloud.Fault in [.status(500), .refused, .truncatedXML, .captivePortal, .hang] {
      rig.server.setFault { $0.path.contains(scopeTag) ? fault : nil }
      rig.source.tabs = [LocalTabRecord(url: "https://midway-\(fault.description.count).example/", title: "Midway", lastActive: rig.clock.now, profileSyncId: nil)]
      rig.service.localDidChange()
      rig.clock.advance(61)
      await rig.service.syncNow()
      #expect(rig.service.phase == .offline, "\(fault)")
      rig.clock.advance(61)
      await rig.service.syncNow()
      #expect(rig.service.phase == .offline, "\(fault)")
      #expect(!rig.metaJSON.contains("\"outOfSync\":true"), "\(fault)")
    }
    rig.server.setFault(nil)
    await rig.service.syncNow()
    #expect(rig.service.phase == .updated)
    await rig.finish()
  }

  @Test func changesMadeWhileTheServerIsDownPublishOnceWhenItIsBack() async throws {
    let rig = try NextcloudRig(timeout: 0.3)
    try await rig.joined()
    let me = try #require(rig.me)
    let target = try #require(rig.service.devicesThatReceiveTabs.first)
    try rig.mac.sync(["app", Self.scope])

    rig.server.setFault { $0.method == "PUT" ? .landsThenDrops : nil }
    #expect(await rig.service.addBookmark(url: URL(string: "https://offline-pin.example/")!, title: "Offline Pin") == .pinned)
    await rig.service.syncNow()
    #expect(rig.service.phase == .offline)

    rig.server.fail(.refused)
    for round in 0..<4 {
      rig.clock.advance(61)
      rig.source.tabs = [LocalTabRecord(url: "https://offline-\(round).example/", title: "Offline \(round)", lastActive: rig.clock.now, profileSyncId: nil)]
      rig.service.localDidChange()
      if round == 1 {
        #expect(await rig.service.send(url: URL(string: "https://offline-send.example/")!, title: "Offline Send", to: target))
      }
      await rig.service.syncNow()
      #expect(rig.service.phase == .offline)
    }
    try rig.mac.put(Self.scope, "bm:while", #"{"k":"u","p":"bar","t":"While Down","u":"https://while.example/","a":4,"pos":"4"}"#)
    try rig.mac.sync([Self.scope])

    rig.server.fail(nil)
    rig.clock.advance(61)
    await rig.service.syncNow()
    await rig.service.syncNow()
    #expect(rig.service.phase == .updated)
    #expect(rig.phoneBookmarks().contains("While Down"))
    #expect(rig.phoneBookmarks().contains("Offline Pin"))
    try rig.mac.sync(["app", Self.scope])
    #expect(try rig.macBookmarkURLs().filter { $0 == "https://offline-pin.example/" }.count == 1)
    let store = try rig.mac.store(Self.scope)
    #expect(store.values.compactMap { $0 as? [String: Any] }.filter { $0["u"] as? String == "https://offline-send.example/" }.count == 1)
    let tabs = try #require(store["tabs:\(me)"] as? [String: Any])
    #expect((tabs["tabs"] as? [[String: String]])?.map { $0["u"] } == ["https://offline-3.example/"])
    await rig.finish()
  }

  @Test func aChainTrulyMissingOnAHealthyServerStillResets() async throws {
    let rig = try NextcloudRig()
    try await rig.joined()
    try FileManager.default.removeItem(at: rig.mac.vault.chainURL)

    await rig.service.syncNow()
    #expect(rig.service.phase == .offline)
    rig.clock.advance(20)
    await rig.service.syncNow()
    #expect(rig.service.phase == .offline)
    rig.clock.advance(45)
    await rig.service.syncNow()
    #expect(rig.service.phase == .reset)
    #expect(!rig.chainMadeByPhone())
    #expect(!FileManager.default.fileExists(atPath: rig.mac.vault.chainURL.path))
    #expect(rig.savedPasswords.count == 1)
    rig.service.acknowledgeReset()
    #expect(rig.service.phase == .off)
    #expect(rig.savedPasswords.isEmpty)
    #expect(!rig.service.usesNextcloud)
    for revoking in rig.service.revocations { await revoking.value }
    #expect(rig.server.revoked == ["app-password-1"])
    rig.server.shutDown()
    rig.sandbox.remove()
  }

  @Test func aRejectedPasswordAsksToSignInAgainAndStopsTrying() async throws {
    let rig = try NextcloudRig()
    try await rig.joined()
    rig.server.passwords = []
    await rig.service.syncNow()
    #expect(rig.service.phase == .needsFolderAccess)
    #expect(rig.service.statusText == "Sign in to Nextcloud again to keep syncing.")
    #expect(rig.service.isEnabled)
    rig.server.clearLog()
    await rig.service.syncNow()
    rig.service.appBecameActive()
    rig.service.localDidChange()
    await rig.service.syncNow()
    #expect(rig.server.log.isEmpty)
    #expect(rig.service.phase == .needsFolderAccess)
    #expect(rig.savedPasswords.isEmpty)

    await rig.service.close()
    rig.relaunch()
    rig.service.start()
    rig.service.appBecameActive()
    await rig.service.syncNow()
    #expect(rig.service.phase == .needsFolderAccess)
    #expect(rig.service.usesNextcloud)
    #expect(rig.server.log.isEmpty)

    rig.server.passwords = ["app-password-2"]
    #expect(await rig.service.changeLocation(.nextcloud(rig.server.account(password: "app-password-2"), path: nil)) == .connected)
    await rig.service.syncNow()
    #expect(rig.service.phase == .updated)
    #expect(rig.savedPasswords.count == 1)
    for revoking in rig.service.revocations { await revoking.value }
    #expect(rig.server.revoked.isEmpty)
    #expect(!rig.metaJSON.contains("app-password"))
    await rig.finish()
    #expect(rig.server.revoked == ["app-password-2"])
  }

  @Test func stoppingDeletesThePasswordAndRevokesIt() async throws {
    let rig = try NextcloudRig()
    try await rig.joined()
    #expect(rig.savedPasswords.count == 1)
    await rig.service.stopSyncing()
    #expect(rig.service.phase == .off)
    #expect(rig.savedPasswords.isEmpty)
    #expect(!rig.metaJSON.contains("nextcloud"))
    for revoking in rig.service.revocations { await revoking.value }
    #expect(rig.server.revoked == ["app-password-1"])
    rig.server.shutDown()
    rig.sandbox.remove()
  }

  @Test func stoppingWhileTheServerIsDownKeepsThePasswordUntilTheStopLands() async throws {
    let rig = try NextcloudRig(timeout: 0.3)
    try await rig.joined()
    let me = try #require(rig.me)
    rig.server.fail(.refused)
    await rig.service.stopSyncing()
    #expect(rig.service.phase == .off)
    #expect(rig.savedPasswords.count == 1)
    #expect(rig.server.revoked.isEmpty)

    rig.server.fail(nil)
    rig.relaunch()
    rig.service.start()
    rig.service.appBecameActive()
    await rig.service.syncNow()
    for _ in 0..<50 where !rig.savedPasswords.isEmpty {
      try await Task.sleep(for: .milliseconds(50))
    }
    #expect(rig.savedPasswords.isEmpty)
    for revoking in rig.service.revocations { await revoking.value }
    #expect(rig.server.revoked == ["app-password-1"])
    try rig.mac.sync(["app", Self.scope])
    #expect(try rig.mac.store("app")["dev:\(me)"] == nil)
    rig.server.shutDown()
    rig.sandbox.remove()
  }

  @Test func theCredentialNeverReachesSavedStateOrMessages() async throws {
    let rig = try NextcloudRig()
    let account = rig.server.account()
    try await rig.joined()
    let secret = "app-password-1"
    #expect(!rig.metaJSON.contains(secret))
    #expect(rig.metaJSON.contains("\"nextcloud\""))
    #expect(!String(describing: account).contains(secret))
    #expect(!String(reflecting: account).contains(secret))
    #expect(!"\(account)".contains(secret))
    var dumped = ""
    dump(account, to: &dumped)
    #expect(!dumped.contains(secret))
    #expect(!String(describing: SyncDestination.nextcloud(account, path: nil)).contains(secret))
    let problems: [NextcloudProblem] = [.insecure, .certificate, .unreachable, .signInNeeded, .notNextcloud, .refused(500)]
    for problem in problems {
      #expect(!problem.message.contains(secret))
      #expect(!(ConnectResult(problem).message ?? "").contains(secret))
    }
    for file in rig.sandbox.contents(rig.sandbox.state) {
      let data = (try? Data(contentsOf: rig.sandbox.state.appendingPathComponent(file))) ?? Data()
      #expect(data.range(of: Data(secret.utf8)) == nil, "\(file)")
    }
    await rig.finish()
  }

  @Test func aWrongPhraseOrAnEmptyServerSavesNothing() async throws {
    let rig = try NextcloudRig()
    let other = RecoveryPhrase.words(for: RecoveryPhrase.generateEntropy()).joined(separator: " ")
    #expect(await rig.service.connect(phrase: other, to: .nextcloud(rig.server.account(), path: nil)) == .mismatch)
    #expect(rig.savedPasswords.isEmpty)
    #expect(rig.sandbox.contents(rig.sandbox.keys).isEmpty)
    #expect(await rig.connect(path: "Nowhere") == .nextcloudFolderNotFound)
    #expect(await rig.connect(password: "wrong") == .signInNeeded)
    rig.server.fail(.refused)
    #expect(await rig.connect() == .serverUnavailable)
    #expect(rig.savedPasswords.isEmpty)
    #expect(rig.service.phase == .off)
    #expect(!rig.metaJSON.contains("nextcloud"))
    rig.server.shutDown()
    rig.sandbox.remove()
  }

  @Test func aFolderSearchFoundThatWontListIsUnreachableNotEmpty() async throws {
    let rig = try NextcloudRig()
    let root = WebDAV.normalized(rig.server.davPrefix + "/Ardia Sync")
    for fault: FakeNextcloud.Fault in [.status(404), .failedRoot(503)] {
      rig.server.setFault { $0.method == "PROPFIND" && WebDAV.normalized($0.path) == root ? fault : nil }
      #expect(await rig.connect() == .serverUnavailable, "\(fault)")
    }
    #expect(rig.savedPasswords.isEmpty)
    #expect(rig.service.phase == .off)
    rig.server.shutDown()
    rig.sandbox.remove()
  }

  @Test func aTypedFolderThatWontListSaysSoInsteadOfNoData() async throws {
    let rig = try NextcloudRig()
    let root = WebDAV.normalized(rig.server.davPrefix + "/Ardia Sync")
    rig.server.setFault { $0.method == "PROPFIND" && WebDAV.normalized($0.path) == root ? .status(404) : nil }
    #expect(await rig.connect(path: "Ardia Sync") == .nextcloudFolderNotFound)
    rig.server.setFault { $0.method == "PROPFIND" && WebDAV.normalized($0.path) == root ? .failedRoot(503) : nil }
    #expect(await rig.connect(path: "Ardia Sync") == .serverUnavailable)
    rig.server.setFault(nil)
    rig.server.searchSupported = false
    #expect(await rig.connect(path: "Empty") == .nextcloudFolderNotFound)
    try FileManager.default.createDirectory(at: rig.sandbox.root.appendingPathComponent("Empty"), withIntermediateDirectories: true)
    #expect(await rig.connect(path: "Empty") == .noSyncDataInNextcloud)
    #expect(rig.savedPasswords.isEmpty)
    rig.server.shutDown()
    rig.sandbox.remove()
  }

  @Test func aPasswordTheServiceNeverAdoptedIsRevokedWhenReleased() async throws {
    let rig = try NextcloudRig()
    try await rig.joined()
    rig.server.passwords.insert("app-password-2")
    let fresh = rig.server.account(password: "app-password-2")
    #expect(await rig.service.changeLocation(.nextcloud(fresh, path: "Nowhere")) == .nextcloudFolderNotFound)
    rig.service.release(fresh)
    rig.service.release(rig.server.account())
    for revoking in rig.service.revocations { await revoking.value }
    #expect(rig.server.revoked == ["app-password-2"])
    #expect(rig.savedPasswords.count == 1)
    await rig.service.syncNow()
    #expect(rig.service.phase == .updated)
    await rig.finish()
  }

  @Test func releasingAnAccountWhileItsJoinIsInFlightKeepsItWhenItJoins() async throws {
    let rig = try NextcloudRig(timeout: 8)
    let account = rig.server.account()
    let held = rig.server.hold(where: { $0.method == "PROPFIND" })
    let joining = Task { await rig.connect() }
    try await Self.waitUntil { held.arrived }
    rig.service.release(account)
    held.release()
    #expect(await joining.value == .connected)
    for revoking in rig.service.revocations { await revoking.value }
    #expect(rig.server.revoked.isEmpty)
    await rig.service.syncNow()
    #expect(rig.service.phase == .updated)

    rig.server.passwords.insert("app-password-2")
    let other = rig.server.account(password: "app-password-2")
    let heldAgain = rig.server.hold(where: { $0.method == "PROPFIND" })
    let failing = Task { await rig.service.changeLocation(.nextcloud(other, path: "Nowhere")) }
    try await Self.waitUntil { heldAgain.arrived }
    rig.service.release(other)
    heldAgain.release()
    #expect(await failing.value == .nextcloudFolderNotFound)
    for revoking in rig.service.revocations { await revoking.value }
    #expect(rig.server.revoked == ["app-password-2"])
    await rig.finish()
  }

  @Test func aSignInProblemFromTheOldAccountNeverDiscardsTheNewOne() async throws {
    let rig = try NextcloudRig(timeout: 8)
    try await rig.joined()
    rig.server.passwords.insert("app-password-2")
    let held = rig.server.hold(where: { $0.method == "PROPFIND" }, answering: .status(401))
    let cycle = Task { await rig.service.syncNow() }
    try await Self.waitUntil { held.arrived }
    let before = rig.metaJSON
    let change = Task { await rig.service.changeLocation(.nextcloud(rig.server.account(password: "app-password-2"), path: nil)) }
    try await Self.waitUntil { rig.metaJSON != before }
    held.release()
    #expect(await change.value == .connected)
    await cycle.value
    await rig.service.syncNow()
    #expect(rig.service.phase == .updated)
    #expect(rig.service.usesNextcloud)
    #expect(rig.savedPasswords.count == 1)
    for revoking in rig.service.revocations { await revoking.value }
    #expect(rig.server.revoked == ["app-password-1"])
    await rig.finish()
    #expect(rig.server.revoked == ["app-password-1", "app-password-2"])
  }

  @Test func savingTheSameAccountAgainNeverRevokesThePasswordInUse() async throws {
    let rig = try NextcloudRig()
    try await rig.joined()
    #expect(await rig.service.changeLocation(.nextcloud(rig.server.account(), path: "/Ardia Sync/")) == .connected)
    #expect(await rig.connect() == .connected)
    for revoking in rig.service.revocations { await revoking.value }
    #expect(rig.server.revoked.isEmpty)
    #expect(rig.savedPasswords.count == 1)
    await rig.service.syncNow()
    #expect(rig.service.phase == .updated)
    rig.relaunch()
    rig.service.start()
    await rig.service.syncNow()
    #expect(rig.service.phase == .updated)
    await rig.finish()
    #expect(rig.server.revoked == ["app-password-1"])
  }

  @Test func aSignInProblemSettlingAfterAnAccountChangeNeverDiscardsTheNewOne() async throws {
    let rig = try NextcloudRig(timeout: 8)
    try await rig.joined()
    rig.server.passwords.insert("app-password-2")
    let rejected = rig.server.hold(where: { $0.method == "PROPFIND" }, answering: .status(401))
    let cycle = Task { await rig.service.syncNow() }
    try await Self.waitUntil { rejected.arrived }
    let located = rig.server.hold(where: { $0.method == "PROPFIND" })
    let change = Task { await rig.service.changeLocation(.nextcloud(rig.server.account(password: "app-password-2"), path: nil)) }
    try await Self.waitUntil { located.arrived }
    rejected.release()
    Self.blockMainActor(for: 0.4)
    located.release()
    Self.blockMainActor(for: 0.4)
    #expect(await change.value == .connected)
    await cycle.value
    await rig.service.syncNow()
    #expect(rig.service.phase == .updated)
    #expect(rig.savedPasswords.count == 1)
    for revoking in rig.service.revocations { await revoking.value }
    #expect(rig.server.revoked == ["app-password-1"])
    rig.relaunch()
    rig.service.start()
    await rig.service.syncNow()
    #expect(rig.service.phase == .updated)
    await rig.finish()
  }

  static func blockMainActor(for seconds: TimeInterval) {
    Thread.sleep(forTimeInterval: seconds)
  }

  static func waitUntil(_ condition: () -> Bool) async throws {
    let deadline = ContinuousClock.now + .seconds(10)
    while !condition() {
      try #require(ContinuousClock.now < deadline, "condition never held")
      try await Task.sleep(for: .milliseconds(10))
    }
  }

  @Test func aTypedFolderWorksWhenSearchIsUnavailable() async throws {
    let rig = try NextcloudRig()
    let custom = rig.sandbox.root.appendingPathComponent("Backups/Browser Sync", isDirectory: true)
    try FileManager.default.createDirectory(at: custom.deletingLastPathComponent(), withIntermediateDirectories: true)
    try FileManager.default.moveItem(at: rig.sandbox.folder, to: custom)
    rig.server.searchSupported = false
    #expect(await rig.connect() == .noSyncDataInNextcloud)
    #expect(await rig.connect(path: "/Backups/Browser Sync/") == .connected)
    #expect(rig.service.folderName == "Backups/Browser Sync")
    await rig.service.syncNow()
    #expect(rig.service.phase == .updated)
    #expect(rig.phoneBookmarks().contains("Docs"))
    await rig.finish()
  }

  @Test func theDefaultFolderIsTriedWhenSearchFails() async throws {
    let rig = try NextcloudRig()
    rig.server.searchSupported = false
    #expect(await rig.connect() == .connected)
    #expect(rig.service.folderName == "Ardia Sync")
    await rig.finish()
  }

  @Test func searchFindsTheChainInANestedFolder() async throws {
    let rig = try NextcloudRig()
    let nested = rig.sandbox.root.appendingPathComponent("Work/Ardia Sync", isDirectory: true)
    try FileManager.default.createDirectory(at: nested.deletingLastPathComponent(), withIntermediateDirectories: true)
    try FileManager.default.moveItem(at: rig.sandbox.folder, to: nested)
    #expect(await rig.connect() == .connected)
    #expect(rig.service.folderName == "Work/Ardia Sync")
    await rig.service.syncNow()
    #expect(rig.service.phase == .updated)
    await rig.finish()
  }

  @Test func backgroundExpiryEndsAHungRequestAtOnce() async throws {
    let rig = try NextcloudRig(timeout: 5)
    try await rig.joined()
    rig.server.fail(.hang)
    let started = ContinuousClock.now
    let cycle = Task { await rig.service.syncNow() }
    try await Task.sleep(for: .milliseconds(300))
    rig.service.cancelCoordination()
    await cycle.value
    #expect(ContinuousClock.now - started < .seconds(3))
    #expect(rig.service.phase == .offline)
    rig.server.fail(nil)
    await rig.service.syncNow()
    #expect(rig.service.phase == .updated)
    await rig.finish()
  }

  @Test func switchingFromAFolderToNextcloudKeepsTheDevice() async throws {
    let rig = try NextcloudRig()
    #expect(await rig.service.connect(phrase: rig.phrase, folder: rig.sandbox.root) == .connected)
    await rig.service.syncNow()
    let me = try #require(rig.me)
    #expect(!rig.service.usesNextcloud)
    #expect(await rig.service.changeLocation(.nextcloud(rig.server.account(), path: nil)) == .connected)
    await rig.service.syncNow()
    #expect(rig.service.phase == .updated)
    #expect(rig.service.usesNextcloud)
    #expect(rig.me == me)
    #expect(await rig.service.changeFolder(rig.sandbox.root) == .connected)
    await rig.service.syncNow()
    #expect(!rig.service.usesNextcloud)
    #expect(rig.savedPasswords.isEmpty)
    for revoking in rig.service.revocations { await revoking.value }
    #expect(rig.server.revoked == ["app-password-1"])
    await rig.finish()
  }
}
