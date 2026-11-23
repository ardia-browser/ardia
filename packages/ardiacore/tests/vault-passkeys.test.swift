import CryptoKit
import Foundation
import Testing

enum PasskeyFixture {
  static func hex(_ data: Data) -> String { data.map { String(format: "%02x", $0) }.joined() }

  static func bytes(_ hex: String) -> Data {
    var data = Data()
    var index = hex.startIndex
    while index < hex.endIndex {
      let next = hex.index(index, offsetBy: 2)
      data.append(UInt8(hex[index..<next], radix: 16) ?? 0)
      index = next
    }
    return data
  }

  indirect enum Item: Hashable {
    case int(Int)
    case bytes(Data)
    case text(String)
    case map([Item: Item])
    case array([Item])
  }

  struct Reader {
    var data: [UInt8]
    var at = 0

    mutating func item() -> Item? {
      guard at < data.count else { return nil }
      let first = data[at]
      at += 1
      let major = first >> 5
      guard let length = argument(first & 0x1F) else { return nil }
      switch major {
      case 0: return .int(Int(length))
      case 1: return .int(-1 - Int(length))
      case 2, 3:
        guard at + Int(length) <= data.count else { return nil }
        let slice = Data(data[at..<(at + Int(length))])
        at += Int(length)
        return major == 2 ? .bytes(slice) : String(data: slice, encoding: .utf8).map(Item.text)
      case 4:
        var list: [Item] = []
        for _ in 0..<length {
          guard let next = item() else { return nil }
          list.append(next)
        }
        return .array(list)
      case 5:
        var map: [Item: Item] = [:]
        var lastKey: [UInt8]?
        for _ in 0..<length {
          let keyStart = at
          guard let key = item() else { return nil }
          let keyBytes = Array(data[keyStart..<at])
          if let lastKey, !(lastKey.count < keyBytes.count || (lastKey.count == keyBytes.count && lastKey.lexicographicallyPrecedes(keyBytes))) {
            return nil
          }
          lastKey = keyBytes
          guard let value = item() else { return nil }
          map[key] = value
        }
        return .map(map)
      default: return nil
      }
    }

    mutating func argument(_ info: UInt8) -> UInt64? {
      if info < 24 { return UInt64(info) }
      let count: Int
      switch info {
      case 24: count = 1
      case 25: count = 2
      case 26: count = 4
      case 27: count = 8
      default: return nil
      }
      guard at + count <= data.count else { return nil }
      var value: UInt64 = 0
      for _ in 0..<count {
        value = value << 8 | UInt64(data[at])
        at += 1
      }
      if count > 1, value < (count == 2 ? 0x100 : count == 4 ? 0x1_0000 : 0x1_0000_0000) { return nil }
      if count == 1, value < 24 { return nil }
      return value
    }
  }

  static func decodeWhole(_ data: Data) -> Item? {
    var reader = Reader(data: Array(data))
    guard let item = reader.item(), reader.at == data.count else { return nil }
    return item
  }

  static func message(_ options: [String: Any], mediation: String? = nil) -> [String: Any] {
    var message: [String: Any] = ["options": options]
    if let mediation { message["mediation"] = mediation }
    return message
  }

  static let challenge = VaultBase64URL.encode(Data(repeating: 1, count: 32))

  static func createOptions(_ extra: [String: Any] = [:]) -> [String: Any] {
    var options: [String: Any] = [
      "challenge": challenge, "rp": ["name": "Example", "id": "example.com"],
      "user": ["id": VaultBase64URL.encode(Data([1, 2, 3])), "name": "alice\u{202E}@example.com", "displayName": "Alice"],
      "pubKeyCredParams": [["type": "public-key", "alg": -8.0], ["type": "public-key", "alg": -7.0]],
    ]
    for (key, value) in extra { options[key] = value }
    return options
  }

  static func parsedCreate(_ extra: [String: Any] = [:], mediation: String? = nil) -> VaultPasskeyRequest? {
    VaultPasskeyRequest.parse(message(createOptions(extra), mediation: mediation), kind: .create)
  }

  static func parsedGet(_ options: [String: Any], mediation: String? = nil) -> VaultPasskeyRequest? {
    VaultPasskeyRequest.parse(message(options, mediation: mediation), kind: .get)
  }
}

