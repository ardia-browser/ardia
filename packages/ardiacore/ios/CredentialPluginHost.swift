import Foundation

public struct CredentialManifestCheck: Sendable, Equatable {
  public let declaresProvider: Bool
  public let refusals: [String]
  public let program: String?
  public let memoryMB: Int

  public var accepted: Bool { declaresProvider && refusals.isEmpty }
}

public final class CredentialPluginHost: VaultProviderSource, @unchecked Sendable {
  public static let shared = CredentialPluginHost()

  private let lock = NSLock()
  private let host: any CredentialHost
  private var providers: [String: PluginVaultProvider] = [:]
  private var pinned: [String: CredentialRunEndpoint] = [:]
  private var enabled: [String: String] = [:]
  private var wanted: (@Sendable (String) -> Void)?

  init(host: any CredentialHost = CredentialHostLive()) {
    self.host = host
    VaultRegistry.add(self)
  }

  var vaultProviders: [any VaultProvider] { lock.withLock { providers.keys.sorted().compactMap { providers[$0] } } }

  public func onRunWanted(_ handler: @escaping @Sendable (String) -> Void) { lock.withLock { wanted = handler } }

  public static func refuseProgramRoots(_ roots: [String]) { VaultBinaryLocator.refuse(roots: roots) }

  public static func check(manifest: Data) -> CredentialManifestCheck {
    guard CredentialCatalogParser.declaresProvider(manifest: manifest) else {
      return CredentialManifestCheck(declaresProvider: false, refusals: [], program: nil, memoryMB: 0)
    }
    switch CredentialCatalogParser.parse(manifest: manifest) {
    case .accepted(let contribution):
      return CredentialManifestCheck(declaresProvider: true, refusals: [], program: contribution.cli.name, memoryMB: contribution.memoryMB)
    case .refused(let problems):
      return CredentialManifestCheck(declaresProvider: true, refusals: problems, program: nil, memoryMB: 0)
    }
  }

  public static var appVersion: String { Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "0.0.0" }

  public func pin(plugin: String, run: Int, approved: String, attachment: Int, manifest: Data, link: any CredentialPluginLink) -> CredentialRunEndpoint? {
    guard case .accepted(let parsed) = CredentialCatalogParser.parse(manifest: manifest), parsed.plugin == plugin else { return nil }
    let endpoint = CredentialRunEndpoint(
      plugin: plugin, run: run, approved: approved, attachment: attachment, contribution: parsed, host: host, link: link, appVersion: Self.appVersion)
    endpoint.onReady = { [weak self] ready in self?.ready(ready) }
    endpoint.onEnded = { [weak self] ended, crashed in self?.ended(ended, crashed: crashed) }
    let replaced = lock.withLock { () -> CredentialRunEndpoint? in
      defer { pinned[plugin] = endpoint }
      return pinned[plugin]
    }
    replaced?.ended(crashed: false)
    return endpoint
  }

  public func endpoint(_ plugin: String) -> CredentialRunEndpoint? { lock.withLock { pinned[plugin] } }

  private func ready(_ endpoint: CredentialRunEndpoint) {
    let provider = lock.withLock { () -> PluginVaultProvider? in
      guard pinned[endpoint.plugin] === endpoint, enabled[endpoint.plugin] == endpoint.approved else { return nil }
      return providers[endpoint.plugin]
    }
    guard let provider, provider.contribution == endpoint.contribution else { return }
    provider.attach(endpoint)
  }

  private func ended(_ endpoint: CredentialRunEndpoint, crashed: Bool) {
    let provider = lock.withLock { () -> PluginVaultProvider? in
      if pinned[endpoint.plugin] === endpoint { pinned[endpoint.plugin] = nil }
      return providers[endpoint.plugin]
    }
    provider?.detach(endpoint, crashed: crashed)
  }

  public func enable(_ plugin: String) -> String? {
    guard let endpoint = lock.withLock({ pinned[plugin] }), !endpoint.isFinished else {
      return "Ardia runs password managers only from its official plugins, and \(plugin) isn't running as one."
    }
    if let problem = endpoint.problem { return problem }
    let contribution = endpoint.contribution
    let (provider, added) = lock.withLock { () -> (PluginVaultProvider, Bool) in
      enabled[plugin] = endpoint.approved
      if let known = providers[plugin], known.contribution == contribution { return (known, false) }
      let made = makeProvider(contribution)
      providers[plugin] = made
      return (made, true)
    }
    provider.clearUnavailable()
    if endpoint.isReady { provider.attach(endpoint) }
    Task { await VaultBroker.shared.providerAdded(plugin) }
    _ = added
    return nil
  }

  public func restore(plugin: String, approved: String, manifest: Data) -> String? {
    guard case .accepted(let contribution) = CredentialCatalogParser.parse(manifest: manifest), contribution.plugin == plugin else {
      return "This copy of \(plugin) is damaged. Reinstall it."
    }
    lock.withLock {
      enabled[plugin] = approved
      if providers[plugin]?.contribution != contribution { providers[plugin] = makeProvider(contribution) }
    }
    Task { await VaultBroker.shared.providerAdded(plugin) }
    return nil
  }

  public func markDamaged(_ plugin: String) {
    guard let provider = lock.withLock({ providers[plugin] }) else { return }
    provider.locked()
    provider.markUnavailable(.damaged, message: provider.wording.damaged, canRestart: false)
    Task { _ = await VaultBroker.shared.refresh(plugin) }
  }

  public var enabledPlugins: [String: String] { lock.withLock { enabled } }

  public func disable(_ plugin: String, forget: Bool) async {
    let provider = lock.withLock { () -> PluginVaultProvider? in
      enabled[plugin] = nil
      return providers.removeValue(forKey: plugin)
    }
    guard let provider else {
      if forget { await VaultBroker.shared.forgetProviderData(plugin) }
      return
    }
    await VaultBroker.shared.providerRemoved(provider, forget: forget)
  }

  private func makeProvider(_ contribution: CredentialContribution) -> PluginVaultProvider {
    PluginVaultProvider(
      contribution: contribution, host: host,
      wantRun: { [weak self] name in
        guard let self else { return }
        let handler = self.lock.withLock { self.wanted }
        handler?(name)
      },
      openApproval: { name, url in Task { await VaultBroker.shared.announceApproval(name, url: url) } })
  }
}
