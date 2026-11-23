import Foundation

extension VaultBroker {
  enum ItemLinkFailure: String, Error {
    case unsupported
    case locked
    case notFound
    case failed
  }

  func itemLink(provider providerId: String, id itemId: String) async -> Result<URL, ItemLinkFailure> {
    guard let provider = VaultRegistry.provider(providerId), provider.capabilities.opensItems else { return .failure(.unsupported) }
    guard isReady(provider.id) else { return .failure(.locked) }
    guard cachedItems[provider.id]?.contains(where: { $0.id == itemId }) == true else { return .failure(.notFound) }
    if sessions.session(provider.id) == nil { await reconnect(provider) }
    guard let cli = VaultCLI.make(for: provider, sessions: sessions) else { return .failure(.locked) }
    yieldLaneToFill(provider.id)
    do {
      let url = try await lane(provider.id).run { try await provider.itemLink(cli, id: itemId) }
      sessions.touch(provider.id)
      return .success(url)
    } catch {
      await fail(provider, error, ticket: cli.ticket)
      return .failure(error as? VaultError == .locked ? .locked : .failed)
    }
  }
}
