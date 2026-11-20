import Foundation

extension VaultBroker {
  func copy(_ id: String, item: String, field: VaultCopyField) async -> VaultCopyResult {
    if id == ArdiaVault.id { return await ArdiaVaultIndex.shared.copy(id: item, field: field) }
    guard let provider = VaultRegistry.provider(id) else { return .refused(.notFound) }
    let ticket = epochs.ticket(id)
    if field == .password, !(await ownerAllows("copy your password")) { return .declined }
    switch await secret(provider, item: item, field: field.field) {
    case .success(let value):
      guard isCurrent(ticket) else { return .refused(.locked) }
      guard await VaultClipboard.copy(value) else { return .clipboardFailed }
      storeUsedAt = Date()
      sessions.touch(id)
      return .copied
    case .failure(let error):
      NSLog("[vaults] %@ refused a %@ copy: %@", id, field.rawValue, error.rawValue)
      return .refused(error)
    }
  }

  func totp(_ id: String, item: String) async -> VaultTotp? {
    if id == ArdiaVault.id { return await ArdiaVaultIndex.shared.totp(id: item) }
    guard let provider = VaultRegistry.provider(id), case .success(let code) = await totpCode(provider, item: item) else { return nil }
    return code
  }

  func totpCode(_ provider: any VaultProvider, item: String) async -> Result<VaultTotp, VaultFillError> {
    let key = "\(provider.id)/\(item)"
    if let local = localTotp(provider.id, item: item), let code = local.totp() { return .success(code) }
    let nowMs = Date().timeIntervalSince1970 * 1000
    if let recent = recentCodes[key], isReady(provider.id), recent.expiresAt - nowMs > Self.codeReuseMargin { return .success(recent) }
    if let running = codeFetches[key] { return await running.value }
    let task = Task { await self.fetchCode(provider, item: item) }
    codeFetches[key] = task
    let result = await task.value
    if codeFetches[key] == task { codeFetches[key] = nil }
    return result
  }

  func fetchCode(_ provider: any VaultProvider, item: String) async -> Result<VaultTotp, VaultFillError> {
    let outcome = await secret(provider, item: item, field: .totp)
    if let local = localTotp(provider.id, item: item), let code = local.totp() { return .success(code) }
    switch outcome {
    case .success(let value):
      let period = cachedItems[provider.id]?.first(where: { $0.id == item })?.totpPeriod ?? VaultTotp.defaultPeriod
      guard let code = VaultTotp.make(code: value, period: period) else { return .failure(.notFound) }
      recentCodes["\(provider.id)/\(item)"] = code
      return .success(code)
    case .failure(let error):
      return .failure(error)
    }
  }

  func ownerAllows(_ reason: String) async -> Bool {
    guard ownerNeededForPasswords else { return true }
    return await VaultOwnerCheck.confirm(reason)
  }

  func fillValues(provider providerId: String, id itemId: String, fields: [String], origin: String, userChose: Bool, profile: String? = nil) async
    -> Result<VaultFillValues, VaultFillError>
  {
    if providerId == ArdiaVault.id {
      return await ArdiaVaultIndex.shared.fillValues(id: itemId, fields: fields, origin: origin, userChose: userChose, profile: profile)
    }
    guard let provider = VaultRegistry.provider(providerId) else { return .failure(.notFound) }
    guard VaultOriginMatch.isSecure(origin) else { return .failure(.insecure) }
    guard isReady(provider.id) else { return .failure(.locked) }
    let ticket = epochs.ticket(providerId)
    guard let item = await freshItem(provider, itemId) else {
      return .failure(isReady(provider.id) ? .notFound : .locked)
    }
    guard userChose || VaultOriginMatch.matches(item, origin: origin) else { return .failure(.originMismatch) }
    var wanted: [VaultField] = []
    for name in fields {
      let field: VaultField? = name == "otp" ? .totp : VaultField(rawValue: name)
      if let field, !wanted.contains(field) { wanted.append(field) }
    }
    let touched = VaultOwnerCheck.takeFillGrant(provider: providerId, item: itemId, origin: origin)
    if wanted.contains(.password), !touched, !(await ownerAllows("fill your password")) { return .failure(.notAuthorized) }
    var values: [String: String] = [:]
    for field in wanted {
      if field == .username && !item.username.isEmpty {
        values["username"] = item.username
        continue
      }
      if field == .totp {
        switch await totpCode(provider, item: item.id) {
        case .success(let totp):
          values["otp"] = totp.code
        case .failure(let error):
          if error == .notFound && wanted.count > 1 { continue }
          return .failure(error)
        }
        continue
      }
      switch await secret(provider, item: item.id, field: field) {
      case .success(let value):
        values[field.rawValue] = value
      case .failure(let error):
        if error == .notFound && field != .password && wanted.count > 1 { continue }
        return .failure(error)
      }
    }
    guard isCurrent(ticket) else { return .failure(.locked) }
    return values.isEmpty ? .failure(.notFound) : .success(VaultFillValues(values: values, touched: touched))
  }

