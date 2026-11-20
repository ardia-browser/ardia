import Foundation

struct VaultTotp: Codable, Equatable, Sendable {
  static let defaultPeriod = 30

  var code: String
  var period: Int
  var expiresAt: Double
  var next: String?

  func jsonObject() -> [String: Any] { VaultJSON.object(self) }

  static func make(code: String, period: Int, now: Date = Date()) -> VaultTotp? {
    let trimmed = code.trimmingCharacters(in: .whitespacesAndNewlines)
    guard trimmed.count >= 4, trimmed.count <= 10, trimmed.allSatisfy({ $0.isASCII && ($0.isLetter || $0.isNumber) }) else { return nil }
    let step = max(1, period)
    let seconds = now.timeIntervalSince1970
    let expires = (floor(seconds / Double(step)) + 1) * Double(step) * 1000
    return VaultTotp(code: trimmed, period: step, expiresAt: expires)
  }

  static func period(fromURI uri: String) -> Int? {
    guard uri.contains("://") else { return nil }
    return VaultTotpSecret(uri)?.period
  }
}