typealias F = PasskeyFixture

@Suite("WebAuthn encoding")
struct VaultWebAuthnEncodingTests {
  @Test("CBOR integers use the shortest head", arguments: [
    (0, "00"), (23, "17"), (24, "1818"), (500, "1901f4"), (1_000_000, "1a000f4240"), (-1, "20"), (-7, "26"), (-257, "390100"),
  ])
  func cborIntegers(value: Int, encoded: String) {
    #expect(F.hex(VaultCBOR.encode(.int(value))) == encoded)
  }

  @Test func `CBOR text, bytes and maps encode canonically`() {
    #expect(F.hex(VaultCBOR.encode(.text("fmt"))) == "63666d74")
    #expect(F.hex(VaultCBOR.encode(.bytes(Data([1, 2])))) == "420102")
    #expect(F.hex(VaultCBOR.encode(.map([]))) == "a0")
    #expect(F.hex(VaultCBOR.encode(.bytes(Data(repeating: 7, count: 300))).prefix(3)) == "59012c")
    let shuffled = VaultCBOR.encode(.map([(.text("authData"), .int(1)), (.int(-3), .int(2)), (.text("fmt"), .int(3)), (.int(1), .int(4))]))
    #expect(F.hex(shuffled) == "a4" + "0104" + "2202" + "63666d7403" + "6861757468446174610" + "1")
  }

  @Test("base64url round-trips unpadded with the URL alphabet", arguments: [
    (Data([0xFB, 0xFF, 0xBF]), "-_-_"), (Data([1]), "AQ"),
  ])
  func base64urlRoundTrip(data: Data, text: String) {
    #expect(VaultBase64URL.encode(data) == text)
    #expect(VaultBase64URL.decode(text) == data)
  }

  @Test("base64url refuses padding, the standard alphabet and a dangling character", arguments: ["AQ==", "A+Q", "A"])
  func base64urlRefuses(text: String) {
    #expect(VaultBase64URL.decode(text) == nil)
  }

  @Test func `base64url decoding has a length cap`() {
    #expect(VaultBase64URL.decode(String(repeating: "A", count: 100), longest: 10) == nil)
  }

  @Test func `clientDataJSON is laid out as the spec serializes it`() throws {
    let challenge = Data((0..<32).map { UInt8($0) })
    let json = VaultWebAuthn.clientDataJSON(.create, challenge: challenge, origin: "https://webauthn.io")
    #expect(String(data: json, encoding: .utf8) ==
      "{\"type\":\"webauthn.create\",\"challenge\":\"AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8\",\"origin\":\"https://webauthn.io\",\"crossOrigin\":false}")
    let parsed = try #require(try JSONSerialization.jsonObject(with: json) as? [String: Any])
    #expect(parsed["type"] as? String == "webauthn.create")
    #expect(parsed["crossOrigin"] as? Bool == false)
    #expect(VaultBase64URL.decode(parsed["challenge"] as? String ?? "") == challenge)
    let get = try #require(String(data: VaultWebAuthn.clientDataJSON(.get, challenge: Data([1]), origin: "http://localhost:8080"), encoding: .utf8))
    #expect(get.hasPrefix("{\"type\":\"webauthn.get\",\"challenge\":\"AQ\",\"origin\":\"http://localhost:8080\""))
  }

  @Test func `CCDToString escapes quotes, backslashes and control characters`() {
    #expect(VaultWebAuthn.quoted("a\"b\\c\u{1}é") == "\"a\\\"b\\\\c\\u0001é\"")
  }

  @Test func `format characters are dropped from names`() {
    #expect(VaultPasskey.cleaned("a\u{00AD}b\u{E0041}c\u{061C}d") == "abcd")
  }

  @Test func `a name of many combining marks is cut to a size the record still decodes`() throws {
    let heavy = "a" + String(repeating: "\u{0301}", count: 9000)
    let name = VaultPasskey.cleaned(heavy)
    #expect(name.utf8.count <= VaultPasskey.longestNameBytes)
    #expect(name.unicodeScalars.starts(with: "a\u{0301}".unicodeScalars))
    #expect(VaultPasskey.cleaned("Zoë Ångström") == "Zoë Ångström")
    let passkey = VaultPasskey.made(rpId: "example.com", origin: "https://example.com", userHandle: Data([1]), userName: heavy, displayName: heavy,
                                    key: P256.Signing.PrivateKey(), at: 0)
    #expect(VaultPasskey.decoded(passkey.encoded()) == passkey)
  }
}

