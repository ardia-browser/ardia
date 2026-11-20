import Foundation

extension VaultSignInFields {
  init(json: String) {
    self.init()
    guard let object = (try? JSONSerialization.jsonObject(with: Data(json.utf8))) as? [String: Any] else { return }
    email = Self.trimmed(object["email"])
    password = VaultJSON.string(object["password"]) ?? Self.entry(object["passwordEntry"])
    code = Self.trimmed(object["code"])?.replacingOccurrences(of: " ", with: "")
    method = Self.trimmed(object["method"])
    server = Self.trimmed(object["server"])
    clientId = Self.trimmed(object["clientId"])
    clientSecret = Self.trimmed(object["clientSecret"]) ?? Self.entry(object["clientSecretEntry"]).flatMap { Self.trimmed($0) }
    account = Self.trimmed(object["account"])
  }

  private static func entry(_ value: Any?) -> String? {
    guard let token = VaultJSON.string(value) else { return nil }
    return VaultSecretEntries.value(token)
  }

  private static func trimmed(_ value: Any?) -> String? {
    guard let text = VaultJSON.string(value)?.trimmingCharacters(in: .whitespacesAndNewlines), !text.isEmpty else { return nil }
    return text
  }
}

enum VaultTypedPassword: Equatable, Sendable {
  case none
  case typed(String)
  case expired

  init(_ text: String?) {
    if VaultSecretEntries.isExpired(text) {
      self = .expired
    } else if let password = VaultSecretEntries.resolve(text) {
      self = .typed(password)
    } else {
      self = .none
    }
  }
}
