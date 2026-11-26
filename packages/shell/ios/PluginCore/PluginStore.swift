import Darwin
import Foundation

struct StoreCopy: Equatable {
  let key: String
  let entry: String
  let sha: String
  let path: String
  let payloadDigest: String

  var folderId: String { PluginStore.folderId(sha) }
  var version: String { String(entry.dropLast(PluginStore.shaTag + 1)) }
}

struct PluginStore {
  static let activeName = "active"
  static let previousName = "previous"
  static let archiveSuffix = ".tar.gz"
  static let officialSuffix = ".official"
  static let quarantineName = "com.apple.quarantine"
  static let folderPrefix = "store-"
  static let shaTag = 12
  static let staleSeconds = 3600
  static let keptCandidates = 2
  private static let shaPattern = try! NSRegularExpression(pattern: "^[0-9a-f]{64}$")
  private static let versionCharacters = CharacterSet(charactersIn: "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789.+-")

  let root: String
  var moveFolder: (String, String) -> Int32 = { renamex_np($0, $1, UInt32(RENAME_EXCL)) }

  static func folderId(_ sha: String) -> String { folderPrefix + sha }

  static func sha(ofFolderId folderId: String) -> String? {
    guard folderId.hasPrefix(folderPrefix) else { return nil }
    let sha = String(folderId.dropFirst(folderPrefix.count))
    return isSha(sha) ? sha : nil
  }

  static func isSha(_ text: String) -> Bool {
    let whole = NSRange(text.startIndex..., in: text)
    return shaPattern.firstMatch(in: text, range: whole)?.range == whole
  }

  static func parts(_ key: String) -> (scope: String, name: String)? {
    guard PluginPrograms.isKey(key), let split = key.range(of: "__") else { return nil }
    return (String(key[..<split.lowerBound]), String(key[split.upperBound...]))
  }

  static func id(_ key: String) -> String? { parts(key).map { "@\($0.scope)/\($0.name)" } }

  static func entryName(version: String, sha: String) -> String? {
    guard isSha(sha), !version.isEmpty, version.count <= 64, version.unicodeScalars.allSatisfy(versionCharacters.contains), !version.hasPrefix("."), !version.hasPrefix("-") else { return nil }
    return "\(version)-\(sha.prefix(shaTag))"
  }

  func scopeFolder(_ key: String) -> String? { Self.parts(key).map { (root as NSString).appendingPathComponent("@\($0.scope)") } }

  func pluginFolder(_ key: String) -> String? {
    guard let parts = Self.parts(key), let scope = scopeFolder(key) else { return nil }
    return (scope as NSString).appendingPathComponent(parts.name)
  }

  func keys() -> [String] {
    let scopes = ((try? FileManager.default.contentsOfDirectory(atPath: root)) ?? []).filter { $0.hasPrefix("@") }
    return scopes.flatMap { scope -> [String] in
      let folder = (root as NSString).appendingPathComponent(scope)
      guard PluginPrograms.isRealFolder(folder) else { return [] }
      return ((try? FileManager.default.contentsOfDirectory(atPath: folder)) ?? []).map { "\(scope.dropFirst())__\($0)" }.filter(PluginPrograms.isKey)
    }.sorted()
  }

  func lock(_ key: String) -> Int32? {
    guard PluginPrograms.isKey(key), PluginPrograms.realFolder(root, creating: true) != nil else { return nil }
    let fd = open((root as NSString).appendingPathComponent(".\(key).lock"), O_RDWR | O_CREAT | O_CLOEXEC | O_NOFOLLOW, 0o600)
    guard fd >= 0 else { return nil }
    guard flock(fd, LOCK_EX) == 0 else {
      close(fd)
      return nil
    }
    return fd
  }

  func withLock<T>(_ key: String, _ body: () -> T) -> T? {
    guard let held = lock(key) else { return nil }
    defer { close(held) }
    return body()
  }

  func makeScratch(_ key: String, prefix: String) -> String? {
    guard let pluginFolder = pluginFolder(key), let folder = PluginPrograms.realFolder(pluginFolder, creating: true), PluginPrograms.hasPrivateAncestry(folder) else { return nil }
    let path = (folder as NSString).appendingPathComponent("\(prefix)\(getpid())-\(UInt32.random(in: 0...UInt32.max))")
    return mkdir(path, 0o700) == 0 ? path : nil
  }

