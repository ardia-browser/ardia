import AppKit
import UniformTypeIdentifiers

struct VaultExportResult: Encodable, Sendable {
  var saved = false
  var count = 0
  var declined = false

  func jsonObject() -> [String: Any] { VaultJSON.object(self) }
}

extension VaultBroker {
  static let exportColumns = ["name", "url", "username", "password", "otp"]

  func export(_ id: String) async -> VaultExportResult {
    guard id != ArdiaVault.id, let provider = VaultRegistry.provider(id), isReady(id) else { return VaultExportResult() }
    let allowed = await VaultOwnerCheck.confirm("export your passwords")
    guard allowed else { return VaultExportResult(declined: true) }
    guard let destination = await VaultExportFile.destination("\(provider.name) Passwords.csv") else { return VaultExportResult(declined: true) }
    let listed = await items(of: provider)
    let rows = await VaultExportFile.rows(listed, stillOpen: { self.isReady(id) && !Task.isCancelled }) { item in
      let outcome = await self.secret(provider, item: item.id, field: .password, keep: false)
      var password = ""
      if case .success(let value) = outcome { password = value }
      let otp = self.cachedTotps[id]?[item.id].flatMap { $0.itemUpdatedAt == item.updatedAt ? $0.value : nil } ?? ""
      return [item.title, item.urls.first ?? "", item.username, password, otp]
    }
    guard let rows else {
      NSLog("[vaults] export stopped: %@ locked", id)
      return VaultExportResult()
    }
    guard VaultExportFile.write(VaultExportFile.csv([Self.exportColumns] + rows), to: destination) else { return VaultExportResult() }
    return VaultExportResult(saved: true, count: listed.count)
  }
}

extension VaultExportFile {
  static func destination(_ filename: String) async -> URL? {
    if LaunchConfig.shared.background {
      guard let folder = LaunchConfig.shared.dataDirectory else { return nil }
      let url = URL(fileURLWithPath: folder, isDirectory: true).appendingPathComponent(filename)
      NSLog("[vaults] export save panel (background mode, not shown), writing %@", url.path)
      return url
    }
    return await withCheckedContinuation { (done: CheckedContinuation<URL?, Never>) in
      Task { @MainActor in
        ask(filename) { done.resume(returning: $0) }
      }
    }
  }

  @MainActor
  static func ask(_ filename: String, _ chosen: @escaping (URL?) -> Void) {
    let panel = NSSavePanel()
    panel.nameFieldStringValue = filename
    panel.allowedContentTypes = [.commaSeparatedText]
    panel.canCreateDirectories = true
    panel.message = "Anyone who can open this file can read your passwords."
    panel.begin { response in chosen(response == .OK ? panel.url : nil) }
  }
}
