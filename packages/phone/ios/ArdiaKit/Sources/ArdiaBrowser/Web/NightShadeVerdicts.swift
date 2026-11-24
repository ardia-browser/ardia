import Foundation

@MainActor
public final class NightShadeVerdicts {
  static let key = "browsing.nightShadeVerdicts"
  static let limit = 300

  struct Entry: Codable, Equatable {
    var host: String
    var verdict: NightShadeVerdict
    var recorded: Date
  }

  private let defaults: UserDefaults
  private let now: () -> Date
  private var entries: [Entry]
  private var privateVerdicts: [String: NightShadeVerdict] = [:]

  public init(defaults: UserDefaults, now: @escaping () -> Date = Date.init) {
    self.defaults = defaults
    self.now = now
    entries = defaults.data(forKey: Self.key).flatMap { try? JSONDecoder().decode([Entry].self, from: $0) } ?? []
  }

  var count: Int { entries.count }

  public func verdict(for host: String?, isPrivate: Bool = false) -> NightShadeVerdict? {
    guard let key = Self.normalized(host) else { return nil }
    if isPrivate, let verdict = privateVerdicts[key] { return verdict }
    return entries.last { $0.host == key }?.verdict
  }

  public func record(_ verdict: NightShadeVerdict, for host: String?, isPrivate: Bool = false) {
    guard let key = Self.normalized(host) else { return }
    if isPrivate {
      privateVerdicts[key] = verdict
      return
    }
    entries.removeAll { $0.host == key }
    entries.append(Entry(host: key, verdict: verdict, recorded: now()))
    if entries.count > Self.limit { entries.removeFirst(entries.count - Self.limit) }
    save()
  }

  public func clear(since date: Date? = nil) {
    privateVerdicts.removeAll()
    let kept = date.map { since in entries.filter { $0.recorded < since } } ?? []
    guard kept != entries else { return }
    entries = kept
    save()
  }

  public func endPrivateBrowsing() {
    privateVerdicts.removeAll()
  }

  private func save() {
    if entries.isEmpty {
      defaults.removeObject(forKey: Self.key)
    } else if let data = try? JSONEncoder().encode(entries) {
      defaults.set(data, forKey: Self.key)
    }
  }

  static func normalized(_ host: String?) -> String? {
    guard let host else { return nil }
    let key = BlockingSettings.normalize(host)
    return key.isEmpty ? nil : key
  }
}