  private func entries(_ key: String) -> [String] {
    guard let folder = pluginFolder(key), PluginPrograms.isRealFolder(folder) else { return [] }
    return ((try? FileManager.default.contentsOfDirectory(atPath: folder)) ?? []).filter { !$0.hasPrefix(".") && $0 != Self.activeName && $0 != Self.previousName && !$0.hasSuffix(Self.archiveSuffix) }
  }

  private func entry(_ key: String, sha: String) -> String? {
    entries(key).first { $0.hasSuffix("-\(sha.prefix(Self.shaTag))") }
  }

  func copy(_ key: String, sha: String, fresh: Bool = false) -> StoreCopy? {
    guard let parts = Self.parts(key), Self.isSha(sha), let folder = pluginFolder(key), let name = entry(key, sha: sha) else { return nil }
    let path = (folder as NSString).appendingPathComponent(name)
    let archive = path + Self.archiveSuffix
    guard PluginPrograms.isRealFolder(path), PluginPrograms.hasPrivateAncestry(folder), isArchive(archive), PluginPrograms.isSealed(path, keepingRootWritable: false),
      let digest = StoreVerification.shared.digest(archive: archive, sha: sha, copy: path, top: parts.name, scratch: folder, fresh: fresh)
    else { return nil }
    return StoreCopy(key: key, entry: name, sha: sha, path: path, payloadDigest: digest)
  }

  private func linked(_ key: String, _ name: String) -> StoreCopy? {
    guard let folder = pluginFolder(key), let target = PluginPrograms.linkTarget((folder as NSString).appendingPathComponent(name)), !target.contains("/"),
      let sha = shaOf(key, entry: target)
    else { return nil }
    return copy(key, sha: sha)
  }

  private func shaOf(_ key: String, entry name: String) -> String? {
    guard let folder = pluginFolder(key), let text = try? String(contentsOfFile: (folder as NSString).appendingPathComponent(".\(name).sha256"), encoding: .utf8) else { return nil }
    let sha = text.trimmingCharacters(in: .whitespacesAndNewlines)
    return Self.isSha(sha) && name.hasSuffix("-\(sha.prefix(Self.shaTag))") ? sha : nil
  }

  private func proofPath(_ key: String, entry name: String) -> String? {
    pluginFolder(key).map { ($0 as NSString).appendingPathComponent(".\(name)\(Self.officialSuffix)") }
  }

  func recordOfficial(_ copy: StoreCopy, proof: OfficialProof) -> Bool {
    guard let path = proofPath(copy.key, entry: copy.entry), let data = try? JSONSerialization.data(withJSONObject: ["v": 1, "platform": proof.platform, "sig": proof.signature]) else { return false }
    return withLock(copy.key) { () -> Bool in
      guard self.copy(copy.key, sha: copy.sha)?.entry == copy.entry else { return false }
      return (try? data.write(to: URL(fileURLWithPath: path), options: .atomic)) != nil
    } ?? false
  }