@Suite("WebAuthn registration and assertion")
struct VaultWebAuthnCeremonyTests {
  let key = P256.Signing.PrivateKey()

  @Test func `credential ids are 16 random bytes`() {
    let credentialId = VaultWebAuthn.newCredentialId()
    #expect(credentialId.count == 16)
    #expect(credentialId != VaultWebAuthn.newCredentialId())
  }

  @Test func `registration authData carries the rp hash, flags, zero counter and AAGUID, and the credential`() throws {
    let credentialId = VaultWebAuthn.newCredentialId()
    let authData = VaultWebAuthn.authenticatorData(rpId: "example.com", flags: VaultWebAuthn.flags(backedUp: true), credentialId: credentialId, publicKey: key.publicKey)
    #expect(F.hex(authData.prefix(32)) == "a379a6f6eeafb9a55e378c118034e2751e682fab9f2d30ab13d2125586ce1947")
    #expect(authData[32] == 0x5D)
    #expect(F.hex(authData.subdata(in: 33..<37)) == "00000000")
    #expect(authData.subdata(in: 37..<53) == Data(count: 16))
    #expect(Int(authData[53]) << 8 | Int(authData[54]) == 16)
    #expect(authData.subdata(in: 55..<71) == credentialId)

    let cose = authData.subdata(in: 71..<authData.count)
    #expect(cose.count == 77)
    guard case .map(let coseMap)? = F.decodeWhole(cose) else {
      Issue.record("COSE key is not canonical CBOR")
      return
    }
    #expect(coseMap[.int(1)] == .int(2))
    #expect(coseMap[.int(3)] == .int(-7))
    #expect(coseMap[.int(-1)] == .int(1))
    guard case .bytes(let x)? = coseMap[.int(-2)], case .bytes(let y)? = coseMap[.int(-3)] else {
      Issue.record("COSE key has no x and y")
      return
    }
    let point = Data([4]) + x + y
    #expect(try P256.Signing.PublicKey(x963Representation: point).derRepresentation == key.publicKey.derRepresentation)
  }

  @Test func `the attestation object is none attestation around authData, and reads back`() throws {
    let authData = VaultWebAuthn.authenticatorData(rpId: "example.com", flags: VaultWebAuthn.flags(backedUp: true), credentialId: VaultWebAuthn.newCredentialId(),
                                                   publicKey: key.publicKey)
    let attestation = VaultWebAuthn.attestationObject(authenticatorData: authData)
    guard case .map(let object)? = F.decodeWhole(attestation) else {
      Issue.record("attestationObject is not canonical CBOR")
      return
    }
    #expect(object[.text("fmt")] == .text("none"))
    #expect(object[.text("attStmt")] == .map([:]))
    #expect(object[.text("authData")] == .bytes(authData))
    #expect(F.hex(attestation.prefix(5)) == "a363666d74")
    #expect(VaultWebAuthn.authenticatorData(fromAttestation: attestation) == authData)
    #expect(VaultWebAuthn.publicKey(fromAuthenticatorData: authData)?.derRepresentation == key.publicKey.derRepresentation)
    #expect(VaultWebAuthn.authenticatorData(fromAttestation: Data([0xa1, 0x63])) == nil)
    #expect(VaultWebAuthn.publicKey(fromAuthenticatorData: Data(authData.prefix(37))) == nil)
  }

