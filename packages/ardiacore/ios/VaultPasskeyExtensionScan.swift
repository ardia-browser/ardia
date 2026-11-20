import Foundation

enum VaultPasskeyExtensionScan {
  static let longestScript = 8 << 20

  static func wrapsWebAuthn(id: String, userDataDirectory: String) -> Bool {
    guard VaultPasskeyExtension.isId(id), !userDataDirectory.isEmpty else { return false }
    let files = FileManager.default
    let root = URL(fileURLWithPath: userDataDirectory)
    for profile in (try? files.contentsOfDirectory(atPath: root.path)) ?? [] {
      let installs = root.appendingPathComponent(profile).appendingPathComponent("Extensions").appendingPathComponent(id)
      for version in (try? files.contentsOfDirectory(atPath: installs.path)) ?? [] {
        if manifestWrapsWebAuthn(installs.appendingPathComponent(version)) { return true }
      }
    }
    return false
  }

  static func manifestWrapsWebAuthn(_ folder: URL) -> Bool {
    guard let data = try? Data(contentsOf: folder.appendingPathComponent("manifest.json")), data.count <= 1 << 20,
      let manifest = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
    else { return false }
    for script in manifest["content_scripts"] as? [[String: Any]] ?? [] where script["world"] as? String == "MAIN" {
      for file in script["js"] as? [String] ?? [] {
        guard !file.contains(".."), !file.hasPrefix("/") else { continue }
        let url = folder.appendingPathComponent(file)
        guard let size = try? url.resourceValues(forKeys: [.fileSizeKey]).fileSize, size <= longestScript,
          let text = try? String(contentsOf: url, encoding: .utf8)
        else { continue }
        if text.contains("navigator.credentials") || text.contains("CredentialsContainer") { return true }
      }
    }
    return false
  }
}
