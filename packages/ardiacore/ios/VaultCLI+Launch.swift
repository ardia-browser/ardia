import Foundation

extension VaultCLI {
  static let systemPath = "/usr/bin:/bin:/usr/sbin:/sbin"
  static let toolDirectories = ["/opt/homebrew/bin", "/usr/local/bin"]

  private static let passedVariables = [
    "HOME", "USER", "LOGNAME", "TMPDIR", "http_proxy", "https_proxy", "no_proxy", "all_proxy", "HTTP_PROXY", "HTTPS_PROXY",
    "NO_PROXY", "ALL_PROXY", "NODE_EXTRA_CA_CERTS", "SSL_CERT_FILE",
  ]

  static func make(for provider: any VaultProvider, sessions: VaultSessionStore) -> VaultCLI? {
    guard let path = VaultBinaryLocator.locate(provider.binaryName) else { return nil }
    return VaultCLI(provider: provider.id, path: path, environment: environment(for: provider, path: path), host: sessions)
  }

  private static func environment(for provider: any VaultProvider, path: String) -> [String: String] {
    let inherited = LaunchConfig.shared.environmentForChildProcesses
    var environment: [String: String] = [:]
    for name in passedVariables {
      if let value = inherited[name], !value.isEmpty { environment[name] = value }
    }
    if environment["HOME"] == nil { environment["HOME"] = FileManager.default.homeDirectoryForCurrentUser.path }
    if environment["TMPDIR"] == nil { environment["TMPDIR"] = NSTemporaryDirectory() }
    environment["LANG"] = "en_US.UTF-8"
    environment["PATH"] = searchPath(binaryDirectory: (path as NSString).deletingLastPathComponent)
    environment.merge(provider.environment) { _, chosen in chosen }
    if let directory = isolatedDirectory(for: provider) {
      environment.merge(provider.isolatedEnvironment(directory)) { _, chosen in chosen }
    }
    return environment
  }

  private static func searchPath(binaryDirectory: String) -> String {
    var directories = systemPath.split(separator: ":").map(String.init)
    for directory in toolDirectories + [binaryDirectory] where !directories.contains(directory) {
      if directory == binaryDirectory || VaultBinaryLocator.isTrustedDirectory(directory) { directories.append(directory) }
    }
    return directories.joined(separator: ":")
  }

  private static func isolatedDirectory(for provider: any VaultProvider) -> String? {
    guard let data = VaultSandbox.directory else { return nil }
    let url = URL(fileURLWithPath: data, isDirectory: true)
      .appendingPathComponent("Password Managers", isDirectory: true)
      .appendingPathComponent(provider.id, isDirectory: true)
    try? FileManager.default.createDirectory(at: url, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
    return url.path
  }
}

extension VaultSessionStore: VaultCLIHost {
  func confirmOwner(_ provider: String, reason: String) async -> Bool {
    await VaultOwnerCheck.confirmedRecently(reason, touchScope: VaultTouchGrants.unlock(provider: provider))
  }

  func announceChange(_ provider: String) {
    Task { _ = await VaultBroker.shared.refresh(provider) }
  }
}