  @Test func `an assertion signature covers authData and the client data hash, bound to the origin`() throws {
    let authData = VaultWebAuthn.authenticatorData(rpId: "webauthn.io", flags: VaultWebAuthn.flags(backedUp: false))
    #expect(authData.count == 37)
    #expect(F.hex(authData.prefix(32)) == "74a6ea9213c99c2f74b22492b320cf40262a94c1a950a0397f29250b60841ef0")
    #expect(authData[32] == 0x0D)
    let clientData = VaultWebAuthn.clientDataJSON(.get, challenge: Data(repeating: 9, count: 32), origin: "https://webauthn.io")
    let signature = try VaultWebAuthn.signature(key, authenticatorData: authData, clientDataJSON: clientData)
    #expect(signature.first == 0x30)
    let parsed = try P256.Signing.ECDSASignature(derRepresentation: signature)
    let signed = authData + Data(SHA256.hash(data: clientData))
    #expect(key.publicKey.isValidSignature(parsed, for: signed))
    var tampered = signed
    tampered[32] ^= 0x01
    #expect(key.publicKey.isValidSignature(parsed, for: tampered) == false)
    let other = VaultWebAuthn.clientDataJSON(.get, challenge: Data(repeating: 9, count: 32), origin: "https://evil.example")
    #expect(key.publicKey.isValidSignature(parsed, for: authData + Data(SHA256.hash(data: other))) == false)
  }
}

@Suite("Relying party checks")
struct VaultRelyingPartyTests {
  @Test("An rp id the origin may claim is accepted", arguments: [
    (nil, "https://webauthn.io", "webauthn.io"),
    ("webauthn.io", "https://webauthn.io", "webauthn.io"),
    ("example.com", "https://login.example.com", "example.com"),
    ("login.example.com", "https://login.example.com:8443", "login.example.com"),
    ("example.co.uk", "https://a.example.co.uk", "example.co.uk"),
    ("alice.github.io", "https://alice.github.io", "alice.github.io"),
    ("localhost", "http://localhost:3000", "localhost"),
    (nil, "https://localhost", "localhost"),
    ("xn--bcher-kva.de", "https://xn--bcher-kva.de", "xn--bcher-kva.de"),
  ] as [(String?, String, String)])
  func accepts(rpId: String?, origin: String, wanted: String) {
    #expect(VaultRelyingParty.check(rpId: rpId, origin: origin)?.rpId == wanted)
  }

  @Test("An rp id the origin may not claim is refused", arguments: [
    ("github.io", "https://alice.github.io"),
    ("co.uk", "https://example.co.uk"),
    ("com", "https://example.com"),
    ("evil.com", "https://example.com"),
    ("ample.com", "https://example.com"),
    ("bob.github.io", "https://alice.github.io"),
    ("Example.com", "https://example.com"),
    ("example.com.", "https://example.com"),
    ("example..com", "https://example.com"),
    (nil, "http://example.com"),
    (nil, "http://127.0.0.1:8080"),
    (nil, "https://127.0.0.1"),
    (nil, "https://[::1]"),
    (nil, "null"),
    (nil, "file://"),
    (nil, "https://user@example.com"),
    (nil, "https://example.com/path"),
    ("éxample.com", "https://example.com"),
    ("example.com", "https://example.com.evil.net"),
    (nil, "https://github.io"),
    ("localhost", "https://evil.localhost.com"),
  ] as [(String?, String)])
  func refuses(rpId: String?, origin: String) {
    #expect(VaultRelyingParty.check(rpId: rpId, origin: origin) == nil)
  }
}

@Suite("Passkey requests from the page")
struct VaultPasskeyRequestTests {
  @Test func `a create request reads its rp, user, timeout and extensions`() throws {
    let create = try #require(F.parsedCreate(["timeout": 60_000.0, "extensions": ["credProps": true]]))
    #expect(create.rpId == "example.com")
    #expect(create.userName == "alice@example.com")
    #expect(create.userId == Data([1, 2, 3]))
    #expect(create.timeout == 60)
    #expect(create.credProps == true)
    #expect(create.unsupported == false)
  }

  @Test func `empty algorithm params mean the defaults`() {
    #expect(F.parsedCreate(["pubKeyCredParams": [Any]()])?.unsupported == false)
  }

  @Test func `create requests Ardia can't serve fall back`() {
    #expect(F.parsedCreate(["pubKeyCredParams": [["type": "public-key", "alg": -257.0]]])?.unsupported == true)
    #expect(F.parsedCreate(["authenticatorSelection": ["authenticatorAttachment": "cross-platform"]])?.unsupported == true)
    #expect(F.parsedCreate(["hints": ["security-key"]])?.unsupported == true)
    #expect(F.parsedCreate(mediation: "conditional")?.unsupported == true)
  }

