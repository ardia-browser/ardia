import CryptoKit
import Foundation
import Testing

enum PluginPasskeyFixture {
  static let rpId = "github.com"
  static let credentialId = VaultBase64URL.encode(Data(repeating: 0xA7, count: 16))
  static let userHandle = Data([1, 2, 3, 4, 5, 6, 7, 8])

  static func keyTable(_ key: P256.Signing.PrivateKey, credentialId: String = credentialId, rpId: String = rpId) -> [String: Any] {
    [
      "credentialId": credentialId, "rpId": rpId, "privateKey": ["format": "pkcs8", "der": VaultBase64URL.encode(key.derRepresentation)],
      "userHandle": VaultBase64URL.encode(userHandle), "counter": 0,
    ]
  }

  static func key(_ privateKey: Data, credentialId: String = credentialId, rpId: String = rpId, userHandle: Data = userHandle, counter: Int = 0)
    -> CredentialPasskeyKey
  {
    CredentialPasskeyKey(credentialId: credentialId, rpId: rpId, privateKey: privateKey, userHandle: userHandle, counter: counter)
  }

  static func provider(capabilities extra: [String], routes: [CredentialPasskeyRoute] = []) throws -> PluginVaultProvider {
    var contribution = try CredentialRunFixture.contribution()
    contribution.capabilities += extra
    contribution.passkeyRoutes = routes
    return PluginVaultProvider(contribution: contribution, host: try FakeCredentialHost(), wantRun: { _ in }, openApproval: { _, _ in })
  }

  static func cli(_ run: CredentialRun) -> VaultCLI {
    VaultCLI(provider: run.provider, path: run.host.script, environment: [:], host: NoCLIHost(), epochs: run.host.epochs)
  }

  static let handlers = ["state", "signIn", "unlock", "signOut", "list", "reveal", "save", "passkeys.get", "passkeys.save"]
}

struct PasskeyKeyShape: Sendable, CustomTestStringConvertible {
  var testDescription: String
  var change: @Sendable (inout [String: Any]) -> Void

  init(_ why: String, _ change: @escaping @Sendable (inout [String: Any]) -> Void) {
    testDescription = why
    self.change = change
  }

  static let refused: [PasskeyKeyShape] = [
    .init("no private key") { $0["privateKey"] = nil },
    .init("a private key that isn't an object") { $0["privateKey"] = "MIGHAgEA" },
    .init("a private key in another format") { $0["privateKey"] = ["format": "sec1", "der": "AAAA"] },
    .init("a private key with no format") { $0["privateKey"] = ["der": "AAAA"] },
    .init("a private key with no der") { $0["privateKey"] = ["format": "pkcs8"] },
    .init("a der that's a number") { $0["privateKey"] = ["format": "pkcs8", "der": 12] },
    .init("a der in plain base64, not base64url") { $0["privateKey"] = ["format": "pkcs8", "der": "ab+/cd=="] },
    .init("a der of one leftover character") { $0["privateKey"] = ["format": "pkcs8", "der": "AAAAA"] },
    .init("no user handle") { $0["userHandle"] = nil },
    .init("an empty user handle") { $0["userHandle"] = "" },
    .init("a user handle over 64 bytes") { $0["userHandle"] = VaultBase64URL.encode(Data(count: 65)) },
    .init("a user handle that isn't base64url") { $0["userHandle"] = "a b" },
    .init("no counter") { $0["counter"] = nil },
    .init("a counter that's text") { $0["counter"] = "0" },
    .init("a counter that's a boolean") { $0["counter"] = false },
    .init("no credential id") { $0["credentialId"] = nil },
    .init("an empty credential id") { $0["credentialId"] = "" },
    .init("a credential id with a direction override") { $0["credentialId"] = "abc\u{202E}def" },
    .init("a credential id over 512 bytes") { $0["credentialId"] = String(repeating: "a", count: 513) },
    .init("no relying party") { $0["rpId"] = nil },
    .init("a relying party with a newline") { $0["rpId"] = "github.com\nevil.com" },
    .init("a relying party over 253 bytes") { $0["rpId"] = String(repeating: "a", count: 254) },
  ]
}

