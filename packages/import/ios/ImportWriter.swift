import Foundation
import ArdiaCore

final class ImportVault: @unchecked Sendable {
  struct Entry {
    var cookies: [Cookie]
    var addresses: [ImportedAddress]
    var cards: [ImportedCard]
    var kept: Date
  }

  private static let lifetime: TimeInterval = 600
  private let lock = NSLock()
  private var entries: [String: Entry] = [:]

  func keep(cookies: [Cookie], addresses: [ImportedAddress], cards: [ImportedCard]) -> String? {
    guard !cookies.isEmpty || !addresses.isEmpty || !cards.isEmpty else { return nil }
    let token = UUID().uuidString
    lock.withLock {
      purge()
      entries[token] = Entry(cookies: cookies, addresses: addresses, cards: cards, kept: Date())
    }
    DispatchQueue.global(qos: .utility).asyncAfter(deadline: .now() + Self.lifetime + 1) { [weak self] in
      self?.lock.withLock { self?.purge() }
    }
    return token
  }

  func take(_ token: String) -> Entry? {
    lock.withLock {
      purge()
      return entries.removeValue(forKey: token)
    }
  }

  func discard(_ token: String) { _ = take(token) }
  func discardAll() { lock.withLock { entries.removeAll() } }

  private func purge() {
    let cutoff = Date().addingTimeInterval(-Self.lifetime)
    entries = entries.filter { $0.value.kept > cutoff }
  }
}

enum ImportWriter {
  @MainActor
  static func write(_ entry: ImportVault.Entry, profile: String, kinds: Set<ImportKind>, cancellation: Cancellation? = nil) async -> String {
    let body = await ImportBatchWriter.write(cookies: entry.cookies, addresses: entry.addresses, cards: entry.cards, kinds: kinds,
                                             cancellation: cancellation) { call, args in await engine(call, profile: profile, args: args) }
    let data = (try? JSONSerialization.data(withJSONObject: body)) ?? Data("{}".utf8)
    return String(decoding: data, as: UTF8.self)
  }

  @MainActor
  private static func engine(_ name: String, profile: String, args: SecretBytes) async -> [String: Any] {
    let data = args.withUnsafeBytes { NSMutableData(bytes: $0.baseAddress, length: $0.count) }
    args.wipe()
    let json: String = await withCheckedContinuation { done in
      ArdiaEngineBridge.callWithSecret(name, profile: profile, args: data) { done.resume(returning: $0) }
    }
    let parsed = try? JSONSerialization.jsonObject(with: Data(json.utf8))
    return parsed as? [String: Any] ?? ["error": "bad reply from the engine"]
  }
}
