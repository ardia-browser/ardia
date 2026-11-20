import Foundation
import Testing
import os

final class FakeHost: VaultCLIHost, @unchecked Sendable {
  private struct State {
    var sessions: [String: String] = [:]
    var values: [String: String] = [:]
    var preferences: [String: String] = [:]
    var running: [String: VaultCommand] = [:]
    var stored: [String: String] = [:]
  }

  private let state = OSAllocatedUnfairLock(initialState: State())
  let touchID: Bool
  let ownerAnswer: Bool

  init(session: [String: String] = [:], touchID: Bool = false, ownerAnswer: Bool = true) {
    self.touchID = touchID
    self.ownerAnswer = ownerAnswer
    state.withLock { $0.sessions = session }
  }

  func session(_ provider: String) -> String? { state.withLock { $0.sessions[provider] } }
  func remember(_ provider: String, session: String, persistent: Bool) {
    state.withLock {
      $0.sessions[provider] = session
      if persistent { $0.stored[provider] = session }
    }
  }
  func hasStoredSession(_ provider: String) -> Bool { state.withLock { $0.stored[provider] != nil } }
  func storedSession(_ provider: String, reason: String) async -> String? { state.withLock { $0.stored[provider] } }
  func dropStored(_ provider: String) { state.withLock { $0.stored[provider] = nil } }
  func value(_ provider: String, _ key: String) -> String? { state.withLock { $0.values["\(provider)/\(key)"] } }
  func setValue(_ provider: String, _ key: String, _ value: String?) { state.withLock { $0.values["\(provider)/\(key)"] = value } }
  func preference(_ provider: String, _ key: String) -> String? { state.withLock { $0.preferences["\(provider)/\(key)"] } }
  func setPreference(_ provider: String, _ key: String, _ value: String?) { state.withLock { $0.preferences["\(provider)/\(key)"] = value } }
  func setRunning(_ provider: String, _ command: VaultCommand) -> VaultCommand? {
    state.withLock { state in
      let previous = state.running[provider]
      state.running[provider] = command
      return previous
    }
  }
  func finishedRunning(_ provider: String, _ command: VaultCommand) {
    state.withLock { if $0.running[provider] === command { $0.running[provider] = nil } }
  }
  func isRunning(_ provider: String) -> Bool { state.withLock { $0.running[provider] != nil } }
  @discardableResult func cancelRunning(_ provider: String) -> Bool {
    let command = state.withLock { $0.running.removeValue(forKey: provider) }
    command?.cancel()
    return command != nil
  }
  func confirmOwner(_ provider: String, reason: String) async -> Bool { ownerAnswer }
  func announceChange(_ provider: String) {}
}

struct FakeTool {
  let directory: URL
  let path: String

  struct Reply: Sendable {
    var match: String
    var body: String
  }

  static func reply(_ match: String, stdout: String = "", stderr: String = "", exit: Int32 = 0) -> Reply {
    var body = ""
    if !stdout.isEmpty { body += "cat <<'ARDIA_OUT'\n\(stdout)\nARDIA_OUT\n" }
    if !stderr.isEmpty { body += "cat >&2 <<'ARDIA_ERR'\n\(stderr)\nARDIA_ERR\n" }
    body += "exit \(exit)"
    return Reply(match: match, body: body)
  }

  static func run(_ match: String, _ body: String) -> Reply { Reply(match: match, body: body) }

  init(_ name: String, _ replies: [Reply]) {
    directory = FileManager.default.temporaryDirectory.appendingPathComponent("ardia-fake-\(name)-\(UUID().uuidString)", isDirectory: true)
    try? FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    let file = directory.appendingPathComponent(name)
    var script = "#!/bin/sh\necho \"$*\" >> \"\(directory.path)/calls\"\ncase \"$*\" in\n"
    for reply in replies { script += "  \(Self.pattern(reply.match)))\n\(reply.body)\n  ;;\n" }
    script += "  *) echo \"unknown command: $*\" >&2; exit 64 ;;\nesac\n"
    try? script.write(to: file, atomically: true, encoding: .utf8)
    chmod(file.path, 0o755)
    path = file.path
  }

  static func pattern(_ match: String) -> String {
    match.split(separator: "*", omittingEmptySubsequences: false).map { $0.isEmpty ? "" : "'\($0)'" }.joined(separator: "*")
  }

