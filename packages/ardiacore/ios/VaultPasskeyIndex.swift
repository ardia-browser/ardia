import Foundation

struct VaultPasskeyIndex: Sendable {
  private var byRpId: [String: [VaultPasskeyCandidate]] = [:]

  init(provider: String, items: [VaultItem], delegated: Bool) {
    for item in items {
      for passkey in item.passkeys ?? [] where passkey.counter == 0 {
        guard let raw = VaultBase64URL.decode(passkey.credentialId) else { continue }
        byRpId[passkey.rpId, default: []].append(
          VaultPasskeyCandidate(provider: provider, credentialId: raw, item: item.id, rpId: passkey.rpId,
                                userName: passkey.userName.isEmpty ? item.username : passkey.userName, displayName: passkey.displayName,
                                discoverable: passkey.discoverable, delegated: delegated))
      }
    }
    for key in byRpId.keys { byRpId[key]?.sort(by: Self.ordered) }
  }

  static func ordered(_ left: VaultPasskeyCandidate, _ right: VaultPasskeyCandidate) -> Bool {
    (left.userName.lowercased(), left.id) < (right.userName.lowercased(), right.id)
  }

  var count: Int { byRpId.values.reduce(0) { $0 + $1.count } }

  func candidates(rpId: String) -> [VaultPasskeyCandidate] { byRpId[rpId] ?? [] }

  var all: [VaultPasskeyCandidate] { byRpId.keys.sorted().flatMap { byRpId[$0]! } }
}
