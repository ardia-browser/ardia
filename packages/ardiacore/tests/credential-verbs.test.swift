import Foundation
import Testing

struct CredentialVerbFixture: @unchecked Sendable {
  struct Case: @unchecked Sendable, CustomTestStringConvertible {
    let name: String
    let manifest: String
    let verb: String
    let params: [String: Any]
    let testInstance: Bool
    let timeoutMs: Int?
    let launch: [String: Any]?
    let refused: [String: String]?

    var testDescription: String { name }
  }

  let manifests: [String: [String: Any]]
  let secrets: [String: String]
  let testFolder: String
  let cases: [Case]

  static let url = URL(fileURLWithPath: #filePath).deletingLastPathComponent().appendingPathComponent("fixtures/credential-verbs.json")

  static func shared() throws -> CredentialVerbFixture {
    let root = try #require(try JSONSerialization.jsonObject(with: Data(contentsOf: url)) as? [String: Any])
    let cases = try #require(root["cases"] as? [[String: Any]]).map { raw in
      Case(
        name: raw["name"] as? String ?? "", manifest: raw["manifest"] as? String ?? "", verb: raw["verb"] as? String ?? "",
        params: raw["params"] as? [String: Any] ?? [:], testInstance: raw["testInstance"] as? Bool ?? false, timeoutMs: raw["timeoutMs"] as? Int,
        launch: raw["launch"] as? [String: Any], refused: raw["refused"] as? [String: String])
    }
    return CredentialVerbFixture(
      manifests: try #require(root["manifests"] as? [String: [String: Any]]), secrets: try #require(root["secrets"] as? [String: String]),
      testFolder: try #require(root["testFolder"] as? String), cases: cases)
  }

  func cli(_ name: String) throws -> CredentialCliSpec {
    let manifest = try #require(manifests[name])
    guard case .accepted(let contribution) = CredentialCatalogParser.parse(manifest: manifest) else {
      Issue.record("the \(name) fixture manifest is refused: \(CredentialCatalogParser.parse(manifest: manifest))")
      throw CancellationError()
    }
    return contribution.cli
  }

  func build(_ row: Case) throws -> Result<CredentialVerbLaunch, CredentialRefusal> {
    CredentialVerbLaunch.build(
      cli: try cli(row.manifest), verbId: row.verb, params: row.params, requestedTimeoutMs: row.timeoutMs, testFolderBase: row.testInstance ? testFolder : nil,
      secret: { secrets[$0] })
  }
}

@Suite("Credential verb launches")
struct CredentialVerbLaunchTests {
  @Test("A verb builds the argv, env and stdin the shared fixture expects", arguments: try CredentialVerbFixture.shared().cases)
  func sharedFixture(_ row: CredentialVerbFixture.Case) throws {
    let fixture = try CredentialVerbFixture.shared()
    switch try fixture.build(row) {
    case .success(let launch):
      let expected = try #require(row.launch, "\(row.name) expected a refusal, got \(launch.argv)")
      #expect(launch.argv == expected["argv"] as? [String])
      #expect(launch.environment == expected["env"] as? [String: String])
      #expect(String(decoding: launch.stdin ?? Data(), as: UTF8.self) == expected["stdin"] as? String)
      #expect(launch.timeoutMs == expected["timeoutMs"] as? Int)
      #expect(launch.signIn == expected["signIn"] as? Bool)
    case .failure(let refusal):
      let expected = try #require(row.refused, "\(row.name) expected a launch, got \(refusal.message)")
      #expect(refusal.code.rawValue == expected["code"])
      #expect(refusal.message == expected["message"])
    }
  }

  @Test func `the shared fixture covers launches, refusals and both programs`() throws {
    let fixture = try CredentialVerbFixture.shared()
    let codes = Set(fixture.cases.compactMap { $0.refused?["code"] })
    #expect(codes.isSuperset(of: ["bad_request", "expired", "denied", "refused"]))
    #expect(Set(fixture.cases.map(\.manifest)) == ["bw", "op"])
    #expect(fixture.cases.contains { $0.testInstance })
  }

