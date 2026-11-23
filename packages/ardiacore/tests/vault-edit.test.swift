import Foundation
import Testing

enum EditFixture {
  static let key = String(repeating: "CD", count: 16)
  static let itemId = "0f8fad5b-d9cb-469f-a165-70867728950e"
  static let newPassword = "fixture-" + "new-pw-2"
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
  @Test("An invalid change is refused by validation", arguments: RefusedChange.all)
  func refusesInvalidChanges(refused: RefusedChange) {
    let validated = refused.change.validated()
    #expect(validated == nil || validated?.isEmpty == true)
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
}

@Suite("Edit results")
struct VaultEditResultTests {
  @Test func `a failure isn't edited and names its error`() {
    let refused = VaultEditResult.failure(.declined).jsonObject()
    #expect(refused["edited"] as? Bool == false)
    #expect(refused["error"] as? String == "declined")
  }

  @Test func `a success carries the item and never a password`() throws {
    let item = VaultItem(provider: "bitwarden", id: EditFixture.itemId, title: "Example", username: "bob", urls: ["https://example.com"], hasTotp: true, vault: nil)
    let done = VaultEditResult(item: item).jsonObject()
    #expect(done["edited"] as? Bool == true)
    #expect((done["item"] as? [String: Any])?["username"] as? String == "bob")
    let text = try #require(String(data: try JSONSerialization.data(withJSONObject: done), encoding: .utf8))
    #expect(text.contains(EditFixture.newPassword) == false)
  }
}
