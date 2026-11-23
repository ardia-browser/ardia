import Darwin
import Foundation
import Testing
import os

final class FakeCredentialHost: CredentialHost, @unchecked Sendable {
  let epochs = VaultLockEpochs()
  let folder: String
  let script: String
  private let lock = NSLock()
  private var sessions: [String: String] = [:]
  private var remembered: [(String, Bool)] = []
  private var scratchValues: [String: String] = [:]
  private var preferenceValues: [String: String] = [:]
  private var signingIn: [String: VaultCommand] = [:]
  private var run = CredentialSignInRun()
  private var announced = 0
  var touchID: Bool { false }
  var offline: Bool { false }
  var testInstance: Bool { true }

  init() throws {
    folder = try CredentialRunFixture.scratch("host")
    script = CredentialRunFixture.directory.appendingPathComponent("fake-cli.sh").path
  }

  var rememberedSessions: [(String, Bool)] { lock.withLock { remembered } }
  var announcements: Int { lock.withLock { announced } }

  func testFolderBase(_ provider: String) -> String? { folder }
  func ticket(_ provider: String) -> VaultLockEpoch.Ticket { epochs.ticket(provider) }
  func isCurrent(_ ticket: VaultLockEpoch.Ticket) -> Bool { epochs.isCurrent(ticket) }
  func session(_ provider: String) -> String? { lock.withLock { sessions[provider] } }

  func setSession(_ provider: String, _ value: String?) { lock.withLock { sessions[provider] = value } }

  func remember(_ provider: String, session: String, persistent: Bool, ticket: VaultLockEpoch.Ticket) -> Bool {
    epochs.ifCurrent(ticket) {
      lock.withLock {
        sessions[provider] = session
        remembered.append((session, persistent))
      }
    }
  }

  func hasStoredSession(_ provider: String) -> Bool { false }
  var storedWait: Duration = .zero
  func storedSession(_ provider: String, reason: String) async -> String? {
    try? await Task.sleep(for: storedWait)
    return nil
  }
  func dropStoredSession(_ provider: String) {}
  func scratch(_ provider: String) -> [String: String] { lock.withLock { scratchValues } }
  func setScratch(_ provider: String, _ key: String, _ value: String?) { lock.withLock { scratchValues[key] = value } }
  func preferences(_ provider: String) -> [String: String] { lock.withLock { preferenceValues } }
  func setPreference(_ provider: String, _ key: String, _ value: String?) { lock.withLock { preferenceValues[key] = value } }
  func confirmOwner(_ provider: String, reason: String) async -> Bool { true }
  func program(_ name: String) -> CredentialProgram? { CredentialProgram(executable: script, leadingArguments: [], path: script) }
  func environment(for program: CredentialProgram) -> [String: String] { ["PATH": "/usr/bin:/bin", "HOME": folder, "TMPDIR": folder] }

  func startSigningIn(_ provider: String, _ command: VaultCommand) -> VaultCommand? {
    lock.withLock {
      defer { signingIn[provider] = command }
      return signingIn[provider]
    }
  }

  func finishedSigningIn(_ provider: String, _ command: VaultCommand) {
    lock.withLock { if signingIn[provider] === command { signingIn[provider] = nil } }
  }

  func cancelSigningIn(_ provider: String) { lock.withLock { signingIn.removeValue(forKey: provider) }?.cancel() }
  func signInRun(_ provider: String) -> CredentialSignInRun { lock.withLock { run } }
  func setSignInRun(_ provider: String, _ fresh: CredentialSignInRun) { lock.withLock { run = fresh } }
  func announceChange(_ provider: String) { lock.withLock { announced += 1 } }
}

final class RecordingLink: CredentialPluginLink, @unchecked Sendable {
  private let lock = NSLock()
  private var lines: [String] = []
  private var forwardedLines: [String] = []
  private var stops = 0
  private var refusing = false

  var refusesPaced: Bool {
    get { lock.withLock { refusing } }
    set { lock.withLock { refusing = newValue } }
  }
  var sent: [String] { lock.withLock { lines } }
  var forwarded: [String] { lock.withLock { forwardedLines } }
  var stopped: Int { lock.withLock { stops } }

  func send(_ line: String) { lock.withLock { lines.append(line) } }
  func sendPaced(_ batch: [String], then: @escaping @Sendable (Bool) -> Void) {
    let refused = lock.withLock { () -> Bool in
      if !refusing { lines.append(contentsOf: batch) }
      return refusing
    }
    then(!refused)
  }
  func forward(_ line: String) { lock.withLock { forwardedLines.append(line) } }
  func stopRun() { lock.withLock { stops += 1 } }

  func messages() -> [[String: Any]] {
    sent.compactMap { (try? JSONSerialization.jsonObject(with: Data($0.utf8))) as? [String: Any] }
  }

