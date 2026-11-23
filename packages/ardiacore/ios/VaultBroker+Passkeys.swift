import CryptoKit
import Foundation

struct VaultNewPasskey: Sendable {
  var credentialId: UUID
  var key: P256.Signing.PrivateKey
  var rpId: String
  var rpName: String
  var userHandle: Data
  var userName: String
  var displayName: String
  var createdAt: Date

  var rawId: Data { withUnsafeBytes(of: credentialId.uuid) { Data($0) } }
}

protocol VaultPasskeyHolder: VaultProvider {
  func passkeySigner(_ cli: VaultCLI, item: String, credential: Data) async throws -> VaultPasskeySigner?
  func savePasskey(_ cli: VaultCLI, credential: VaultNewPasskey, attachTo item: String?, title: String, url: String) async throws -> String
}

extension VaultBroker {
  func passkeyHolder(_ id: String) -> (any VaultPasskeyHolder)? {
    guard let holder = VaultRegistry.provider(id) as? any VaultPasskeyHolder, holder.capabilities.passkeys, isReady(holder.id) else { return nil }
    return holder
  }

  func passkeyCandidates(rpId: String?) -> [VaultPasskeyCandidate] {
    var found: [VaultPasskeyCandidate] = []
    for provider in VaultRegistry.providers where passkeyHolder(provider.id) != nil {
      for item in cachedItems[provider.id] ?? [] {
        for passkey in item.passkeys ?? [] where passkey.counter == 0 && (rpId == nil || passkey.rpId == rpId) {
          guard let raw = VaultBase64URL.decode(passkey.credentialId) else { continue }
          found.append(VaultPasskeyCandidate(provider: provider.id, credentialId: raw, item: item.id, rpId: passkey.rpId,
                                             userName: passkey.userName.isEmpty ? item.username : passkey.userName,
                                             displayName: passkey.displayName, discoverable: passkey.discoverable))
        }
      }
    }
    return found.sorted { ($0.userName.lowercased(), $0.id) < ($1.userName.lowercased(), $1.id) }
  }

  func passkeySigner(_ candidate: VaultPasskeyCandidate) async -> VaultPasskeySigner? {
    guard let item = candidate.item, let provider = passkeyHolder(candidate.provider),
      cachedItems[provider.id]?.contains(where: { $0.id == item && ($0.passkeys ?? []).contains { $0.credentialId == candidate.id } }) == true
    else { return nil }
    if sessions.session(provider.id) == nil { await reconnect(provider) }
    guard sessions.session(provider.id) != nil, let cli = VaultCLI.make(for: provider, sessions: sessions) else { return nil }
    yieldLaneToFill(provider.id)
    do {
      let signer = try await lane(provider.id).run { try await provider.passkeySigner(cli, item: item, credential: candidate.credentialId) }
      guard isCurrent(cli.ticket) else { return nil }
      sessions.touch(provider.id)
      return signer
    } catch {
      await fail(provider, error, ticket: cli.ticket)
      return nil
    }
  }
}

extension VaultBroker {
  enum PasskeySaveError: Error {
    case unavailable
    case failed(String)
  }

  func savePasskey(_ credential: VaultNewPasskey, in holder: String, origin: String) async -> Result<String, PasskeySaveError> {
    guard let provider = passkeyHolder(holder) else { return .failure(.unavailable) }
    if sessions.session(provider.id) == nil { await reconnect(provider) }
    guard sessions.session(provider.id) != nil, let cli = VaultCLI.make(for: provider, sessions: sessions) else { return .failure(.unavailable) }
    let wanted = credential.userName.lowercased()
    let match = (cachedItems[provider.id] ?? []).first { item in
      (item.passkeys ?? []).isEmpty && !wanted.isEmpty && item.username.lowercased() == wanted
        && VaultOriginMatch.tier(item.urls, modes: item.urlMatch, origin: origin) >= .subdomain
    }
    let title = VaultOriginMatch.siteName(of: origin) ?? credential.rpId
    yieldLaneToFill(provider.id)
    do {
      let itemId = try await lane(provider.id).run {
        try await provider.savePasskey(cli, credential: credential, attachTo: match?.id, title: title, url: origin)
      }
      sessions.touch(provider.id)
      _ = await fetchItems(provider)
      return .success(itemId)
    } catch {
      await fail(provider, error, ticket: cli.ticket)
      if case VaultError.failed(let message) = error { return .failure(.failed(message)) }
      return .failure(.failed("\(provider.name) couldn't save the passkey."))
    }
  }
}
