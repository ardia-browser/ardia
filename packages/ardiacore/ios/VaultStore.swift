import CryptoKit
import Foundation

final class VaultStore {
  static let shared = VaultStore()

  struct AlwaysGrant: Codable, Equatable {
    let profile: String
    let origin: String
    let teamId: String
    let identifier: String
    let program: String
    let added: Double
  }

  private struct Contents: Codable {
    var version = 1
    var codes: [String: VerificationCode] = [:]
    var always: [AlwaysGrant] = []
  }

  static let idleSeconds = 300.0

  let queue = DispatchQueue(label: "ardia.vault", qos: .userInitiated)
  private var key: SymmetricKey?
  private var contents: Contents?
  private var eviction: DispatchWorkItem?
  private(set) var problem: String?
  private(set) var unlockMs: Double = 0

  private var folder: URL { URL(fileURLWithPath: ArdiaHost.dataDirectory).appendingPathComponent("Ardia Vault", isDirectory: true) }
  private var keyURL: URL { folder.appendingPathComponent("vault-key.json") }
  private var sealedURL: URL { folder.appendingPathComponent("vault.sealed") }
  var activityURL: URL { folder.appendingPathComponent("activity.jsonl") }

  static func codeKey(_ profile: String, _ origin: String, _ username: String) -> String { "\(profile)\n\(origin)\n\(username)" }

  private var software: Bool { LaunchConfig.shared.testValue("vaultKey") == "software" }

  func ensureFolder() {
    try? FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
  }

  private enum Read {
    case absent
    case data(Data)
    case failed
  }

  private func read(_ url: URL) -> Read {
    guard FileManager.default.fileExists(atPath: url.path) else { return .absent }
    guard let data = try? Data(contentsOf: url) else { return .failed }
    return .data(data)
  }

  private func setAside(_ urls: [URL]) {
    let stamp = "\(Int(Date().timeIntervalSince1970))-\(UUID().uuidString.prefix(8))"
    for url in urls where FileManager.default.fileExists(atPath: url.path) {
      try? FileManager.default.moveItem(at: url, to: url.appendingPathExtension("unreadable-\(stamp)"))
    }
  }

  private func keepWarm() {
    eviction?.cancel()
    let drop = DispatchWorkItem { [weak self] in
      self?.key = nil
      self?.contents = nil
    }
    eviction = drop
    queue.asyncAfter(deadline: .now() + Self.idleSeconds, execute: drop)
  }

  private func load() -> Bool {
    if contents != nil {
      keepWarm()
      return true
    }
    let started = DispatchTime.now().uptimeNanoseconds
    defer { unlockMs = Double(DispatchTime.now().uptimeNanoseconds - started) / 1_000_000 }
    switch read(keyURL) {
    case .failed:
      problem = "retry"
      return false
    case .absent:
      setAside([sealedURL])
      key = nil
    case .data(let data):
      guard let file = try? JSONDecoder().decode(VaultKey.File.self, from: data) else {
        setAside([keyURL, sealedURL])
        problem = "unrecoverable"
        key = nil
        contents = Contents()
        keepWarm()
        return true
      }
      switch VaultKey.restore(file, software: software) {
      case .retry:
        problem = "retry"
        return false
      case .unreadable:
        setAside([keyURL, sealedURL])
        problem = "unrecoverable"
        key = nil
      case .key(let restored):
        key = restored
      }
    }
    var opened = Contents()
    if let key {
      switch read(sealedURL) {
      case .failed:
        self.key = nil
        problem = "retry"
        return false
      case .absent:
        break
      case .data(let sealed):
        if let box = try? AES.GCM.SealedBox(combined: sealed), let plain = try? AES.GCM.open(box, using: key), let decoded = try? JSONDecoder().decode(Contents.self, from: plain), decoded.version == 1 {
          opened = decoded
        } else {
          setAside([sealedURL])
          problem = "unreadable"
        }
      }
    }
    if problem == "retry" { problem = nil }
    contents = opened
    keepWarm()
    return true
  }

  private func persist(_ next: Contents) -> Bool {
    if key == nil {
      ensureFolder()
      guard let (file, made) = VaultKey.make(software: software) else {
        problem = "unavailable"
        return false
      }
      guard let data = try? JSONEncoder().encode(file), (try? data.write(to: keyURL, options: [.atomic])) != nil else { return false }
      try? FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: keyURL.path)
      key = made
      problem = nil
    }
    guard let key, let plain = try? JSONEncoder().encode(next), let sealed = try? AES.GCM.seal(plain, using: key).combined else { return false }
    ensureFolder()
    guard (try? sealed.write(to: sealedURL, options: [.atomic])) != nil else { return false }
    try? FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: sealedURL.path)
    contents = next
    return true
  }

  private func change(_ edit: (inout Contents) -> Bool) -> Bool {
    guard load(), var next = contents else { return false }
    guard edit(&next) else { return true }
    return persist(next)
  }

  func warm() -> Bool { load() }

  func state() -> [String: Any] {
    let ready = load()
    return ["ready": ready, "problem": problem as Any? ?? NSNull(), "unlockMs": unlockMs, "secureEnclave": SecureEnclave.isAvailable, "kind": software ? "software" : "secureEnclave"]
  }

  func saveCode(_ code: VerificationCode, profile: String, origin: String, username: String) -> Bool {
    change { $0.codes[Self.codeKey(profile, origin, username)] = code; return true }
  }

  func removeCode(profile: String, origin: String, username: String) -> Bool {
    change { $0.codes.removeValue(forKey: Self.codeKey(profile, origin, username)) != nil }
  }

  func code(profile: String, origin: String, username: String) -> VerificationCode? {
    load() ? contents?.codes[Self.codeKey(profile, origin, username)] : nil
  }

  func codes(profile: String) -> [[String: String]] {
    guard load(), let contents else { return [] }
    return contents.codes.keys.compactMap { key in
      let parts = key.components(separatedBy: "\n")
      guard parts.count == 3, parts[0] == profile else { return nil }
      return ["origin": parts[1], "username": parts[2]]
    }
  }

  func always() -> [AlwaysGrant] {
    load() ? contents?.always ?? [] : []
  }

  func setAlways(_ grant: AlwaysGrant, on: Bool) -> Bool {
    change { contents in
      contents.always.removeAll { $0.profile == grant.profile && $0.origin == grant.origin && $0.teamId == grant.teamId && $0.identifier == grant.identifier }
      if on { contents.always.append(grant) }
      return true
    }
  }
}
