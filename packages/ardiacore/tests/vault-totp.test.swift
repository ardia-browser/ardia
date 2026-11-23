import Foundation
import Testing

enum TotpFixture {
  static let sha1Key = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ"
  static let sha256Key = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQGEZA===="
  static let sha512Key = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQGEZDGNA="
  static let shortKey = String(repeating: "ABCD", count: 4)
  static let loginPassword = "fixture-" + "pw-1"

  static func uri(_ query: String, label: String = "Example:alice@example.com") -> String { "otpauth://totp/\(label)?\(query)" }
}

private let sha1Key = TotpFixture.sha1Key
private let sha256Key = TotpFixture.sha256Key
private let sha512Key = TotpFixture.sha512Key
private let shortKey = TotpFixture.shortKey
private let pw = TotpFixture.loginPassword
private func uri(_ query: String, label: String = "Example:alice@example.com") -> String { TotpFixture.uri(query, label: label) }

@Suite("TOTP secrets and links")
struct VaultTotpParsingTests {
  @Test("Rejects what is not a usable code", arguments: [
    "", "   ", "otpauth://hotp/Example?secret=\(sha1Key)&counter=0", "otpauth://totp/Example", "otpauth://totp/Example?secret=",
    "otpauth://totp/Example?secret=GEZDGNBVGY3TQOJ1", "otpauth://totp/Example?secret=\(sha1Key)&digits=5",
    "otpauth://totp/Example?secret=\(sha1Key)&digits=9", "otpauth://totp/Example?secret=\(sha1Key)&digits=six",
    "otpauth://totp/Example?secret=\(sha1Key)&period=0", "otpauth://totp/Example?secret=\(sha1Key)&period=4",
    "otpauth://totp/Example?secret=\(sha1Key)&period=301", "otpauth://totp/Example?secret=\(sha1Key)&period=-30",
    "otpauth://totp/Example?secret=\(sha1Key)&period=1e9", "otpauth://totp/Example?secret=\(sha1Key)&period=99999999999999999999",
    "otpauth://totp/Example?secret=\(sha1Key)&algorithm=MD5", "otpauth://totp/Example?secret=\(sha1Key)&encoder=steam&digits=6",
    "https://example.com/?secret=\(sha1Key)", "steam://", "otpauth://totp/Example?secret=\(String(repeating: "A", count: 2100))",
    "otpauth://totp/\(String(repeating: "x", count: 2100))?secret=\(sha1Key)",
  ])
  func rejects(text: String) {
    #expect(VaultTotpSecret(text) == nil)
  }

  @Test func `a secret shorter than 80 bits is refused for setup but still makes codes once stored`() {
    #expect(VaultTotpURI.setupURI("otpauth://totp/Example?secret=ABCDABCD") == nil)
    #expect(VaultTotpSecret("otpauth://totp/Example?secret=ABCDABCD") != nil)
  }

  @Test("A plain key is refused when it can't be a setup key", arguments: [
    ("ABCDABCDABCDABC", "https://example.com"),
    (shortKey, "http://example.com"),
    (shortKey + "!", "https://example.com"),
  ])
  func refusesKey(key: String, origin: String) {
    #expect(VaultTotpURI.keyURI(key, origin: origin) == nil)
  }

  @Test func `a link that is not a code is not a setup URI`() {
    #expect(VaultTotpURI.setupURI(inText: "https://example.com/setup", origin: "https://example.com") == nil)
  }

  @Test func `QR payloads find no code, one code, or many`() {
    #expect(VaultTotpURI.found(inPayloads: []) == .none)
    #expect(VaultTotpURI.found(inPayloads: ["https://example.com", "WIFI:S:home;T:WPA;P:\(pw);;"]) == .none)
    let other = uri("secret=\(sha256Key)", label: "Other:bob")
    #expect(VaultTotpURI.found(inPayloads: [uri("secret=\(sha1Key)"), other]) == .many)
    let same = uri("secret=\(sha1Key)", label: "Second:label")
    #expect(VaultTotpURI.found(inPayloads: [uri("secret=\(sha1Key)"), same, "noise"]) == .one(uri("secret=\(sha1Key)")))
  }