@Suite("A plugin's passkey key, read from its answer")
struct PluginPasskeyKeyReadTests {
  @Test func `a pkcs8 key with ids, a user handle and a counter reads as exactly those, and fields it doesn't name are dropped`() throws {
    let key = P256.Signing.PrivateKey()
    var table = PluginPasskeyFixture.keyTable(key)
    table["publicKey"] = "leaked-public"
    table["password"] = "hunter2"
    table["privateKey"] = ["format": "pkcs8", "der": VaultBase64URL.encode(key.derRepresentation), "raw": "leaked-raw"]
    let read = try #require(try CredentialResults.passkeyKey(table))
    #expect(read == PluginPasskeyFixture.key(key.derRepresentation))
  }

  @Test(arguments: [nil, NSNull()] as [NSNull?])
  func `no key at all reads as no key, not as a broken answer`(_ value: NSNull?) throws {
    #expect(try CredentialResults.passkeyKey(value) == nil)
  }

  @Test func `an answer that isn't an object is broken`() {
    #expect(throws: CredentialResults.Invalid.self) { try CredentialResults.passkeyKey("key") }
    #expect(throws: CredentialResults.Invalid.self) { try CredentialResults.passkeyKey([PluginPasskeyFixture.keyTable(P256.Signing.PrivateKey())]) }
  }

  @Test(arguments: PasskeyKeyShape.refused)
  func `a key missing a part or carrying the wrong kind of value is broken`(_ shape: PasskeyKeyShape) {
    var table = PluginPasskeyFixture.keyTable(P256.Signing.PrivateKey())
    shape.change(&table)
    #expect(throws: CredentialResults.Invalid.self) { try CredentialResults.passkeyKey(table) }
  }

  @Test func `a credential id of 512 bytes, a relying party of 253 and a user handle of 64 are still read`() throws {
    var table = PluginPasskeyFixture.keyTable(P256.Signing.PrivateKey())
    table["credentialId"] = String(repeating: "a", count: 512)
    table["rpId"] = String(repeating: "a", count: 253)
    table["userHandle"] = VaultBase64URL.encode(Data(repeating: 9, count: 64))
    let read = try #require(try CredentialResults.passkeyKey(table))
    #expect(read.userHandle.count == 64)
  }
}

struct SignerRefusal: Sendable, CustomTestStringConvertible {
  var testDescription: String
  var key: @Sendable (P256.Signing.PrivateKey) -> CredentialPasskeyKey

  init(_ why: String, _ key: @escaping @Sendable (P256.Signing.PrivateKey) -> CredentialPasskeyKey) {
    testDescription = why
    self.key = key
  }

  static let all: [SignerRefusal] = [
    .init("another credential id") { PluginPasskeyFixture.key($0.derRepresentation, credentialId: VaultBase64URL.encode(Data(repeating: 0xA8, count: 16))) },
    .init("another relying party") { PluginPasskeyFixture.key($0.derRepresentation, rpId: "evil.com") },
    .init("a subdomain of the relying party") { PluginPasskeyFixture.key($0.derRepresentation, rpId: "gist.github.com") },
    .init("a counter that has moved") { PluginPasskeyFixture.key($0.derRepresentation, counter: 1) },
    .init("an empty user handle") { PluginPasskeyFixture.key($0.derRepresentation, userHandle: Data()) },
    .init("a user handle over 64 bytes") { PluginPasskeyFixture.key($0.derRepresentation, userHandle: Data(count: 65)) },
    .init("a raw scalar instead of pkcs8") { PluginPasskeyFixture.key($0.rawRepresentation) },
    .init("a truncated pkcs8 key") { PluginPasskeyFixture.key($0.derRepresentation.dropLast(8)) },
    .init("a P-384 key") { _ in PluginPasskeyFixture.key(P384.Signing.PrivateKey().derRepresentation) },
    .init("no key bytes") { _ in PluginPasskeyFixture.key(Data()) },
  ]
}

