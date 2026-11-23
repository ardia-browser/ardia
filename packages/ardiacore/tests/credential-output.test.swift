import Foundation
import Testing

@Suite("Credential verb output")
struct CredentialVerbOutputTests {
  static let secret = "s3cret-session-key-0123456789"

  static func verb(_ output: CredentialVerb.Output, hints: [String: [String]] = [:]) -> CredentialVerb {
    CredentialVerb(
      id: "list.items", argv: [.token("list")], slots: [:], env: [], stdin: nil, timeoutMs: 30_000, outputLimitBytes: 1 << 20, output: output, signIn: false,
      unlocks: output == .lastLineSecret ? .yes : .no, outlivesCall: false, hints: hints, hintOrder: hints.keys.sorted())
  }

  static func launch(secrets: [String] = [secret], stdinTexts: [String] = []) -> CredentialVerbLaunch {
    CredentialVerbLaunch(
      verb: "list.items", argv: ["list"], env: [], stdin: nil, timeoutMs: 30_000, outputLimitBytes: 1 << 20, signIn: false,
      secrets: secrets.enumerated().map { CredentialSecretUse(handle: "h\($0.offset + 1)", value: $0.element) }, stdinTexts: stdinTexts, testFolders: [])
  }

  static func result(_ stdout: String, stderr: String = "", status: Int32 = 0) -> VaultCommandResult {
    VaultCommandResult(status: status, stdout: Data(stdout.utf8), stderr: stderr, launched: true, timedOut: false, cancelled: false, overflowed: false, incomplete: false)
  }

  static func parsed(_ line: String) throws -> [String: Any] {
    try #require(try JSONSerialization.jsonObject(with: Data(line.utf8)) as? [String: Any])
  }

