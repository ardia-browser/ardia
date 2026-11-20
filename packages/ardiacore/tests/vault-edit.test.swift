import Foundation
import Testing

enum EditFixture {
  static let key = String(repeating: "CD", count: 16)
  static let oldKey = String(repeating: "AB", count: 16)
  static let oldURI = "otpauth://totp/Example:alice?secret=\(oldKey)&issuer=Example"
  static let newURI = "otpauth://totp/Example:alice?secret=\(key)&issuer=Example"
  static let bwId = "0f8fad5b-d9cb-469f-a165-70867728950e"
  static let opId = "abcdefghijklmnopqrstuvwxyz"
  static let oldPassword = "fixture-" + "old-pw-1"
  static let newPassword = "fixture-" + "new-pw-2"
  static let pin = "fixture-" + "pin"

  static func json(_ object: Any) -> [String: Any] {
    let data = try! JSONSerialization.data(withJSONObject: object)
    return try! JSONSerialization.jsonObject(with: data) as! [String: Any]
  }

  static func same(_ a: Any?, _ b: Any?) -> Bool {
    guard let a, let b else { return a == nil && b == nil }
    if a is NSNull || b is NSNull { return a is NSNull && b is NSNull }
    let wrap: (Any) -> Data? = { try? JSONSerialization.data(withJSONObject: ["v": $0], options: [.sortedKeys]) }
    return wrap(a) == wrap(b)
  }

  static func bitwardenItem() -> [String: Any] {
    json([
      "object": "item", "id": bwId, "organizationId": NSNull(), "folderId": "folder-1", "type": 1, "reprompt": 0, "name": "Example",
      "notes": "keep these notes", "favorite": true, "revisionDate": "2026-01-01T00:00:00.000Z",
      "fields": [["name": "PIN", "value": pin, "type": 1, "linkedId": NSNull()]],
      "passwordHistory": [["lastUsedDate": "2025-01-01T00:00:00.000Z", "password": "fixture-" + "older"]],
      "login": [
        "uris": [["match": 1, "uri": "https://example.com/login"], ["match": NSNull(), "uri": "https://app.example.com"]],
        "username": "alice@example.com", "password": oldPassword, "totp": oldURI, "passwordRevisionDate": NSNull(),
        "fido2Credentials": [],
      ],
    ])
  }

  static func onePasswordItem() -> [String: Any] {
    json([
      "id": opId, "title": "Example", "version": 4, "vault": ["id": "vaultvaultvaultvault1234", "name": "Private"], "category": "LOGIN",
      "favorite": false, "tags": ["work"], "updated_at": "2026-01-01T00:00:00Z", "additional_information": "alice@example.com",
      "urls": [["label": "website", "primary": false, "href": "https://other.example.com"], ["primary": true, "href": "https://example.com"]],
      "sections": [["id": "add more"]],
      "fields": [
        ["id": "username", "type": "STRING", "purpose": "USERNAME", "label": "username", "value": "alice@example.com", "reference": "op://x/y/username"],
        ["id": "password", "type": "CONCEALED", "purpose": "PASSWORD", "label": "password", "value": oldPassword, "entropy": 80.5,
         "password_details": ["strength": "FANTASTIC"], "reference": "op://x/y/password"],
        ["id": "notesPlain", "type": "STRING", "purpose": "NOTES", "label": "notesPlain", "value": "keep these notes"],
        ["id": "TOTP_abc", "section": ["id": "add more"], "type": "OTP", "label": "one-time password", "value": oldURI, "totp": "123456"],
        ["id": "pin", "section": ["id": "add more"], "type": "CONCEALED", "label": "PIN", "value": pin],
      ],
    ])
  }

  static func login(_ item: [String: Any]) -> [String: Any] { item["login"] as? [String: Any] ?? [:] }
  static func fields(_ item: [String: Any]) -> [[String: Any]] { (item["fields"] as? [Any] ?? []).compactMap { $0 as? [String: Any] } }
  static func field(_ item: [String: Any], purpose: String) -> [String: Any]? { fields(item).first { $0["purpose"] as? String == purpose } }
  static func otpFields(_ item: [String: Any]) -> [[String: Any]] { fields(item).filter { ($0["type"] as? String)?.uppercased() == "OTP" } }
  static func dictionaries(_ value: Any?) -> [[String: Any]] { (value as? [Any] ?? []).compactMap { $0 as? [String: Any] } }
}

