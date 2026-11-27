import ArdiaDesign
import Foundation

enum UsageConsent {
  private static let defaults = UserDefaults(suiteName: "ardia-usage-consent") ?? .standard
  private static let sharingKey = "sharing"
  private static let generationKey = "generation"
  private static let sinceKey = "since"
  static let lock = NSLock()

  static func set(sharing: Bool) {
    lock.withLock {
      if sharing, defaults.object(forKey: sinceKey) == nil { defaults.set(Date().timeIntervalSince1970 * 1000, forKey: sinceKey) }
      if defaults.object(forKey: generationKey) != nil, defaults.bool(forKey: sharingKey) == sharing { return }
      defaults.set(sharing, forKey: sharingKey)
      defaults.set(defaults.integer(forKey: generationKey) + 1, forKey: generationKey)
      if sharing { defaults.set(Date().timeIntervalSince1970 * 1000, forKey: sinceKey) }
      if !sharing {
        PendingCounts.clearLocked()
        PhoneExits.clearLocked()
      }
    }
  }

  static func state() -> (sharing: Bool, generation: Int) {
    lock.withLock { (defaults.bool(forKey: sharingKey), defaults.integer(forKey: generationKey)) }
  }

  static func sharingSinceLocked() -> Double? {
    guard defaults.bool(forKey: sharingKey), defaults.object(forKey: sinceKey) != nil else { return nil }
    let since = defaults.double(forKey: sinceKey)
    return since > 0 ? since : nil
  }

  static func windowLocked() -> Int? {
    defaults.bool(forKey: sharingKey) ? defaults.integer(forKey: generationKey) : nil
  }
}

enum PendingCounts {
  static let glassShadersFailed = "glass_shaders_failed"
  static let glassCapturesOverBudget = "glass_captures_over_budget"
  static let glassLensBridged = "glass_lens_bridged"
  static let glassLensWithheld = "glass_lens_withheld"
  private static let suite = "ardia-pending-counts"
  private static let defaults = UserDefaults(suiteName: suite) ?? .standard

  static func add(_ field: String, by count: Int = 1) {
    UsageConsent.lock.withLock {
      guard UsageConsent.windowLocked() != nil else { return }
      defaults.set(defaults.integer(forKey: field) + count, forKey: field)
    }
  }

  static func add(_ field: String, sampledWindow: Int?) {
    UsageConsent.lock.withLock {
      guard LiquidGlassRules.countsIn(sampledWindow: sampledWindow, currentWindow: UsageConsent.windowLocked()) else { return }
      defaults.set(defaults.integer(forKey: field) + 1, forKey: field)
    }
  }

  static func peek() -> [String: Int] {
    UsageConsent.lock.withLock { allLocked() }
  }

  static func take() -> [String: Int] {
    UsageConsent.lock.withLock {
      let taken = allLocked()
      clearLocked()
      return taken
    }
  }

  fileprivate static func clearLocked() {
    defaults.removePersistentDomain(forName: suite)
  }

  private static func allLocked() -> [String: Int] {
    var counts: [String: Int] = [:]
    for (key, value) in defaults.persistentDomain(forName: suite) ?? [:] {
      if let number = value as? Int, number > 0 { counts[key] = number }
    }
    return counts
  }
}
