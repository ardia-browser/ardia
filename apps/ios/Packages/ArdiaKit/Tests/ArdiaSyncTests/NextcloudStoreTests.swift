import ArdiaSyncCore
import Foundation
import Testing
@testable import ArdiaSync

@Suite(.serialized) struct NextcloudStoreTests {
  static let scope = "p:personal000000000000000000"

  struct Fixture {
    let sandbox: Sandbox
    let server: FakeNextcloud
    let keys: SyncKeys
    let store: NextcloudStore

    func remove() {
      server.shutDown()
      sandbox.remove()
    }
  }

  func fixture(timeout: TimeInterval = 0.5) throws -> Fixture {
    let sandbox = try Sandbox()
    let entropy = RecoveryPhrase.generateEntropy()
    let keys = SyncKeys(entropy: entropy)
    try SyncVault(folder: sandbox.folder, keys: keys).createChain()
    let server = FakeNextcloud(filesRoot: sandbox.root)
    let store = NextcloudStore(connection: NextcloudConnection(account: server.account(), path: "Ardia Sync", transport: server.transport(timeout: timeout)), keys: keys)
    return Fixture(sandbox: sandbox, server: server, keys: keys, store: store)
  }

  @Test func aWriteToAScopeWithNoFolderMakesOnlyThatFolder() throws {
    let f = try fixture()
    defer { f.remove() }
    let id = try f.store.write(scope: Self.scope, payload: Data(#"{"hello":1}"#.utf8))
    let mkcols = f.server.log.filter { $0.method == "MKCOL" }.map { WebDAV.normalized($0.path) }
    #expect(mkcols == [WebDAV.normalized(f.store.scopeURL(Self.scope).path(percentEncoded: false))])
    let listing = try f.store.read(scope: Self.scope, skipping: [])
    #expect(listing.present == [id])
    #expect(listing.files.map { String(decoding: $0.payload, as: UTF8.self) } == [#"{"hello":1}"#])
    #expect(try f.store.read(scope: Self.scope, skipping: [id]).files.isEmpty)
    #expect(try f.store.read(scope: Self.scope, skipping: [id]).present == [id])
    f.server.clearLog()
    _ = try f.store.write(scope: Self.scope, payload: Data("{}".utf8))
    #expect(!f.server.log.contains { $0.method == "MKCOL" })
  }

  @Test func aWriteNeverCreatesAMissingChain() throws {
    let f = try fixture()
    defer { f.remove() }
    try FileManager.default.removeItem(at: f.sandbox.folder.appendingPathComponent(f.keys.chainTag))
    #expect(throws: SyncCoordination.TimedOut.self) { try f.store.write(scope: Self.scope, payload: Data("{}".utf8)) }
    #expect(!FileManager.default.fileExists(atPath: f.sandbox.folder.appendingPathComponent(f.keys.chainTag).path))
    #expect(f.server.log.filter { $0.method == "MKCOL" }.allSatisfy { !WebDAV.normalized($0.path).hasSuffix(f.keys.chainTag) })
  }

  @Test func aFileThatVanishesBeforeItsReadIsSkipped() throws {
    let f = try fixture()
    defer { f.remove() }
    let kept = try f.store.write(scope: Self.scope, payload: Data(#"{"n":"kept"}"#.utf8))
    let doomed = try f.store.write(scope: Self.scope, payload: Data(#"{"n":"gone"}"#.utf8))
    let doomedFile = f.sandbox.folder.appendingPathComponent(f.keys.chainTag).appendingPathComponent(f.keys.scopeTag(Self.scope)).appendingPathComponent("\(doomed).nns")
    f.server.beforeGet { path in
      if path.hasSuffix("\(doomed).nns") { try? FileManager.default.removeItem(at: doomedFile) }
    }
    let listing = try f.store.read(scope: Self.scope, skipping: [])
    #expect(listing.files.map(\.id) == [kept])
    #expect(listing.present == [kept])
    #expect(listing.damaged.isEmpty)
  }

  @Test func deletingAFileThatIsAlreadyGoneSucceeds() throws {
    let f = try fixture()
    defer { f.remove() }
    let id = try f.store.write(scope: Self.scope, payload: Data("{}".utf8))
    try f.store.remove(scope: Self.scope, ids: [id, SyncKeys.newFileId()])
    try f.store.remove(scope: Self.scope, ids: [id])
    #expect(try f.store.read(scope: Self.scope, skipping: []).present.isEmpty)
    try f.store.remove(scope: "p:never00000000000000000000", ids: [SyncKeys.newFileId()])
  }

  @Test func aScopeWithNoFolderReadsEmpty() throws {
    let f = try fixture()
    defer { f.remove() }
    let listing = try f.store.read(scope: Self.scope, skipping: [])
    #expect(listing.files.isEmpty && listing.present.isEmpty && listing.pending.isEmpty)
  }

  @Test func aFileThatWontOpenIsDamagedNotFatal() throws {
    let f = try fixture()
    defer { f.remove() }
    let scopeFolder = f.sandbox.folder.appendingPathComponent(f.keys.chainTag).appendingPathComponent(f.keys.scopeTag(Self.scope))
    try FileManager.default.createDirectory(at: scopeFolder, withIntermediateDirectories: true)
    let bad = SyncKeys.newFileId()
    try Data(repeating: 7, count: 2048).write(to: scopeFolder.appendingPathComponent("\(bad).nns"))
    try Data("stray".utf8).write(to: scopeFolder.appendingPathComponent("notes.txt"))
    try Data("copy".utf8).write(to: scopeFolder.appendingPathComponent("\(bad) 2.nns"))
    let listing = try f.store.read(scope: Self.scope, skipping: [])
    #expect(listing.files.isEmpty)
    #expect(listing.damaged.map(\.id) == [bad])
    #expect(listing.present == [bad])
  }

  @Test(arguments: [
    FakeNextcloud.Fault.refused, .hang, .status(403), .status(404), .status(423), .status(500), .status(503),
    .captivePortal, .truncatedXML, .emptyMultiStatus, .failedRoot(503), .failedRoot(404), .hrefOnlyRoot, .foreignRoot, .otherHostRoot,
  ])
  func everyServerProblemIsUnavailableAndTheRestOfTheCycleFailsFast(_ fault: FakeNextcloud.Fault) throws {
    let f = try fixture(timeout: 0.3)
    defer { f.remove() }
    f.server.fail(fault)
    #expect(throws: SyncCoordination.TimedOut.self, "\(fault)") { try f.store.rootNames() }
    f.server.clearLog()
    #expect(throws: SyncCoordination.TimedOut.self, "\(fault)") { try f.store.read(scope: Self.scope, skipping: []) }
    #expect(throws: SyncCoordination.TimedOut.self, "\(fault)") { try f.store.write(scope: Self.scope, payload: Data("{}".utf8)) }
    #expect(f.server.log.isEmpty, "\(fault)")
    f.server.fail(nil)
    f.store.resume()
    #expect(try f.store.rootNames() == [f.keys.chainTag], "\(fault)")
  }

  @Test func aChildThatFailsIsIgnoredUnlessSyncCouldUseItsName() throws {
    let f = try fixture()
    defer { f.remove() }
    let id = try f.store.write(scope: Self.scope, payload: Data("{}".utf8))
    f.server.brokenChildren = ["Shared with me", ".~lock.notes.txt#", "upload.part", "notes.nns", "\(SyncKeys.newFileId()).nns.part"]
    #expect(try f.store.rootNames() == [f.keys.chainTag])
    #expect(try f.store.read(scope: Self.scope, skipping: []).present == [id])
  }

  @Test func aFailedChainShapedChildMakesTheRootUnavailable() throws {
    let f = try fixture()
    defer { f.remove() }
    f.server.brokenChildren = [SyncKeys.newFileId()]
    #expect(throws: SyncCoordination.TimedOut.self) { try f.store.rootNames() }
  }

  @Test func aFailedSyncFileMakesItsScopeUnavailable() throws {
    let f = try fixture()
    defer { f.remove() }
    _ = try f.store.write(scope: Self.scope, payload: Data("{}".utf8))
    f.server.brokenChildren = ["\(SyncKeys.newFileId()).nns"]
    #expect(try f.store.rootNames() == [f.keys.chainTag])
    #expect(throws: SyncCoordination.TimedOut.self) { try f.store.read(scope: Self.scope, skipping: []) }
  }

  @Test func aRejectedPasswordIsSignInNeeded() throws {
    let f = try fixture()
    defer { f.remove() }
    f.server.passwords = []
    #expect(throws: SyncSignInNeeded.self) { try f.store.rootNames() }
    #expect(throws: SyncCoordination.TimedOut.self) { try f.store.read(scope: Self.scope, skipping: []) }
  }

  @Test func theStoreUsesTheUserIdAndTheSubpath() throws {
    let f = try fixture()
    defer { f.remove() }
    _ = try f.store.rootNames()
    let path = try #require(f.server.log.first?.path)
    #expect(path.hasPrefix("/nc/remote.php/dav/files/\(f.server.userId)/Ardia Sync"))
    #expect(!path.contains(f.server.loginName))
  }

  @Test func multiStatusParsingRefusesWhatIsNotAListing() {
    let url = URL(string: "https://cloud.test/remote.php/dav/files/u/Ardia%20Sync/")!
    let good = Data(#"<?xml version="1.0"?><d:multistatus xmlns:d="DAV:"><d:response><d:href>/remote.php/dav/files/u/Ardia%20Sync/</d:href><d:propstat><d:prop><d:resourcetype><d:collection/></d:resourcetype></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response><d:response><d:href>/remote.php/dav/files/u/Ardia%20Sync/abc/</d:href><d:propstat><d:prop><d:resourcetype><d:collection/></d:resourcetype></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response></d:multistatus>"#.utf8)
    let entries = WebDAV.parse(good)
    #expect(entries?.count == 2)
    #expect(WebDAV.children(of: url, in: entries ?? [], strictAbout: WebDAV.isChainName)?.map(\.name) == ["abc"])
    #expect(WebDAV.children(of: url, in: entries ?? [], strictAbout: WebDAV.isChainName)?.first?.isCollection == true)
    #expect(WebDAV.parse(good.prefix(good.count - 30)) == nil)
    #expect(WebDAV.parse(Data("<html><body>Hotel Wi-Fi</body></html>".utf8)) == nil)
    #expect(WebDAV.parse(Data()) == nil)
    let empty = WebDAV.parse(Data(#"<?xml version="1.0"?><d:multistatus xmlns:d="DAV:"/>"#.utf8))
    #expect(empty == [])
    #expect(WebDAV.children(of: url, in: empty ?? [], strictAbout: WebDAV.isChainName) == nil)
    let absolute = Data(#"<d:multistatus xmlns:d="DAV:"><d:response><d:href>https://cloud.test/remote.php/dav/files/u/Ardia%20Sync/</d:href><d:propstat><d:prop><d:resourcetype><d:collection/></d:resourcetype></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response><d:response><d:href>https://cloud.test/remote.php/dav/files/u/Ardia%20Sync/x.nns</d:href><d:propstat><d:prop><d:resourcetype/></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response></d:multistatus>"#.utf8)
    #expect(WebDAV.children(of: url, in: WebDAV.parse(absolute) ?? [], strictAbout: WebDAV.isChainName)?.map(\.name) == ["x.nns"])
  }

  static func multiStatus(_ responses: String) -> Data {
    Data((#"<?xml version="1.0"?><d:multistatus xmlns:d="DAV:">"# + responses + "</d:multistatus>").utf8)
  }

  static let collection = "<d:propstat><d:prop><d:resourcetype><d:collection/></d:resourcetype></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat>"

  @Test func aRootThatFailedIsNeverAnEmptyListing() {
    let url = URL(string: "https://cloud.test/remote.php/dav/files/u/Ardia%20Sync/")!
    let root = "/remote.php/dav/files/u/Ardia%20Sync/"
    let failed = [
      "<d:response><d:href>\(root)</d:href><d:status>HTTP/1.1 503 Service Unavailable</d:status></d:response>",
      "<d:response><d:href>\(root)</d:href><d:propstat><d:prop><d:resourcetype><d:collection/></d:resourcetype></d:prop><d:status>HTTP/1.1 403 Forbidden</d:status></d:propstat></d:response>",
      "<d:response><d:href>\(root)</d:href></d:response>",
      "<d:response><d:href>\(root)</d:href><d:propstat><d:prop><d:getlastmodified>Mon, 01 Jan 2024 00:00:00 GMT</d:getlastmodified></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>",
      "<d:response><d:href>\(root)</d:href>\(Self.collection)<d:status>HTTP/1.1 507 Insufficient Storage</d:status></d:response>",
      "<d:response><d:href>\(root)</d:href><d:propstat><d:prop><d:resourcetype/></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>",
      "<d:response><d:href>\(root)</d:href>\(Self.collection)</d:response><d:response><d:href>\(root)\(SyncKeys.newFileId())/</d:href><d:status>HTTP/1.1 503 Service Unavailable</d:status></d:response>",
    ]
    for body in failed {
      #expect(WebDAV.parse(Self.multiStatus(body)).flatMap { WebDAV.children(of: url, in: $0, strictAbout: WebDAV.isChainName) } == nil, "\(body)")
    }
    let file = "<d:propstat><d:prop><d:resourcetype/></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat><d:propstat><d:prop><d:quota-used-bytes/></d:prop><d:status>HTTP/1.1 404 Not Found</d:status></d:propstat>"
    let id = SyncKeys.newFileId()
    let mixed = "<d:response><d:href>\(root)</d:href>\(Self.collection)</d:response><d:response><d:href>\(root)\(id).nns</d:href>\(file)</d:response><d:response><d:href>\(root)Shared/</d:href><d:status>HTTP/1.1 503 Service Unavailable</d:status></d:response><d:response><d:href>\(root).~lock.x%23</d:href><d:propstat><d:prop><d:resourcetype/></d:prop><d:status>HTTP/1.1 403 Forbidden</d:status></d:propstat></d:response>"
    let entries = WebDAV.parse(Self.multiStatus(mixed)) ?? []
    #expect(WebDAV.children(of: url, in: entries, strictAbout: WebDAV.isChainName)?.map(\.name) == ["\(id).nns"])
    #expect(WebDAV.children(of: url, in: entries, strictAbout: WebDAV.isSyncFileName)?.map(\.name) == ["\(id).nns"])
    let brokenFile = "<d:response><d:href>\(root)</d:href>\(Self.collection)</d:response><d:response><d:href>\(root)\(id).nns</d:href><d:status>HTTP/1.1 503 Service Unavailable</d:status></d:response>"
    #expect(WebDAV.parse(Self.multiStatus(brokenFile)).flatMap { WebDAV.children(of: url, in: $0, strictAbout: WebDAV.isSyncFileName) } == nil)
    #expect(WebDAV.parse(Self.multiStatus(brokenFile)).flatMap { WebDAV.children(of: url, in: $0, strictAbout: WebDAV.isChainName) }?.isEmpty == true)
  }

  @Test func onlyTheExactRequestedCollectionCountsAsTheRoot() {
    let url = URL(string: "https://cloud.test/nc/remote.php/dav/files/u/Ardia%20Sync/")!
    func children(_ root: String) -> [String]? {
      let file = "<d:propstat><d:prop><d:resourcetype/></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat>"
      let body = "<d:response><d:href>\(root)</d:href>\(Self.collection)</d:response><d:response><d:href>\(WebDAV.normalized(root))/x.nns</d:href>\(file)</d:response>"
      return WebDAV.parse(Self.multiStatus(body)).flatMap { WebDAV.children(of: url, in: $0, strictAbout: WebDAV.isChainName) }?.map(\.name)
    }
    #expect(children("/backup/nc/remote.php/dav/files/u/Ardia%20Sync/") == nil)
    #expect(children("/remote.php/dav/files/u/Ardia%20Sync/") == nil)
    #expect(children("/nc/remote.php/dav/files/u/Other/Ardia%20Sync/") == nil)
    #expect(children("https://evil.test/nc/remote.php/dav/files/u/Ardia%20Sync/") == nil)
    #expect(children("http://cloud.test/nc/remote.php/dav/files/u/Ardia%20Sync/") == nil)
    #expect(children("https://cloud.test:8443/nc/remote.php/dav/files/u/Ardia%20Sync/") == nil)
    #expect(children("/nc/remote.php/dav/files/u/Ardia%20Sync/") == ["x.nns"])
    #expect(children("/nc/remote.php/dav/files/u/Ardia Sync") == ["x.nns"])
    #expect(children("https://CLOUD.test:443/nc/remote.php/dav/files/u/Ardia%20Sync") == ["x.nns"])
  }

  @Test func redirectsStayOnTheSameSecureHost() {
    let from = URL(string: "https://cloud.test/nc/remote.php/dav/")
    #expect(SameHostRedirects.allows(from: from, to: URL(string: "https://cloud.test/nc/remote.php/dav/files/")))
    #expect(!SameHostRedirects.allows(from: from, to: URL(string: "https://evil.test/nc/")))
    #expect(!SameHostRedirects.allows(from: from, to: URL(string: "http://cloud.test/nc/")))
    #expect(!SameHostRedirects.allows(from: from, to: URL(string: "https://cloud.test:8443/nc/")))
  }

  @Test func serverAddressesBecomeHttpsAndHttpIsRefused() throws {
    #expect(try NextcloudLogin.serverURL(from: " cloud.example.com/ ").absoluteString == "https://cloud.example.com")
    #expect(try NextcloudLogin.serverURL(from: "https://example.com/nextcloud/index.php").absoluteString == "https://example.com/nextcloud")
    #expect(try NextcloudLogin.serverURL(from: "HTTPS://Cloud.Example.com:8443/nc").absoluteString == "HTTPS://Cloud.Example.com:8443/nc")
    #expect(throws: NextcloudProblem.insecure) { try NextcloudLogin.serverURL(from: "http://cloud.example.com") }
    #expect(throws: NextcloudProblem.self) { try NextcloudLogin.serverURL(from: "   ") }
    #expect(throws: NextcloudProblem.insecure) { try NextcloudClient(transport: .live).sendBlocking(URLRequest(url: URL(string: "http://cloud.example.com/")!)) }
  }

  @Test func loginFlowV2ReturnsTheUserIdAndChecksThePollHost() async throws {
    let sandbox = try Sandbox()
    let server = FakeNextcloud(filesRoot: sandbox.root)
    defer {
      server.shutDown()
      sandbox.remove()
    }
    let login = NextcloudLogin(transport: server.transport())
    let start = try await login.begin(server: server.serverURL)
    #expect(start.loginURL.host() == server.host)
    #expect(try await login.poll(start) == nil)
    server.approveLogin(password: "fresh-password")
    let account = try await login.waitForAccount(start, every: .milliseconds(10), giveUpAfter: .seconds(5))
    #expect(account.userId == server.userId)
    #expect(account.loginName == server.loginName)
    #expect(account.server == server.serverURL)
    #expect(account.appPassword == "fresh-password")

    server.pollHost = "phish.test"
    await #expect(throws: NextcloudProblem.insecure) { try await login.begin(server: server.serverURL) }
  }

  @Test func metaSavedBeforeNextcloudStillLoads() throws {
    let sandbox = try Sandbox()
    defer { sandbox.remove() }
    let files = SyncFiles(directory: sandbox.state)
    try FileManager.default.createDirectory(at: sandbox.state, withIntermediateDirectories: true)
    let old = #"{"deviceId":"olddevice00000000000000000","deviceName":"Test iPhone","folder":{"bookmark":"Ym9va21hcms=","subfolder":"Ardia Sync","name":"Ardia Sync"},"enabled":true,"setupAt":784000000,"lastSyncedAt":784000500,"selectedProfileId":"personal000000000000000000","outOfSync":false,"chainSeen":true}"#
    try Data(old.utf8).write(to: files.metaURL)
    let meta = files.loadMeta()
    #expect(meta.deviceId == "olddevice00000000000000000")
    #expect(meta.deviceName == "Test iPhone")
    #expect(meta.folder?.name == "Ardia Sync")
    #expect(meta.folder?.bookmark == Data("bookmark".utf8))
    #expect(meta.enabled && meta.chainSeen)
    #expect(meta.nextcloud == nil)

    var withNextcloud = meta
    withNextcloud.folder = nil
    withNextcloud.nextcloud = NextcloudLocation(server: "https://cloud.example.com/nc", userId: "u-1", loginName: "alex", path: "Ardia Sync", keychainAccount: "nextcloud-abc")
    try files.saveMeta(withNextcloud)
    #expect(files.loadMeta() == withNextcloud)
  }
}