struct RefusedChange: Sendable, CustomTestStringConvertible {
  let name: String
  let change: VaultLoginChange
  var testDescription: String { name }

  static let all: [RefusedChange] = [
    RefusedChange(name: "nothing", change: VaultLoginChange()),
    RefusedChange(name: "empty password", change: VaultLoginChange(password: "")),
    RefusedChange(name: "long password", change: VaultLoginChange(password: String(repeating: "a", count: VaultLoginChange.longestPassword + 1))),
    RefusedChange(name: "password with a newline", change: VaultLoginChange(password: "pass\nword")),
    RefusedChange(name: "password with a NUL", change: VaultLoginChange(password: "pass\u{0}word")),
    RefusedChange(name: "long username", change: VaultLoginChange(username: String(repeating: "u", count: VaultLoginChange.longestUsername + 1))),
    RefusedChange(name: "username with a newline", change: VaultLoginChange(username: "al\nice")),
    RefusedChange(name: "url without scheme", change: VaultLoginChange(url: "example.com")),
    RefusedChange(name: "javascript url", change: VaultLoginChange(url: "javascript:alert(1)")),
    RefusedChange(name: "file url", change: VaultLoginChange(url: "file:///etc/passwd")),
    RefusedChange(name: "url with spaces", change: VaultLoginChange(url: "https://exa mple.com")),
    RefusedChange(name: "long url", change: VaultLoginChange(url: "https://example.com/" + String(repeating: "a", count: VaultLoginChange.longestURL))),
    RefusedChange(name: "bad totp", change: VaultLoginChange(totp: .set("otpauth://totp/Example?secret=GEZDGNBVGY3TQOJ1"))),
    RefusedChange(name: "hotp", change: VaultLoginChange(totp: .set("otpauth://hotp/Example?secret=\(EditFixture.key)&counter=0"))),
    RefusedChange(name: "plain key", change: VaultLoginChange(totp: .set(EditFixture.key))),
  ]
}

@Suite("Login change validation")
struct VaultLoginChangeTests {
  @Test("An invalid change is refused by validation and by both managers", arguments: RefusedChange.all)
  func refusesInvalidChanges(refused: RefusedChange) {
    let validated = refused.change.validated()
    #expect(validated == nil || validated?.isEmpty == true)
    #expect(VaultLoginEditPlan.bitwardenCommand(id: EditFixture.bwId, item: EditFixture.bitwardenItem(), change: refused.change) == nil)
    #expect(VaultLoginEditPlan.onePasswordCommand(id: EditFixture.opId, item: EditFixture.onePasswordItem(), change: refused.change, account: []) == nil)
  }

  @Test func `an empty change is empty, and removing a code is a change`() {
    #expect(VaultLoginChange().isEmpty)
    #expect(VaultLoginChange(totp: .remove).isEmpty == false)
  }

  @Test func `usernames and URLs are trimmed, passwords are kept exactly`() {
    #expect(VaultLoginChange(username: "  bob  ").validated()?.username == "bob")
    #expect(VaultLoginChange(username: "").validated()?.username == "")
    #expect(VaultLoginChange(url: " https://example.com/a ").validated()?.url == "https://example.com/a")
    #expect(VaultLoginChange(password: " spaced ").validated()?.password == " spaced ")
  }

  @Test("Bitwarden refuses a malformed item id", arguments: [
    "", "--session=x", "0f8fad5b-d9cb-469f-a165-70867728950", "../../etc", "0f8fad5b d9cb 469f a165 70867728950e",
  ])
  func bitwardenRefusesId(id: String) {
    let change = VaultLoginChange(password: EditFixture.newPassword)
    #expect(VaultLoginEditPlan.bitwardenCommand(id: id, item: EditFixture.bitwardenItem(), change: change) == nil)
  }