  @Test("The timeout clamps to 10 through 600 seconds", arguments: [(1.0, 10), (1e12, 600)])
  func timeoutClamps(milliseconds: Double, seconds: Int) {
    #expect(F.parsedCreate(["timeout": milliseconds])?.timeout == TimeInterval(seconds))
  }

  @Test func `malformed create requests are refused`() {
    var longUser = F.createOptions()
    longUser["user"] = ["id": VaultBase64URL.encode(Data(repeating: 1, count: 65)), "name": "a"]
    #expect(VaultPasskeyRequest.parse(F.message(longUser), kind: .create) == nil)
    var noUser = F.createOptions()
    noUser["user"] = ["name": "a"]
    #expect(VaultPasskeyRequest.parse(F.message(noUser), kind: .create) == nil)
    var numericRp = F.createOptions()
    numericRp["rp"] = ["id": 5.0, "name": "x"]
    #expect(VaultPasskeyRequest.parse(F.message(numericRp), kind: .create) == nil)
    let manyIds = (0..<65).map { _ in ["type": "public-key", "id": "AQ"] }
    #expect(F.parsedCreate(["excludeCredentials": manyIds]) == nil)
    #expect(F.parsedCreate(["challenge": ""]) == nil)
  }

  @Test func `the exclude list is read`() {
    #expect(F.parsedCreate(["excludeCredentials": [["type": "public-key", "id": "AQI"]]])?.credentials == [Data([1, 2])])
  }

  @Test func `a get request reads conditional mediation, rp id and allow list`() throws {
    let get = try #require(F.parsedGet(["challenge": F.challenge, "rpId": "webauthn.io", "allowCredentials": [["type": "public-key", "id": "AQI"]]],
                                       mediation: "conditional"))
    #expect(get.conditional)
    #expect(get.rpId == "webauthn.io")
    #expect(get.credentials == [Data([1, 2])])
  }

  @Test("Silent and immediate get requests fall back", arguments: ["silent", "immediate"])
  func getFallsBack(mediation: String) {
    #expect(F.parsedGet(["challenge": F.challenge], mediation: mediation)?.unsupported == true)
  }

  @Test func `a get request reads appid and treats a null rpId as the default`() throws {
    #expect(F.parsedGet(["challenge": F.challenge, "extensions": ["appid": "https://x"]])?.appid == true)
    let nullRp = try #require(F.parsedGet(["challenge": F.challenge, "rpId": NSNull()]))
    #expect(nullRp.rpId == nil)
  }
}

@Suite("Stored passkeys")
struct VaultPasskeyStorageTests {
  let key = P256.Signing.PrivateKey()

  @Test func `a passkey round-trips with its key, trimmed name and sorted JSON`() throws {
    let passkey = VaultPasskey.made(rpId: "example.com", origin: "https://example.com", userHandle: Data([9, 9]), userName: " alice\n",
                                    displayName: "Alice", key: key, at: 1000)
    #expect(passkey.userName == "alice")
    let decoded = try #require(VaultPasskey.decoded(passkey.encoded()))
    #expect(decoded == passkey)
    #expect(decoded.signingKey?.publicKey.derRepresentation == key.publicKey.derRepresentation)
    #expect(passkey.encoded()?.contains("\"createdAt\"") == true)
  }

  @Test func `a stored passkey with a bad key or rp id is refused`() {
    let passkey = VaultPasskey.made(rpId: "example.com", origin: "https://example.com", userHandle: Data([9, 9]), userName: "alice",
                                    displayName: "Alice", key: key, at: 1000)
    var badKey = passkey
    badKey.privateKey = "AAAA"
    #expect(VaultPasskey.decoded(badKey.encoded()) == nil)
    var badRp = passkey
    badRp.rpId = "Example.com"
    #expect(VaultPasskey.decoded(badRp.encoded()) == nil)
  }

  @Test("Only base64url credential ids are passkey ledger keys", arguments: [
    (VaultBase64URL.encode(Data([1, 2, 3, 4])), true), ("AQ==", false), ("code.abc", false),
  ])
  func ledgerKeys(id: String, isPasskey: Bool) {
    #expect(VaultPasskey.isId(id) == isPasskey)
  }

