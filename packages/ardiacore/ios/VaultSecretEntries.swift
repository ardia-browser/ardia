import Foundation
import os

enum VaultSecretEntries {
  static let prefix = "entry-"
  static let mostEntries = 16
  static let longestValue = 4096

  private struct Held {
    var values: [String: String] = [:]
    var order: [String] = []
  }

  private static let held = OSAllocatedUnfairLock(initialState: Held())

  static func isToken(_ text: String) -> Bool { text.hasPrefix(prefix) && text.count <= 64 }

  static func set(_ token: String, _ value: String) {
    guard isToken(token) else { return }
    let kept = value.count > longestValue ? String(value.prefix(longestValue)) : value
    held.withLock { held in
      if held.values[token] == nil {
        while held.order.count >= mostEntries { held.values[held.order.removeFirst()] = nil }
        held.order.append(token)
      }
      held.values[token] = kept
    }
  }

  static func value(_ token: String) -> String? {
    guard isToken(token) else { return nil }
    return held.withLock { $0.values[token].flatMap { $0.isEmpty ? nil : $0 } }
  }

  static func resolve(_ text: String?) -> String? {
    guard let text else { return nil }
    guard isToken(text) else { return text }
    return value(text)
  }

  static func isExpired(_ text: String?) -> Bool {
    guard let text, isToken(text) else { return false }
    return held.withLock { $0.values[text] == nil }
  }

  static func drop(_ token: String) {
    held.withLock { held in
      held.values[token] = nil
      held.order.removeAll { $0 == token }
    }
  }

  static func dropAll() {
    held.withLock { $0 = Held() }
  }
}