  func officialProof(_ copy: StoreCopy) -> OfficialProof? {
    guard let path = proofPath(copy.key, entry: copy.entry) else { return nil }
    var info = stat()
    guard lstat(path, &info) == 0, (info.st_mode & S_IFMT) == S_IFREG, info.st_size <= 4096, let data = FileManager.default.contents(atPath: path),
      let doc = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any], (doc["v"] as? NSNumber)?.intValue == 1, let platform = doc["platform"] as? String,
      let signature = doc["sig"] as? String
    else { return nil }
    return OfficialProof(platform: platform, signature: signature)
  }

  func isOfficial(_ copy: StoreCopy, keys: [String]) -> Bool {
    guard let id = Self.id(copy.key), id.hasPrefix(PluginOfficial.scopePrefix), let proof = officialProof(copy) else { return false }
    return PluginOfficial.verify(id: id, version: copy.version, sha256: copy.sha, proof: proof, keys: keys)
  }

  func archivePath(_ key: String, _ sha: String) -> String? {
    guard let folder = pluginFolder(key), let name = entry(key, sha: sha) else { return nil }
    return (folder as NSString).appendingPathComponent(name) + Self.archiveSuffix
  }

  func active(_ key: String) -> StoreCopy? { linked(key, Self.activeName) }

  func previous(_ key: String) -> StoreCopy? { linked(key, Self.previousName) }

  func candidates(_ key: String) -> [StoreCopy] {
    let current = active(key)?.entry
    let earlier = previous(key)?.entry
    return entries(key).filter { $0 != current && $0 != earlier }.compactMap { name in shaOf(key, entry: name).flatMap { copy(key, sha: $0) } }
  }

  private func isArchive(_ path: String) -> Bool {
    var info = stat()
    return lstat(path, &info) == 0 && (info.st_mode & S_IFMT) == S_IFREG
  }

  func publish(_ key: String, version: String, staged: String, archive: PluginArchive.Snapshot, sha: String) -> Result<StoreCopy, FolderRefusal> {
    guard Self.isSha(sha), archive.sha == sha, let name = Self.entryName(version: version, sha: sha), let pluginFolder = pluginFolder(key) else {
      PluginPrograms.discard(staged)
      return .failure(FolderRefusal(reason: "its digest or version isn't valid", cause: .mismatch))
    }
    let published = withLock(key) { () -> Result<StoreCopy, FolderRefusal> in
      if let existing = copy(key, sha: sha) {
        PluginPrograms.discard(staged)
        return .success(existing)
      }
      let target = (pluginFolder as NSString).appendingPathComponent(name)
      if PluginPrograms.isRealFolder(target) { PluginPrograms.discard(target) }
      unlink(target + Self.archiveSuffix)
      guard let folder = PluginPrograms.realFolder(pluginFolder, creating: true) else {
        PluginPrograms.discard(staged)
        return .failure(FolderRefusal(reason: "its folder isn't one you own", cause: .folder))
      }
      let kept = (folder as NSString).appendingPathComponent(".download-\(getpid())-\(UInt32.random(in: 0...UInt32.max))")
      let keptFile = open(kept, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0o600)
      guard keptFile >= 0 else {
        let failed = errno
        PluginPrograms.discard(staged)
        return .failure(FolderRefusal(reason: "its download couldn't be kept (\(String(cString: strerror(failed))))", cause: FailureCause(errno: failed)))
      }
      let written = PluginArchive.copyAll(from: archive.fd, to: keptFile) && fchmod(keptFile, 0o444) == 0
      let writeError = errno
      close(keptFile)
      let shaFile = (folder as NSString).appendingPathComponent(".\(name).sha256")
      unlink(shaFile)
      unlink((folder as NSString).appendingPathComponent(".\(name)\(Self.officialSuffix)"))
      guard written, rename(kept, target + Self.archiveSuffix) == 0 else {
        unlink(kept)
        PluginPrograms.discard(staged)
        return .failure(FolderRefusal(reason: "its download couldn't be kept (\(String(cString: strerror(writeError))))", cause: FailureCause(errno: writeError)))
      }
      guard moveFolder(staged, target) == 0 else {
        let failed = errno
        unlink(target + Self.archiveSuffix)
        PluginPrograms.discard(staged)
        return .failure(FolderRefusal(reason: "its copy couldn't be put in place (\(String(cString: strerror(failed))))", cause: FailureCause(errno: failed)))
      }
      guard PluginPrograms.seal(target, keepingRootWritable: false) else {
        PluginPrograms.discard(target)
        unlink(target + Self.archiveSuffix)
        return .failure(FolderRefusal(reason: "its copy couldn't be made read-only", cause: .permission))
      }
      guard let made = copy(key, sha: sha, fresh: true), (try? (sha + "\n").write(toFile: shaFile, atomically: true, encoding: .utf8)) != nil else {
        PluginPrograms.discard(target)
        unlink(target + Self.archiveSuffix)
        unlink(shaFile)
        return .failure(FolderRefusal(reason: "its copy doesn't match its download", cause: .mismatch))
      }
      return .success(made)
    }
    return published ?? .failure(FolderRefusal(reason: "its folder couldn't be locked", cause: .folder))
  }

  func activate(_ key: String, sha: String) -> Bool {
    withLock(key) { () -> Bool in
      guard let made = copy(key, sha: sha), let folder = pluginFolder(key) else { return false }
      let before = PluginPrograms.linkTarget((folder as NSString).appendingPathComponent(Self.activeName))
      if before == made.entry { return true }
      let previousPath = (folder as NSString).appendingPathComponent(Self.previousName)
      let earlier = PluginPrograms.linkTarget(previousPath)
      if let before, !before.contains("/") {
        guard PluginPrograms.swapLink(in: folder, named: Self.previousName, to: before) else { return false }
      }
      guard PluginPrograms.swapLink(in: folder, named: Self.activeName, to: made.entry) else {
        if let earlier, !earlier.contains("/") { _ = PluginPrograms.swapLink(in: folder, named: Self.previousName, to: earlier) } else if before != nil { unlink(previousPath) }
        return false
      }
      return true
    } ?? false
  }

  func rollback(_ key: String, expectedVersion: String? = nil, expectedSha: String? = nil) -> StoreCopy? {
    withLock(key) { () -> StoreCopy? in
      guard let folder = pluginFolder(key), let earlier = previous(key) else { return nil }
      if let expectedVersion, earlier.version != expectedVersion { return nil }
      if let expectedSha, earlier.sha != expectedSha { return nil }
      let current = active(key)
      guard PluginPrograms.swapLink(in: folder, named: Self.activeName, to: earlier.entry) else { return nil }
      if let current { _ = PluginPrograms.swapLink(in: folder, named: Self.previousName, to: current.entry) } else { unlink((folder as NSString).appendingPathComponent(Self.previousName)) }
      return earlier
    } ?? nil
  }

  func deactivate(_ key: String) {
    guard let folder = pluginFolder(key) else { return }
    _ = withLock(key) { unlink((folder as NSString).appendingPathComponent(Self.activeName)) }
  }

  func remove(_ key: String) -> Bool {
    guard let folder = pluginFolder(key) else { return false }
    return withLock(key) { () -> Bool in
      var info = stat()
      guard lstat(folder, &info) == 0 else { return true }
      guard PluginPrograms.isRealFolder(folder) else { return false }
      PluginPrograms.discard(folder)
      return lstat(folder, &info) != 0
    } ?? false
  }

  func removeCandidate(_ key: String, folderId: String) -> Bool {
    guard let folder = pluginFolder(key), let sha = Self.sha(ofFolderId: folderId) else { return false }
    return withLock(key) { () -> Bool in
      guard PluginPrograms.isRealFolder(folder) else { return true }
      let keep = Set([Self.activeName, Self.previousName].compactMap { PluginPrograms.linkTarget((folder as NSString).appendingPathComponent($0)) })
      for entry in entries(key) where !keep.contains(entry) && shaOf(key, entry: entry) == sha {
        PluginPrograms.discard((folder as NSString).appendingPathComponent(entry))
        unlink((folder as NSString).appendingPathComponent(".\(entry).sha256"))
        unlink((folder as NSString).appendingPathComponent(".\(entry)\(Self.officialSuffix)"))
        unlink((folder as NSString).appendingPathComponent("\(entry)\(Self.archiveSuffix)"))
      }
      return true
    } ?? false
  }

  func sweep(_ key: String) {
    _ = withLock(key) { sweepLocked(key) }
  }

  private func sweepLocked(_ key: String) {
    guard let folder = pluginFolder(key), PluginPrograms.isRealFolder(folder), let names = try? FileManager.default.contentsOfDirectory(atPath: folder) else { return }
    var keep = Set([Self.activeName, Self.previousName].compactMap { PluginPrograms.linkTarget((folder as NSString).appendingPathComponent($0)) })
    let waiting = entries(key).filter { !keep.contains($0) && shaOf(key, entry: $0) != nil && isArchive((folder as NSString).appendingPathComponent($0) + Self.archiveSuffix) }.sorted { modified((folder as NSString).appendingPathComponent($0)) > modified((folder as NSString).appendingPathComponent($1)) }
    keep.formUnion(waiting.prefix(Self.keptCandidates))
    for name in names where name != Self.activeName && name != Self.previousName {
      let path = (folder as NSString).appendingPathComponent(name)
      if name.hasPrefix(".trash-") {
        PluginPrograms.discard(path)
      } else if [".stage-", ".fetch-", ".download-", ".snapshot-"].contains(where: name.hasPrefix) {
        if Int(Date().timeIntervalSince1970) - modified(path) > Self.staleSeconds { PluginPrograms.discard(path) }
      } else if name.hasPrefix("."), name.hasSuffix(".sha256") {
        if !keep.contains(String(name.dropFirst().dropLast(".sha256".count))) { unlink(path) }
      } else if name.hasPrefix("."), name.hasSuffix(Self.officialSuffix) {
        if !keep.contains(String(name.dropFirst().dropLast(Self.officialSuffix.count))) { unlink(path) }
      } else if name.hasSuffix(Self.archiveSuffix) {
        if !keep.contains(String(name.dropLast(Self.archiveSuffix.count))) { unlink(path) }
      } else if !name.hasPrefix("."), !keep.contains(name) {
        PluginPrograms.discard(path)
      }
    }
  }

  private func modified(_ path: String) -> Int {
    var info = stat()
    guard lstat(path, &info) == 0 else { return 0 }
    return info.st_mtimespec.tv_sec
  }

  static func clearQuarantine(_ path: String) -> Bool {
    removexattr(path, quarantineName, XATTR_NOFOLLOW) == 0 || errno == ENOATTR
  }

  static func stripQuarantine(tree root: String) -> Bool {
    guard let walker = FileManager.default.enumerator(atPath: root) else { return false }
    var paths = [root]
    while let relative = walker.nextObject() as? String { paths.append((root as NSString).appendingPathComponent(relative)) }
    return paths.allSatisfy(clearQuarantine)
  }
}

