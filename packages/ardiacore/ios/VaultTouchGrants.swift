import Foundation

struct VaultHandOn: Sendable, Equatable {
  let tab: String
  let origin: String

  init?(tab: String?, origin: String?) {
    guard let tab, let origin, !tab.isEmpty, !origin.isEmpty else { return nil }
    self.tab = tab
    self.origin = origin
  }
}

struct VaultTouchGrants: Sendable {
  static let lifetime: TimeInterval = 10
  private static let fillKind = "fill"
  private static let handOnKind = "fill-hand-on"
  private static let unlockKind = "unlock"
  private static let passkeyKind = "passkey"
  private static let cardKind = "autofill-card"

  private var scope: String?
  private var grantedAt: Date?

  static func fill(provider: String, item: String, origin: String, tab: String) -> String {
    [fillKind, provider, item, origin, tab].joined(separator: "\n")
  }

  static func handOn(provider: String, origin: String, tab: String) -> String? {
    let parts = [provider, origin, tab]
    guard parts.allSatisfy({ !$0.isEmpty && !$0.contains("\n") }) else { return nil }
    return ([handOnKind] + parts).joined(separator: "\n")
  }

  static func unlock(provider: String) -> String { [unlockKind, provider].joined(separator: "\n") }

  static func passkey(request: String, credential: String) -> String { [passkeyKind, request, credential].joined(separator: "\n") }

  static func card(card: String, tab: String) -> String { [cardKind, card, tab].joined(separator: "\n") }

  static func isUnlock(_ scope: String) -> Bool { scope.hasPrefix(unlockKind + "\n") }

  var isHeld: Bool { scope != nil }

  mutating func grant(_ scope: String, at now: Date) {
    guard !scope.isEmpty else { return drop() }
    self.scope = scope
    grantedAt = now
  }

  mutating func drop() {
    scope = nil
    grantedAt = nil
  }

  mutating func take(_ wanted: String, at now: Date) -> Bool {
    guard let scope, let grantedAt, !wanted.isEmpty else { return false }
    let age = now.timeIntervalSince(grantedAt)
    guard age >= 0, age < Self.lifetime else {
      drop()
      return false
    }
    guard Self.covers(scope, wanted) else { return false }
    drop()
    return true
  }

  private static func covers(_ scope: String, _ wanted: String) -> Bool {
    if scope == wanted { return !scope.hasPrefix(handOnKind + "\n") }
    let held = scope.split(separator: "\n", omittingEmptySubsequences: false)
    let fill = wanted.split(separator: "\n", omittingEmptySubsequences: false)
    guard held.count == 4, held[0] == handOnKind, fill.count == 5, fill[0] == fillKind, !fill[2].isEmpty else { return false }
    return fill[1] == held[1] && fill[3] == held[2] && fill[4] == held[3]
  }
}

struct VaultPresence<Context: AnyObject> {
  static var lifetime: Duration { .seconds(30) }

  private(set) var confirmedAt: ContinuousClock.Instant?
  private var context: Context?

  func isRecent(at now: ContinuousClock.Instant) -> Bool {
    guard let confirmedAt, now >= confirmedAt else { return false }
    return now - confirmedAt < Self.lifetime
  }

  func context(at now: ContinuousClock.Instant) -> Context? { isRecent(at: now) ? context : nil }

  mutating func confirm(at now: ContinuousClock.Instant, context fresh: Context?) -> Context? {
    let replaced = context === fresh ? nil : context
    confirmedAt = now
    context = fresh
    return replaced
  }

  mutating func clear() -> Context? {
    let held = context
    confirmedAt = nil
    context = nil
    return held
  }
}