  var calls: [String] {
    let text = (try? String(contentsOf: directory.appendingPathComponent("calls"), encoding: .utf8)) ?? ""
    return text.split(separator: "\n").map(String.init)
  }

  func file(_ name: String) -> String { (try? String(contentsOf: directory.appendingPathComponent(name), encoding: .utf8)) ?? "" }

  func cli(_ provider: String, host: FakeHost) -> VaultCLI {
    VaultCLI(provider: provider, path: path, environment: ["PATH": "/usr/bin:/bin", "FAKE_DIR": directory.path], host: host)
  }
}

enum ProviderFixture {
  static let password = "fixture-" + "pw-1"
  static let newPassword = "fixture-" + "pw-2"
  static let typedPassword = "fixture-" + "typed-1"
  static let sessionKey = "fixture-" + "session-key-1"
  static let storedSession = "fixture-" + "stored-session-1"
  static let clientSecret = "fixture-" + "client-1"
  static let accessToken = "fixture-" + "token-1"
  static let slowTool = #"/bin/sleep 10 & echo $! > "$FAKE_DIR/child"; wait; echo done > "$FAKE_DIR/finished""#
  static let signedOut = #"{"serverUrl":null,"status":"unauthenticated"}"#

  static let onePasswordItems = """
    [{"id":"abcdefghijklmnopqrstuvwxyz","title":"Example","additional_information":"me@example.com","urls":[{"href":"https://example.com"}],"vault":{"name":"Private"},"updated_at":"2026-01-02T03:04:05.678Z"}]
    """

