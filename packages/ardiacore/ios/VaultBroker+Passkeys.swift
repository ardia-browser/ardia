import Foundation

extension VaultBroker {
  func passkeyHolder(_ id: String) -> (any VaultPasskeyHolder)? {
    guard let holder = VaultRegistry.provider(id) as? any VaultPasskeyHolder, holder.capabilities.passkeys, isReady(holder.id) else { return nil }
    return holder
  }

  func listsDelegatedPasskeys(_ provider: any VaultProvider) -> Bool {
    provider.capabilities.passkeysVia?.contains { $0.via == .browserExtension } == true && isReady(provider.id)
  }

  func passkeyIndex(_ provider: any VaultProvider, delegated: Bool) -> VaultPasskeyIndex? {
    guard let items = cachedItems[provider.id] else {
      passkeyIndexes[provider.id] = nil
      return nil
    }
    if let built = passkeyIndexes[provider.id], built.items == items {
      passkeyIndexes[provider.id] = (items, built.index)
      return built.index
    }
    let index = VaultPasskeyIndex(provider: provider.id, items: items, delegated: delegated)
    passkeyIndexes[provider.id] = (items, index)
    return index
  }

  func passkeyCandidates(rpId: String?) -> [VaultPasskeyCandidate] {
    var found: [VaultPasskeyCandidate] = []
    for provider in VaultRegistry.providers {
      let holds = passkeyHolder(provider.id) != nil
      guard let delegated = VaultPasskeyUse.delegated(holdsKeys: holds, listsDelegated: !holds && listsDelegatedPasskeys(provider)) else { continue }
      guard let index = passkeyIndex(provider, delegated: delegated) else { continue }
      found += rpId.map(index.candidates) ?? index.all
    }
    return found
  }

  func passkeyDelegates() -> [VaultPasskeyDelegate] {
    VaultRegistry.providers.compactMap { provider in
      guard let routes = provider.capabilities.passkeysVia, !routes.isEmpty, let state = states[provider.id]?.state, state == .locked || state == .unlocked
      else { return nil }
      return VaultPasskeyDelegate(provider: provider.id, name: provider.name, routes: routes)
    }
  }

  func passkeySigner(_ candidate: VaultPasskeyCandidate) async -> VaultPasskeySigner? {
    guard let item = candidate.item, let provider = passkeyHolder(candidate.provider),
      cachedItems[provider.id]?.contains(where: { $0.id == item && ($0.passkeys ?? []).contains { $0.credentialId == candidate.id } }) == true
    else { return nil }
    if sessions.session(provider.id) == nil { await reconnect(provider) }
    guard sessions.session(provider.id) != nil, let cli = VaultCLI.make(for: provider, sessions: sessions) else { return nil }
    yieldLaneToFill(provider.id)
    do {
      let signer = try await lane(provider.id).run { try await provider.passkeySigner(cli, item: item, credential: candidate.credentialId, rpId: candidate.rpId) }
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

extension VaultBroker {
  func refetchItems(_ id: String) async {
    guard let provider = VaultRegistry.provider(id), isReady(id) else { return }
    fetchedAt[id] = nil
    _ = await fetchItems(provider)
  }
}