  @Test("1Password refuses a malformed item id", arguments: ["", "--vault=x", "abc def", String(repeating: "a", count: 65), "abc/def"])
  func onePasswordRefusesId(id: String) {
    let change = VaultLoginChange(password: EditFixture.newPassword)
    #expect(VaultLoginEditPlan.onePasswordCommand(id: id, item: EditFixture.onePasswordItem(), change: change, account: []) == nil)
  }

  @Test func `Bitwarden refuses cards, items without a login and another item's JSON`() {
    let change = VaultLoginChange(password: EditFixture.newPassword)
    var card = EditFixture.bitwardenItem()
    card["type"] = 3
    #expect(VaultLoginEditPlan.bitwardenItem(card, change) == nil)
    var noLogin = EditFixture.bitwardenItem()
    noLogin["login"] = nil
    #expect(VaultLoginEditPlan.bitwardenItem(noLogin, change) == nil)
    var otherId = EditFixture.bitwardenItem()
    otherId["id"] = "11111111-2222-3333-4444-555555555555"
    #expect(VaultLoginEditPlan.bitwardenCommand(id: EditFixture.bwId, item: otherId, change: change) == nil)
  }

  @Test func `1Password refuses documents and another item's JSON`() {
    let change = VaultLoginChange(password: EditFixture.newPassword)
    var otherOp = EditFixture.onePasswordItem()
    otherOp["id"] = "zzzzzzzzzzzzzzzzzzzzzzzzzz"
    #expect(VaultLoginEditPlan.onePasswordCommand(id: EditFixture.opId, item: otherOp, change: change, account: []) == nil)
    var document = EditFixture.onePasswordItem()
    document["category"] = "DOCUMENT"
    #expect(VaultLoginEditPlan.onePasswordItem(document, change) == nil)
  }
}

@Suite("Bitwarden login edits")
struct BitwardenEditTests {
  typealias F = EditFixture

  @Test func `a username change touches only the username`() throws {
    let original = F.bitwardenItem()
    let edited = try #require(VaultLoginEditPlan.bitwardenItem(original, VaultLoginChange(username: "bob@example.com")))
    #expect(F.login(edited)["username"] as? String == "bob@example.com")
    #expect(F.login(edited)["password"] as? String == F.oldPassword)
    #expect(F.login(edited)["totp"] as? String == F.oldURI)
    for key in original.keys where key != "login" {
      #expect(F.same(edited[key], original[key]), "keeps \(key)")
    }
    for key in F.login(original).keys where key != "username" {
      #expect(F.same(F.login(edited)[key], F.login(original)[key]), "keeps login.\(key)")
    }
  }

  @Test func `a password change keeps the username and the history for the CLI to extend`() throws {
    let original = F.bitwardenItem()
    let password = try #require(VaultLoginEditPlan.bitwardenItem(original, VaultLoginChange(password: F.newPassword)))
    #expect(F.login(password)["password"] as? String == F.newPassword)
    #expect(F.login(password)["username"] as? String == "alice@example.com")
    #expect(F.same(password["passwordHistory"], original["passwordHistory"]))
  }

  @Test func `a URL change replaces the first URL and keeps the rest`() throws {
    let url = try #require(VaultLoginEditPlan.bitwardenItem(F.bitwardenItem(), VaultLoginChange(url: "https://new.example.com/sign-in")))
    let uris = F.dictionaries(F.login(url)["uris"])
    #expect(uris.count == 2)
    #expect(uris.first?["uri"] as? String == "https://new.example.com/sign-in")
    #expect(uris.first?["match"] as? Int == 1)
    #expect(uris.last?["uri"] as? String == "https://app.example.com")
  }

  @Test func `a URL is added to a login with none`() throws {
    var bare = F.bitwardenItem()
    var bareLogin = F.login(bare)
    bareLogin["uris"] = NSNull()
    bare["login"] = bareLogin
    let added = try #require(VaultLoginEditPlan.bitwardenItem(bare, VaultLoginChange(url: "https://example.com")))
    #expect(F.dictionaries(F.login(added)["uris"]).map { $0["uri"] as? String } == ["https://example.com"])
  }

