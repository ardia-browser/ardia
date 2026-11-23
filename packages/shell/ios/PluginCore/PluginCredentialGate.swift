import Foundation

enum PluginCredentialGate {
  enum Verdict: Equatable {
    case forward
    case reply(String)
    case drop
  }

  static let refusedMessage = "Only Ardia's official password manager plugins can use credentials requests."
  static let nativeCallPattern = #"^v[1-9][0-9]{0,15}$"#

  static func screen(_ line: String) -> Verdict {
    guard line.contains("credentials") || line.contains("\"call\"") || line.contains("\\") else { return .forward }
    guard let message = (try? JSONSerialization.jsonObject(with: Data(line.utf8))) as? [String: Any] else { return .forward }
    let method = message["method"] as? String
    if let method, method == "credentials" || method.hasPrefix("credentials.") {
      guard let id = message["id"], id is String || ((id as? NSNumber).map { CFGetTypeID($0) != CFBooleanGetTypeID() } ?? false),
        let reply = try? JSONSerialization.data(withJSONObject: ["id": id, "error": ["code": "refused", "message": refusedMessage]])
      else { return .drop }
      return .reply(String(decoding: reply, as: UTF8.self))
    }
    if method == "result", let call = (message["params"] as? [String: Any])?["call"] as? String,
      call.range(of: nativeCallPattern, options: .regularExpression) != nil
    {
      return .drop
    }
    return .forward
  }
}