  @Test func `secret values a launch consumes are listed for redaction, and only those`() throws {
    let fixture = try CredentialVerbFixture.shared()
    let launch = try fixture.build(try #require(fixture.cases.first { $0.name.hasPrefix("flag slots render") })).get()
    #expect(launch.secretValues == [fixture.secrets["h1"]!])
    #expect(launch.handles == ["h1"])
    #expect(!launch.argv.contains(fixture.secrets["h1"]!))
  }

  @Test func `strings of six or more characters in a json stdin slot are kept for stderr redaction`() throws {
    let fixture = try CredentialVerbFixture.shared()
    let launch = try fixture.build(try #require(fixture.cases.first { $0.verb == "create.item" && $0.launch != nil })).get()
    #expect(launch.stdinTexts.contains("https://example.com/"))
    #expect(launch.stdinTexts.contains("Example"))
    #expect(!launch.stdinTexts.contains("a"))
  }
}

@Suite("Credential catalogs")
struct CredentialCatalogTests {
  static func manifest(verbs: [String: Any], env: [[String: Any]] = [], program: String = "bw", extra: [String: Any] = [:]) -> [String: Any] {
    var contribution: [String: Any] = [
      "title": "Fakewarden",
      "signIn": ["methods": [["id": "password", "title": "Password", "fields": [["id": "masterPassword", "title": "Master Password", "type": "secret"]]]]],
      "cli": ["name": program, "install": ["command": "brew install fake", "url": "https://example.com/"], "patterns": ["word": "^[a-z]+$"], "env": env, "verbs": verbs],
    ]
    for (key, value) in extra { contribution[key] = value }
    return ["name": "fakewarden", "official": true, "main": "dist/main.js", "contributes": ["credentialProvider": contribution]]
  }

  static func problems(_ manifest: [String: Any]) -> [String] {
    if case .refused(let problems) = CredentialCatalogParser.parse(manifest: manifest) { return problems }
    return []
  }

  static let P = "contributes.credentialProvider"

  @Test func `a catalog can't declare a denied command, even behind global flags`() {
    let found = Self.problems(Self.manifest(verbs: ["serve": ["argv": ["--nointeraction", "serve"]]]))
    #expect(found == ["\(Self.P).cli.verbs.serve: bw serve is never allowed, since it opens a server"])
  }

  @Test func `a catalog can't hide a denied command in an enum value`() {
    let verbs: [String: Any] = ["get.any": ["argv": ["get", ["slot": "kind"]], "slots": ["kind": ["type": "enum", "values": ["item", "attachment"]]]]]
    #expect(Self.problems(Self.manifest(verbs: verbs)) == ["\(Self.P).cli.verbs.get.any: bw get attachment is never allowed, since it writes files"])
  }

  @Test func `a write-to-file flag is denied for op read at parse time`() {
    let verbs: [String: Any] = ["read": ["argv": ["read", ["slot": "ref"], ["flag": "--out-file", "slot": "path"]], "slots": ["ref": ["type": "id", "pattern": "word"], "path": ["type": "id", "pattern": "word"]]]]
    #expect(Self.problems(Self.manifest(verbs: verbs, program: "op")) == ["\(Self.P).cli.verbs.read: op read with --out-file is never allowed, since it writes files"])
  }

  @Test("A catalog can't spell a denied command with a short flag, a later subcommand or an option Ardia doesn't know", arguments: [
    ("op", ["read", "op://vault/item/field", "-o", "out.txt"], "op read with -o is never allowed, since it writes files"),
    ("op", ["document", "get", "doc", "-oout.txt"], "op document get with -o is never allowed, since it writes files"),
    ("op", ["connect", "token", "create"], "op connect is never allowed, since it mints credentials"),
    ("op", ["events-api", "create"], "op events-api is never allowed, since it mints credentials"),
    ("op", ["item", "share", "abc"], "op item share is never allowed, since it shares data"),
    ("op", ["update", "--directory", "here"], "op update with --directory is never allowed, since it writes files"),
    ("bw", ["import", "bitwardenjson", "file.json"], "bw import is never allowed, since it reads files"),
    ("bw", ["create", "attachment", "--file", "a.txt"], "bw create attachment with --file is never allowed, since it reads files"),
    ("bw", ["receive", "--output", "a.txt"], "bw receive with --output is never allowed, since it writes files"),
    ("bw", ["get", "--raw", "attachment", "x"], "bw get attachment is never allowed, since it writes files"),
    ("bw", ["--weird", "serve"], "bw --weird is never allowed, since an option Ardia doesn't know comes before the command"),
  ])
  func deniedSpellings(_ program: String, _ argv: [String], _ message: String) {
    #expect(Self.problems(Self.manifest(verbs: ["v": ["argv": argv]], program: program)) == ["\(Self.P).cli.verbs.v: \(message)"])
  }

  @Test func `a flag that only looks like a denied one stays allowed`() {
    #expect(Self.problems(Self.manifest(verbs: ["v": ["argv": ["read", "op://vault/item/field", "--no-newline"]]], program: "op")).isEmpty)
    #expect(Self.problems(Self.manifest(verbs: ["v": ["argv": ["update"]]], program: "op")).isEmpty)
  }

  @Test("An environment entry Ardia never passes is refused", arguments: [
    ("DYLD_INSERT_LIBRARIES", "DYLD_*"), ("NODE_OPTIONS", "NODE_*"), ("LD_PRELOAD", "LD_*"), ("NODE_TLS_REJECT_UNAUTHORIZED", "NODE_*"),
    ("SSL_KEYLOGFILE", "SSL_*"), ("XDG_CONFIG_HOME", "XDG_*"), ("OP_CONNECT_HOST", "OP_CONNECT_*"), ("BITWARDENCLI_APPDATA_DIR", "BITWARDENCLI_*"),
  ])
  func deniedEnvironment(_ name: String, _ pattern: String) {
    let found = Self.problems(Self.manifest(verbs: ["status": ["argv": ["status"]]], env: [["name": name, "literal": "x"]]))
    #expect(found == ["\(Self.P).cli.env[0].name: \(name) matches \(pattern), which Ardia never passes"])
  }

  @Test func `a proxy variable spelled with the suffix is refused`() {
    let found = Self.problems(Self.manifest(verbs: ["status": ["argv": ["status"]]], env: [["name": "MY_PROXY", "literal": "x"]]))
    #expect(found == ["\(Self.P).cli.env[0].name: MY_PROXY matches *_PROXY, which Ardia never passes"])
  }

  @Test func `Ardia's own variables can't be set, not even by a test folder`() {
    let found = Self.problems(Self.manifest(verbs: ["status": ["argv": ["status"]]], env: [["name": "HOME", "testFolder": ""], ["name": "PATH", "literal": "/tmp"]]))
    #expect(found == ["\(Self.P).cli.env[0].name: HOME is set by Ardia", "\(Self.P).cli.env[1].name: PATH is set by Ardia"])
  }

  @Test func `a test folder may name a denied variable, which is how Bitwarden is isolated in tests`() {
    #expect(Self.problems(Self.manifest(verbs: ["status": ["argv": ["status"]]], env: [["name": "BITWARDENCLI_APPDATA_DIR", "testFolder": ""]])).isEmpty)
  }

  @Test func `a secret slot can't go in argv, a json slot only goes in stdin, and a flag slot only in a when`() {
    let verbs: [String: Any] = [
      "a": ["argv": ["a", ["slot": "password"]], "slots": ["password": ["type": "secret"]]],
      "b": ["argv": ["b", ["slot": "item"]], "slots": ["item": ["type": "json"]]],
      "c": ["argv": ["c", ["slot": "on"]], "slots": ["on": ["type": "flag"]]],
    ]
    #expect(Self.problems(Self.manifest(verbs: verbs)).sorted() == [
      "\(Self.P).cli.verbs.a.argv[1]: a secret slot can't go in argv, where other programs see it",
      "\(Self.P).cli.verbs.a.slots.password isn't used in argv, env or stdin",
      "\(Self.P).cli.verbs.b.argv[1]: a json slot only goes in stdin",
      "\(Self.P).cli.verbs.b.slots.item isn't used in argv, env or stdin",
      "\(Self.P).cli.verbs.c.argv[1]: a flag slot goes in a when",
      "\(Self.P).cli.verbs.c.slots.on isn't used in argv, env or stdin",
    ].sorted())
  }