  static let bitwardenItems = #"""
    [{"id":"11111111-2222-3333-4444-555555555555","type":1,"name":"Example","revisionDate":"2026-01-02T03:04:05.000Z","login":{"username":"me","password":"\#(password)","uris":[{"uri":"https://example.com","match":null}]}}]
    """#

  static func failure<T>(_ work: () async throws -> T) async -> VaultError? {
    do {
      _ = try await work()
      return nil
    } catch let error as VaultError {
      return error
    } catch {
      return .failed("\(error)")
    }
  }

  static func isFailed(_ error: VaultError?) -> Bool {
    if case .failed? = error { return true }
    return false
  }

  static func waitUntil(seconds: Double, _ done: () -> Bool) async {
    let deadline = ContinuousClock.now + .seconds(seconds)
    while ContinuousClock.now < deadline, done() == false { try? await Task.sleep(for: .milliseconds(10)) }
  }

  static func childStopped(_ tool: FakeTool) async -> Bool {
    let child = Int32(tool.file("child").trimmingCharacters(in: .whitespacesAndNewlines)) ?? 0
    await waitUntil(seconds: 3) { child > 0 && kill(child, 0) != 0 }
    return child > 0 && kill(child, 0) != 0
  }
}

@Suite("Provider JSON and versions")
struct VaultProviderJSONTests {
  @Test("Lists read only from well-formed JSON", arguments: [
    ("[WARN] 2026/11/15 10:00:00 a newer version is available\n[{\"id\":\"a\"}]", 1 as Int?),
    ("[]", 0),
    ("garbage", nil),
    ("[{\"id\":\"a\"},{\"id\"", nil),
    ("{\"items\":[]}", nil),
  ])
  func list(text: String, count: Int?) {
    #expect((try? VaultJSON.list(Data(text.utf8), from: "Tool"))?.count == count)
  }

  @Test func `a reply buried under a large banner is not searched past the banner limit`() {
    let banner = String(repeating: "n", count: 70 * 1024) + "\n"
    let truncated = String(repeating: "[{\"id\":\"a\"},", count: 200_000)
    let started = ContinuousClock.now
    #expect((try? VaultJSON.list(Data((banner + "[{\"id\":\"a\"}]").utf8), from: "Tool")) == nil)
    #expect((try? VaultJSON.list(Data(truncated.utf8), from: "Tool")) == nil)
    #expect(ContinuousClock.now - started < .seconds(5))
  }

  @Test func `a list where an object belongs is an error`() {
    #expect((try? VaultJSON.record(Data("[1]".utf8), from: "Tool")) == nil)
  }

  @Test("Internet dates read as milliseconds", arguments: [
    ("2026-01-02T03:04:05.678Z", 1_767_323_045_678 as Int64?),
    ("2026-01-02T03:04:05Z", 1_767_323_045_000),
    ("2026-01-02T03:04:05", 1_767_323_045_000),
    ("not a date", nil),
  ])
  func dates(text: String, milliseconds: Int64?) {
    #expect(VaultJSON.milliseconds(text).map(Int64.init) == milliseconds)
  }

  @Test func `seconds become milliseconds`() {
    #expect(VaultJSON.milliseconds(1_767_323_045) == 1_767_323_045_000)
  }

  @Test("The version is the dotted number, not the last word", arguments: [
    ("pass-cli 1.4.2 (abc123)", "1.4.2"), ("2.32.0", "2.32.0"),
  ])
  func version(text: String, version: String) {
    #expect(VaultCLI.versionNumber(in: text) == version)
  }
}

@Suite("Bitwarden URI match modes")
struct BitwardenURIMatchTests {
  @Test("Each Bitwarden match mode maps to an Ardia rule", arguments: [
    (nil as Int?, "host" as String?), (0, ""), (1, "host"), (2, "exact"), (3, "exact"), (4, nil), (5, nil),
  ])
  func mode(match: Int?, rule: String?) {
    #expect(BitwardenVault.urlMatch(match) == rule)
  }
}

@Suite("Background reads")
struct VaultProviderBackgroundTests {
  let now = Date(timeIntervalSince1970: 1_000_000)

  @Test func `1Password reads ahead only within its authorization window`() {
    let onePassword = OnePasswordVault()
    #expect(onePassword.staysQuiet(lastAuthorized: nil, now: now) == false)
    #expect(onePassword.staysQuiet(lastAuthorized: now.addingTimeInterval(-300), now: now))
    #expect(onePassword.staysQuiet(lastAuthorized: now.addingTimeInterval(-601), now: now) == false)
  }

  @Test func `a manager without an app prompt always reads ahead`() {
    #expect(BitwardenVault().staysQuiet(lastAuthorized: nil, now: now))
  }
}

@Suite("Typed passwords")
struct VaultTypedPasswordTests {
  @Test func `a live typed-password token resolves to what was typed and sign-in fields read it`() {
    let token = VaultSecretEntries.prefix + "typed-\(UUID().uuidString.prefix(8))"
    VaultSecretEntries.set(token, ProviderFixture.typedPassword)
    #expect(VaultTypedPassword(token) == .typed(ProviderFixture.typedPassword))
    let fields = VaultSignInFields(json: #"{"email":" me@example.com ","passwordEntry":"\#(token)","code":"123 456"}"#)
    #expect(fields.email == "me@example.com")
    #expect(fields.password == ProviderFixture.typedPassword)
    #expect(fields.code == "123456")
  }

  @Test func `a token whose entry is gone is expired, never sent as a password`() {
    #expect(VaultTypedPassword(VaultSecretEntries.prefix + "gone-\(UUID().uuidString.prefix(8))") == .expired)
  }

  @Test func `no password asks for Touch ID or a stored session`() {
    #expect(VaultTypedPassword(nil) == VaultTypedPassword.none)
  }

  @Test func `an expired entry asks for the master password again, naming the manager`() {
    let expired = BitwardenVault().typedPasswordExpired(nil)
    #expect(expired.ok == false)
    #expect(expired.needs == .password)
    #expect(expired.entryExpired == true)
    #expect(expired.error == "Type your Bitwarden master password again.")
  }
}

@Suite("Provider tools", .serialized)
struct VaultProviderToolTests {
  @Suite("1Password")
  struct OnePassword {
    let host = FakeHost(session: ["1password": "1password-app"])
    let vault = OnePasswordVault()
    let login = VaultNewLogin(title: "Example", username: "me@example.com", password: ProviderFixture.password, url: "https://example.com")
    let created = #"{"id":"abcdefghijklmnopqrstuvwxyz","title":"Example","vault":{"name":"Private"}}"#
    let kept = #"""
      {"id":"abcdefghijklmnopqrstuvwxyz","fields":[{"id":"username","purpose":"USERNAME","value":"me@example.com"},{"id":"password","purpose":"PASSWORD","type":"CONCEALED","value":"\#(ProviderFixture.password)"}]}
      """#
    let vaults = #"[{"id":"vvvvvvvvvvvvvvvvvvvvvvvvvv","name":"Private"},{"id":"wwwwwwwwwwwwwwwwwwwwwwwwww","name":"Family"}]"#
    let shared = #"[{"id":"wwwwwwwwwwwwwwwwwwwwwwwwww","name":"Family"},{"id":"xxxxxxxxxxxxxxxxxxxxxxxxxx","name":"Work"}]"#

    @Test func `items read from good JSON`() async {
      let tool = FakeTool("op", [FakeTool.reply("item list*", stdout: ProviderFixture.onePasswordItems)])
      let items = try? await vault.items(tool.cli("1password", host: host))
      #expect(items?.items.first?.username == "me@example.com")
    }

    @Test func `items read past a notice`() async {
      let tool = FakeTool("op", [FakeTool.reply("item list*", stdout: "[INFO] update available\n" + ProviderFixture.onePasswordItems)])
      let items = try? await vault.items(tool.cli("1password", host: host))
      #expect(items?.items.count == 1)
    }

    @Test("Unreadable output is an error, never an empty vault", arguments: ["<html>proxy error</html>", "[{\"id\":\"abc\",\"title\"", ""])
    func unreadable(stdout: String) async {
      let tool = FakeTool("op", [FakeTool.reply("item list*", stdout: stdout)])
      let error = await ProviderFixture.failure { try await vault.items(tool.cli("1password", host: host)) }
      #expect(ProviderFixture.isFailed(error))
    }

    @Test func `a signed-out 1Password reads as locked`() async {
      let tool = FakeTool("op", [FakeTool.reply("item list*", stderr: "[ERROR] 2026/11/15 10:00:00 not currently signed in", exit: 1)])
      let locked = await ProviderFixture.failure { try await vault.items(tool.cli("1password", host: host)) }
      #expect(locked == .locked)
    }

    @Test func `runaway output is an error`() async {
      let tool = FakeTool("op", [FakeTool.run("item list*", "exec /usr/bin/yes")])
      let huge = await ProviderFixture.failure { try await vault.items(tool.cli("1password", host: host)) }
      #expect(ProviderFixture.isFailed(huge))
    }

    @Test func `cancelling a hung read stops it promptly`() async {
      let tool = FakeTool("op", [FakeTool.run("item list*", "exec /bin/sleep 30")])
      let started = ContinuousClock.now
      let hung = tool.cli("1password", host: host)
      let vault = vault
      let waiting = Task { @Sendable in await ProviderFixture.failure { try await vault.items(hung) } }
      await ProviderFixture.waitUntil(seconds: 5) { tool.calls.contains { $0.hasPrefix("item list") } }
      waiting.cancel()
      let stopped = await waiting.value
      #expect(ProviderFixture.isFailed(stopped))
      #expect(ContinuousClock.now - started < .seconds(5))
    }

    @Test func `a login is saved into the private vault with the password only on stdin`() async throws {
      let tool = FakeTool("op", [
        FakeTool.reply("vault list*", stdout: vaults),
        FakeTool.run("item create*", "cat > \"$FAKE_DIR/template\"\ncat <<'ARDIA_OUT'\n\(created)\nARDIA_OUT"),
        FakeTool.reply("item get*", stdout: kept),
      ])
      let saved = try await vault.save(tool.cli("1password", host: host), login: login)
      #expect(saved.id == "abcdefghijklmnopqrstuvwxyz")
      let create = try #require(tool.calls.first { $0.hasPrefix("item create") })
      #expect(create.hasPrefix("item create - "))
      #expect(create.contains("--vault=vvvvvvvvvvvvvvvvvvvvvvvvvv"))
      #expect(create.contains(ProviderFixture.password) == false)
      #expect(tool.file("template").contains(ProviderFixture.password))
      #expect(tool.calls.contains { $0.hasPrefix("item get abcdefghijklmnopqrstuvwxyz") && $0.contains("--reveal") })
    }

    @Test func `a login saved without its password is reported, not claimed as saved`() async {
      let bare = #"{"id":"abcdefghijklmnopqrstuvwxyz","fields":[]}"#
      let tool = FakeTool("op", [
        FakeTool.reply("vault list*", stdout: vaults),
        FakeTool.reply("item create*", stdout: created),
        FakeTool.reply("item get*", stdout: bare),
        FakeTool.reply("item edit*", stdout: bare),
      ])
      let incomplete = await ProviderFixture.failure { try await vault.save(tool.cli("1password", host: host), login: login) }
      #expect(ProviderFixture.isFailed(incomplete))
      #expect(tool.calls.contains { $0.hasPrefix("item edit abcdefghijklmnopqrstuvwxyz") })
    }

    @Test func `with only shared vaults, 1Password saves nothing`() async {
      let tool = FakeTool("op", [
        FakeTool.reply("vault list*", stdout: shared),
        FakeTool.reply("vault get*", stdout: #"{"type":"USER_CREATED"}"#),
        FakeTool.reply("item create*", stdout: created),
      ])
      let unknown = await ProviderFixture.failure { try await vault.save(tool.cli("1password", host: host), login: login) }
      #expect(ProviderFixture.isFailed(unknown))
      #expect(tool.calls.contains { $0.hasPrefix("item create") } == false)
    }

    @Test func `a renamed personal vault is found by its type`() async {
      let tool = FakeTool("op", [
        FakeTool.reply("vault list*", stdout: shared),
        FakeTool.reply("vault get xxxxxxxxxxxxxxxxxxxxxxxxxx*", stdout: #"{"type":"PERSONAL"}"#),
        FakeTool.reply("vault get*", stdout: #"{"type":"USER_CREATED"}"#),
        FakeTool.reply("item create*", stdout: created),
        FakeTool.reply("item get*", stdout: kept),
      ])
      _ = try? await vault.save(tool.cli("1password", host: host), login: login)
      #expect(tool.calls.contains { $0.hasPrefix("item create") && $0.contains("--vault=xxxxxxxxxxxxxxxxxxxxxxxxxx") })
    }
  }

  @Suite("Bitwarden")
  struct Bitwarden {
    let vault = BitwardenVault()

    func syncedHost() -> FakeHost {
      let host = FakeHost(session: ["bitwarden": ProviderFixture.sessionKey])
      host.setValue("bitwarden", "syncedAt", String(Date().timeIntervalSince1970))
      return host
    }

    @Test func `items read from good JSON`() async {
      let tool = FakeTool("bw", [FakeTool.reply("list items*", stdout: ProviderFixture.bitwardenItems)])
      let items = try? await vault.items(tool.cli("bitwarden", host: syncedHost()))
      #expect(items?.items.count == 1)
      #expect(items?.passwords.count == 1)
    }

    @Test func `unreadable output is an error`() async {
      let tool = FakeTool("bw", [FakeTool.reply("list items*", stdout: "Could not find data file; creating it instead.\n[garbage")])
      let host = syncedHost()
      #expect(ProviderFixture.isFailed(await ProviderFixture.failure { try await vault.items(tool.cli("bitwarden", host: host)) }))
    }

    @Test func `a locked Bitwarden reads as locked`() async {
      let tool = FakeTool("bw", [FakeTool.reply("list items*", stderr: "Vault is locked.", exit: 1)])
      let host = syncedHost()
      #expect(await ProviderFixture.failure { try await vault.items(tool.cli("bitwarden", host: host)) } == .locked)
    }

    @Test func `an unreadable status says so`() async {
      let tool = FakeTool("bw", [FakeTool.reply("status*", stdout: "not json")])
      let state = await vault.state(tool.cli("bitwarden", host: syncedHost()))
      #expect(state.state == .unavailable)
      #expect(state.message?.contains("couldn't read") == true)
    }

    @Test func `the first code request covers new-device verification and keeps the password out of arguments`() async {
      let tool = FakeTool("bw", [FakeTool.reply("status*", stdout: ProviderFixture.signedOut), FakeTool.reply("login*", stderr: "Code is required.", exit: 1)])
      let first = await vault.signIn(tool.cli("bitwarden", host: FakeHost()),
                                     fields: VaultSignInFields(email: "me@example.com", password: ProviderFixture.password))
      #expect(first.needs == .code)
      #expect(first.error?.contains("new device") == true)
      #expect(tool.calls.contains { $0.contains(ProviderFixture.password) } == false)
    }

    @Test func `cancelling a load stops its sync before it lists`() async {
      let unsynced = FakeHost(session: ["bitwarden": ProviderFixture.sessionKey])
      let tool = FakeTool("bw", [FakeTool.run("sync*", "exec /bin/sleep 30"), FakeTool.reply("list items*", stdout: ProviderFixture.bitwardenItems)])
      let started = ContinuousClock.now
      let syncing = tool.cli("bitwarden", host: unsynced)
      let vault = vault
      let waiting = Task { @Sendable in await ProviderFixture.failure { try await vault.items(syncing) } }
      await ProviderFixture.waitUntil(seconds: 5) { tool.calls.contains { $0.hasPrefix("sync") } }
      let syncRan = tool.calls.contains { $0.hasPrefix("sync") }
      waiting.cancel()
      let stopped = await waiting.value
      guard syncRan else {
        print("skip: offline, so Bitwarden skipped its sync")
        return
      }
      #expect(stopped != nil)
      #expect(ContinuousClock.now - started < .seconds(5))
      #expect(tool.calls.contains { $0.hasPrefix("list items") } == false)
    }

    @Test func `a session that arrives after a lock is dropped, and a later unlock keeps its own`() async {
      let tool = FakeTool("bw", [FakeTool.run("unlock*", "/bin/sleep 1\necho \(ProviderFixture.sessionKey)")])
      let host = FakeHost(touchID: true)
      let epochs = VaultLockEpochs()
      let cli = VaultCLI(provider: "bitwarden", path: tool.path, environment: ["PATH": "/usr/bin:/bin", "FAKE_DIR": tool.directory.path],
                         host: host, epochs: epochs)
      let vault = vault
      let unlocking = Task { await vault.unlock(cli, password: ProviderFixture.password) }
      await ProviderFixture.waitUntil(seconds: 4) { tool.calls.contains { $0.hasPrefix("unlock") } }
      epochs.advanceAll()
      _ = await unlocking.value
      #expect(host.session("bitwarden") == nil)
      #expect(host.hasStoredSession("bitwarden") == false)

      let fresh = VaultCLI(provider: "bitwarden", path: tool.path, environment: ["PATH": "/usr/bin:/bin"], host: host, epochs: epochs)
      let after = await vault.unlock(fresh, password: ProviderFixture.password)
      #expect(after.ok)
      #expect(host.session("bitwarden") == ProviderFixture.sessionKey)
    }

    func storedHost() -> FakeHost {
      let host = FakeHost(touchID: true)
      host.remember("bitwarden", session: ProviderFixture.storedSession, persistent: true)
      return host
    }

    @Test("A status that can't be trusted keeps the Touch ID session for the next try", arguments: [
      FakeTool.reply("status*", stderr: "node crashed", exit: 1),
      FakeTool.reply("status*", stdout: "<html>502</html>"),
      FakeTool.reply("status*", stdout: #"{"status":"weird"}"#),
    ])
    func keepsStoredSession(reply: FakeTool.Reply) async {
      let tool = FakeTool("bw", [reply])
      let held = storedHost()
      let result = await vault.unlock(tool.cli("bitwarden", host: held), password: nil)
      #expect(result.ok == false)
      #expect(held.hasStoredSession("bitwarden"))
    }

    @Test func `a status stopped by a lock keeps the Touch ID session`() async {
      let slow = FakeTool("bw", [FakeTool.run("status*", ProviderFixture.slowTool)])
      let held = storedHost()
      let cli = slow.cli("bitwarden", host: held)
      let vault = vault
      let reading = Task { await vault.unlock(cli, password: nil) }
      await ProviderFixture.waitUntil(seconds: 4) { slow.file("child").isEmpty == false }
      reading.cancel()
      let cancelled = await reading.value
      #expect(cancelled.ok == false)
      #expect(held.hasStoredSession("bitwarden"))
    }

    @Test("A locked or signed-out status drops the stale Touch ID session", arguments: ["locked", "unauthenticated"])
    func dropsStaleSession(answer: String) async {
      let tool = FakeTool("bw", [FakeTool.reply("status*", stdout: #"{"status":"\#(answer)"}"#)])
      let dropped = storedHost()
      let result = await vault.unlock(tool.cli("bitwarden", host: dropped), password: nil)
      #expect(result.ok == false)
      #expect(result.needs == .password)
      #expect(dropped.hasStoredSession("bitwarden") == false)
    }

    @Test func `an unlocked status reuses the Touch ID session`() async {
      let tool = FakeTool("bw", [FakeTool.reply("status*", stdout: #"{"status":"unlocked"}"#)])
      let good = storedHost()
      let result = await vault.unlock(tool.cli("bitwarden", host: good), password: nil)
      #expect(result.ok)
      #expect(good.hasStoredSession("bitwarden"))
    }
  }

  @Suite("Proton Pass")
  struct ProtonPass {
    let vault = ProtonPassVault()
    let host = FakeHost(session: ["protonpass": "protonpass-session"])
    let vaults = #"{"vaults":[{"name":"Work","share_id":"shareWork1"},{"name":"Personal","share_id":"sharePersonal1"}]}"#
    let listed = #"""
      {"items":[{"id":"item0001","state":"Active","modify_time":1767323045,"content":{"title":"Example","content":{"Login":{"username":"me","password":"\#(ProviderFixture.password)","urls":["https://example.com"]}}}}]}
      """#

    @Test("Signing in to a pass-cli that is already signed in asks the owner first", arguments: [true, false])
    func signedInShortcut(ownerSays: Bool) async {
      let tool = FakeTool("pass-cli", [FakeTool.reply("info*", stdout: #"{"email":"fixture@example.com"}"#)])
      let asked = FakeHost(ownerAnswer: ownerSays)
      let result = await vault.signIn(tool.cli("protonpass", host: asked), fields: VaultSignInFields())
      #expect(result.ok == ownerSays)
      #expect((asked.session("protonpass") != nil) == ownerSays)
    }

    @Test func `every vault reads past an update notice`() async {
      let tool = FakeTool("pass-cli", [
        FakeTool.reply("vault list*", stdout: "A new version of pass-cli is available [1.5.0]\n" + vaults),
        FakeTool.reply("item list*", stdout: listed),
      ])
      let items = try? await vault.items(tool.cli("protonpass", host: host))
      #expect(items?.items.count == 2)
    }

    @Test func `an unreadable vault list is an error`() async {
      let tool = FakeTool("pass-cli", [FakeTool.reply("vault list*", stdout: "Error loading vaults")])
      #expect(ProviderFixture.isFailed(await ProviderFixture.failure { try await vault.items(tool.cli("protonpass", host: host)) }))
    }

    @Test func `a pass-cli without --show-secrets still lists logins`() async {
      let tool = FakeTool("pass-cli", [
        FakeTool.reply("vault list*", stdout: vaults),
        FakeTool.reply("item list*--show-secrets*", stderr: "error: unexpected argument '--show-secrets' found", exit: 2),
        FakeTool.reply("item list*", stdout: listed),
      ])
      let plain = try? await vault.items(tool.cli("protonpass", host: host))
      #expect(plain?.items.count == 2)
    }

    @Test func `a save whose output names no id finds the new login in the personal vault`() async throws {
      let login = VaultNewLogin(title: "Example", username: "me", password: ProviderFixture.newPassword, url: "https://example.com")
      let tool = FakeTool("pass-cli", [
        FakeTool.reply("vault list*", stdout: vaults),
        FakeTool.reply("item create*", stdout: "Item created successfully."),
        FakeTool.reply("item list*", stdout: listed),
      ])
      let saved = try await vault.save(tool.cli("protonpass", host: host), login: login)
      #expect(saved.id == "sharePersonal1/item0001")
      #expect(tool.calls.contains { $0.hasPrefix("item create login --share-id=sharePersonal1") })
    }

    @Test func `with only shared vaults, Proton Pass picks none, and a single vault takes new logins`() {
      let shared = [["name": "Work", "share_id": "shareWork1"], ["name": "Family", "share_id": "shareFamily1"]]
      #expect((try? ProtonPassVault.vaultForNewItems(shared)) == nil)
      #expect((try? ProtonPassVault.vaultForNewItems([["name": "Mine", "share_id": "shareMine1"]]))?["share_id"] as? String == "shareMine1")
    }

    @Test func `the approval link skips other links, trailing punctuation and look-alike hosts`() {
      let text = "Docs: https://protonpass.github.io/pass-cli/\nOpen https://account.proton.me/authorize?code=abc. Then wait."
      #expect(ProtonPassVault.approvalURL(in: text) == "https://account.proton.me/authorize?code=abc")
      #expect(ProtonPassVault.approvalURL(in: "https://proton.me.evil.example/x") == nil)
    }
  }

  @Suite("Commands")
  struct Commands {
    @Test func `stopping a command also stops the children it started`() async throws {
      let directory = FileManager.default.temporaryDirectory.appendingPathComponent("ardia-group-\(UUID().uuidString)")
      try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
      defer { try? FileManager.default.removeItem(at: directory) }
      let pidFile = directory.appendingPathComponent("pid").path
      let script = "/bin/sleep 30 & echo $! > \(pidFile); wait"
      let result = await VaultCommand(executable: "/bin/sh", arguments: ["-c", script], environment: ["PATH": "/usr/bin:/bin"], input: nil,
                                      timeout: 0.5).run()
      #expect(result.timedOut)
      let child = Int32((try? String(contentsOfFile: pidFile, encoding: .utf8))?.trimmingCharacters(in: .whitespacesAndNewlines) ?? "") ?? 0
      await ProviderFixture.waitUntil(seconds: 3) { child > 0 && kill(child, 0) != 0 }
      #expect(child > 0)
      #expect(kill(child, 0) != 0)
    }

    @Test func `quitting halts every running command`() async {
      let lingering = Task {
        await VaultCommand(executable: "/bin/sleep", arguments: ["30"], environment: ["PATH": "/usr/bin:/bin"], input: nil, timeout: 30).run()
      }
      await ProviderFixture.waitUntil(seconds: 3) { VaultCommand.running > 0 }
      VaultCommand.haltAll()
      let halted = await lingering.value
      #expect(halted.cancelled)
      #expect(halted.succeeded == false)
      #expect(VaultCommand.running == 0)
    }
  }

  struct SignInCancel: Sendable, CustomTestStringConvertible {
    let testDescription: String
    let tool: String
    let provider: String
    let replies: [FakeTool.Reply]
    let work: @Sendable (VaultCLI) async -> VaultSignInResult

    static let all: [SignInCancel] = [
      SignInCancel(testDescription: "a Bitwarden sign-in", tool: "bw", provider: "bitwarden",
                   replies: [FakeTool.reply("status*", stdout: ProviderFixture.signedOut),
                             FakeTool.run("login*", ProviderFixture.slowTool + "\necho \(ProviderFixture.sessionKey)")]) { cli in
        await BitwardenVault().signIn(cli, fields: VaultSignInFields(email: "me@example.com", password: ProviderFixture.password))
      },
      SignInCancel(testDescription: "a Bitwarden API key sign-in", tool: "bw", provider: "bitwarden",
                   replies: [FakeTool.reply("status*", stdout: ProviderFixture.signedOut), FakeTool.run("login --apikey*", ProviderFixture.slowTool)]) { cli in
        await BitwardenVault().signIn(cli, fields: VaultSignInFields(password: ProviderFixture.password, clientId: "user.abc",
                                                                     clientSecret: ProviderFixture.clientSecret))
      },
      SignInCancel(testDescription: "a Bitwarden unlock", tool: "bw", provider: "bitwarden",
                   replies: [FakeTool.run("unlock*", ProviderFixture.slowTool + "\necho \(ProviderFixture.sessionKey)")]) { cli in
        await BitwardenVault().unlock(cli, password: ProviderFixture.password)
      },
      SignInCancel(testDescription: "a Proton Pass token sign-in", tool: "pass-cli", provider: "protonpass",
                   replies: [FakeTool.run("login", ProviderFixture.slowTool)]) { cli in
        await ProtonPassVault().signIn(cli, fields: VaultSignInFields(password: ProviderFixture.accessToken, method: "accessToken"))
      },
      SignInCancel(testDescription: "a 1Password unlock", tool: "op", provider: "1password",
                   replies: [FakeTool.reply("account list*", stdout: #"[{"account_uuid":"ACCOUNT1","email":"me@example.com","url":"my.1password.com"}]"#),
                             FakeTool.run("vault list*", ProviderFixture.slowTool + "\necho '[]'")]) { cli in
        await OnePasswordVault().unlock(cli, password: nil)
      },
    ]
  }

  @Test("Cancelling a sign-in stops the tool and its children and leaves nothing signed in", arguments: SignInCancel.all)
  func cancelSignIn(row: SignInCancel) async {
    let tool = FakeTool(row.tool, row.replies)
    let host = FakeHost()
    let cli = tool.cli(row.provider, host: host)
    let started = ContinuousClock.now
    let signing = Task { await row.work(cli) }
    await ProviderFixture.waitUntil(seconds: 4) { tool.file("child").isEmpty == false }
    let found = host.cancelRunning(row.provider)
    let result = await signing.value
    #expect(found)
    #expect(result.ok == false)
    #expect(ContinuousClock.now - started < .seconds(4))
    #expect(host.session(row.provider) == nil)
    #expect(host.hasStoredSession(row.provider) == false)
    #expect(await ProviderFixture.childStopped(tool))
    #expect(tool.file("finished").isEmpty)
  }
}
