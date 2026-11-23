import CryptoKit
import Foundation

enum VaultPasskeyWork {
  @concurrent static func matching(_ candidates: [VaultPasskeyCandidate], request: VaultPasskeyRequest, handlers: [String: VaultPasskeyHandler]) async
    -> (existing: [String], candidates: [VaultPasskeyCandidate])
  {
    let usable = candidates.filter { candidate in
      guard candidate.delegated else { return true }
      if case .browserExtension = handlers[candidate.provider] { return true }
      return false
    }
    switch request.kind {
    case .create:
      let excluded = Set(request.credentials)
      return (usable.filter { excluded.contains($0.credentialId) }.map(\.id), [])
    case .get:
      let allowed = Set(request.credentials)
      return ([], usable.filter { allowed.isEmpty ? $0.discoverable : allowed.contains($0.credentialId) })
    }
  }


  struct MadePasskey: Sendable {
    var key: P256.Signing.PrivateKey
    var credentialId: Data
    var passkey: VaultPasskey
  }

  @concurrent static func newPasskey(rpId: String, origin: String, request: VaultPasskeyRequest) async -> MadePasskey {
    let key = P256.Signing.PrivateKey()
    let passkey = VaultPasskey.made(rpId: rpId, origin: origin, userHandle: request.userId, userName: request.userName, displayName: request.displayName, key: key,
                                    at: Date().timeIntervalSince1970)
    return MadePasskey(key: key, credentialId: VaultWebAuthn.newCredentialId(), passkey: passkey)
  }

  @concurrent static func registration(site: VaultRelyingParty.Site, request: VaultPasskeyRequest, origin: String, key: P256.Signing.PrivateKey,
                                                   credentialId: Data, backedUp: Bool) async -> VaultSystemPasskeys.Answer
  {
    let authData = VaultWebAuthn.authenticatorData(rpId: site.rpId, flags: VaultWebAuthn.flags(backedUp: backedUp), credentialId: credentialId,
                                                   publicKey: key.publicKey)
    let clientData = VaultWebAuthn.clientDataJSON(.create, challenge: request.challenge, origin: origin)
    return VaultSystemPasskeys.Answer(texts: [
      "kind": "create", "id": VaultBase64URL.encode(credentialId), "clientDataJSON": VaultBase64URL.encode(clientData),
      "attestationObject": VaultBase64URL.encode(VaultWebAuthn.attestationObject(authenticatorData: authData)),
      "authenticatorData": VaultBase64URL.encode(authData), "publicKey": VaultBase64URL.encode(key.publicKey.derRepresentation),
    ], transports: ["internal"], publicKeyAlgorithm: VaultWebAuthn.es256, credProps: request.credProps)
  }

  @concurrent static func assertion(_ signer: VaultPasskeySigner, credentialId: String, rpId: String, request: VaultPasskeyRequest, origin: String,
                                                backedUp: Bool) async -> [String: String]?
  {
    let authData = VaultWebAuthn.authenticatorData(rpId: rpId, flags: VaultWebAuthn.flags(backedUp: backedUp))
    let clientData = VaultWebAuthn.clientDataJSON(.get, challenge: request.challenge, origin: origin)
    guard let signature = try? VaultWebAuthn.signature(signer.key, authenticatorData: authData, clientDataJSON: clientData) else { return nil }
    return [
      "kind": "get", "id": credentialId, "clientDataJSON": VaultBase64URL.encode(clientData), "authenticatorData": VaultBase64URL.encode(authData),
      "signature": VaultBase64URL.encode(signature), "userHandle": VaultBase64URL.encode(signer.userHandle),
    ]
  }
}