  func reply(to id: Int, within seconds: TimeInterval = 15) async throws -> [String: Any] {
    try await CredentialRunFixture.eventually(seconds) { self.messages().first { ($0["id"] as? Int) == id && $0["method"] == nil } }
  }

  func call(named handler: String, within seconds: TimeInterval = 15) async throws -> [String: Any] {
    try await CredentialRunFixture.eventually(seconds) { self.messages().last { $0["name"] as? String == handler && $0["kind"] as? String == "credentials" } }
  }
}

enum CredentialRunFixture {
  static let directory = URL(fileURLWithPath: #filePath).deletingLastPathComponent().appendingPathComponent("fixtures/credentials")
  static let password = "correct horse battery staple"
  static let key = "fakesession0123456789abcdefKEY"

  static func scratch(_ name: String) throws -> String {
    let path = (NSTemporaryDirectory() as NSString).appendingPathComponent("ardia-credential-\(name)-\(UUID().uuidString)")
    try FileManager.default.createDirectory(atPath: path, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
    return path
  }

  static func contribution() throws -> CredentialContribution {
    let data = try Data(contentsOf: directory.appendingPathComponent("fakewarden.json"))
    guard case .accepted(let parsed) = CredentialCatalogParser.parse(manifest: data) else { throw CancellationError() }
    return parsed
  }

  static func eventually<T>(_ seconds: TimeInterval, _ probe: @escaping () -> T?) async throws -> T {
    let deadline = Date().addingTimeInterval(seconds)
    while Date() < deadline {
      if let found = probe() { return found }
      try await Task.sleep(for: .milliseconds(10))
    }
    return try #require(probe(), "nothing arrived within \(seconds) s")
  }

  static func line(_ object: [String: Any]) -> String {
    String(decoding: try! JSONSerialization.data(withJSONObject: object), as: UTF8.self)
  }

  static func handle(_ id: String) -> [String: Any] { ["$secret": id] }
}

struct CredentialRun {
  let host: FakeCredentialHost
  let link = RecordingLink()
  let endpoint: CredentialRunEndpoint
  var provider: String { endpoint.plugin }
  private static let ids = OSAllocatedUnfairLock(initialState: 1000)

  init(handlers: [String] = ["state", "signIn", "unlock", "signOut", "list", "reveal", "save"], credentials: Any? = 1, ready: Bool = true) async throws {
    host = try FakeCredentialHost()
    endpoint = CredentialRunEndpoint(
      plugin: "fakewarden", run: 1, approved: "approved", attachment: 1, contribution: try CredentialRunFixture.contribution(), host: host, link: link,
      appVersion: "1.41.0")
    var hello: [String: Any] = ["protocol": 2, "sdk": "2.1.0"]
    if let credentials { hello["credentials"] = credentials }
    send(["id": 1, "method": "hello", "params": hello])
    _ = try await link.reply(to: 1)
    guard ready else { return }
    send(["id": 2, "method": "ready", "params": ["commands": [Any](), "credentialProvider": ["handlers": handlers]]])
    _ = await endpoint.waitUntilReady(timeout: 5)
  }

  func send(_ object: [String: Any]) { endpoint.receive(CredentialRunFixture.line(object)) }

  func nextId() -> Int { Self.ids.withLock { value in
    value += 1
    return value
  } }

  func request(_ method: String, _ params: [String: Any]) async throws -> [String: Any] {
    let id = nextId()
    send(["id": id, "method": method, "params": params])
    return try await link.reply(to: id, within: 20)
  }

  func verb(_ call: String, _ verb: String, _ params: [String: Any] = [:], timeoutMs: Int? = nil) async throws -> [String: Any] {
    var body: [String: Any] = ["call": call, "verb": verb, "params": params]
    if let timeoutMs { body["timeoutMs"] = timeoutMs }
    return try await request("credentials.verb", body)
  }

  func open(_ handler: String = "list", input: @escaping @Sendable (inout CredentialCallBuilder) -> [String: Any] = { _ in [:] }) async throws
    -> (call: String, message: [String: Any], answer: Task<CredentialCallAnswer, Never>)
  {
    let before = link.messages().count
    let endpoint = self.endpoint
    let ticket = host.ticket(provider)
    let answer = Task { await endpoint.call(handler, ticket: ticket, input: input) }
    let message = try await CredentialRunFixture.eventually(10) { link.messages().dropFirst(before).first { $0["kind"] as? String == "credentials" } }
    return (try #require(message["call"] as? String), message, answer)
  }

  func finish(_ call: String, result: Any = NSNull()) async throws {
    _ = try await request("result", ["call": call, "result": result])
  }
}

@Suite("Credential runs", .serialized)
struct CredentialRunTests {
  @Test func `hello answers the credentials protocol natively and ready is forwarded re-encoded`() async throws {
    let run = try await CredentialRun()
    let hello = try await run.link.reply(to: 1)
    let credentials = try #require((hello["result"] as? [String: Any])?["credentials"] as? [String: Any])
    #expect(credentials["supported"] as? [Int] == [1])
    #expect(credentials["provider"] as? String == "fakewarden")
    #expect(run.endpoint.isReady)
    let forwarded = try #require(run.link.forwarded.first)
    #expect(forwarded.contains("\"method\":\"ready\""))
    #expect(!forwarded.contains("credentialProvider"))
    let ready = try await run.link.reply(to: 2)
    #expect((ready["result"] as? [String: Any])?["ok"] as? Bool == true)
    #expect(!forwarded.contains("\"id\":2"), "JS answers a ready native already answered, so its reply can't reach the plugin")
  }

  @Test("A plugin speaking another credentials protocol is refused and its provider stays unavailable", arguments: [2, 0])
  func protocolSkew(_ spoken: Int) async throws {
    let run = try await CredentialRun(credentials: spoken == 0 ? nil : spoken)
    let hello = try await run.link.reply(to: 1)
    #expect((hello["error"] as? [String: Any])?["code"] as? String == "refused")
    #expect(run.endpoint.problem?.contains("speaks credentials protocol \(spoken)") == true)
    #expect(!run.endpoint.isReady)
    let answer = await run.endpoint.call("state", ticket: run.host.ticket(run.provider)) { _ in [:] }
    guard case .host(.stopped) = answer else {
      Issue.record("a refused run took a call: \(answer)")
      return
    }
  }

  @Test func `a ready without a required handler, or without the handler a capability needs, makes the run unusable`() async throws {
    let missingList = try await CredentialRun(handlers: ["state", "signIn", "unlock", "signOut", "reveal", "save"])
    #expect(missingList.endpoint.problem == "Fakewarden's plugin is missing list.")
    let missingSave = try await CredentialRun(handlers: ["state", "signIn", "unlock", "signOut", "list", "reveal"])
    #expect(missingSave.endpoint.problem == "Fakewarden's plugin doesn't handle save, which it offers.")
  }

  @Test("Every method other than hello, ready, result and credentials is refused natively", arguments: [
    "storage.get", "secrets.get", "net.fetch", "page.post", "tools.call", "ui.toast", "subscribe", "programs.status", "credentials.anything",
  ])
  func refusedMethods(_ method: String) async throws {
    let run = try await CredentialRun()
    let reply = try await run.request(method, [:])
    #expect((reply["error"] as? [String: Any])?["code"] as? String == "refused")
    #expect((reply["error"] as? [String: Any])?["message"] as? String == CredentialRunEndpoint.refusedMethodMessage)
  }

  @Test func `a line that isn't a JSON object is dropped and counted`() async throws {
    let run = try await CredentialRun()
    let before = run.link.sent.count
    run.endpoint.receive("not json")
    run.endpoint.receive("[1,2]")
    _ = try await run.request("credentials.verb", ["call": "v0", "verb": "status"])
    #expect(run.endpoint.droppedLines == 2)
    #expect(run.link.sent.count == before + 1)
  }

  @Test func `a verb outside an open call is closed, and a result for no call is a bad request`() async throws {
    let run = try await CredentialRun()
    let verb = try await run.verb("v999999", "status")
    #expect((verb["error"] as? [String: Any])?["code"] as? String == "closed")
    let result = try await run.request("result", ["call": "v999999", "result": NSNull()])
    #expect((result["error"] as? [String: Any])?["message"] as? String == "There's no call v999999 waiting.")
  }

  @Test func `a session handle reaches the CLI as its env value and never comes back`() async throws {
    let run = try await CredentialRun()
    run.host.setSession(run.provider, CredentialRunFixture.key)
    let open = try await run.open("state")
    let context = try #require(open.message["context"] as? [String: Any])
    let session = try #require((context["session"] as? [String: Any])?["key"] as? [String: Any])
    let reply = try await run.verb(open.call, "status", ["session": session])
    let result = try #require(reply["result"] as? [String: Any])
    #expect((result["json"] as? [String: Any])?["status"] as? String == "unlocked")
    #expect(!run.link.sent.joined().contains(CredentialRunFixture.key))
    try await run.finish(open.call, result: ["state": "unlocked"])
    guard case .result = await open.answer.value else {
      Issue.record("the call didn't end with its result")
      return
    }
  }

  @Test func `a typed secret survives a failed launch, is spent by a successful one and can't be replayed`() async throws {
    let run = try await CredentialRun()
    let password = CredentialRunFixture.password
    let open = try await run.open("signIn") { builder in ["fields": ["masterPassword": (builder.handle(password) ?? [:]) as Any]] }
    let handle = try #require(((open.message["input"] as? [String: Any])?["fields"] as? [String: Any])?["masterPassword"] as? [String: Any])
    let echoed = try await run.verb(open.call, "echo", ["password": handle])
    let echoedResult = try #require(echoed["result"] as? [String: Any])
    #expect((echoedResult["stderr"] as? String)?.trimmingCharacters(in: .newlines) == "rejected [hidden]")
    let login = try await run.verb(open.call, "login", ["email": "a@example.com", "password": handle])
    let loginResult = try #require(login["result"] as? [String: Any])
    #expect(loginResult["unlocked"] as? Bool == true)
    #expect(run.host.rememberedSessions.map(\.0) == [CredentialRunFixture.key])
    #expect(run.host.rememberedSessions.first?.1 == true)
    let replay = try await run.verb(open.call, "login", ["email": "a@example.com", "password": handle])
    #expect((replay["error"] as? [String: Any])?["code"] as? String == "expired")
    #expect(!run.link.sent.joined().contains(CredentialRunFixture.key))
    #expect(!run.link.sent.joined().contains(password))
    try await run.finish(open.call, result: ["ok": true])
  }

  @Test func `a typed secret ends after three launches even when none succeeds`() async throws {
    let run = try await CredentialRun()
    let open = try await run.open("signIn") { builder in ["password": (builder.handle("wrong password") ?? [:]) as Any] }
    let handle = try #require((open.message["input"] as? [String: Any])?["password"] as? [String: Any])
    for _ in 0..<3 { _ = try await run.verb(open.call, "echo", ["password": handle]) }
    let fourth = try await run.verb(open.call, "echo", ["password": handle])
    #expect((fourth["error"] as? [String: Any])?["code"] as? String == "expired")
    try await run.finish(open.call)
  }

  @Test func `a handle from one call can't be used in another`() async throws {
    let run = try await CredentialRun()
    let first = try await run.open("signIn") { builder in ["password": (builder.handle("first secret value") ?? [:]) as Any] }
    let handle = try #require((first.message["input"] as? [String: Any])?["password"] as? [String: Any])
    let second = try await run.open("unlock")
    let crossed = try await run.verb(second.call, "echo", ["password": handle])
    #expect((crossed["error"] as? [String: Any])?["code"] as? String == "expired")
    try await run.finish(first.call)
    try await run.finish(second.call)
    let after = try await run.verb(first.call, "echo", ["password": handle])
    #expect((after["error"] as? [String: Any])?["code"] as? String == "closed")
  }

  @Test func `a result that carries a handle is invalid`() async throws {
    let run = try await CredentialRun()
    let open = try await run.open("reveal")
    try await run.finish(open.call, result: ["password": CredentialRunFixture.handle("h1")])
    guard case .host(.invalid) = await open.answer.value else {
      Issue.record("a handle in a reveal result was accepted")
      return
    }
  }

  @Test func `the CLI gets only Ardia's own environment and the catalog's entries`() async throws {
    setenv("NODE_OPTIONS", "--require /tmp/evil.js", 1)
    setenv("DYLD_INSERT_LIBRARIES", "/tmp/evil.dylib", 1)
    defer {
      unsetenv("NODE_OPTIONS")
      unsetenv("DYLD_INSERT_LIBRARIES")
    }
    let run = try await CredentialRun()
    let open = try await run.open("state")
    let reply = try await run.verb(open.call, "env")
    let lines = try #require((reply["result"] as? [String: Any])?["lines"] as? [String])
    let names = Set(lines.compactMap { $0.split(separator: "=", maxSplits: 1).first.map(String.init) })
    #expect(!names.contains("NODE_OPTIONS"))
    #expect(!names.contains("DYLD_INSERT_LIBRARIES"))
    #expect(names.isSuperset(of: ["BW_NOINTERACTION", "FAKE_STATE_DIR", "HOME", "PATH"]))
    try await run.finish(open.call)
  }

  @Test func `a denied command is refused at run time after skipping global flags`() async throws {
    let run = try await CredentialRun()
    let open = try await run.open("state")
    let denied = try await run.verb(open.call, "sub", ["word": "serve"])
    #expect((denied["error"] as? [String: Any])?["message"] as? String == "bw serve is never allowed.")
    let allowed = try await run.verb(open.call, "sub", ["word": "status"])
    #expect(allowed["result"] != nil)
    try await run.finish(open.call)
  }

  @Test func `locking ends the call as stale, stops the run and kills the CLI's process group`() async throws {
    let run = try await CredentialRun()
    let open = try await run.open("list")
    let id = run.nextId()
    run.send(["id": id, "method": "credentials.verb", "params": ["call": open.call, "verb": "sleep", "params": ["seconds": "30"]]])
    let pidFile = (run.host.folder as NSString).appendingPathComponent("sleeping.pid")
    let pid = try await CredentialRunFixture.eventually(10) { (try? String(contentsOfFile: pidFile, encoding: .utf8)).flatMap { Int32($0.trimmingCharacters(in: .whitespacesAndNewlines)) } }
    run.host.epochs.advance(run.provider)
    run.endpoint.lockNow()
    guard case .host(.stale) = await open.answer.value else {
      Issue.record("the open call didn't end stale")
      return
    }
    #expect(run.link.stopped == 1)
    _ = try await CredentialRunFixture.eventually(5) { kill(pid, 0) != 0 ? true : nil }
    let after = try await run.verb(open.call, "status")
    #expect((after["error"] as? [String: Any])?["code"] as? String == "closed")
  }

  @Test func `a run that ends mid-call fails the call as stopped`() async throws {
    let run = try await CredentialRun()
    let open = try await run.open("list")
    run.endpoint.ended(crashed: true)
    guard case .host(.stopped) = await open.answer.value else {
      Issue.record("the call didn't end stopped")
      return
    }
    #expect(run.endpoint.isFinished)
  }

  @Test func `a request after the epoch moved is stale`() async throws {
    let run = try await CredentialRun()
    let open = try await run.open("list")
    run.host.epochs.advance(run.provider)
    let stale = try await run.verb(open.call, "status")
    #expect((stale["error"] as? [String: Any])?["code"] as? String == "stale")
    #expect((stale["error"] as? [String: Any])?["message"] as? String == "Fakewarden locked, so this call ended.")
    try await run.finish(open.call)
  }

  @Test func `a verb past its timeout is stopped and says so`() async throws {
    let run = try await CredentialRun()
    let open = try await run.open("list")
    let started = Date()
    let reply = try await run.verb(open.call, "sleep", ["seconds": "30"], timeoutMs: 1000)
    let result = try #require(reply["result"] as? [String: Any])
    #expect(result["timedOut"] as? Bool == true)
    #expect(result["succeeded"] as? Bool == false)
    #expect(Date().timeIntervalSince(started) < 8)
    try await run.finish(open.call)
  }

  @Test func `cancelling the broker's task cancels the call, tells the plugin and kills its verbs`() async throws {
    let run = try await CredentialRun()
    let open = try await run.open("list")
    let id = run.nextId()
    run.send(["id": id, "method": "credentials.verb", "params": ["call": open.call, "verb": "sleep", "params": ["seconds": "30"]]])
    _ = try await CredentialRunFixture.eventually(10) { run.endpoint.runningVerbs == 1 ? true : nil }
    open.answer.cancel()
    guard case .host(.cancelled) = await open.answer.value else {
      Issue.record("the call didn't end cancelled")
      return
    }
    #expect(run.link.messages().contains { $0["call"] as? String == open.call && $0["cancel"] as? Bool == true })
    _ = try await CredentialRunFixture.eventually(10) { run.endpoint.runningVerbs == 0 ? true : nil }
  }

  @Test func `at most four CLI runs at once`() async throws {
    let run = try await CredentialRun()
    let open = try await run.open("list")
    for _ in 0..<4 {
      run.send(["id": run.nextId(), "method": "credentials.verb", "params": ["call": open.call, "verb": "sleep", "params": ["seconds": "20"]]])
    }
    _ = try await CredentialRunFixture.eventually(10) { run.endpoint.runningVerbs == 4 ? true : nil }
    let fifth = try await run.verb(open.call, "status")
    #expect((fifth["error"] as? [String: Any])?["message"] as? String == "Fakewarden has 4 commands running.")
    try await run.finish(open.call)
    _ = try await CredentialRunFixture.eventually(10) { run.endpoint.runningVerbs == 0 ? true : nil }
  }

  @Test func `a reused request id can't start a second CLI past the cap, and lock still kills every CLI`() async throws {
    let run = try await CredentialRun()
    let open = try await run.open("list")
    let id = run.nextId()
    let pidFile = (run.host.folder as NSString).appendingPathComponent("sleeping.pid")
    run.send(["id": id, "method": "credentials.verb", "params": ["call": open.call, "verb": "sleep", "params": ["seconds": "30"]]])
    let pid = try await CredentialRunFixture.eventually(10) { (try? String(contentsOfFile: pidFile, encoding: .utf8)).flatMap { Int32($0.trimmingCharacters(in: .whitespacesAndNewlines)) } }
    run.send(["id": id, "method": "credentials.verb", "params": ["call": open.call, "verb": "sleep", "params": ["seconds": "30"]]])
    let duplicate = try await run.link.reply(to: id, within: 10)
    #expect((duplicate["error"] as? [String: Any])?["code"] as? String == "bad_request")
    #expect(run.endpoint.runningVerbs == 1)
    run.host.epochs.advance(run.provider)
    run.endpoint.lockNow()
    _ = await open.answer.value
    _ = try await CredentialRunFixture.eventually(5) { kill(pid, 0) != 0 ? true : nil }
    #expect(run.endpoint.runningVerbs == 0)
  }

  @Test func `a secret field typed as plain text never reaches the plugin on the first sign-in step`() async throws {
    let run = try await CredentialRun()
    let provider = PluginVaultProvider(contribution: try CredentialRunFixture.contribution(), host: run.host, wantRun: { _ in }, openApproval: { _, _ in })
    provider.attach(run.endpoint)
    let cli = VaultCLI(provider: "fakewarden", path: run.host.script, environment: [:], host: NoCLIHost(), epochs: run.host.epochs)
    let signing = Task { await provider.signIn(cli, fields: VaultSignInFields(method: "password", values: ["email": "a@example.com", "masterPassword": "typed in plain"], secrets: [:])) }
    let message = try await run.link.call(named: "signIn")
    let fields = try #require((message["input"] as? [String: Any])?["fields"] as? [String: Any])
    #expect(fields["email"] as? String == "a@example.com")
    #expect(fields["masterPassword"] == nil)
    #expect(!run.link.sent.joined().contains("typed in plain"))
    try await run.finish(try #require(message["call"] as? String), result: ["outcome": "failed", "problem": "wrongCredentials"])
    _ = await signing.value
  }

  @Test func `one caller's wait for ready running out doesn't end another caller's longer wait`() async throws {
    let run = try await CredentialRun(ready: false)
    let endpoint = run.endpoint
    let short = Task { await endpoint.waitUntilReady(timeout: 0.2) }
    let long = Task { await endpoint.waitUntilReady(timeout: 10) }
    #expect(await short.value == false)
    try await Task.sleep(for: .milliseconds(300))
    run.send(["id": 2, "method": "ready", "params": ["commands": [Any](), "credentialProvider": ["handlers": ["state", "signIn", "unlock", "signOut", "list", "reveal", "save"]]]])
    #expect(await long.value == true)
  }

  @Test func `a big listing streams one item per line before its reply`() async throws {
    let run = try await CredentialRun()
    let open = try await run.open("list")
    let key = CredentialRunFixture.key
    run.host.setSession(run.provider, key)
    let session = try await run.open("list")
    let handle = try #require(((session.message["context"] as? [String: Any])?["session"] as? [String: Any])?["key"] as? [String: Any])
    let reply = try await run.verb(session.call, "list.items", ["session": handle, "count": "20000"])
    let result = try #require(reply["result"] as? [String: Any])
    #expect(result["items"] as? Int == 20000)
    #expect((result["json"] as? [Any])?.isEmpty == true)
    let messages = run.link.messages()
    let replyIndex = try #require(messages.firstIndex { ($0["result"] as? [String: Any])?["items"] as? Int == 20000 })
    let items = messages.prefix(replyIndex).filter { $0["item"] != nil }
    #expect(items.count == 20000)
    #expect(items.allSatisfy { !(String(describing: $0)).contains(key) })
    try await run.finish(open.call)
    try await run.finish(session.call)
  }

  @Test func `a listing the link can't hold fails as overflowed with none of its items`() async throws {
    let run = try await CredentialRun()
    run.link.refusesPaced = true
    run.host.setSession(run.provider, CredentialRunFixture.key)
    let session = try await run.open("list")
    let handle = try #require(((session.message["context"] as? [String: Any])?["session"] as? [String: Any])?["key"] as? [String: Any])
    let reply = try await run.verb(session.call, "list.items", ["session": handle, "count": "200"])
    let result = try #require(reply["result"] as? [String: Any])
    #expect(result["overflowed"] as? Bool == true)
    #expect(result["succeeded"] as? Bool == false)
    #expect(result["items"] as? Int == 0)
    #expect(!run.link.messages().contains { $0["item"] != nil })
    try await run.finish(session.call)
  }

  @Test func `a big JSON value without items comes in parts`() async throws {
    let run = try await CredentialRun()
    run.host.setSession(run.provider, CredentialRunFixture.key)
    let open = try await run.open("list")
    let handle = try #require(((open.message["context"] as? [String: Any])?["session"] as? [String: Any])?["key"] as? [String: Any])
    let reply = try await run.verb(open.call, "list.json", ["session": handle, "count": "4000"])
    let result = try #require(reply["result"] as? [String: Any])
    let parts = try #require(result["parts"] as? Int)
    #expect(parts > 1)
    #expect(result["json"] is NSNull)
    #expect(run.link.messages().filter { $0["part"] != nil }.count == parts)
    try await run.finish(open.call)
  }

  @Test func `stream lines arrive while the call is open, before the reply`() async throws {
    let run = try await CredentialRun()
    let open = try await run.open("signIn")
    let reply = try await run.verb(open.call, "stream", ["count": "3"])
    let messages = run.link.messages()
    let replyIndex = try #require(messages.firstIndex { ($0["id"] as? Int) == (reply["id"] as? Int) && $0["result"] != nil })
    let texts = messages.prefix(replyIndex).compactMap { ($0["line"] as? [String: Any])?["text"] as? String }
    #expect(texts.prefix(3) == ["line 1", "line 2", "line 3"])
    #expect(texts.contains("warning 4"))
    try await run.finish(open.call)
  }

  @Test func `Touch ID is asked one at a time, and its reason is short plain text`() async throws {
    let run = try await CredentialRun()
    run.host.storedWait = .seconds(1)
    let open = try await run.open("unlock")
    let first = run.nextId()
    run.send(["id": first, "method": "credentials.session.takeStored", "params": ["call": open.call, "reason": "unlock Fakewarden"]])
    let second = try await run.request("credentials.session.takeStored", ["call": open.call, "reason": "unlock Fakewarden"])
    #expect((second["error"] as? [String: Any])?["code"] as? String == "overloaded")
    #expect((try await run.link.reply(to: first))["result"] != nil)
    for reason in ["unlock Fake\u{0301}warden", "unlock\u{200B}Fakewarden", String(repeating: "\u{1D538}", count: 60)] {
      let refused = try await run.request("credentials.session.takeStored", ["call": open.call, "reason": reason])
      #expect((refused["error"] as? [String: Any])?["code"] as? String == "bad_request", "\(reason.unicodeScalars.count) scalars")
    }
    try await run.finish(open.call)
  }

  @Test func `values the plugin keeps are checked`() async throws {
    let run = try await CredentialRun()
    let open = try await run.open("list")
    let fine = try await run.request("credentials.values.set", ["call": open.call, "store": "scratch", "key": "syncedAt", "value": "1700000000000"])
    #expect((fine["result"] as? [String: Any])?["ok"] as? Bool == true)
    #expect(run.host.scratch(run.provider)["syncedAt"] == "1700000000000")
    let badKey = try await run.request("credentials.values.set", ["call": open.call, "store": "scratch", "key": "a b", "value": "x"])
    #expect((badKey["error"] as? [String: Any])?["code"] as? String == "bad_request")
    let tooBig = try await run.request("credentials.values.set", ["call": open.call, "store": "preferences", "key": "k", "value": String(repeating: "v", count: 1025)])
    #expect((tooBig["error"] as? [String: Any])?["code"] as? String == "bad_request")
    try await run.finish(open.call)
  }
}

final class NodePluginLink: CredentialPluginLink, @unchecked Sendable {
  let process = Process()
  private let input = Pipe()
  private let output = Pipe()
  private let lock = NSLock()
  private var partial = Data()
  var endpoint: CredentialRunEndpoint?
  private var stops = 0

  var stopped: Int { lock.withLock { stops } }

  init(node: String) throws {
    process.executableURL = URL(fileURLWithPath: node)
    process.arguments = [CredentialRunFixture.directory.appendingPathComponent("fake-plugin.mjs").path]
    process.standardInput = input
    process.standardOutput = output
    process.standardError = FileHandle.nullDevice
    output.fileHandleForReading.readabilityHandler = { [weak self] handle in self?.take(handle.availableData) }
    try process.run()
  }

  private func take(_ data: Data) {
    let lines = lock.withLock { () -> [String] in
      partial.append(data)
      var found: [String] = []
      while let newline = partial.firstIndex(of: 10) {
        found.append(String(decoding: partial[partial.startIndex..<newline], as: UTF8.self))
        partial = Data(partial[partial.index(after: newline)...])
      }
      return found
    }
    lines.forEach { endpoint?.receive($0) }
  }

  func send(_ line: String) { try? input.fileHandleForWriting.write(contentsOf: Data((line + "\n").utf8)) }
  func sendPaced(_ lines: [String], then: @escaping @Sendable (Bool) -> Void) {
    lines.forEach(send)
    then(true)
  }

  func forward(_ line: String) {
    guard let object = (try? JSONSerialization.jsonObject(with: Data(line.utf8))) as? [String: Any], let id = object["id"] else { return }
    send(CredentialRunFixture.line(["id": id, "result": ["ok": true]]))
  }

  func stopRun() {
    lock.withLock { stops += 1 }
    process.terminate()
  }

  static func node() -> String? {
    ["/opt/homebrew/bin/node", "/usr/local/bin/node", "/usr/bin/node"].first { FileManager.default.isExecutableFile(atPath: $0) }
  }
}

struct NoCLIHost: VaultCLIHost {
  var touchID: Bool { false }
  func session(_ provider: String) -> String? { nil }
  func remember(_ provider: String, session: String, persistent: Bool) {}
  func hasStoredSession(_ provider: String) -> Bool { false }
  func storedSession(_ provider: String, reason: String) async -> String? { nil }
  func dropStored(_ provider: String) {}
  func value(_ provider: String, _ key: String) -> String? { nil }
  func setValue(_ provider: String, _ key: String, _ value: String?) {}
  func preference(_ provider: String, _ key: String) -> String? { nil }
  func setPreference(_ provider: String, _ key: String, _ value: String?) {}
  func setRunning(_ provider: String, _ command: VaultCommand) -> VaultCommand? { nil }
  func finishedRunning(_ provider: String, _ command: VaultCommand) {}
  func isRunning(_ provider: String) -> Bool { false }
  func cancelRunning(_ provider: String) -> Bool { false }
  func confirmOwner(_ provider: String, reason: String) async -> Bool { true }
  func announceChange(_ provider: String) {}
}

@Suite("A plugin provider end to end", .serialized, .enabled(if: NodePluginLink.node() != nil, "needs node to run the fake JS plugin"))
struct PluginProviderEndToEndTests {
  struct Rig {
    let host: FakeCredentialHost
    let link: NodePluginLink
    let provider: PluginVaultProvider
    let endpoint: CredentialRunEndpoint
    let wanted = OSAllocatedUnfairLock(initialState: 0)

    init() throws {
      host = try FakeCredentialHost()
      link = try NodePluginLink(node: try #require(NodePluginLink.node()))
      let contribution = try CredentialRunFixture.contribution()
      endpoint = CredentialRunEndpoint(
        plugin: "fakewarden", run: 1, approved: "approved", attachment: 1, contribution: contribution, host: host, link: link, appVersion: "1.41.0")
      link.endpoint = endpoint
      let counter = wanted
      provider = PluginVaultProvider(contribution: contribution, host: host, wantRun: { _ in counter.withLock { $0 += 1 } }, openApproval: { _, _ in })
    }

    func cli() -> VaultCLI {
      VaultCLI(provider: "fakewarden", path: host.script, environment: [:], host: NoCLIHost(), epochs: host.epochs)
    }

    func ready() async throws {
      #expect(await endpoint.waitUntilReady(timeout: 15))
      provider.attach(endpoint)
    }
  }

  @Test func `a fake JS plugin signs in, lists and reveals through the native transport and a fake CLI`() async throws {
    let rig = try Rig()
    defer { rig.link.stopRun() }
    try await rig.ready()
    let signedOut = await rig.provider.state(rig.cli())
    #expect(signedOut.state == .signedOut)
    #expect(signedOut.plugin == "fakewarden")
    #expect(signedOut.signIn?.methods.first?.fields.map(\.id) == ["email", "masterPassword"])

    let wrongToken = "entry-\(UUID().uuidString.prefix(8))"
    VaultSecretEntries.set(wrongToken, "not the password")
    let wrong = await rig.provider.signIn(rig.cli(), fields: VaultSignInFields(method: "password", values: ["email": "a@example.com"], secrets: ["masterPassword": wrongToken]))
    #expect(!wrong.ok)
    #expect(wrong.error == "The email or master password isn't right.")
    #expect(wrong.field == "masterPassword")

    let token = "entry-\(UUID().uuidString.prefix(8))"
    VaultSecretEntries.set(token, CredentialRunFixture.password)
    let signedIn = await rig.provider.signIn(rig.cli(), fields: VaultSignInFields(method: "password", values: ["email": "a@example.com"], secrets: ["masterPassword": token]))
    #expect(signedIn.ok)
    #expect(rig.host.session("fakewarden") == CredentialRunFixture.key)

    let unlocked = await rig.provider.state(rig.cli())
    #expect(unlocked.state == .unlocked)
    #expect(unlocked.account == "a@example.com")
    #expect(unlocked.server == "Fakewarden.com")

    let list = try await rig.provider.items(rig.cli())
    #expect(list.items.map(\.id) == ["item-1", "item-2", "item-3"])
    #expect(list.passwords["item-2"] == "pw-2-secret")
    #expect(list.items.allSatisfy { $0.provider == "fakewarden" })

    let password = try await rig.provider.secret(rig.cli(), id: "item-3", field: .password)
    #expect(password == "pw-3-secret")
    await #expect(throws: VaultError.notFound) { try await rig.provider.secret(rig.cli(), id: "nothing", field: .password) }
    await #expect(throws: VaultError.unsupported) {
      try await rig.provider.save(rig.cli(), login: VaultNewLogin(title: "x", username: "y", password: "z", url: "https://x.example"))
    }
  }

  @Test func `locking kills the plugin's run, and the next call asks for a new run instead of hanging`() async throws {
    let rig = try Rig()
    try await rig.ready()
    rig.host.epochs.advance("fakewarden")
    rig.provider.locked()
    #expect(rig.link.stopped == 1)
    _ = try await CredentialRunFixture.eventually(10) { rig.link.process.isRunning ? nil : true }
    let started = Date()
    let state = await rig.provider.state(rig.cli())
    #expect(state.state == .unavailable)
    #expect(rig.wanted.withLock { $0 } == 1)
    #expect(Date().timeIntervalSince(started) < CredentialLimits.runWait + 5)
  }

  @Test func `an unlock that needs the master password asks for that field`() async throws {
    let rig = try Rig()
    defer { rig.link.stopRun() }
    try await rig.ready()
    let result = await rig.provider.unlock(rig.cli(), password: nil)
    #expect(!result.ok)
    #expect(result.needs == .password)
    #expect(result.field == "masterPassword")
    #expect(result.error == "Enter your master password.")
    #expect(result.state.needs?.field == "masterPassword")
  }
}