  @Test("Base32 keys decode in every written form", arguments: [
    sha1Key.lowercased(), "gezd gnbv gy3t qojq gezd gnbv gy3t qojq", "GEZD-GNBV-GY3T-QOJQ-GEZD-GNBV-GY3T-QOJQ",
  ])
  func base32Forms(text: String) throws {
    let plain = try #require(VaultTotpSecret(sha1Key)?.key)
    #expect(plain.count == 20)
    #expect(VaultTotpSecret(text)?.key == plain)
  }

  @Test func `padding is accepted only at the end`() {
    #expect(VaultTotpSecret(uri("secret=\(sha256Key.lowercased())"))?.key.count == 32)
    #expect(VaultTotpSecret(uri("secret=GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQGEZA%3D%3D%3D%3D", label: "x"))?.key.count == 22)
    #expect(VaultTotpSecret("GEZD=GNBV") == nil)
  }

  @Test func `a URI with raw spaces parses and is stored escaped`() throws {
    let spaced = "otpauth://totp/ACME Co:john@example.com?secret=\(sha1Key)&issuer=ACME Co"
    #expect(VaultTotpSecret(spaced) != nil)
    let stored = try #require(VaultTotpURI.setupURI(spaced))
    #expect(stored.contains(" ") == false)
    #expect(URLComponents(string: stored) != nil)
    let labels = try #require(VaultTotpURI.labels(spaced))
    #expect(labels.issuer == "ACME Co")
    #expect(labels.account == "john@example.com")
  }

  @Test("Labels read issuer and account", arguments: [
    ("otpauth://totp/ACME%20Co%3Ajohn%40example.com?secret=\(sha1Key)&issuer=ACME%20Co", "ACME Co", "john@example.com"),
    (uri("secret=\(sha1Key)&issuer=Real", label: "Fake:me"), "Real", "me"),
    (uri("secret=\(sha1Key)", label: "octo"), "", "octo"),
    (uri("secret=\(sha1Key)&issuer=GitHub", label: "GitHub"), "GitHub", ""),
    (uri("secret=\(sha1Key)", label: "Bank%E2%80%AElapyap:me%E2%80%8B"), "Banklapyap", "me"),
  ])
  func labels(link: String, issuer: String, account: String) throws {
    let labels = try #require(VaultTotpURI.labels(link))
    #expect(labels.issuer == issuer)
    #expect(labels.account == account)
  }

  @Test func `long labels clip`() {
    let long = String(repeating: "a", count: 400)
    #expect(VaultTotpURI.labels(uri("secret=\(sha1Key)", label: "x:\(long)"))?.account.count == VaultTotpURI.longestLabel)
  }

  @Test func `uppercase scheme and names parse and are stored lowercase`() throws {
    let upper = "OTPAUTH://TOTP/Example?SECRET=\(sha1Key)&DIGITS=8&PERIOD=60&ALGORITHM=SHA256"
    let secret = try #require(VaultTotpSecret(upper))
    #expect(secret.digits == 8)
    #expect(secret.period == 60)
    #expect(secret.algorithm == .sha256)
    #expect(VaultTotpURI.setupURI(upper)?.hasPrefix("otpauth://totp/") == true)
  }

  @Test func `URI parameters fall back sensibly`() {
    #expect(VaultTotpURI.setupURI("otpauth://totp?secret=\(sha1Key)") == "otpauth://totp/?secret=\(sha1Key)")
    #expect(VaultTotpSecret(uri("secret=\(sha1Key)&period=60&period=10"))?.period == 60)
    #expect(VaultTotpSecret(uri("secret=\(sha1Key)&digits=&period="))?.digits == 6)
    #expect(VaultTotp.period(fromURI: uri("secret=\(sha1Key)&period=45")) == 45)
    #expect(VaultTotp.period(fromURI: sha1Key) == nil)
  }

  @Test func `a setup URI is found inside text`() {
    #expect(VaultTotpURI.setupURI(inText: "Scan or open otpauth://totp/X:y?secret=\(sha1Key) now", origin: "https://x.com")
            == "otpauth://totp/X:y?secret=\(sha1Key)")
  }

  @Test func `a plain key becomes a code named after the site`() throws {
    let key = try #require(VaultTotpURI.setupURI(inText: " abcd abcd abcd abcd ", origin: "https://www.example.com"))
    #expect(VaultTotpSecret(key)?.key == VaultTotpSecret(shortKey)?.key)
    #expect(VaultTotpURI.labels(key)?.issuer == "example.com")
    #expect(VaultTotpURI.keyURI(shortKey, origin: "http://localhost:8080") != nil)
  }

  @Test func `algorithm names are read loosely`() {
    #expect(VaultTotpSecret(uri("secret=\(sha1Key)&algorithm=HmacSHA256"))?.algorithm == .sha256)
    #expect(VaultTotpSecret(uri("secret=\(sha1Key)&algorithm=sha512"))?.algorithm == .sha512)
  }
}