  @Test func `decodedAll keeps only valid entries`() throws {
    let passkey = VaultPasskey.made(rpId: "example.com", origin: "https://example.com", userHandle: Data([9]), userName: "alice",
                                    displayName: "", key: key, at: 1)
    let encoded = try #require(passkey.encoded())
    #expect(VaultPasskey.decodedAll([VaultBase64URL.encode(Data([1, 2, 3, 4])): encoded, "junk": "x"]).count == 1)
  }

  @Test func `passkeys sync through the ledger, deletions included`() throws {
    let passkey = VaultPasskey.made(rpId: "example.com", origin: "https://example.com", userHandle: Data([1]), userName: "alice", displayName: "",
                                    key: key, at: 1)
    let id = VaultBase64URL.encode(Data([7, 7, 7]))
    var macA = ArdiaVaultFile(device: "a")
    macA.passkeys.set(id, passkey.encoded(), at: 100, device: "a")
    var macB = ArdiaVaultFile(device: "b")
    let reached = macB.merge(macA.shared)
    #expect(reached)
    #expect(VaultPasskey.decodedAll(macB.passkeys.values)[id] == passkey)
    macB.passkeys.set(id, nil, at: 200, device: "b")
    let deleted = macA.merge(macB.shared)
    #expect(deleted)
    #expect(VaultPasskey.decodedAll(macA.passkeys.values).isEmpty)
    let fromEmpty = macA.merge(ArdiaVaultFile(device: "old").shared)
    #expect(fromEmpty == false)
    var stale = ArdiaVaultFile(device: "c")
    stale.passkeys.set(id, passkey.encoded(), at: 150, device: "c")
    macA.merge(stale)
    #expect(macA.passkeys.isRemoved(id))
    #expect(ArdiaVaultFile(device: "x").isEmpty)
    let decoded = try #require(ArdiaVaultFile.decode(try JSONEncoder().encode(macA.shared), device: "z", now: 0))
    #expect(decoded.passkeys == macA.passkeys)
  }
}

struct PasskeyRouteCase: Sendable, CustomTestStringConvertible {
  static let proton = "ghmbeldphafepmbegfdlkpapadhbakde"
  static let other = "nngceckbapebfimnlniiiahkandclblb"

  let why: String
  let setting: String
  var create = false
  var conditional = false
  var extensions = [proton]
  var can = true
  var has = true
  let route: VaultPasskeyRoute

  var testDescription: String { why }

  var decided: VaultPasskeyRoute {
    VaultPasskeyRoute.decide(.init(source: VaultPasskeySource(setting: setting), creating: create, conditional: conditional, extensions: extensions,
                                   ardiaCan: can, ardiaHasPasskeys: has))
  }

  static let all: [PasskeyRouteCase] = [
    .init(why: "no extension: Ardia as before", setting: "ask", extensions: [], route: .ardia),
    .init(why: "no extension, no passkey: Chrome as before", setting: "ask", extensions: [], has: false, route: .asIfAbsent),
    .init(why: "Chrome default holds without extensions", setting: "chrome", extensions: [], route: .chrome),
    .init(why: "ask shows the chooser", setting: "ask", route: .choose(ardia: true, extensions: [proton])),
    .init(why: "the chooser leaves out Ardia with nothing to sign in with", setting: "ask", has: false, route: .choose(ardia: false, extensions: [proton])),
    .init(why: "Ardia can always save", setting: "ask", create: true, has: false, route: .choose(ardia: true, extensions: [proton])),
    .init(why: "Ardia default goes straight to Ardia", setting: "ardia", route: .ardia),
    .init(why: "Ardia default with nothing saved asks among the rest", setting: "ardia", has: false, route: .choose(ardia: false, extensions: [proton])),
    .init(why: "extension default goes straight there", setting: "ext:\(proton)", route: .extensionId(proton)),
    .init(why: "extension default takes autofill too", setting: "ext:\(proton)", conditional: true, route: .extensionId(proton)),
    .init(why: "a default extension that's gone means ask", setting: "ext:\(other)", route: .choose(ardia: true, extensions: [proton])),
    .init(why: "Chrome default", setting: "chrome", route: .chrome),
    .init(why: "Chrome default takes autofill", setting: "chrome", conditional: true, route: .chrome),
    .init(why: "ask keeps autofill in Ardia's menu", setting: "ask", conditional: true, route: .ardia),
    .init(why: "Ardia keeps autofill", setting: "ardia", conditional: true, route: .ardia),
    .init(why: "with nothing in Ardia, autofill is left to the page's own order", setting: "ask", conditional: true, extensions: [proton, other], has: false,
          route: .asIfAbsent),
    .init(why: "a request Ardia can't take never offers Ardia", setting: "ask", can: false, route: .choose(ardia: false, extensions: [proton])),
  ]
}

