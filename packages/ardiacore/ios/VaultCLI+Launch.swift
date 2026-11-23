import Foundation

extension VaultCLI {
  static let systemPath = "/usr/bin:/bin:/usr/sbin:/sbin"
  static let toolDirectories = ["/opt/homebrew/bin", "/usr/local/bin"]

  private static let passedVariables = [
    "HOME", "USER", "LOGNAME", "TMPDIR", "http_proxy", "https_proxy", "no_proxy", "all_proxy", "HTTP_PROXY", "HTTPS_PROXY",
    "NO_PROXY", "ALL_PROXY", "NODE_EXTRA_CA_CERTS", "SSL_CERT_FILE",
  ]

  static func make(for provider: any VaultProvider, sessions: VaultSessionStore) -> VaultCLI? {
    guard let program = VaultBinaryLocator.program(provider.binaryName) else { return nil }
    return VaultCLI(provider: provider.id, path: program.path, environment: hostEnvironment(binaryDirectory: (program.path as NSString).deletingLastPathComponent),
                    host: sessions)
  }

  static func hostEnvironment(binaryDirectory: String) -> [String: String] {
    let inherited = LaunchConfig.shared.environmentForChildProcesses
    var environment: [String: String] = [:]
    for name in passedVariables {
      if let value = inherited[name], !value.isEmpty { environment[name] = value }
    }
    if environment["HOME"] == nil { environment["HOME"] = FileManager.default.homeDirectoryForCurrentUser.path }
    if environment["TMPDIR"] == nil { environment["TMPDIR"] = NSTemporaryDirectory() }
    environment["LANG"] = "en_US.UTF-8"
    environment["PATH"] = searchPath(binaryDirectory: binaryDirectory)
    return environment
  }

  private static func searchPath(binaryDirectory: String) -> String {
    var directories = systemPath.split(separator: ":").map(String.init)
    for directory in toolDirectories + [binaryDirectory] where !directories.contains(directory) {
      if VaultBinaryLocator.isTrustedDirectory(directory) { directories.append(directory) }
    }
    return directories.joined(separator: ":")
  }

  static func testFolder(for provider: String) -> String? {
    guard let data = VaultSandbox.directory else { return nil }
    return URL(fileURLWithPath: data, isDirectory: true)
      .appendingPathComponent("Password Managers", isDirectory: true)
      .appendingPathComponent(provider, isDirectory: true).path
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