  func save(provider providerId: String, origin: String, username: String, password: String, title: String?, profile: String? = nil) async
    -> Result<VaultItem, VaultFillError>
  {
    if providerId == ArdiaVault.id {
      return await ArdiaVaultIndex.shared.save(origin: origin, username: username, password: password, profile: profile)
    }
    guard let provider = VaultRegistry.provider(providerId) else { return .failure(.notFound) }
    guard provider.capabilities.save, !password.isEmpty else { return .failure(.failed) }
    guard VaultOriginMatch.isSecure(origin) else { return .failure(.insecure) }
    if sessions.session(provider.id) == nil, isReady(provider.id) { await reconnect(provider) }
    guard sessions.session(provider.id) != nil, let cli = VaultCLI.make(for: provider, sessions: sessions) else { return .failure(.locked) }
    let named = title?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
    let fallback = VaultOriginMatch.siteName(of: origin) ?? origin
    let login = VaultNewLogin(title: named.isEmpty ? fallback : named, username: username, password: password, url: origin)
    do {
      let item = try await lane(provider.id).run { try await provider.save(cli, login: login) }
      guard epochs.isCurrent(cli.ticket), sessions.session(provider.id) != nil else { return .success(item) }
      noteAuthorized(provider.id)
      sessions.touch(provider.id)
      remember(item, password: password)
      refreshInBackground(provider)
      return .success(item)
    } catch {
      await fail(provider, error, ticket: cli.ticket)
      return .failure(Self.fillError(error))
    }
  }

  func secret(_ provider: any VaultProvider, item: String, field: VaultField, keep: Bool = true) async -> Result<String, VaultFillError> {
    let id = provider.id
    guard isReady(id) else { return .failure(.locked) }
    let listed = cachedItems[id]?.first { $0.id == item }
    if field == .password, let listed, let hit = cachedPasswords[id]?[item], hit.itemUpdatedAt == listed.updatedAt {
      storeUsedAt = Date()
      sessions.touch(id)
      return .success(hit.value)
    }
    if field == .username, let listed, !listed.username.isEmpty { return .success(listed.username) }
    if !provider.readsOffline, VaultNetwork.isOffline { return .failure(.offline) }
    if sessions.session(id) == nil { await reconnect(provider) }
    guard sessions.session(id) != nil, let cli = VaultCLI.make(for: provider, sessions: sessions) else { return .failure(.locked) }
    yieldLaneToFill(id)
    do {
      let value = try await lane(id).run { try await provider.secret(cli, id: item, field: field) }
      guard isCurrent(cli.ticket), sessions.session(id) != nil else { return .failure(.locked) }
      noteAuthorized(id)
      sessions.touch(id)
      if field == .totp, value.lowercased().hasPrefix("otpauth://"), let parsed = VaultTotpSecret(value) {
        if keep, let listed {
          cachedTotps[id, default: [:]][item] = VaultCacheSnapshot.Password(value: value, itemUpdatedAt: listed.updatedAt)
          persist(id)
        }
        return .success(parsed.code())
      }
      if keep, field == .password, let listed {
        cachedPasswords[id, default: [:]][item] = VaultCacheSnapshot.Password(value: value, itemUpdatedAt: listed.updatedAt)
        persist(id)
      }
      return .success(value)
    } catch {
      await fail(provider, error, ticket: cli.ticket)
      return .failure(Self.fillError(error))
    }
  }

  static func fillError(_ error: Error) -> VaultFillError {
    switch error as? VaultError {
    case .locked?, .signedOut?: return .locked
    case .notFound?: return .notFound
    default: return .failed
    }
  }
}
