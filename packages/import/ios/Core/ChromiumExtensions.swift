import Foundation

public struct ImportedExtension: Codable, Equatable, Sendable {
  public enum Skip: String, Codable, Sendable {
    case manifestV2, unpacked, policy, external, notWebStore
  }

  public var id: String
  public var name: String
  public var webStoreUrl: String
  public var enabled: Bool
  public var pinnedIndex: Int?
  public var skip: Skip?
}

public enum ChromiumExtensions {
  static let uBlockOrigin = "cjpalhdlnbpafiamejdnhcphjbkeiagm"
  static let uBlockOriginLite = "ddkjiahejlhfcafbddmgiahcphecmpfh"
  static let notOffered: Set<String> = [uBlockOrigin, uBlockOriginLite]

  static let internalLocation = 1
  static let unpackedLocations: Set<Int> = [4, 8]
  static let policyLocations: Set<Int> = [7, 9]
  static let externalLocations: Set<Int> = [2, 3, 6]
  static let componentLocations: Set<Int> = [5, 10]

  static let userAction = 1 << 0
  static let unsupportedManifestVersion = 1 << 23

  public static func list(profile: URL) -> [ImportedExtension] {
    var settings: [String: Any] = [:]
    var pinned: [String] = []
    for file in ["Preferences", "Secure Preferences"] {
      guard let data = try? Data(contentsOf: profile.appendingPathComponent(file)),
            let root = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
            let extensions = root["extensions"] as? [String: Any] else { continue }
      if let ids = extensions["pinned_extensions"] as? [String] { pinned = ids }
      guard let found = extensions["settings"] as? [String: Any] else { continue }
      settings.merge(found) { old, new in
        guard var a = old as? [String: Any], let b = new as? [String: Any] else { return new }
        a.merge(b) { $1 }
        return a
      }
    }
    var out: [ImportedExtension] = []
    for (id, value) in settings {
      guard isExtensionId(id), !notOffered.contains(id), let entry = value as? [String: Any] else { continue }
      let location = jsonInt(entry["location"])
      if let location, componentLocations.contains(location) { continue }
      let (manifest, folder) = manifest(entry: entry, profile: profile, unpacked: location.map(unpackedLocations.contains) ?? false)
      if manifest?["theme"] != nil || manifest?["app"] != nil { continue }
      let reasons = disableReasons(entry)
      out.append(ImportedExtension(
        id: id,
        name: name(manifest: manifest, folder: folder) ?? id,
        webStoreUrl: "https://chromewebstore.google.com/detail/\(id)",
        enabled: !reasons.contains(userAction),
        pinnedIndex: pinned.firstIndex(of: id),
        skip: skip(location: location, entry: entry, manifest: manifest, reasons: reasons)))
    }
    return out.sorted { $0.name.localizedCaseInsensitiveCompare($1.name) == .orderedAscending }
  }

  static func skip(location: Int?, entry: [String: Any], manifest: [String: Any]?, reasons: Set<Int>) -> ImportedExtension.Skip? {
    guard let location else { return .notWebStore }
    if unpackedLocations.contains(location) { return .unpacked }
    if policyLocations.contains(location) { return .policy }
    if externalLocations.contains(location) { return .external }
    if location != internalLocation || jsonBool(entry["from_webstore"]) != true { return .notWebStore }
    if jsonInt(manifest?["manifest_version"]) == 2 || reasons.contains(unsupportedManifestVersion) { return .manifestV2 }
    return nil
  }

  static func disableReasons(_ entry: [String: Any]) -> Set<Int> {
    if let list = entry["disable_reasons"] as? [Any] { return Set(list.compactMap(jsonInt)) }
    if let mask = jsonInt(entry["disable_reasons"]), mask != 0 {
      return Set((0..<31).map { 1 << $0 }.filter { mask & $0 != 0 })
    }
    return jsonInt(entry["state"]) == 0 ? [userAction] : []
  }

  static func jsonBool(_ value: Any?) -> Bool? {
    guard let number = value as? NSNumber, CFGetTypeID(number) == CFBooleanGetTypeID() else { return nil }
    return number.boolValue
  }

  static func jsonInt(_ value: Any?) -> Int? {
    guard let number = value as? NSNumber, CFGetTypeID(number) != CFBooleanGetTypeID(), CFNumberIsFloatType(number) == false else { return nil }
    return number.intValue
  }

  static func isExtensionId(_ id: String) -> Bool {
    id.count == 32 && id.allSatisfy { ("a"..."p").contains($0) }
  }

  static func manifest(entry: [String: Any], profile: URL, unpacked: Bool) -> ([String: Any]?, URL?) {
    var manifest = entry["manifest"] as? [String: Any]
    guard let path = entry["path"] as? String, !path.contains("..") else { return (manifest, nil) }
    let folder: URL
    if path.hasPrefix("/") {
      guard unpacked else { return (manifest, nil) }
      folder = URL(fileURLWithPath: path, isDirectory: true)
    } else {
      folder = profile.appendingPathComponent("Extensions").appendingPathComponent(path, isDirectory: true)
    }
    if manifest == nil, let data = try? Data(contentsOf: folder.appendingPathComponent("manifest.json")) {
      manifest = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
    }
    return (manifest, folder)
  }

  static func name(manifest: [String: Any]?, folder: URL?) -> String? {
    guard let raw = (manifest?["name"] as? String)?.trimmingCharacters(in: .whitespaces), !raw.isEmpty else { return nil }
    guard raw.hasPrefix("__MSG_"), raw.hasSuffix("__") else { return raw }
    let key = String(raw.dropFirst(6).dropLast(2)).lowercased()
    guard let folder, let locale = manifest?["default_locale"] as? String,
          let data = try? Data(contentsOf: folder.appendingPathComponent("_locales/\(locale)/messages.json")),
          let messages = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return nil }
    let match = messages.first { $0.key.lowercased() == key }?.value as? [String: Any]
    return (match?["message"] as? String).flatMap { $0.isEmpty ? nil : $0 }
  }
}