  @Test func `the code is replaced or removed, and removing it keeps the password`() throws {
    let original = F.bitwardenItem()
    let set = try #require(VaultLoginEditPlan.bitwardenItem(original, VaultLoginChange(totp: .set(F.newURI))))
    #expect(F.login(set)["totp"] as? String == VaultTotpURI.setupURI(F.newURI))
    let removed = try #require(VaultLoginEditPlan.bitwardenItem(original, VaultLoginChange(totp: .remove)))
    #expect(F.login(removed)["totp"] is NSNull)
    #expect(F.login(removed)["password"] as? String == F.oldPassword)
  }

  @Test func `a cleared username becomes null`() throws {
    let cleared = try #require(VaultLoginEditPlan.bitwardenItem(F.bitwardenItem(), VaultLoginChange(username: "")))
    #expect(F.login(cleared)["username"] is NSNull)
  }

  @Test func `the command keeps secrets out of argv and sends the item as base64 on stdin`() throws {
    let change = VaultLoginChange(username: "bob", password: F.newPassword, url: "https://example.com", totp: .set(F.newURI))
    let command = try #require(VaultLoginEditPlan.bitwardenCommand(id: F.bwId, item: F.bitwardenItem(), change: change))
    #expect(command.arguments == ["edit", "item", F.bwId, "--nointeraction"])
    let joined = command.arguments.joined(separator: " ")
    for secret in [F.newPassword, F.oldPassword, F.key, "bob"] {
      #expect(joined.contains(secret) == false, "argv never holds \(secret)")
    }
    let text = try #require(String(data: command.input, encoding: .utf8))
    #expect(text.contains(F.newPassword) == false)
    #expect(text.contains("{") == false)
    let decoded = try #require(Data(base64Encoded: text))
    let object = try #require(try JSONSerialization.jsonObject(with: decoded) as? [String: Any])
    #expect(F.login(object)["password"] as? String == F.newPassword)
    #expect(F.login(object)["username"] as? String == "bob")
    #expect(object["id"] as? String == F.bwId)
    #expect(object["notes"] as? String == "keep these notes")
  }

  @Test func `the old and new secrets are redacted from its output`() {
    let change = VaultLoginChange(username: "bob", password: F.newPassword, url: "https://example.com", totp: .set(F.newURI))
    let hidden = VaultLoginEditPlan.bitwardenSecrets(F.bitwardenItem(), change)
    for secret in [F.oldPassword, F.newPassword, F.oldURI] {
      #expect(hidden.contains(secret), "redacts \(secret.prefix(12))")
    }
  }
}

@Suite("1Password login edits")
struct OnePasswordEditTests {
  typealias F = EditFixture

  @Test func `a username change touches only the username field`() throws {
    let original = F.onePasswordItem()
    let edited = try #require(VaultLoginEditPlan.onePasswordItem(original, VaultLoginChange(username: "bob@example.com")))
    #expect(F.field(edited, purpose: "USERNAME")?["value"] as? String == "bob@example.com")
    #expect(F.field(edited, purpose: "USERNAME")?["reference"] as? String == "op://x/y/username")
    #expect(F.field(edited, purpose: "PASSWORD")?["value"] as? String == F.oldPassword)
    #expect(F.fields(edited).count == F.fields(original).count)
    for key in original.keys where key != "fields" {
      #expect(F.same(edited[key], original[key]), "keeps \(key)")
    }
    for (old, new) in zip(F.fields(original), F.fields(edited)) where old["purpose"] as? String != "USERNAME" {
      #expect(F.same(old, new), "keeps field \(old["id"] as? String ?? "")")
    }
  }

  @Test func `a password change stays concealed, drops the old strength and keeps the code`() throws {
    let password = try #require(VaultLoginEditPlan.onePasswordItem(F.onePasswordItem(), VaultLoginChange(password: F.newPassword)))
    let passwordField = try #require(F.field(password, purpose: "PASSWORD"))
    #expect(passwordField["value"] as? String == F.newPassword)
    #expect(passwordField["type"] as? String == "CONCEALED")
    #expect(passwordField["password_details"] == nil)
    #expect(passwordField["entropy"] == nil)
    #expect(F.otpFields(password).count == 1)
  }

