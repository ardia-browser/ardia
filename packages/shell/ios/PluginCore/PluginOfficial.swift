import Foundation

struct OfficialProof: Equatable {
  let platform: String
  let signature: String
}

enum PluginOfficial {
  static let domain = "ardia-official-native-v1\n"
  static let scopePrefix = "@ardia/"
  static let builtInKeys: [String: String] = [:]
  static let platforms: Set<String> = ["universal", "macos-arm64", "macos-x64", "linux-x64", "linux-arm64", "windows-x64"]
  private static let keyed = try! NSRegularExpression(pattern: "^([A-Za-z0-9._:-]{1,128})=([\\s\\S]+)$")
  private static let versionCharacters = CharacterSet(charactersIn: "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789.+-")
  private static let idCharacters = CharacterSet(charactersIn: "abcdefghijklmnopqrstuvwxyz0123456789-@/")

  static func keys(override: String?) -> [String] {
    guard let override, !override.isEmpty else { return Array(builtInKeys.values) }
    let parsed = override.split(separator: ",").map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }.filter { !$0.isEmpty }.map { part -> String in
      let whole = NSRange(part.startIndex..., in: part)
      if let found = keyed.firstMatch(in: part, range: whole), let value = Range(found.range(at: 2), in: part) {
        let key = part[value].trimmingCharacters(in: .whitespacesAndNewlines)
        if key.count >= 40 { return key }
      }
      return part
    }
    return parsed.isEmpty ? Array(builtInKeys.values) : parsed
  }

  static func message(id: String, version: String, platform: String, sha256: String) -> Data? {
    guard id.hasPrefix(scopePrefix), id.unicodeScalars.allSatisfy(idCharacters.contains), platforms.contains(platform), PluginStore.isSha(sha256), !version.isEmpty, version.count <= 64,
      version.unicodeScalars.allSatisfy(versionCharacters.contains)
    else { return nil }
    return Data("\(domain){\"id\":\"\(id)\",\"platform\":\"\(platform)\",\"sha256\":\"\(sha256)\",\"v\":1,\"version\":\"\(version)\"}".utf8)
  }

  static func keyText(_ given: String) -> String {
    guard given.contains("-----BEGIN") else { return given }
    return given.split(whereSeparator: \.isNewline).filter { !$0.hasPrefix("-----") }.joined()
  }

  static func verify(id: String, version: String, sha256: String, proof: OfficialProof, keys: [String]) -> Bool {
    guard let message = message(id: id, version: version, platform: proof.platform, sha256: sha256), proof.signature.count == 86 else { return false }
    return keys.contains { PluginSignatures.verify(publicKey: keyText($0), signature: proof.signature, data: message) }
  }
}
