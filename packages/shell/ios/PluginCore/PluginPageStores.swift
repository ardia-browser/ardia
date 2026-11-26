import Foundation

final class PluginPageStores {
  private let file: URL?
  private let lock = NSLock()
  private var known: [String: [String]]

  init(file: URL?) {
    self.file = file
    if let file, let data = try? Data(contentsOf: file), let read = try? JSONSerialization.jsonObject(with: data) as? [String: [String]] {
      known = read.mapValues { $0.filter(Self.isKey) }
    } else {
      known = [:]
    }
  }

  static func isKey(_ key: String) -> Bool {
    (1...64).contains(key.count) && key.allSatisfy { $0.isASCII && ($0.isLetter || $0.isNumber || $0 == "-" || $0 == "_") }
  }

  func record(_ plugin: String, key: String) {
    lock.lock()
    defer { lock.unlock() }
    guard Self.isKey(key), !(known[plugin] ?? []).contains(key) else { return }
    known[plugin] = (known[plugin] ?? []) + [key]
    save()
  }

  func keys(_ plugin: String) -> [String] {
    lock.lock()
    defer { lock.unlock() }
    return known[plugin] ?? []
  }

  func forget(_ plugin: String, key: String) {
    lock.lock()
    defer { lock.unlock() }
    guard var keys = known[plugin], let at = keys.firstIndex(of: key) else { return }
    keys.remove(at: at)
    known[plugin] = keys.isEmpty ? nil : keys
    save()
  }

  private func save() {
    guard let file, let data = try? JSONSerialization.data(withJSONObject: known, options: [.sortedKeys]) else { return }
    try? FileManager.default.createDirectory(at: file.deletingLastPathComponent(), withIntermediateDirectories: true)
    try? data.write(to: file, options: .atomic)
  }
}