  @Test func `a parsed items array is sent one element per line and comes back emptied`() throws {
    let report = CredentialVerbOutput.report(Self.result(#"[{"id":"a"},{"id":"b"},{"id":"c"}]"#), verb: Self.verb(.json(items: "$")), launch: Self.launch(), verbOf: 7)
    #expect(report.notifications.count == 3)
    let first = try Self.parsed(report.notifications[0])
    #expect(first["verbOf"] as? Int == 7)
    #expect(first["index"] as? Int == 0)
    #expect((first["item"] as? [String: Any])?["id"] as? String == "a")
    #expect((report.reply["json"] as? [Any])?.isEmpty == true)
    #expect(report.reply["items"] as? Int == 3)
    #expect(report.succeeded)
  }

  @Test func `output that isn't JSON comes back as null, never as an empty vault`() {
    let report = CredentialVerbOutput.report(Self.result("Vault is locked."), verb: Self.verb(.json(items: "$")), launch: Self.launch(), verbOf: 1)
    #expect(report.notifications.isEmpty)
    #expect(report.reply["json"] is NSNull)
    #expect(report.reply["items"] as? Int == 0)
  }

  @Test func `a leading notice line before the JSON is skipped`() {
    let report = CredentialVerbOutput.report(
      Self.result("[INFO] A new version is available\n[{\"id\":\"a\"}]"), verb: Self.verb(.json(items: "$")), launch: Self.launch(), verbOf: 1)
    #expect(report.reply["items"] as? Int == 1)
  }

  @Test func `items under a key come back as the wrapper with an emptied list`() throws {
    let report = CredentialVerbOutput.report(Self.result(#"{"vaults":[{"id":"a"}],"total":1}"#), verb: Self.verb(.json(items: "vaults")), launch: Self.launch(), verbOf: 1)
    let wrapper = try #require(report.reply["json"] as? [String: Any])
    #expect((wrapper["vaults"] as? [Any])?.isEmpty == true)
    #expect(wrapper["total"] as? Int == 1)
    #expect(report.notifications.count == 1)
  }

  @Test func `an element over a megabyte fails the verb as overflowed and sends nothing`() {
    let big = String(repeating: "x", count: CredentialLimits.outputItemBytes)
    let report = CredentialVerbOutput.report(Self.result("[{\"id\":\"a\"},{\"notes\":\"\(big)\"}]"), verb: Self.verb(.json(items: "$")), launch: Self.launch(), verbOf: 1)
    #expect(report.notifications.isEmpty)
    #expect(report.reply["overflowed"] as? Bool == true)
    #expect(report.reply["succeeded"] as? Bool == false)
  }

  @Test func `large JSON without items travels in parts of at most 256 KB that join back to the value`() throws {
    let notes = String(repeating: "é", count: 300_000)
    let report = CredentialVerbOutput.report(Self.result("{\"notes\":\"\(notes)\"}"), verb: Self.verb(.json(items: nil)), launch: Self.launch(), verbOf: 3)
    #expect(report.reply["json"] is NSNull)
    let parts = try report.notifications.map { try #require(try Self.parsed($0)["part"] as? String) }
    #expect(report.reply["parts"] as? Int == parts.count)
    #expect(parts.count >= 3)
    #expect(parts.allSatisfy { $0.utf8.count <= CredentialLimits.chunkBytes })
    let joined = try #require(try JSONSerialization.jsonObject(with: Data(parts.joined().utf8)) as? [String: String])
    #expect(joined["notes"] == notes)
  }

  @Test func `every consumed secret is hidden in json, items, lines and stderr`() throws {
    let stdout = "[{\"note\":\"key \(Self.secret) here\"}]"
    let report = CredentialVerbOutput.report(
      Self.result(stdout, stderr: "error: bad session \(Self.secret)", status: 1), verb: Self.verb(.json(items: "$")), launch: Self.launch(), verbOf: 1)
    #expect(report.notifications.allSatisfy { !$0.contains(Self.secret) })
    #expect(report.notifications.first?.contains("[hidden]") == true)
    #expect(report.reply["stderr"] as? String == "error: bad session [hidden]")
    let lines = CredentialVerbOutput.report(Self.result("one \(Self.secret)\ntwo\n"), verb: Self.verb(.lines), launch: Self.launch(), verbOf: 1)
    #expect(lines.reply["lines"] as? [String] == ["one [hidden]", "two"])
  }

  @Test func `stderr hides the plaintext a json stdin carried, from six characters up`() {
    let report = CredentialVerbOutput.report(
      Self.result("", stderr: "rejected item hunter22 for site abc", status: 1), verb: Self.verb(.json(items: nil)),
      launch: Self.launch(secrets: [], stdinTexts: ["hunter22", "abc"]), verbOf: 1)
    #expect(report.reply["stderr"] as? String == "rejected item [hidden] for site abc")
  }

  @Test func `hints match the raw stderr, case-insensitively, before redaction`() {
    let verb = Self.verb(.lines, hints: ["wrongCode": ["Invalid Code"], "locked": ["vault is locked"]])
    let report = CredentialVerbOutput.report(Self.result("", stderr: "ERROR: invalid code", status: 1), verb: verb, launch: Self.launch(), verbOf: 1)
    #expect(report.reply["hints"] as? [String] == ["wrongCode"])
  }

  @Test func `stderr loses ANSI codes and log prefixes and stops at 64 KB`() throws {
    let report = CredentialVerbOutput.report(
      Self.result("", stderr: "\u{1B}[31m[ERROR] 2025/01/02 03:04:05 boom\u{1B}[0m\n" + String(repeating: "y", count: 100_000), status: 1), verb: Self.verb(.lines),
      launch: Self.launch(), verbOf: 1)
    let stderr = try #require(report.reply["stderr"] as? String)
    #expect(stderr.hasPrefix("boom\n"))
    #expect(stderr.utf8.count <= CredentialLimits.stderrBytes)
  }

  @Test func `a last-line secret is captured natively and never returned`() {
    let report = CredentialVerbOutput.report(Self.result("You are logged in!\n\(Self.secret)\n"), verb: Self.verb(.lastLineSecret), launch: Self.launch(secrets: []), verbOf: 1)
    #expect(report.capturedKey == Self.secret)
    #expect(report.reply["lines"] as? [String] == [])
    #expect(!String(describing: report.reply).contains(Self.secret))
  }

  @Test("A last line that isn't one long word isn't a key", arguments: ["short", "two words here, not a key at all", ""])
  func notAKey(_ line: String) {
    let report = CredentialVerbOutput.report(Self.result("\(line)\n"), verb: Self.verb(.lastLineSecret), launch: Self.launch(secrets: []), verbOf: 1)
    #expect(report.capturedKey == nil)
  }

  @Test func `a failed exit keeps no key even when the last line looks like one`() {
    let report = CredentialVerbOutput.report(Self.result("\(Self.secret)\n", status: 1), verb: Self.verb(.lastLineSecret), launch: Self.launch(secrets: []), verbOf: 1)
    #expect(report.capturedKey == nil)
  }

  @Test func `lines too big for one reply overflow instead of breaking the channel`() {
    let stdout = String(repeating: String(repeating: "z", count: 1000) + "\n", count: 1200)
    let report = CredentialVerbOutput.report(Self.result(stdout), verb: Self.verb(.lines), launch: Self.launch(), verbOf: 1)
    #expect(report.reply["overflowed"] as? Bool == true)
    #expect(report.reply["lines"] as? [String] == [])
  }

  @Test func `a stream line is redacted, cleaned and capped`() throws {
    let line = CredentialVerbOutput.streamLine("\u{1B}[1mOpen https://x/\(Self.secret)" + String(repeating: "q", count: 20_000), stream: "stdout", verbOf: 4, secrets: [Self.secret])
    let object = try Self.parsed(line)
    let text = try #require((object["line"] as? [String: Any])?["text"] as? String)
    #expect(text.hasPrefix("Open https://x/[hidden]"))
    #expect(text.utf8.count <= CredentialLimits.streamLineBytes)
    #expect(object["verbOf"] as? Int == 4)
  }
}

@Suite("Credential results")
struct CredentialResultTests {
  @Test func `a plugin's error detail is cut to 240 bytes wherever it comes in`() throws {
    let long = String(repeating: "é", count: 400)
    let wire = try CredentialResults.wireError(["code": "failed", "problem": "failed", "detail": long])
    #expect(try #require(wire.detail).utf8.count <= 240)
    let state = try CredentialResults.state(["state": "locked", "detail": long])
    #expect(try #require(state.detail).utf8.count <= 240)
  }

  @Test func `a listed item keeps passkey metadata only and cleans display text`() throws {
    let raw: [String: Any] = [
      "snapshot": "s1",
      "items": [[
        "id": "item-1", "title": "Bank\u{202E}lmth", "username": "me\u{0007}", "urls": ["https://bank.example"],
        "passkeys": [["credentialId": "AAEC", "rpId": "bank.example", "userName": "me", "displayName": "Me", "discoverable": true, "counter": 0, "privateKey": "LEAK"]],
        "secrets": ["password": "pa\u{0007}ss\u{202E}word"],
      ]],
    ]
    let page = try CredentialResults.page(raw, provider: "fakewarden")
    let item = try #require(page.list.items.first)
    #expect(item.title == "Banklmth")
    #expect(item.username == "me")
    #expect(item.passkeys?.first?.credentialId == "AAEC")
    #expect(!String(describing: item).contains("LEAK"))
    #expect(page.list.passwords["item-1"] == "pa\u{0007}ss\u{202E}word")
  }

  @Test func `an item id with a control character is refused`() {
    #expect(throws: CredentialResults.Invalid.self) { try CredentialResults.item(["id": "a\nb", "title": "x", "username": "y"], provider: "p") }
  }

  @Test func `a sign-in answer needs a known problem code`() {
    #expect(throws: CredentialResults.Invalid.self) { try CredentialResults.signIn(["ok": false, "problem": "madeUp"]) }
    #expect(throws: (any Error).self) { try CredentialResults.signIn(["ok": false]) }
  }

  @Test func `a sign-in that needs a code carries its methods`() throws {
    let outcome = try CredentialResults.signIn([
      "ok": false, "need": ["kind": "code", "methods": [["id": "0", "title": "App"], ["id": "1", "title": "Email", "sendsCode": true]]], "state": "signedOut",
    ])
    guard case .needs(.code(let methods, _), _, _, let state) = outcome else {
      Issue.record("expected a code need, got \(outcome)")
      return
    }
    #expect(methods?.map(\.id) == ["0", "1"])
    #expect(methods?.last?.sendsCode == true)
    #expect(state == .signedOut)
  }

  @Test func `wording comes from native sentences, with the plugin's detail only for failed`() {
    let wording = CredentialWording(
      title: "Fakewarden", program: "bw",
      signIn: CredentialSignInSpec(methods: [CredentialSignInSpec.Method(
        id: "password", title: "Password", kind: .fields,
        fields: [CredentialSignInSpec.Field(id: "masterPassword", title: "Master Password", type: .secret, optional: false, prefillsAccount: false, masked: true)],
        twoStep: false)], servers: [], unlockField: "masterPassword", approvalHosts: []))
    #expect(wording.sentence("signInFirst") == "Sign in to Fakewarden first.")
    #expect(wording.sentence("unlockNext") == "Signed in. Enter your master password to unlock.")
    #expect(wording.sentence("failed", detail: "Server said no") == "Server said no")
    #expect(wording.sentence("failed") == "bw stopped with an error.")
    #expect(wording.sentence("wrongPassword", detail: "ignored") == "That master password isn't right.")
    #expect(wording.sentence("extraPassword", field: "extraPassword") == "Enter your Fakewarden extra password too.")
    #expect(CredentialWording.cleanedDetail("\u{1B}[31mfirst \u{202E}line token-abc\nsecond", secrets: ["token-abc"]) == "first line [hidden]")
  }
}

@Suite("Hostile CLI output")
struct CredentialHostileOutputTests {
  static func hostile() throws -> [(String, String)] {
    let text = try #require(ProcessInfo.processInfo.environment["ARDIA_HOSTILE_INPUTS"], "the runner passes scripts/security/hostile-inputs.mjs")
    let pairs = try #require(try JSONSerialization.jsonObject(with: Data(text.utf8)) as? [[String]])
    return pairs.compactMap { $0.count == 2 ? ($0[0], $0[1]) : nil }
  }

  @Test func `a CLI's error line reaches Ardia's wording as one short visible line with the secrets it was given hidden`() throws {
    let cases = try Self.hostile()
    #expect(cases.count > 40)
    let secret = "s3cret-master-value"
    for (id, value) in cases {
      let stderr = "Error: \(value) \(secret)\nsecond line \(secret)"
      guard let detail = CredentialWording.cleanedDetail(stderr, secrets: [secret]) else { continue }
      #expect(!detail.contains(secret), "\(id)")
      #expect(detail.count <= CredentialLimits.detailLength, "\(id)")
      #expect(!detail.unicodeScalars.contains { CredentialCatalogParser.isControlOrDirection($0) }, "\(id)")
      #expect(!detail.contains("second line"), "\(id)")
    }
  }

  @Test func `a plugin's error detail and reported account are cleaned the same way, whatever the CLI printed`() throws {
    for (id, value) in try Self.hostile() {
      let wire = try CredentialResults.wireError(["code": "failed", "problem": "failed", "detail": value])
      if let detail = wire.detail {
        #expect(detail.utf8.count <= CredentialLimits.detailLength, "\(id)")
        #expect(!detail.unicodeScalars.contains { CredentialCatalogParser.isControlOrDirection($0) }, "\(id)")
      }
      let state = try CredentialResults.state(["state": "locked", "account": value])
      if let account = state.account { #expect(!account.unicodeScalars.contains { CredentialCatalogParser.isControlOrDirection($0) }, "\(id)") }
    }
  }
}
