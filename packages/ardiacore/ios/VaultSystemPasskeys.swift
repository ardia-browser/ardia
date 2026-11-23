import AppKit
import AuthenticationServices
import Foundation

@MainActor
enum VaultSystemPasskeys {
  enum Result {
    case credential([String: Any])
    case cancelled
    case excluded
    case failed
  }

  enum Raw: Sendable {
    case registration(id: Data, clientData: Data, attestation: Data)
    case assertion(id: Data, clientData: Data, authenticatorData: Data, signature: Data, userId: Data)
  }

  struct Answer: Sendable {
    var texts: [String: String]
    var transports: [String]?
    var publicKeyAlgorithm: Int?
    var credProps: Bool

    var credential: [String: Any] {
      var object: [String: Any] = texts
      if let transports { object["transports"] = transports }
      if let publicKeyAlgorithm { object["publicKeyAlgorithm"] = publicKeyAlgorithm }
      if credProps { object["extensions"] = ["credProps": ["rk": true]] }
      return object
    }
  }

  enum Ending: Sendable {
    case raw(Raw)
    case cancelled
    case excluded
    case failed
  }

  nonisolated static let matchedExcludedCredential = 1006

  static var available: Bool {
    guard WebKitHub.passkeysEntitled else { return false }
    return ASAuthorizationWebBrowserPublicKeyCredentialManager().authorizationStateForPlatformCredentials != .denied
  }

  private static var running: Session?

  static func cancelRunning() { running?.cancel() }

  static func perform(_ request: VaultPasskeyRequest, site: VaultRelyingParty.Site, origin: String, window: NSWindow) async -> Result {
    guard available, running == nil else { return .failed }
    let provider = ASAuthorizationPlatformPublicKeyCredentialProvider(relyingPartyIdentifier: site.rpId)
    var client = ASPublicKeyCredentialClientData(challenge: request.challenge, origin: origin)
    client.crossOrigin = .sameOriginWithAncestors
    let authorization: ASAuthorizationRequest
    switch request.kind {
    case .create:
      let registration = provider.createCredentialRegistrationRequest(clientData: client, name: request.userName, userID: request.userId)
      if !request.displayName.isEmpty { registration.displayName = request.displayName }
      registration.userVerificationPreference = .required
      registration.excludedCredentials = request.credentials.map { ASAuthorizationPlatformPublicKeyCredentialDescriptor(credentialID: $0) }
      authorization = registration
    case .get:
      let assertion = provider.createCredentialAssertionRequest(clientData: client)
      assertion.userVerificationPreference = .required
      assertion.allowedCredentials = request.credentials.map { ASAuthorizationPlatformPublicKeyCredentialDescriptor(credentialID: $0) }
      authorization = assertion
    }
    let session = Session(window: window)
    running = session
    let ending = await session.run(authorization)
    running = nil
    switch ending {
    case .cancelled: return .cancelled
    case .excluded: return .excluded
    case .failed: return .failed
    case .raw(let raw):
      guard let answer = await answer(raw, credProps: request.credProps) else { return .failed }
      return .credential(answer.credential)
    }
  }

  @concurrent nonisolated static func answer(_ raw: Raw, credProps: Bool) async -> Answer? {
    switch raw {
    case .registration(let id, let clientData, let attestation):
      var texts = [
        "kind": "create", "id": VaultBase64URL.encode(id), "clientDataJSON": VaultBase64URL.encode(clientData), "attestationObject": VaultBase64URL.encode(attestation),
      ]
      var algorithm: Int?
      if let authData = VaultWebAuthn.authenticatorData(fromAttestation: attestation) {
        texts["authenticatorData"] = VaultBase64URL.encode(authData)
        if let key = VaultWebAuthn.publicKey(fromAuthenticatorData: authData) {
          texts["publicKey"] = VaultBase64URL.encode(key.derRepresentation)
          algorithm = VaultWebAuthn.es256
        }
      }
      return Answer(texts: texts, transports: ["hybrid", "internal"], publicKeyAlgorithm: algorithm, credProps: credProps)
    case .assertion(let id, let clientData, let authenticatorData, let signature, let userId):
      return Answer(texts: [
        "kind": "get", "id": VaultBase64URL.encode(id), "clientDataJSON": VaultBase64URL.encode(clientData),
        "authenticatorData": VaultBase64URL.encode(authenticatorData), "signature": VaultBase64URL.encode(signature), "userHandle": VaultBase64URL.encode(userId),
      ], credProps: false)
    }
  }

  private final class Session: NSObject, ASAuthorizationControllerDelegate, ASAuthorizationControllerPresentationContextProviding {
    let window: NSWindow
    private var done: CheckedContinuation<Ending, Never>?
    private var controller: ASAuthorizationController?

    func cancel() {
      controller?.cancel()
      finish(.cancelled)
    }

    init(window: NSWindow) { self.window = window }

    func run(_ request: ASAuthorizationRequest) async -> Ending {
      let controller = ASAuthorizationController(authorizationRequests: [request])
      controller.delegate = self
      controller.presentationContextProvider = self
      self.controller = controller
      return await withCheckedContinuation { continuation in
        done = continuation
        controller.performRequests()
      }
    }

    nonisolated func presentationAnchor(for controller: ASAuthorizationController) -> ASPresentationAnchor {
      MainActor.assumeIsolated { window }
    }

    nonisolated func authorizationController(controller: ASAuthorizationController, didCompleteWithAuthorization authorization: ASAuthorization) {
      let raw = Self.raw(authorization.credential)
      MainActor.assumeIsolated { finish(raw.map(Ending.raw) ?? .failed) }
    }

    nonisolated func authorizationController(controller: ASAuthorizationController, didCompleteWithError error: Error) {
      let code = (error as NSError).domain == ASAuthorizationError.errorDomain ? (error as NSError).code : 0
      let ending: Ending = code == ASAuthorizationError.canceled.rawValue ? .cancelled : code == VaultSystemPasskeys.matchedExcludedCredential ? .excluded : .failed
      MainActor.assumeIsolated { finish(ending) }
    }

    private func finish(_ ending: Ending) {
      done?.resume(returning: ending)
      done = nil
    }

    private nonisolated static func raw(_ credential: ASAuthorizationCredential) -> Raw? {
      if let made = credential as? ASAuthorizationPlatformPublicKeyCredentialRegistration, let attestation = made.rawAttestationObject {
        return .registration(id: made.credentialID, clientData: made.rawClientDataJSON, attestation: attestation)
      }
      if let used = credential as? ASAuthorizationPlatformPublicKeyCredentialAssertion {
        return .assertion(id: used.credentialID, clientData: used.rawClientDataJSON, authenticatorData: used.rawAuthenticatorData, signature: used.signature,
                          userId: used.userID)
      }
      return nil
    }
  }
}