  @Test func `a URL change replaces the primary URL and keeps the other`() throws {
    let url = try #require(VaultLoginEditPlan.onePasswordItem(F.onePasswordItem(), VaultLoginChange(url: "https://new.example.com")))
    let urls = F.dictionaries(url["urls"])
    #expect(urls.count == 2)
    #expect(urls.last?["href"] as? String == "https://new.example.com")
    #expect(urls.last?["primary"] as? Bool == true)
    #expect(urls.first?["href"] as? String == "https://other.example.com")
  }

  @Test func `a URL added to an item with none is primary`() throws {
    var noURLs = F.onePasswordItem()
    noURLs["urls"] = nil
    let added = try #require(VaultLoginEditPlan.onePasswordItem(noURLs, VaultLoginChange(url: "https://example.com")))
    let urls = F.dictionaries(added["urls"])
    #expect(urls.map { $0["href"] as? String } == ["https://example.com"])
    #expect(urls.first?["primary"] as? Bool == true)
  }

  @Test func `a new code replaces the code field in place`() throws {
    let set = try #require(VaultLoginEditPlan.onePasswordItem(F.onePasswordItem(), VaultLoginChange(totp: .set(F.newURI))))
    let otp = F.otpFields(set)
    #expect(otp.count == 1)
    #expect(otp.first?["value"] as? String == VaultTotpURI.setupURI(F.newURI))
    #expect(otp.first?["totp"] == nil)
    #expect(otp.first?["id"] as? String == "TOTP_abc")
  }

  @Test func `a code is added as an OTP field to an item without one`() throws {
    var noCode = F.onePasswordItem()
    noCode["fields"] = F.fields(noCode).filter { ($0["type"] as? String) != "OTP" }
    let added = try #require(VaultLoginEditPlan.onePasswordItem(noCode, VaultLoginChange(totp: .set(F.newURI))))
    #expect(F.otpFields(added).count == 1)
    #expect(F.otpFields(added).first?["type"] as? String == "OTP")
  }

  @Test func `a username change works on an item without a code`() throws {
    var noCode = F.onePasswordItem()
    noCode["fields"] = F.fields(noCode).filter { ($0["type"] as? String) != "OTP" }
    let fresh = try #require(VaultLoginEditPlan.onePasswordItem(noCode, VaultLoginChange(username: "carol")))
    #expect(F.field(fresh, purpose: "USERNAME")?["value"] as? String == "carol")
  }

  @Test func `removing the code removes only the code field`() throws {
    let original = F.onePasswordItem()
    let removed = try #require(VaultLoginEditPlan.onePasswordItem(original, VaultLoginChange(totp: .remove)))
    #expect(F.otpFields(removed).isEmpty)
    #expect(F.fields(removed).count == F.fields(original).count - 1)
  }

  @Test func `a username field is added to an item without one`() throws {
    var noUser = F.onePasswordItem()
    noUser["fields"] = F.fields(noUser).filter { ($0["purpose"] as? String) != "USERNAME" }
    let added = try #require(VaultLoginEditPlan.onePasswordItem(noUser, VaultLoginChange(username: "carol")))
    #expect(F.field(added, purpose: "USERNAME")?["value"] as? String == "carol")
  }

  @Test func `the command keeps secrets out of argv and sends the item as JSON on stdin`() throws {
    let change = VaultLoginChange(username: "bob", password: F.newPassword, url: "https://example.com", totp: .set(F.newURI))
    let command = try #require(VaultLoginEditPlan.onePasswordCommand(id: F.opId, item: F.onePasswordItem(), change: change, account: ["--account=ABC"]))
    #expect(command.arguments == ["item", "edit", F.opId, "--format=json", "--account=ABC"])
    let joined = command.arguments.joined(separator: " ")
    for secret in [F.newPassword, F.oldPassword, F.key, "bob"] {
      #expect(joined.contains(secret) == false, "argv never holds \(secret)")
    }
    let object = try #require(try JSONSerialization.jsonObject(with: command.input) as? [String: Any])
    #expect(F.field(object, purpose: "PASSWORD")?["value"] as? String == F.newPassword)
    #expect(object["id"] as? String == F.opId)
  }

