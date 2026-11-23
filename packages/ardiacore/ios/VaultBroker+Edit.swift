import Foundation

extension VaultBroker {
  func edit(provider providerId: String, id itemId: String, change raw: VaultLoginChange) async -> VaultEditResult {
    await edit(provider: providerId, id: itemId, change: raw, origin: nil)
  }

  func updatePassword(provider providerId: String, id itemId: String, origin: String, password: String) async -> VaultEditResult {
    await edit(provider: providerId, id: itemId, change: VaultLoginChange(password: password), origin: origin)
  }

  private func edit(provider providerId: String, id itemId: String, change raw: VaultLoginChange, origin: String?) async -> VaultEditResult {
    if providerId == ArdiaVault.id { return .failure(.unsupported) }
    guard let provider = VaultRegistry.provider(providerId) else { return .failure(.notFound) }
    guard provider.capabilities.edit else { return .failure(.unsupported) }
    guard let change = raw.validated(), !change.isEmpty else { return .failure(.invalid) }
    if let origin, !VaultOriginMatch.isSecure(origin) { return .failure(.invalid) }
    guard isReady(provider.id) else { return .failure(.locked) }
    guard let listed = await freshItem(provider, itemId) else { return .failure(isReady(provider.id) ? .notFound : .locked) }
    if let origin, !VaultOriginMatch.matches(listed, origin: origin) { return .failure(.notFound) }
    guard await VaultOwnerCheck.confirm(change.changesPassword ? "change your password" : "edit a login") else { return .failure(.declined) }
    if sessions.session(provider.id) == nil { await reconnect(provider) }
    guard let cli = VaultCLI.make(for: provider, sessions: sessions) else {
      await fail(provider, VaultError.locked)
      return .failure(.locked)
    }
    yieldLaneToFill(provider.id)
    if let pending = loading[provider.id] { _ = await pending.value }
    do {
      let edited = try await lane(provider.id).run { try await provider.edit(cli, id: itemId, change: change) }
      sessions.touch(provider.id)
      let item = rememberEdit(change, on: edited, listed: listed)
      Task { await self.pinEditAfterRefetch(provider, itemId: itemId, change: change) }
      return VaultEditResult(item: item)
    } catch {
      forgetSecrets(provider.id, itemId: itemId, change: change)
      await fail(provider, error, ticket: cli.ticket)
      return Self.editFailure(error)
    }
  }

  func rememberEdit(_ change: VaultLoginChange, on edited: VaultItem, listed: VaultItem) -> VaultItem {
    let id = listed.provider
    var item = edited
    item.provider = id
    if item.title.isEmpty { item.title = listed.title }
    if let username = change.username { item.username = username } else if item.username.isEmpty { item.username = listed.username }
    if item.urls.isEmpty { item.urls = Self.urls(listed.urls, replacingFirstWith: change.url) }
    if item.vault == nil { item.vault = listed.vault }
    if item.favorite == nil { item.favorite = listed.favorite }
    if item.profile == nil { item.profile = listed.profile }
    if item.urlMatch == nil, item.urls.count == listed.urls.count { item.urlMatch = listed.urlMatch }
    if item.updatedAt == nil || item.updatedAt == listed.updatedAt { item.updatedAt = Self.editStamp(after: listed.updatedAt) }
    switch change.totp {
    case .set(let uri):
      item.hasTotp = true
      item.totpPeriod = VaultTotp.period(fromURI: uri)
    case .remove:
      item.hasTotp = false
      item.totpPeriod = nil
    case .unchanged:
      if item.hasTotp == nil { item.hasTotp = listed.hasTotp }
      if item.totpPeriod == nil { item.totpPeriod = listed.totpPeriod }
    }
    guard cachedItems[id] != nil else {
      forgetSecrets(id, itemId: item.id, change: change)
      return item
    }
    if let index = cachedItems[id]?.firstIndex(where: { $0.id == item.id }) {
      cachedItems[id]?[index] = item
    } else {
      cachedItems[id]?.append(item)
    }
    if let password = change.password {
      cachedPasswords[id, default: [:]][item.id] = VaultCacheSnapshot.Password(value: password, itemUpdatedAt: item.updatedAt)
    } else if let kept = cachedPasswords[id]?[item.id], kept.itemUpdatedAt == listed.updatedAt {
      cachedPasswords[id]?[item.id] = VaultCacheSnapshot.Password(value: kept.value, itemUpdatedAt: item.updatedAt)
    } else {
      cachedPasswords[id]?[item.id] = nil
    }
    switch change.totp {
    case .set(let uri):
      cachedTotps[id, default: [:]][item.id] = VaultCacheSnapshot.Password(value: uri, itemUpdatedAt: item.updatedAt)
    case .remove:
      cachedTotps[id]?[item.id] = nil
    case .unchanged:
      if let kept = cachedTotps[id]?[item.id], kept.itemUpdatedAt == listed.updatedAt {
        cachedTotps[id]?[item.id] = VaultCacheSnapshot.Password(value: kept.value, itemUpdatedAt: item.updatedAt)
      } else {
        cachedTotps[id]?[item.id] = nil
      }
    }
    if change.totp != .unchanged { recentCodes["\(id)/\(item.id)"] = nil }
    if change.url != nil || change.username != nil { siteIndexes[id] = nil }
    storeUsedAt = Date()
    persist(id)
    announceItems(id)
    return item
  }

