import Foundation

enum PackedFollowUp {
  @MainActor
  static func settle<Key: Hashable>(
    _ keys: [Key],
    packed: [[String]?],
    owner: String,
    work: SharedWork<Key, [String]>,
    retries: SharedWork<Key, [String]>,
    unchanged: (Key, [String]) -> Bool,
    alone: @escaping @MainActor (Key) async -> [String]?,
    again: @escaping @MainActor (Key, [String]) async -> [String]?
  ) async -> [[String]?] {
    var out: [[String]?] = []
    for (i, key) in keys.enumerated() {
      let parts = packed.indices.contains(i) ? packed[i] : nil
      if let parts, !unchanged(key, parts) {
        out.append(parts)
        continue
      }
      if let parts {
        out.append(await retries.value(for: key, owner: owner) { await again(key, parts) } ?? parts)
      } else {
        out.append(await work.value(for: key, owner: owner) { await alone(key) })
      }
    }
    return out
  }
}
