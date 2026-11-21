import ArdiaCore
import ExpoModulesCore
import Foundation
import Security

public class KeychainModule: Module {
  private static let service = "Ardia Connected Accounts"

  public func definition() -> ModuleDefinition {
    Name("ArdiaKeychain")

    AsyncFunction("get") { (account: String) -> String? in
      if let store = IsolatedSecrets.shared { return store.get(account) }
      var item: CFTypeRef?
      guard SecItemCopyMatching(Self.readQuery(account) as CFDictionary, &item) == errSecSuccess, let data = item as? Data else { return nil }
      return String(data: data, encoding: .utf8)
    }

    AsyncFunction("read") { (account: String) -> [String: Any] in
      if let store = IsolatedSecrets.shared { return store.read(account) }
      var item: CFTypeRef?
      let status = SecItemCopyMatching(Self.readQuery(account) as CFDictionary, &item)
      if status == errSecItemNotFound { return ["status": "missing"] }
      guard status == errSecSuccess else { return ["status": "error", "reason": "Keychain read failed (status \(status))"] }
      guard let data = item as? Data, let text = String(data: data, encoding: .utf8) else {
        return ["status": "error", "reason": "Keychain item isn't valid UTF-8"]
      }
      return ["status": "ok", "value": text]
    }

    AsyncFunction("set") { (account: String, secret: String) -> Bool in
      if let store = IsolatedSecrets.shared { return store.set(account, secret) }
      let data = Data(secret.utf8)
      let update: [String: Any] = [kSecValueData as String: data]
      var status = SecItemUpdate(Self.query(account) as CFDictionary, update as CFDictionary)
      if status == errSecItemNotFound {
        var add = Self.query(account)
        add[kSecValueData as String] = data
        add[kSecAttrLabel as String] = "Ardia: \(account)"
        status = SecItemAdd(add as CFDictionary, nil)
      } else if status != errSecSuccess {
        SecItemDelete(Self.query(account) as CFDictionary)
        var add = Self.query(account)
        add[kSecValueData as String] = data
        status = SecItemAdd(add as CFDictionary, nil)
      }
      return status == errSecSuccess
    }

    AsyncFunction("delete") { (account: String) -> Bool in
      if let store = IsolatedSecrets.shared { return store.set(account, nil) }
      let status = SecItemDelete(Self.query(account) as CFDictionary)
      return status == errSecSuccess || status == errSecItemNotFound
    }
  }

  private static func query(_ account: String) -> [String: Any] {
    [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service, kSecAttrAccount as String: account]
  }

  private static func readQuery(_ account: String) -> [String: Any] {
    var query = query(account)
    query[kSecReturnData as String] = true
    query[kSecMatchLimit as String] = kSecMatchLimitOne
    #if DEBUG
    query[kSecUseAuthenticationUI as String] = kSecUseAuthenticationUIFail
    #endif
    return query
  }
}

private final class IsolatedSecrets {
  static let shared = LaunchConfig.shared.dataDirectory.map {
    IsolatedSecrets(URL(fileURLWithPath: $0, isDirectory: true).appendingPathComponent("Connected Accounts.json"))
  }

  private let url: URL
  private let lock = NSLock()

  private init(_ url: URL) { self.url = url }

  private func load() -> [String: String]? {
    guard FileManager.default.fileExists(atPath: url.path) else { return [:] }
    guard let data = try? Data(contentsOf: url) else { return nil }
    return try? JSONDecoder().decode([String: String].self, from: data)
  }

  func get(_ account: String) -> String? {
    lock.lock()
    defer { lock.unlock() }
    return load()?[account]
  }

  func read(_ account: String) -> [String: Any] {
    lock.lock()
    defer { lock.unlock() }
    guard FileManager.default.fileExists(atPath: url.path) else { return ["status": "missing"] }
    guard let data = try? Data(contentsOf: url) else { return ["status": "error", "reason": "Connected Accounts file is unreadable"] }
    guard let secrets = try? JSONDecoder().decode([String: String].self, from: data) else {
      return ["status": "error", "reason": "Connected Accounts file isn't valid JSON"]
    }
    guard let value = secrets[account] else { return ["status": "missing"] }
    return ["status": "ok", "value": value]
  }

  func set(_ account: String, _ secret: String?) -> Bool {
    lock.lock()
    defer { lock.unlock() }
    guard var secrets = load() else { return false }
    secrets[account] = secret
    do {
      try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
      try JSONEncoder().encode(secrets).write(to: url, options: .atomic)
      try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: url.path)
      return true
    } catch {
      return false
    }
  }
}
