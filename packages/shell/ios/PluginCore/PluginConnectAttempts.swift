import Foundation

struct PluginConnectAttempts {
  static let fallbackAfter: TimeInterval = 3

  let addresses: [String]
  let deadline: TimeInterval
  private(set) var tried = 0
  private var lastFailure: String?

  init(addresses: [String], deadline: TimeInterval) {
    self.addresses = addresses
    self.deadline = deadline
  }

  mutating func next(now: TimeInterval) -> (address: String, timeout: TimeInterval)? {
    let remaining = deadline - now
    guard tried < addresses.count, remaining > 0 else { return nil }
    let address = addresses[tried]
    tried += 1
    let isLast = tried == addresses.count
    return (address, isLast ? remaining : min(remaining, Self.fallbackAfter))
  }

  mutating func failed(reason: String) {
    lastFailure = reason
  }

  var failureReason: String {
    let reason = lastFailure ?? "it timed out"
    return tried > 1 ? "none of its \(tried) addresses answered (\(reason))" : reason
  }
}