  @Test func `a lone -- or a token with a space can't be a literal`() {
    let verbs: [String: Any] = ["a": ["argv": ["a", "--"]], "b": ["argv": ["b", "x y"]]]
    #expect(Self.problems(Self.manifest(verbs: verbs)).sorted() == [
      "\(Self.P).cli.verbs.a.argv[1] must be a plain token: no spaces, newlines, NUL or a lone --",
      "\(Self.P).cli.verbs.b.argv[1] must be a plain token: no spaces, newlines, NUL or a lone --",
    ])
  }

  @Test func `a lastLineSecret verb must unlock, an outliving verb must stream, and unlocking needs the sign-in slot`() {
    let verbs: [String: Any] = [
      "a": ["argv": ["a"], "output": ["mode": "lastLineSecret"]],
      "b": ["argv": ["b"], "signIn": true, "outlivesCall": true, "output": ["mode": "lines"]],
      "c": ["argv": ["c"], "unlocks": true],
    ]
    #expect(Self.problems(Self.manifest(verbs: verbs)).sorted() == [
      "\(Self.P).cli.verbs.a: a lastLineSecret verb must unlock, since its secret goes nowhere else",
      "\(Self.P).cli.verbs.b.outlivesCall needs signIn: true and mode stream",
      "\(Self.P).cli.verbs.c.unlocks needs signIn: true",
    ])
  }

  @Test func `a credential provider is closed: main only, nothing else contributed, no permissions`() {
    var manifest = Self.manifest(verbs: ["status": ["argv": ["status"]]])
    manifest["main"] = nil
    manifest["sidecar"] = ["run": ["x"]]
    manifest["permissions"] = ["tabs": "read"]
    manifest["activationEvents"] = ["onStartup"]
    var contributes = manifest["contributes"] as! [String: Any]
    contributes["commands"] = [[String: Any]()]
    manifest["contributes"] = contributes
    manifest["official"] = nil
    #expect(Self.problems(manifest) == [
      "\(Self.P) needs a main", "\(Self.P) runs in main, not a sidecar", "contributes.commands: a credential provider contributes nothing else",
      "permissions: a credential provider asks for no permissions",
      "activationEvents: a credential provider starts when Ardia asks it, so it takes no activation events", "\(Self.P) needs official: true",
    ])
  }

  @Test func `the fixture manifests parse with their memory default and symbol`() throws {
    let fixture = try CredentialVerbFixture.shared()
    guard case .accepted(let contribution) = CredentialCatalogParser.parse(manifest: try #require(fixture.manifests["bw"])) else {
      Issue.record("the bw fixture manifest is refused")
      return
    }
    #expect(contribution.memoryMB == 1024)
    #expect(contribution.symbol == "key.fill")
    #expect(contribution.cli.verbs.count == 10)
  }
}
