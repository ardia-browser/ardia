import Foundation
import Testing

@Suite("Secret entry tokens", .serialized)
struct VaultSecretEntriesTests {
  static func token(_ name: String) -> String { "\(VaultSecretEntries.prefix)\(name)-\(UUID().uuidString.prefix(8))" }

  @Test func `an entry token nobody typed into resolves to no secret and reads as expired`() {
    let unknown = Self.token("never-typed")
    #expect(VaultSecretEntries.resolve(unknown) == nil)
    #expect(VaultSecretEntries.isExpired(unknown))
  }

  @Test func `a typed entry resolves to what was typed until it is dropped`() {
    let typed = Self.token("typed")
    let secret = "fixture-" + "typed-1"
    VaultSecretEntries.set(typed, secret)
    #expect(VaultSecretEntries.resolve(typed) == secret)
    #expect(VaultSecretEntries.value(typed) == secret)
    #expect(VaultSecretEntries.isExpired(typed) == false)

    VaultSecretEntries.drop(typed)
    #expect(VaultSecretEntries.resolve(typed) == nil)
    #expect(VaultSecretEntries.isExpired(typed))
  }

  @Test func `an emptied field resolves to no secret and is empty, not expired`() {
    let cleared = Self.token("cleared")
    VaultSecretEntries.set(cleared, "")
    #expect(VaultSecretEntries.resolve(cleared) == nil)
    #expect(VaultSecretEntries.value(cleared) == nil)
    #expect(VaultSecretEntries.isExpired(cleared) == false)
  }

  @Test func `text that isn't an entry token passes through and never expires`() {
    let plain = "fixture-" + "plain-text"
    #expect(VaultSecretEntries.resolve(plain) == plain)
    #expect(VaultSecretEntries.resolve(nil) == nil)
    #expect(VaultSecretEntries.isExpired(nil) == false)
    #expect(VaultSecretEntries.isExpired(plain) == false)
  }

  @Test func `an over-long name is not a token, so nothing is stored under it`() {
    let tooLong = VaultSecretEntries.prefix + String(repeating: "x", count: 64)
    VaultSecretEntries.set(tooLong, "fixture-" + "kept")
    #expect(VaultSecretEntries.resolve(tooLong) == tooLong)
    #expect(VaultSecretEntries.value(tooLong) == nil)
  }

  @Test func `past the cap the oldest entry is forgotten and the newest are kept`() {
    let first = Self.token("first")
    VaultSecretEntries.set(first, "fixture-" + "first")
    let later = (0..<VaultSecretEntries.mostEntries).map { index in
      let name = Self.token("later\(index)")
      VaultSecretEntries.set(name, "fixture-\(index)")
      return name
    }
    #expect(VaultSecretEntries.resolve(first) == nil)
    #expect(VaultSecretEntries.isExpired(first))
    #expect(later.allSatisfy { VaultSecretEntries.value($0) != nil })
  }

  @Test func `locking drops every typed value`() {
    let typed = Self.token("typed")
    VaultSecretEntries.set(typed, "fixture-typed")
    VaultSecretEntries.dropAll()
    #expect(VaultSecretEntries.value(typed) == nil)
    #expect(VaultSecretEntries.isExpired(typed))
  }

  @Test func `a value past the longest is cut to it`() {
    let long = Self.token("long")
    VaultSecretEntries.set(long, String(repeating: "a", count: VaultSecretEntries.longestValue + 10))
    #expect(VaultSecretEntries.value(long)?.count == VaultSecretEntries.longestValue)
  }
}