@Suite("The signer a plugin's passkey key yields")
struct PluginPasskeySignerTests {
  @Test func `a key for the asked credential and site yields a signer whose signatures the passkey's public key verifies`() throws {
    let key = P256.Signing.PrivateKey()
    let signer = try #require(
      PluginVaultProvider.checkedSigner(PluginPasskeyFixture.key(key.derRepresentation), credentialId: PluginPasskeyFixture.credentialId,
                                        rpId: PluginPasskeyFixture.rpId))
    let challenge = Data("authenticator data plus client data hash".utf8)
    let signature = try signer.key.signature(for: challenge)
    #expect(key.publicKey.isValidSignature(signature, for: challenge))
    #expect(!P256.Signing.PrivateKey().publicKey.isValidSignature(signature, for: challenge))
    #expect(signer.userHandle == PluginPasskeyFixture.userHandle)
  }

  @Test(arguments: SignerRefusal.all)
  func `a key that isn't for the asked credential and site, or isn't a usable P-256 key, yields no signer`(_ refusal: SignerRefusal) {
    let key = refusal.key(P256.Signing.PrivateKey())
    #expect(PluginVaultProvider.checkedSigner(key, credentialId: PluginPasskeyFixture.credentialId, rpId: PluginPasskeyFixture.rpId) == nil)
  }
}

struct ReadBack: Sendable, CustomTestStringConvertible {
  var testDescription: String
  var answer: @Sendable (_ saved: [String: Any]) -> Any

  init(_ why: String, _ answer: @escaping @Sendable (_ saved: [String: Any]) -> Any) {
    testDescription = why
    self.answer = answer
  }

  static func echo(_ saved: [String: Any]) -> [String: Any] {
    ["credentialId": saved["credentialId"]!, "rpId": saved["rpId"]!, "privateKey": saved["privateKey"]!, "userHandle": saved["userHandle"]!, "counter": 0]
  }

  static let refused: [ReadBack] = [
    .init("another key under the same ids") { saved in
      var table = echo(saved)
      table["privateKey"] = ["format": "pkcs8", "der": VaultBase64URL.encode(P256.Signing.PrivateKey().derRepresentation)]
      return table
    },
    .init("the key under another credential id") { saved in
      var table = echo(saved)
      table["credentialId"] = VaultBase64URL.encode(Data(repeating: 1, count: 16))
      return table
    },
    .init("the key under another relying party") { saved in
      var table = echo(saved)
      table["rpId"] = "evil.com"
      return table
    },
    .init("no key") { _ in NSNull() },
    .init("a key with no private key") { saved in
      var table = echo(saved)
      table["privateKey"] = nil
      return table
    },
  ]
}

@Suite("Saving a passkey to a plugin reads it back before answering", .serialized)
struct PluginPasskeySaveReadBackTests {
  static let made = VaultNewPasskey(
    credentialId: UUID(), key: P256.Signing.PrivateKey(), rpId: PluginPasskeyFixture.rpId, rpName: "GitHub", userHandle: PluginPasskeyFixture.userHandle,
    userName: "octocat", displayName: "Octo Cat", createdAt: Date(timeIntervalSince1970: 1_700_000_000))

