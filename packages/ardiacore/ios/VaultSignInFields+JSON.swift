import Foundation

extension VaultSignInFields {
  static let longestValue = 4096
  static let mostFields = 16

  init(json: String) {
    self.init()
    guard let object = (try? JSONSerialization.jsonObject(with: Data(json.utf8))) as? [String: Any] else { return }
    method = Self.trimmed(object["method"])
    server = Self.trimmed(object["server"])
    values = Self.table(object["values"]).compactMapValues { Self.trimmed($0) }
    secrets = Self.table(object["secrets"]).compactMapValues { value in
      guard let token = value as? String, VaultSecretEntries.isToken(token) else { return nil }
      return token
    }
  }

  init(answer json: String) {
    self.init()
    guard let object = (try? JSONSerialization.jsonObject(with: Data(json.utf8))) as? [String: Any], let need = Self.trimmed(object["need"]) else { return }
    let token = (object["entryToken"] as? String).flatMap { VaultSecretEntries.isToken($0) ? $0 : nil }
    answer = VaultSignInAnswer(
      need: need, value: Self.trimmed(object["value"]), entryToken: token, methodId: Self.trimmed(object["methodId"]), accountId: Self.trimmed(object["accountId"]))
  }

  private static func table(_ value: Any?) -> [String: Any] {
    guard let table = value as? [String: Any], table.count <= mostFields else { return [:] }
    return table.filter { $0.key.range(of: #"^[A-Za-z0-9_-]{1,40}$"#, options: .regularExpression) != nil }
  }

  private static func trimmed(_ value: Any?) -> String? {
    guard let text = (value as? String)?.trimmingCharacters(in: .whitespacesAndNewlines), !text.isEmpty, text.utf8.count <= longestValue else { return nil }
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
