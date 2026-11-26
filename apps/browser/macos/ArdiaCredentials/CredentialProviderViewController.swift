import AuthenticationServices

final class CredentialProviderViewController: ASCredentialProviderViewController {
  private func answerWithNothing() {
    extensionContext.cancelRequest(withError: NSError(domain: ASExtensionErrorDomain, code: ASExtensionError.Code.credentialIdentityNotFound.rawValue))
  }

  override func loadView() {
    view = NSView(frame: .zero)
  }

  override func prepareCredentialList(for serviceIdentifiers: [ASCredentialServiceIdentifier]) {
    answerWithNothing()
  }

  override func prepareCredentialList(for serviceIdentifiers: [ASCredentialServiceIdentifier], requestParameters: ASPasskeyCredentialRequestParameters) {
    answerWithNothing()
  }

  override func prepareOneTimeCodeCredentialList(for serviceIdentifiers: [ASCredentialServiceIdentifier]) {
    answerWithNothing()
  }

  override func provideCredentialWithoutUserInteraction(for credentialRequest: any ASCredentialRequest) {
    answerWithNothing()
  }

  override func prepareInterfaceToProvideCredential(for credentialRequest: any ASCredentialRequest) {
    answerWithNothing()
  }

  override func prepareInterface(forPasskeyRegistration registrationRequest: any ASCredentialRequest) {
    answerWithNothing()
  }

  override func prepareInterfaceForExtensionConfiguration() {
    extensionContext.completeExtensionConfigurationRequest()
  }
}
