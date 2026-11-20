import AppKit
import AuthenticationServices
import Foundation

@MainActor
enum VaultSystemPasskeys {
  enum Result {
    case credential([String: Any])
    case cancelled
    case failed
  }

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
    defer { running = nil }
    return await session.run(authorization, credProps: request.credProps)
  }

  private final class Session: NSObject, ASAuthorizationControllerDelegate, ASAuthorizationControllerPresentationContextProviding {
    let window: NSWindow
    private var done: CheckedContinuation<Result, Never>?
    private var credProps = false
    private var controller: ASAuthorizationController?

    func cancel() {
      controller?.cancel()
      finish(.cancelled)
    }

    init(window: NSWindow) { self.window = window }

    func run(_ request: ASAuthorizationRequest, credProps: Bool) async -> Result {
      self.credProps = credProps
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
      let credential = authorization.credential
      MainActor.assumeIsolated { finish(Self.answer(credential, credProps: credProps).map(Result.credential) ?? .failed) }
    }

    nonisolated func authorizationController(controller: ASAuthorizationController, didCompleteWithError error: Error) {
      let cancelled = (error as? ASAuthorizationError)?.code == .canceled
      MainActor.assumeIsolated { finish(cancelled ? .cancelled : .failed) }
    }

    private func finish(_ result: Result) {
      done?.resume(returning: result)
      done = nil
    }

    private static func answer(_ credential: ASAuthorizationCredential, credProps: Bool) -> [String: Any]? {
      if let made = credential as? ASAuthorizationPlatformPublicKeyCredentialRegistration, let attestation = made.rawAttestationObject {
        var answer: [String: Any] = [
          "kind": "create", "id": VaultBase64URL.encode(made.credentialID), "clientDataJSON": VaultBase64URL.encode(made.rawClientDataJSON),
          "attestationObject": VaultBase64URL.encode(attestation), "transports": ["hybrid", "internal"],
        ]
        if let authData = VaultWebAuthn.authenticatorData(fromAttestation: attestation) {
          answer["authenticatorData"] = VaultBase64URL.encode(authData)
          if let key = VaultWebAuthn.publicKey(fromAuthenticatorData: authData) {
            answer["publicKey"] = VaultBase64URL.encode(key.derRepresentation)
            answer["publicKeyAlgorithm"] = VaultWebAuthn.es256
          }
        }
        if credProps { answer["extensions"] = ["credProps": ["rk": true]] }
        return answer
      }
      if let used = credential as? ASAuthorizationPlatformPublicKeyCredentialAssertion {
        return [
          "kind": "get", "id": VaultBase64URL.encode(used.credentialID), "clientDataJSON": VaultBase64URL.encode(used.rawClientDataJSON),
          "authenticatorData": VaultBase64URL.encode(used.rawAuthenticatorData), "signature": VaultBase64URL.encode(used.signature),
          "userHandle": VaultBase64URL.encode(used.userID),
        ]
      }
      return nil
    }
  }
}