@Suite("TOTP codes")
struct VaultTotpCodeTests {
  struct Vector: Sendable, CustomTestStringConvertible {
    let time: TimeInterval
    let sha1: String
    let sha256: String
    let sha512: String
    var testDescription: String { "t=\(Int64(time))" }
  }

  @Test("RFC 6238 vectors", arguments: [
    Vector(time: 59, sha1: "94287082", sha256: "46119246", sha512: "90693936"),
    Vector(time: 1_111_111_109, sha1: "07081804", sha256: "68084774", sha512: "25091201"),
    Vector(time: 1_111_111_111, sha1: "14050471", sha256: "67062674", sha512: "99943326"),
    Vector(time: 1_234_567_890, sha1: "89005924", sha256: "91819424", sha512: "93441116"),
    Vector(time: 2_000_000_000, sha1: "69279037", sha256: "90698825", sha512: "38618901"),
    Vector(time: 20_000_000_000, sha1: "65353130", sha256: "77737706", sha512: "47863826"),
  ])
  func rfc6238(vector: Vector) throws {
    let sha1 = try #require(VaultTotpSecret(uri("secret=\(sha1Key)&digits=8&algorithm=SHA1")))
    let sha256 = try #require(VaultTotpSecret(uri("secret=\(sha256Key)&digits=8&algorithm=SHA256")))
    let sha512 = try #require(VaultTotpSecret(uri("secret=\(sha512Key)&digits=8&algorithm=sha-512")))
    let date = Date(timeIntervalSince1970: vector.time)
    #expect(sha1.code(at: date) == vector.sha1)
    #expect(sha256.code(at: date) == vector.sha256)
    #expect(sha512.code(at: date) == vector.sha512)
  }

  @Test("RFC 4226 counters", arguments: zip(0..<10, ["755224", "287082", "359152", "969429", "338314", "254676", "287922", "162583", "399871", "520489"]))
  func rfc4226(counter: Int, wanted: String) {
    #expect(VaultTotpSecret(sha1Key)?.code(counter: UInt64(counter)) == wanted)
  }

  @Test func `seven digit codes`() {
    #expect(VaultTotpSecret(uri("secret=\(sha1Key)&digits=7"))?.code(counter: 1) == "4287082")
  }

  @Test("Steam forms make Steam codes", arguments: [
    "steam://\(sha1Key)", uri("secret=\(sha1Key)&encoder=steam", label: "Steam:me"),
    uri("secret=\(sha1Key)&issuer=Steam&digits=5", label: "Steam:me"),
  ])
  func steam(form: String) throws {
    let secret = try #require(VaultTotpSecret(form))
    #expect(secret.encoding == .steam)
    #expect(secret.code(counter: 0) == "GG5F5")
    #expect(secret.code(counter: 1) == "PV9M4")
    #expect(secret.code(counter: 37_037_036) == "PY4YB")
  }

  @Test func `a steam link is stored as an otpauth URI that keeps Steam`() throws {
    let stored = try #require(VaultTotpURI.setupURI("steam://\(sha1Key)"))
    #expect(VaultTotpSecret(stored)?.encoding == .steam)
    #expect(stored.hasPrefix("otpauth://totp/Steam"))
    #expect(VaultTotpSecret("steam://\(sha1Key)")?.totp(at: Date(timeIntervalSince1970: 59))?.code == "PV9M4")
  }

  @Test func `codes expire on the period edge and carry the next one`() throws {
    let secret = try #require(VaultTotpSecret(sha1Key))
    let before = Date(timeIntervalSince1970: 59.999)
    let edge = Date(timeIntervalSince1970: 60)
    #expect(secret.totp(at: before)?.expiresAt == 60_000)
    #expect(secret.totp(at: edge)?.expiresAt == 90_000)
    #expect(secret.code(at: before) != secret.code(at: edge))
    #expect(secret.totp(at: before)?.next == secret.totp(at: edge)?.code)
    let minute = try #require(VaultTotpSecret(uri("secret=\(sha1Key)&period=60")))
    #expect(minute.totp(at: Date(timeIntervalSince1970: 61))?.expiresAt == 120_000)
  }