@Suite("Passkey routing")
struct VaultPasskeyRouteTests {
  static let proton = PasskeyRouteCase.proton
  static let other = PasskeyRouteCase.other

  @Test("The passkey setting reads as a source", arguments: [
    ("ext:\(proton)", VaultPasskeySource.extensionId(proton)), ("ext:NOTANID", .ask), ("", .ask),
  ])
  func source(setting: String, source: VaultPasskeySource) {
    #expect(VaultPasskeySource(setting: setting) == source)
  }

  @Test("A passkey request goes where the setting and the page allow", arguments: PasskeyRouteCase.all)
  func routes(row: PasskeyRouteCase) {
    #expect(row.decided == row.route)
  }

  @Test func `only installed passkey extensions count as claims, once each, in installed order`() {
    let unrelated = "abcdefghijklmnopabcdefghijklmnop"
    let installed = [VaultPasskeyExtension(id: Self.other, name: "Bitwarden", known: true), VaultPasskeyExtension(id: Self.proton, name: "Proton Pass", known: false),
                     VaultPasskeyExtension(id: unrelated, name: "Dark Reader", known: false)]
    #expect(VaultPasskeyExtension.eligible([Self.proton, Self.other, Self.other, unrelated, "zzz"], installed: installed) { $0 == Self.proton } == [Self.other, Self.proton])
    #expect(VaultPasskeyExtension.eligible([unrelated], installed: installed) { _ in false } == [])
  }
}

@Suite("Passkey extension scan")
struct VaultPasskeyExtensionScanTests {
  let root = FileManager.default.temporaryDirectory.appendingPathComponent("passkey-scan-\(UUID().uuidString)")

  func install(_ id: String, world: String?, script: String) throws {
    let folder = root.appendingPathComponent("Default/Extensions/\(id)/1.0_0")
    try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
    var entry: [String: Any] = ["matches": ["https://*/*"], "js": ["page.js"]]
    if let world { entry["world"] = world }
    let manifest: [String: Any] = ["manifest_version": 3, "content_scripts": [entry]]
    try JSONSerialization.data(withJSONObject: manifest).write(to: folder.appendingPathComponent("manifest.json"))
    try Data(script.utf8).write(to: folder.appendingPathComponent("page.js"))
  }

  @Test func `only a MAIN-world script touching navigator credentials wraps WebAuthn`() throws {
    defer { try? FileManager.default.removeItem(at: root) }
    let wrapper = String(repeating: "a", count: 32)
    let isolated = String(repeating: "b", count: 32)
    let unrelated = String(repeating: "c", count: 32)
    try install(wrapper, world: "MAIN", script: "const c = navigator.credentials; c.get = () => 1;")
    try install(isolated, world: nil, script: "navigator.credentials.get = () => 1;")
    try install(unrelated, world: "MAIN", script: "document.title = 'x';")
    #expect(VaultPasskeyExtensionScan.wrapsWebAuthn(id: wrapper, userDataDirectory: root.path))
    #expect(VaultPasskeyExtensionScan.wrapsWebAuthn(id: isolated, userDataDirectory: root.path) == false)
    #expect(VaultPasskeyExtensionScan.wrapsWebAuthn(id: unrelated, userDataDirectory: root.path) == false)
    #expect(VaultPasskeyExtensionScan.wrapsWebAuthn(id: String(repeating: "d", count: 32), userDataDirectory: root.path) == false)
  }
}