final class StoreVerification {
  static let shared = StoreVerification()

  private struct Stamp: Equatable {
    let archive: [Int64]
    let copy: [[Int64]]
  }

  private let lock = NSLock()
  private var verified: [String: (stamp: Stamp, digest: String)] = [:]

  private static func stamp(_ path: String) -> [Int64]? {
    var info = stat()
    guard lstat(path, &info) == 0 else { return nil }
    return [Int64(info.st_dev), Int64(info.st_ino), Int64(info.st_size), Int64(info.st_mtimespec.tv_sec), Int64(info.st_mtimespec.tv_nsec), Int64(info.st_ctimespec.tv_sec), Int64(info.st_ctimespec.tv_nsec)]
  }

  static func treeStamp(_ root: String) -> [[Int64]]? {
    guard let top = stamp(root), let walker = FileManager.default.enumerator(atPath: root) else { return nil }
    var stamps = [top]
    var names: [String] = []
    while let relative = walker.nextObject() as? String { names.append(relative) }
    for relative in names.sorted() {
      guard let entry = stamp((root as NSString).appendingPathComponent(relative)) else { return nil }
      stamps.append(entry + [Int64(relative.hashValue)])
    }
    return stamps
  }

  private func forget(_ key: String) -> String? {
    lock.lock()
    verified.removeValue(forKey: key)
    lock.unlock()
    return nil
  }

  func digest(archive: String, sha: String, copy: String, top: String, scratch: String, fresh: Bool = false) -> String? {
    let key = "\(archive)\u{0}\(copy)"
    guard let archiveStamp = Self.stamp(archive), let copyStamp = Self.treeStamp(copy) else { return forget(key) }
    let stamp = Stamp(archive: archiveStamp, copy: copyStamp)
    lock.lock()
    if !fresh, let known = verified[key], known.stamp == stamp {
      lock.unlock()
      return known.digest
    }
    lock.unlock()
    guard let expected = PluginArchive.verifiedPayloadDigest(archive: archive, sha: sha, top: top, scratch: scratch),
      PluginPrograms.payloadDigest(copy, keepingCaches: true, skippingReserved: false) == expected
    else { return forget(key) }
    lock.lock()
    verified[key] = (stamp, expected)
    lock.unlock()
    return expected
  }

  func forgetAll() {
    lock.lock()
    verified.removeAll()
    lock.unlock()
  }
}