  @Test func `the old and new secrets are redacted from its output`() {
    let change = VaultLoginChange(username: "bob", password: F.newPassword, url: "https://example.com", totp: .set(F.newURI))
    let hidden = VaultLoginEditPlan.onePasswordSecrets(F.onePasswordItem(), change)
    for secret in [F.oldPassword, F.newPassword, F.oldURI, F.pin] {
      #expect(hidden.contains(secret), "redacts \(secret.prefix(12))")
    }
  }

  @Test func `the saved item must hold every change`() throws {
    let change = VaultLoginChange(username: "bob", password: F.newPassword, url: "https://new.example.com", totp: .set(F.newURI))
    let planned = try #require(VaultLoginEditPlan.onePasswordItem(F.onePasswordItem(), change))
    #expect(VaultLoginEditPlan.onePasswordHolds(planned, change))
    #expect(VaultLoginEditPlan.onePasswordHolds(F.onePasswordItem(), change) == false)
  }

  @Test func `a concealed password isn't proof, but a username-only check ignores it`() throws {
    let change = VaultLoginChange(username: "bob", password: F.newPassword, url: "https://new.example.com", totp: .set(F.newURI))
    var concealed = try #require(VaultLoginEditPlan.onePasswordItem(F.onePasswordItem(), change))
    concealed["fields"] = F.fields(concealed).map { field in
      var copy = field
      if copy["purpose"] as? String == "PASSWORD" { copy["value"] = "[use 'op item get x --reveal' to reveal]" }
      return copy
    }
    #expect(VaultLoginEditPlan.onePasswordHolds(concealed, change) == false)
    #expect(VaultLoginEditPlan.onePasswordHolds(concealed, VaultLoginChange(username: "bob")))
  }

  @Test func `a current code proves the secret`() throws {
    let change = VaultLoginChange(totp: .set(F.newURI))
    let secret = try #require(VaultTotpSecret(F.newURI))
    var codeOnly = try #require(VaultLoginEditPlan.onePasswordItem(F.onePasswordItem(), change))
    codeOnly["fields"] = F.fields(codeOnly).map { field in
      var copy = field
      if (copy["type"] as? String) == "OTP" {
        copy["value"] = nil
        copy["totp"] = secret.code(at: Date())
      }
      return copy
    }
    #expect(VaultLoginEditPlan.onePasswordHolds(codeOnly, change))
  }

  @Test func `only a result with no code proves removal`() throws {
    let change = VaultLoginChange(totp: .remove)
    let removed = try #require(VaultLoginEditPlan.onePasswordItem(F.onePasswordItem(), change))
    #expect(VaultLoginEditPlan.onePasswordHolds(removed, change))
    #expect(VaultLoginEditPlan.onePasswordHolds(F.onePasswordItem(), change) == false)
  }
}

@Suite("Edit results")
struct VaultEditResultTests {
  @Test func `a failure isn't edited and names its error`() {
    let refused = VaultEditResult.failure(.declined).jsonObject()
    #expect(refused["edited"] as? Bool == false)
    #expect(refused["error"] as? String == "declined")
  }

  @Test func `a success carries the item and never a password`() throws {
    let item = VaultItem(provider: "bitwarden", id: EditFixture.bwId, title: "Example", username: "bob", urls: ["https://example.com"], hasTotp: true, vault: nil)
    let done = VaultEditResult(item: item).jsonObject()
    #expect(done["edited"] as? Bool == true)
    #expect((done["item"] as? [String: Any])?["username"] as? String == "bob")
    let text = try #require(String(data: try JSONSerialization.data(withJSONObject: done), encoding: .utf8))
    #expect(text.contains(EditFixture.newPassword) == false)
  }
}
