import Foundation

struct VaultPasskeyEntry: Equatable, Sendable {
  var provider: String
  var item: String
  var passkey: VaultItemPasskey
  var userName: String
}

struct VaultPasskeyIndex: Sendable {
  private var byRpId: [String: [VaultPasskeyEntry]] = [:]

  init(_ items: [VaultItem]) {
    VaultOffMain.check()
    for item in items {
      for passkey in item.passkeys ?? [] where passkey.counter == 0 {
        byRpId[passkey.rpId, default: []].append(
          VaultPasskeyEntry(provider: item.provider, item: item.id, passkey: passkey, userName: passkey.userName.isEmpty ? item.username : passkey.userName))
      }
    }
    for key in byRpId.keys { byRpId[key]?.sort(by: Self.ordered) }
  }

  static func ordered(_ left: VaultPasskeyEntry, _ right: VaultPasskeyEntry) -> Bool {
    (left.provider, left.userName.lowercased(), left.passkey.credentialId) < (right.provider, right.userName.lowercased(), right.passkey.credentialId)
  }

  var count: Int { byRpId.values.reduce(0) { $0 + $1.count } }

  func entries(rpId: String) -> [VaultPasskeyEntry] { byRpId[rpId] ?? [] }

  var all: [VaultPasskeyEntry] { byRpId.keys.sorted().flatMap { byRpId[$0]! } }
}