  @Test("A broken clock counts from zero", arguments: [-5, TimeInterval.nan])
  func brokenClock(time: TimeInterval) throws {
    #expect(try #require(VaultTotpSecret(sha1Key)).counter(at: Date(timeIntervalSince1970: time)) == 0)
  }

  @Test func `code shapes are checked and a zero period is clamped`() {
    #expect(VaultTotp.make(code: "12 34", period: 30) == nil)
    #expect(VaultTotp.make(code: "123", period: 30) == nil)
    #expect(VaultTotp.make(code: " 123456\n", period: 0)?.period == 1)
  }
}

@Suite("Imported codes")
struct VaultCodeImportTests {
  @Test func `files without codes import nothing`() {
    #expect(VaultCodeImport.rows("").isEmpty)
    #expect(VaultCodeImport.rows("url,username,password\nhttps://a.com,me,\(pw)\n").isEmpty)
  }

  @Test func `an Apple export row keeps its origin, username and secret`() throws {
    let apple = "Title,URL,Username,Password,Notes,OTPAuth\r\nA,https://a.com/login?x=1,me,\(pw),,\"otpauth://totp/A:me?secret=\(sha1Key)&issuer=A\"\r\n"
    let rows = VaultCodeImport.rows(apple)
    #expect(rows.count == 1)
    let row = try #require(rows.first)
    #expect(row.origin == "https://a.com")
    #expect(row.username == "me")
    #expect(VaultTotpSecret(row.uri)?.key == VaultTotpSecret(sha1Key)?.key)
  }

  @Test func `a Bitwarden bare key on a host is named after the site and bad rows are skipped`() {
    let bitwarden = "folder,favorite,type,name,notes,fields,reprompt,login_uri,login_username,login_password,login_totp\n,,login,B,,,0,b.example.com,bo,\(pw),\(shortKey)\n,,login,C,,,0,https://c.com,co,\(pw),\n,,login,D,,,0,javascript:alert(1),do,\(pw),\(shortKey)\n,,login,E,,,0,https://e.com,eo,\(pw),not a key\n"
    let rows = VaultCodeImport.rows(bitwarden)
    #expect(rows.map(\.origin) == ["https://b.example.com"])
    #expect(rows.first.flatMap { VaultTotpURI.labels($0.uri) }?.issuer == "b.example.com")
  }

  @Test func `the last row for a login wins and quoted commas are kept`() {
    let twice = "url,username,otpauth\nhttps://a.com,me,\(shortKey)\nhttps://a.com,me,otpauth://totp/A?secret=\(sha1Key)\n"
    #expect(VaultCodeImport.rows(twice).count == 1)
    let quoted = "url,username,totp\n\"https://q.com\",\"a,b\",\"\(shortKey)\"\n"
    #expect(VaultCodeImport.rows(quoted).first?.username == "a,b")
  }

  @Test func `a code link whose login address isn't a web address is kept without a website`() {
    let export = "name,login_uri,login_username,login_totp\nBank,androidapp://com.bank.app,me,otpauth://totp/Bank:me?secret=\(sha1Key)\nShop,\"https://Shop.example:443/a,https://www.shop.example\",you,otpauth://totp/Shop:you?secret=\(sha1Key)\n"
    let rows = VaultCodeImport.rows(export)
    #expect(rows.map(\.origin) == ["", "https://shop.example"])
    #expect(rows.map(\.username) == ["me", "you"])
  }

  @Test("Login origins keep only web origins", arguments: [
    ("https://Example.com:8443/path", "https://example.com:8443" as String?), ("ftp://example.com", nil), ("  ", nil),
    ("javascript:alert(1)", nil), ("androidapp://com.example.app", nil), ("Bank of Foo", nil),
    ("https://bank.example,https://www.bank.example/login", "https://bank.example"), ("androidapp://x, https://shop.example/a", "https://shop.example"),
    ("https://Bank.example./login", "https://bank.example"), ("https://me@shop.example/login", "https://shop.example"),
    ("https://ok.example:443/x", "https://ok.example"), ("http://[::1]:8080/x", "http://[::1]:8080"), ("https://bank.example:99999999999", nil),
  ])
  func origin(login: String, wanted: String?) {
    #expect(VaultCodeImport.origin(ofLogin: login) == wanted)
  }

