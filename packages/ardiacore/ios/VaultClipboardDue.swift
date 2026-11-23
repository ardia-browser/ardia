import Foundation

enum VaultClipboardDue: Equatable, Sendable {
  case keep, clear, forget

  static func decide(placedCount: Int, deadline: Date, currentCount: Int, now: Date, quitting: Bool) -> VaultClipboardDue {
    guard currentCount == placedCount else { return .forget }
    return quitting || now >= deadline ? .clear : .keep
  }
}
