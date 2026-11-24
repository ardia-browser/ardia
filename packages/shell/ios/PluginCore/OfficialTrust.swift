import Foundation

enum OfficialTrust {
  static func trustedActive(_ store: OfficialStore, _ entry: OfficialPinEntry) -> OfficialCopy? {
    guard let active = store.active(entry.name), entry.trusts(active.sha) else { return nil }
    return active
  }

  static func copy(_ store: OfficialStore, name: String, folderId: String, pin: OfficialPin?, fresh: Bool = false) -> OfficialCopy? {
    guard let sha = OfficialPin.sha(ofFolderId: folderId), let entry = pin?.entry(name), entry.trusts(sha) else { return nil }
    return store.copy(name, sha: sha, fresh: fresh)
  }

  static func bundledCopyHolds(_ folder: String, digests: Set<String>) -> Bool {
    guard !digests.isEmpty, let digest = BundledCopyVerification.shared.digest(folder) else { return false }
    return digests.contains(digest)
  }
}

final class BundledCopyVerification {
  static let shared = BundledCopyVerification()

  private let lock = NSLock()
  private var known: [String: (stamp: [[Int64]], digest: String)] = [:]

  func digest(_ folder: String) -> String? {
    guard PluginPrograms.isRealFolder(folder), let stamp = OfficialVerification.treeStamp(folder) else { return forget(folder) }
    lock.lock()
    if let seen = known[folder], seen.stamp == stamp {
      lock.unlock()
      return seen.digest
    }
    lock.unlock()
    guard let digest = PluginPrograms.payloadDigest(folder), OfficialVerification.treeStamp(folder) == stamp else { return forget(folder) }
    lock.lock()
    known[folder] = (stamp, digest)
    lock.unlock()
    return digest
  }

  @discardableResult
  private func forget(_ folder: String) -> String? {
    lock.lock()
    known.removeValue(forKey: folder)
    lock.unlock()
    return nil
  }

  func forgetAll() {
    lock.lock()
    known.removeAll()
    lock.unlock()
  }
}