  @Test func `the plan adds fresh codes, asks before replacing, and leaves the same code alone`() {
    let plan = VaultCodeImport.plan([("a", "otpauth://totp/A?secret=\(sha1Key)"), ("b", "otpauth://totp/B?secret=\(sha1Key)"), ("c", "otpauth://totp/C?secret=\(sha1Key)")],
                                    existing: ["b": "otpauth://totp/B?secret=\(sha1Key)", "c": "otpauth://totp/Old?secret=\(shortKey)"])
    #expect(plan.fresh.map(\.0) == ["a"])
    #expect(plan.replacing.map(\.0) == ["c"])
    #expect(plan.fresh.count + plan.replacing.count == 2)
  }
}

@Suite("Standalone code import")
struct VaultStandaloneImportTests {
  let link = "otpauth://totp/GitHub:octo?secret=\(sha1Key)&issuer=GitHub"
  var authenticator: String { "name,otpauth\nWork VPN,\"otpauth://totp/VPN?secret=\(sha256Key)\"\nGitHub,\"\(link)\"\nBare,\(shortKey)\n" }

  @Test func `a file with no website column keeps links and names, not bare keys`() {
    let rows = VaultCodeImport.rows(authenticator)
    #expect(rows.map(\.origin) == ["", ""])
    #expect(rows.map(\.name) == ["Work VPN", "GitHub"])
  }

  @Test func `rows without a matching login become standalone codes with their website`() {
    let mixed = "url,username,otpauth\nhttps://a.com,me,\(link)\nhttps://b.com,bo,otpauth://totp/B?secret=\(sha256Key)\n,,otpauth://totp/Solo?secret=\(sha512Key)\n"
    let all = VaultCodeImport.rows(mixed)
    #expect(all.count == 3)
    let planned = VaultCodeImport.standalone(all, matched: [0], existing: [], loginCodes: [], now: 5)
    #expect(planned.map(\.label) == ["B", "Solo"])
    #expect(planned.first?.website == "https://b.com")
    #expect(planned.last?.website == nil)
  }

  @Test func `labels come from the name column, then the account`() {
    let named = VaultCodeImport.standalone(VaultCodeImport.rows(authenticator), matched: [], existing: [], loginCodes: [], now: 5)
    #expect(named.map(\.label) == ["Work VPN", "GitHub"])
    #expect(named.last?.issuer == nil)
    let unnamed = VaultCodeImport.standalone([VaultCodeImport.Row(origin: "", username: "", uri: link, name: "")], matched: [], existing: [], loginCodes: [], now: 5)
    #expect(unnamed.first?.label == "octo")
    #expect(unnamed.first?.issuer == "GitHub")
  }

  @Test func `a code already saved by itself or on a login, or twice in the file, is added once`() {
    let held = ArdiaStandaloneCode(uri: link, label: "Mine", issuer: nil, website: nil, createdAt: 1)
    #expect(VaultCodeImport.standalone(VaultCodeImport.rows(authenticator), matched: [], existing: [held], loginCodes: [], now: 5).allSatisfy { $0.label != "GitHub" })
    #expect(VaultCodeImport.standalone(VaultCodeImport.rows(authenticator), matched: [], existing: [], loginCodes: [link], now: 5).allSatisfy { $0.label != "GitHub" })
    let doubled = VaultCodeImport.rows("name,otpauth\nA,\(link)\nB,\(link)\n")
    #expect(VaultCodeImport.standalone(doubled, matched: [], existing: [], loginCodes: [], now: 5).count == 1)
  }

  @Test func `a pasted key with no website makes a nameless code only when asked`() throws {
    let bareKey = try #require(VaultTotpURI.setupURI(inText: "ABCD ABCD ABCD ABCD", origin: "", allowingBareKey: true))
    #expect(VaultTotpSecret(bareKey)?.key == VaultTotpSecret(shortKey)?.key)
    let labels = try #require(VaultTotpURI.labels(bareKey))
    #expect(labels.issuer.isEmpty)
    #expect(labels.account.isEmpty)
    #expect(VaultTotpURI.setupURI(inText: shortKey, origin: "") == nil)
  }
}

@Suite("Touch ID grants")
struct VaultTouchGrantTests {
  let start = Date(timeIntervalSince1970: 1000)
  let here = VaultTouchGrants.fill(provider: "ardia", item: "a", origin: "https://a.example", tab: "t1")