  func pinEditAfterRefetch(_ provider: any VaultProvider, itemId: String, change: VaultLoginChange) async {
    let id = provider.id
    if let pending = loading[id] { _ = await pending.value }
    guard sessions.session(id) != nil, case .success(let items) = await fetchResult(provider) else { return }
    guard let fresh = items.first(where: { $0.id == itemId }), let index = cachedItems[id]?.firstIndex(where: { $0.id == itemId }) else { return }
    var changed = false
    if let password = change.password {
      let held = cachedPasswords[id]?[itemId]
      if held?.value != password || held?.itemUpdatedAt != fresh.updatedAt {
        cachedPasswords[id, default: [:]][itemId] = VaultCacheSnapshot.Password(value: password, itemUpdatedAt: fresh.updatedAt)
        changed = true
      }
    }
    switch change.totp {
    case .set(let uri):
      let held = cachedTotps[id]?[itemId]
      if held?.value != uri || held?.itemUpdatedAt != fresh.updatedAt || fresh.hasTotp != true {
        if cachedItems[id]?[index].hasTotp != false { cachedItems[id]?[index].hasTotp = true }
        if cachedItems[id]?[index].totpPeriod == nil { cachedItems[id]?[index].totpPeriod = VaultTotp.period(fromURI: uri) }
        cachedTotps[id, default: [:]][itemId] = VaultCacheSnapshot.Password(value: uri, itemUpdatedAt: fresh.updatedAt)
        changed = true
      }
    case .remove:
      if cachedTotps[id]?[itemId] != nil {
        cachedTotps[id]?[itemId] = nil
        changed = true
      }
    case .unchanged:
      break
    }
    guard changed else { return }
    persist(id)
    announceItems(id)
  }

  func forgetSecrets(_ id: String, itemId: String, change: VaultLoginChange) {
    var forgot = false
    if change.password != nil, cachedPasswords[id]?[itemId] != nil {
      cachedPasswords[id]?[itemId] = nil
      forgot = true
    }
    if change.totp != .unchanged, cachedTotps[id]?[itemId] != nil {
      cachedTotps[id]?[itemId] = nil
      recentCodes["\(id)/\(itemId)"] = nil
      forgot = true
    }
    if forgot { persist(id) }
  }

  static func urls(_ urls: [String], replacingFirstWith url: String?) -> [String] {
    guard let url else { return urls }
    return [url] + urls.dropFirst()
  }

  static func editStamp(after previous: Double?) -> Double {
    let now = (Date().timeIntervalSince1970 * 1000).rounded()
    guard let previous, previous >= now else { return now }
    return previous + 1
  }

  static func editFailure(_ error: Error) -> VaultEditResult {
    switch error as? VaultError {
    case .locked?, .signedOut?: return .failure(.locked)
    case .notFound?: return .failure(.notFound)
    case .unsupported?: return .failure(.unsupported)
    case .failed(let message)?: return .failure(.failed, message)
    default: return .failure(.failed)
    }
  }
}
