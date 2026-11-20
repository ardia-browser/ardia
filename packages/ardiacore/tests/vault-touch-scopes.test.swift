import Foundation
import Testing

struct TouchScopeTable: Decodable, Sendable {
  struct Scope: Decodable, Sendable, CustomTestStringConvertible {
    let kind: String
    let parts: [String: String]
    let scope: String

    var testDescription: String { "\(kind) \(parts.keys.sorted().map { "\($0)=\(parts[$0] ?? "")" }.joined(separator: " "))" }
  }

  struct Take: Decodable, Sendable, CustomTestStringConvertible {
    let granted: String
    let wanted: String
    let taken: Bool
    let why: String

    var testDescription: String { why }
  }

  let scopes: [Scope]
  let takes: [Take]

  static func shared() throws -> TouchScopeTable {
    let url = URL(fileURLWithPath: #filePath).deletingLastPathComponent().appendingPathComponent("fixtures/vault-touch-scopes.json")
    return try JSONDecoder().decode(TouchScopeTable.self, from: Data(contentsOf: url))
  }
}

@Suite("Touch ID grant scopes")
struct VaultTouchScopeTests {
  static let now = Date(timeIntervalSince1970: 1_000)

  static func built(_ row: TouchScopeTable.Scope) -> String? {
    let part = { (name: String) in row.parts[name] ?? "" }
    switch row.kind {
    case "fill": return VaultTouchGrants.fill(provider: part("provider"), item: part("item"), origin: part("origin"), tab: part("tab"))
    case "unlock": return VaultTouchGrants.unlock(provider: part("provider"))
    case "passkey": return VaultTouchGrants.passkey(request: part("request"), credential: part("credential"))
    case "card": return VaultTouchGrants.card(card: part("card"), tab: part("tab"))
    default: return nil
    }
  }

  @Test func `the shared table covers every kind of grant`() throws {
    #expect(Set(try TouchScopeTable.shared().scopes.map(\.kind)) == ["fill", "unlock", "passkey", "card"])
  }

  @Test("A grant is spelled as the JS side spells it", arguments: try TouchScopeTable.shared().scopes)
  func spelledLikeJS(row: TouchScopeTable.Scope) {
    #expect(Self.built(row) == row.scope)
  }

  @Test("A grant from the menu is taken by its own action", arguments: try TouchScopeTable.shared().scopes)
  func takenByItsOwnAction(row: TouchScopeTable.Scope) {
    var grants = VaultTouchGrants()
    grants.grant(row.scope, at: Self.now)
    let taken = grants.take(row.scope, at: Self.now)
    #expect(taken)
  }

  @Test("A grant is taken only by the action it was given for", arguments: try TouchScopeTable.shared().takes)
  func takes(row: TouchScopeTable.Take) {
    var grants = VaultTouchGrants()
    grants.grant(row.granted, at: Self.now)
    let taken = grants.take(row.wanted, at: Self.now.addingTimeInterval(1))
    #expect(taken == row.taken)
  }

  @Test func `an unlock scope reads as an unlock`() {
    #expect(VaultTouchGrants.isUnlock(VaultTouchGrants.unlock(provider: "bitwarden")))
  }

  @Test func `an item id with a newline can't stretch a hand-on to another site`() throws {
    var grants = VaultTouchGrants()
    let newline = VaultTouchGrants.fill(provider: "bitwarden", item: "a\nhttps://b.example", origin: "https://a.example", tab: "t1")
    grants.grant(try #require(VaultTouchGrants.handOn(provider: "bitwarden", origin: "https://b.example", tab: "t1")), at: Self.now)
    let taken = grants.take(newline, at: Self.now)
    #expect(taken == false)
  }

  @Test func `a hand-on never takes a part with a newline`() {
    #expect(VaultTouchGrants.handOn(provider: "bitwarden", origin: "https://a.example\nt2", tab: "t1") == nil)
  }

  @Test func `a hand-on needs the menu's site`() {
    #expect(VaultTouchGrants.handOn(provider: "bitwarden", origin: "", tab: "t1") == nil)
  }

  @Test func `an unlock from Settings has no menu, so it hands nothing on`() {
    #expect(VaultHandOn(tab: nil, origin: "https://a.example") == nil)
  }
}