  @Test func `nothing is granted before a touch`() {
    var grants = VaultTouchGrants()
    let taken = grants.take(here, at: start)
    #expect(taken == false)
  }

  @Test("A fill touch can't be used by anything else", arguments: [
    VaultTouchGrants.fill(provider: "ardia", item: "a", origin: "https://a.example", tab: "t2"),
    VaultTouchGrants.fill(provider: "ardia", item: "a", origin: "https://evil.a.example", tab: "t1"),
    VaultTouchGrants.fill(provider: "ardia", item: "b", origin: "https://a.example", tab: "t1"),
    VaultTouchGrants.fill(provider: "bitwarden", item: "a", origin: "https://a.example", tab: "t1"),
    VaultTouchGrants.unlock(provider: "ardia"),
    "export",
  ])
  func fillTouchIsScoped(other: String) {
    var grants = VaultTouchGrants()
    grants.grant(here, at: start)
    let stolen = grants.take(other, at: start)
    let used = grants.take(here, at: start.addingTimeInterval(1))
    #expect(stolen == false)
    #expect(used)
  }

  @Test func `the touched fill uses it once`() {
    var grants = VaultTouchGrants()
    grants.grant(here, at: start)
    let first = grants.take(here, at: start.addingTimeInterval(1))
    let replay = grants.take(here, at: start.addingTimeInterval(1))
    #expect(first)
    #expect(replay == false)
  }

  @Test("A grant can't be taken after it expires or before it was given", arguments: [VaultTouchGrants.lifetime, -1])
  func expires(offset: TimeInterval) {
    var grants = VaultTouchGrants()
    grants.grant(here, at: start)
    let taken = grants.take(here, at: start.addingTimeInterval(offset))
    #expect(taken == false)
  }

  @Test func `an empty scope grants nothing`() {
    var grants = VaultTouchGrants()
    grants.grant("", at: start)
    let taken = grants.take("", at: start)
    #expect(taken == false)
  }

  @Test func `an unlock hand-on fills that manager's next login once and never unlocks again`() throws {
    var grants = VaultTouchGrants()
    grants.grant(try #require(VaultTouchGrants.handOn(provider: "bitwarden", origin: "https://b.example", tab: "t9")), at: start)
    let fill = VaultTouchGrants.fill(provider: "bitwarden", item: "x", origin: "https://b.example", tab: "t9")
    let unlocked = grants.take(VaultTouchGrants.unlock(provider: "bitwarden"), at: start)
    let filled = grants.take(fill, at: start)
    let again = grants.take(fill, at: start)
    #expect(unlocked == false)
    #expect(filled)
    #expect(again == false)
  }

  @Test func `an unlock touch unlocks its manager`() {
    var grants = VaultTouchGrants()
    grants.grant(VaultTouchGrants.unlock(provider: "bitwarden"), at: start)
    let taken = grants.take(VaultTouchGrants.unlock(provider: "bitwarden"), at: start)
    #expect(taken)
  }
}

@Suite("Clipboard clearing")
struct VaultClipboardDueTests {
  struct Case: Sendable, CustomTestStringConvertible {
    let currentCount: Int
    let after: TimeInterval
    let quitting: Bool
    let wanted: VaultClipboardDue
    let why: String
    var testDescription: String { why }
  }

  @Test("Decides when the copied secret is cleared", arguments: [
    Case(currentCount: 7, after: 89, quitting: false, wanted: .keep, why: "a copy stays until its deadline"),
    Case(currentCount: 7, after: 3600, quitting: false, wanted: .clear, why: "waking after sleep past the deadline clears it"),
    Case(currentCount: 8, after: 3600, quitting: false, wanted: .forget, why: "something copied since is left alone"),
    Case(currentCount: 7, after: 0, quitting: true, wanted: .clear, why: "quitting clears it early"),
    Case(currentCount: 9, after: 0, quitting: true, wanted: .forget, why: "quitting leaves someone else's copy"),
  ])
  func decide(row: Case) {
    let placedAt = Date(timeIntervalSince1970: 5000)
    let decision = VaultClipboardDue.decide(placedCount: 7, deadline: placedAt.addingTimeInterval(90), currentCount: row.currentCount,
                                            now: placedAt.addingTimeInterval(row.after), quitting: row.quitting)
    #expect(decision == row.wanted)
  }
}

enum VaultJSON {
  static func object<Value: Encodable>(_ value: Value) -> [String: Any] { [:] }
}