  func save(_ readBack: @Sendable ([String: Any]) -> Any) async throws -> (result: Result<String, VaultError>, get: [String: Any]) {
    let run = try await CredentialRun(handlers: PluginPasskeyFixture.handlers)
    let provider = try PluginPasskeyFixture.provider(capabilities: ["passkeys"])
    provider.attach(run.endpoint)
    let cli = PluginPasskeyFixture.cli(run)
    let made = Self.made
    let saving = Task { () -> Result<String, VaultError> in
      do { return .success(try await provider.savePasskey(cli, credential: made, attachTo: nil, title: "GitHub", url: "https://github.com")) }
      catch let error as VaultError { return .failure(error) }
      catch { return .failure(.failed("\(error)")) }
    }
    let saveCall = try await run.link.call(named: "passkeys.save")
    let saved = try #require((saveCall["input"] as? [String: Any])?["credential"] as? [String: Any])
    try await run.finish(try #require(saveCall["call"] as? String), result: ["item": "item-9"])
    let getCall = try await run.link.call(named: "passkeys.get")
    try await run.finish(try #require(getCall["call"] as? String), result: readBack(saved))
    return (await saving.value, try #require(getCall["input"] as? [String: Any]))
  }

  @Test func `a plugin that kept the key it was given answers with the item it saved to`() async throws {
    let (result, get) = try await save(ReadBack.echo)
    #expect(try result.get() == "item-9")
    #expect(get["item"] as? String == "item-9")
    #expect(get["credentialId"] as? String == VaultBase64URL.encode(Self.made.rawId))
    #expect(get["rpId"] as? String == PluginPasskeyFixture.rpId)
  }

  @Test(arguments: ReadBack.refused)
  func `a plugin whose read-back doesn't sign as the new key fails the save`(_ readBack: ReadBack) async throws {
    let provider = try PluginPasskeyFixture.provider(capabilities: ["passkeys"])
    let (result, _) = try await save(readBack.answer)
    #expect(throws: VaultError.failed(provider.wording.keptPasskeyMismatch)) { try result.get() }
  }
}

@Suite("A plugin whose passkeys are used through its extension or macOS", .serialized)
struct PluginDelegatedPasskeyTests {
  @Test(arguments: [[CredentialPasskeyRoute.browserExtension(["ghmbeldphafepmbegfdlkpapadhbakde"])], [.system], []])
  func `never holds a passkey for Ardia and is never asked for a key to sign with`(_ routes: [CredentialPasskeyRoute]) async throws {
    let run = try await CredentialRun(handlers: PluginPasskeyFixture.handlers)
    let provider = try PluginPasskeyFixture.provider(capabilities: [], routes: routes)
    provider.attach(run.endpoint)
    #expect(!provider.capabilities.passkeys)
    let cli = PluginPasskeyFixture.cli(run)
    let asking = Task { try await provider.passkeySigner(cli, item: "item-9", credential: Data(repeating: 0xA7, count: 16), rpId: PluginPasskeyFixture.rpId) }
    var asked: [String: Any]?
    for _ in 0..<50 where asked == nil {
      asked = run.link.messages().first { $0["name"] as? String == "passkeys.get" }
      try await Task.sleep(for: .milliseconds(20))
    }
    if let call = asked?["call"] as? String {
      Issue.record("asked the plugin for a passkey key")
      try await run.finish(call, result: PluginPasskeyFixture.keyTable(P256.Signing.PrivateKey()))
    }
    #expect(try await asking.value == nil)
  }
}

@Suite("A passkey's sign count, read from a plugin")
struct PluginPasskeyCounterTests {
  static let refused: [Double] = [1e300, -1, 0.5, Double(UInt32.max) + 1]
  static let accepted: [Double] = [0, Double(UInt32.max)]

  static func listed(_ counter: Double) -> [String: Any] {
    ["credentialId": PluginPasskeyFixture.credentialId, "rpId": PluginPasskeyFixture.rpId, "counter": counter]
  }

  static func key(_ counter: Double) -> [String: Any] {
    var table = PluginPasskeyFixture.keyTable(P256.Signing.PrivateKey())
    table["counter"] = counter
    return table
  }

  @Test(arguments: refused)
  func `a count that's huge, negative, fractional or past 32 bits is broken, in a listed passkey and in a key`(_ counter: Double) {
    #expect(throws: CredentialResults.Invalid.self) { try CredentialResults.passkey(Self.listed(counter)) }
    #expect(throws: CredentialResults.Invalid.self) { try CredentialResults.passkeyKey(Self.key(counter)) }
  }

  @Test(arguments: accepted)
  func `a count from zero to the 32-bit maximum is read as that count, in a listed passkey and in a key`(_ counter: Double) throws {
    #expect(try CredentialResults.passkey(Self.listed(counter)).counter == Int(counter))
    #expect(try #require(try CredentialResults.passkeyKey(Self.key(counter))).counter == Int(counter))
  }
}

@Suite("An edit through a provider that puts secrets on its command line", .serialized)
struct PluginSealedEditTests {
  static let handlers = ["state", "signIn", "unlock", "signOut", "list", "reveal", "save", "edit", "addTotp"]
  static let tooLong = String(repeating: "p", count: CredentialLimits.secretBytes + 1)

  static func rig() async throws -> (run: CredentialRun, provider: PluginVaultProvider, cli: VaultCLI) {
    let run = try await CredentialRun(handlers: handlers)
    var contribution = try CredentialRunFixture.contribution()
    contribution.capabilities += ["edit", "addTotp"]
    contribution.cli.verbs = contribution.cli.verbs.mapValues { verb in
      var sealed = verb
      sealed.argvSecrets = true
      return sealed
    }
    let provider = PluginVaultProvider(contribution: contribution, host: run.host, wantRun: { _ in }, openApproval: { _, _ in })
    #expect(provider.sendsSecretHandles)
    provider.attach(run.endpoint)
    return (run, provider, PluginPasskeyFixture.cli(run))
  }

  static func outcome(_ run: CredentialRun, handler: String, _ operation: @escaping @Sendable () async throws -> VaultItem) async throws
    -> (error: VaultError?, input: [String: Any]?)
  {
    let working = Task { () -> VaultError? in
      do {
        _ = try await operation()
        return nil
      } catch let error as VaultError { return error } catch { return .failed("\(error)") }
    }
    var call: [String: Any]?
    for _ in 0..<50 where call == nil {
      call = run.link.messages().first { $0["name"] as? String == handler }
      try await Task.sleep(for: .milliseconds(20))
    }
    if let id = call?["call"] as? String {
      _ = try await run.request("result", ["call": id, "error": ["code": "notFound"]])
    }
    return (await working.value, call?["input"] as? [String: Any])
  }

  @Test func `a new password too long to seal fails before the plugin sees an edit`() async throws {
    let (run, provider, cli) = try await Self.rig()
    let (error, input) = try await Self.outcome(run, handler: "edit") {
      try await provider.edit(cli, id: "item-1", change: VaultLoginChange(password: Self.tooLong))
    }
    #expect(input == nil, "the plugin was asked to edit")
    #expect(error == .failed(provider.wording.secretTooLong))
  }

  @Test func `a code URI too long to seal fails before the plugin sees an addTotp`() async throws {
    let (run, provider, cli) = try await Self.rig()
    let uri = "otpauth://totp/Site:me?secret=" + String(repeating: "A", count: CredentialLimits.secretBytes)
    let (error, input) = try await Self.outcome(run, handler: "addTotp") { try await provider.addTotp(cli, id: "item-1", uri: uri) }
    #expect(input == nil, "the plugin was asked to add a code")
    #expect(error == .failed(provider.wording.secretTooLong))
  }

  @Test func `a password of ordinary length still reaches the plugin, sealed`() async throws {
    let (run, provider, cli) = try await Self.rig()
    let password = "new-password-Q7!x"
    let (error, input) = try await Self.outcome(run, handler: "edit") {
      try await provider.edit(cli, id: "item-1", change: VaultLoginChange(password: password))
    }
    let sent = try #require(input)
    let text = String(decoding: try JSONSerialization.data(withJSONObject: sent), as: UTF8.self)
    #expect(text.contains("\"$secret\""))
    #expect(!text.contains(password))
    #expect(error == .notFound)
  }
}

@Suite("A plugin that holds passkeys for Ardia lists none to delegate")
struct PluginKeyHolderTests {
  @Test func `the passkeys capability with no routes offers keys and no delegation`() throws {
    let provider = try PluginPasskeyFixture.provider(capabilities: ["passkeys"])
    #expect(provider.capabilities.passkeys)
    #expect(provider.capabilities.passkeysVia == nil)
  }
}
