import Darwin
import Foundation

struct OfficialCopy: Equatable {
  let name: String
  let sha: String
  let path: String
  let payloadDigest: String

  var folderId: String { OfficialPin.folderId(sha) }
}

struct OfficialStore {
  static let activeName = "active"
  static let archiveSuffix = ".tar.gz"
  static let quarantineName = "com.apple.quarantine"
  static let staleSeconds = 3600

  let root: String
  var moveFolder: (String, String) -> Int32 = { renamex_np($0, $1, UInt32(RENAME_EXCL)) }

  func pluginFolder(_ name: String) -> String { (root as NSString).appendingPathComponent(name) }

  func copyPath(_ name: String, _ sha: String) -> String { (pluginFolder(name) as NSString).appendingPathComponent(sha) }

  func archivePath(_ name: String, _ sha: String) -> String { (pluginFolder(name) as NSString).appendingPathComponent(sha + Self.archiveSuffix) }

  func lock(_ name: String) -> Int32? {
    guard PluginPrograms.isName(name), PluginPrograms.realFolder(root, creating: true) != nil else { return nil }
    let fd = open((root as NSString).appendingPathComponent(".\(name).lock"), O_RDWR | O_CREAT | O_CLOEXEC | O_NOFOLLOW, 0o600)
    guard fd >= 0 else { return nil }
    guard flock(fd, LOCK_EX) == 0 else {
      close(fd)
      return nil
    }
    return fd
  }

  func withLock<T>(_ name: String, _ body: () -> T) -> T? {
    guard let held = lock(name) else { return nil }
    defer { close(held) }
    return body()
  }

  func makeScratch(_ name: String, prefix: String) -> String? {
    guard PluginPrograms.isName(name), let folder = PluginPrograms.realFolder(pluginFolder(name), creating: true), PluginPrograms.hasPrivateAncestry(folder) else { return nil }
    let path = (folder as NSString).appendingPathComponent("\(prefix)\(getpid())-\(UInt32.random(in: 0...UInt32.max))")
    return mkdir(path, 0o700) == 0 ? path : nil
  }

  func copy(_ name: String, sha: String, fresh: Bool = false) -> OfficialCopy? {
    guard PluginPrograms.isName(name), OfficialPin.isSha(sha) else { return nil }
    let path = copyPath(name, sha)
    guard PluginPrograms.isRealFolder(path), PluginPrograms.hasPrivateAncestry(pluginFolder(name)), isArchive(archivePath(name, sha)),
      PluginPrograms.isSealed(path, keepingRootWritable: false),
      let digest = OfficialVerification.shared.digest(archive: archivePath(name, sha), sha: sha, copy: path, top: name, scratch: pluginFolder(name), fresh: fresh)
    else { return nil }
    return OfficialCopy(name: name, sha: sha, path: path, payloadDigest: digest)
  }

  func active(_ name: String) -> OfficialCopy? {
    guard let target = PluginPrograms.linkTarget((pluginFolder(name) as NSString).appendingPathComponent(Self.activeName)), OfficialPin.isSha(target) else { return nil }
    return copy(name, sha: target)
  }

  private func isArchive(_ path: String) -> Bool {
    var info = stat()
    return lstat(path, &info) == 0 && (info.st_mode & S_IFMT) == S_IFREG
  }

  func publish(_ name: String, staged: String, archive: OfficialArchive.Snapshot, sha: String) -> Result<OfficialCopy, FolderRefusal> {
    guard OfficialPin.isSha(sha), archive.sha == sha else { return .failure(FolderRefusal(reason: "its digest isn't valid", cause: .mismatch)) }
    let published = withLock(name) { () -> Result<OfficialCopy, FolderRefusal> in
      if let existing = copy(name, sha: sha) {
        PluginPrograms.discard(staged)
        return .success(existing)
      }
      if PluginPrograms.isRealFolder(copyPath(name, sha)) { PluginPrograms.discard(copyPath(name, sha)) }
      unlink(archivePath(name, sha))
      guard let folder = PluginPrograms.realFolder(pluginFolder(name), creating: true) else {
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
      let written = OfficialArchive.copyAll(from: archive.fd, to: keptFile) && fchmod(keptFile, 0o444) == 0
      let writeError = errno
      close(keptFile)
      guard written else {
        unlink(kept)
        PluginPrograms.discard(staged)
        return .failure(FolderRefusal(reason: "its download couldn't be kept (\(String(cString: strerror(writeError))))", cause: FailureCause(errno: writeError)))
      }
      guard rename(kept, archivePath(name, sha)) == 0 else {
        let failed = errno
        unlink(kept)
        PluginPrograms.discard(staged)
        return .failure(FolderRefusal(reason: "its download couldn't be kept (\(String(cString: strerror(failed))))", cause: FailureCause(errno: failed)))
      }
      guard moveFolder(staged, copyPath(name, sha)) == 0 else {
        let failed = errno
        unlink(archivePath(name, sha))
        PluginPrograms.discard(staged)
        return .failure(FolderRefusal(reason: "its copy couldn't be put in place (\(String(cString: strerror(failed))))", cause: FailureCause(errno: failed)))
      }
      guard PluginPrograms.seal(copyPath(name, sha), keepingRootWritable: false) else {
        PluginPrograms.discard(copyPath(name, sha))
        unlink(archivePath(name, sha))
        return .failure(FolderRefusal(reason: "its copy couldn't be made read-only", cause: .permission))
      }
      guard let made = copy(name, sha: sha, fresh: true) else {
        PluginPrograms.discard(copyPath(name, sha))
        unlink(archivePath(name, sha))
        return .failure(FolderRefusal(reason: "its copy doesn't match its download", cause: .mismatch))
      }
      return .success(made)
    }
    return published ?? .failure(FolderRefusal(reason: "its folder couldn't be locked", cause: .folder))
  }

  func activate(_ name: String, sha: String) -> Bool {
    withLock(name) { () -> Bool in
      guard copy(name, sha: sha) != nil else { return false }
      return PluginPrograms.swapLink(in: pluginFolder(name), named: Self.activeName, to: sha)
    } ?? false
  }

  func deactivate(_ name: String) {
    _ = withLock(name) { unlink((pluginFolder(name) as NSString).appendingPathComponent(Self.activeName)) }
  }

  func remove(_ name: String) -> Bool {
    withLock(name) { () -> Bool in
      let folder = pluginFolder(name)
      var info = stat()
      guard lstat(folder, &info) == 0 else { return true }
      guard PluginPrograms.isRealFolder(folder) else { return false }
      PluginPrograms.discard(folder)
      return lstat(folder, &info) != 0
    } ?? false
  }

  func sweep(_ name: String, keeping wanted: Set<String>) {
    _ = withLock(name) { sweepLocked(name, keeping: wanted) }
  }

  private func sweepLocked(_ name: String, keeping wanted: Set<String>) {
    let folder = pluginFolder(name)
    guard PluginPrograms.isRealFolder(folder), let entries = try? FileManager.default.contentsOfDirectory(atPath: folder) else { return }
    var keep = wanted
    if let current = PluginPrograms.linkTarget((folder as NSString).appendingPathComponent(Self.activeName)) { keep.insert(current) }
    for entry in entries where entry != Self.activeName {
      let path = (folder as NSString).appendingPathComponent(entry)
      if entry.hasPrefix(".trash-") {
        PluginPrograms.discard(path)
      } else if [".stage-", ".fetch-", ".download-", ".snapshot-"].contains(where: entry.hasPrefix) {
        if olderThan(path, seconds: Self.staleSeconds) { PluginPrograms.discard(path) }
      } else if entry.hasSuffix(Self.archiveSuffix) {
        let sha = String(entry.dropLast(Self.archiveSuffix.count))
        if !OfficialPin.isSha(sha) || !PluginPrograms.isRealFolder(copyPath(name, sha)) || !keep.contains(sha) { unlink(path) }
      } else if OfficialPin.isSha(entry) {
        if !keep.contains(entry) || !isArchive(archivePath(name, entry)) { PluginPrograms.discard(path) }
      }
    }
  }

  private func olderThan(_ path: String, seconds: Int) -> Bool {
    var info = stat()
    guard lstat(path, &info) == 0 else { return false }
    return Int(Date().timeIntervalSince1970) - info.st_mtimespec.tv_sec > seconds
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

final class OfficialVerification {
  static let shared = OfficialVerification()

  private struct Stamp: Equatable {
    let archive: [Int64]
    let copy: [[Int64]]
  }

  private let lock = NSLock()
  private var verified: [String: (stamp: Stamp, digest: String, checked: Date)] = [:]

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

  func digest(archive: String, sha: String, copy: String, top: String, scratch: String, fresh: Bool = false) -> String? {
    let key = "\(archive)\u{0}\(copy)"
    lock.lock()
    lock.unlock()
    guard let archiveStamp = Self.stamp(archive), let copyStamp = Self.treeStamp(copy) else {
      lock.lock()
      verified.removeValue(forKey: key)
      lock.unlock()
      return nil
    }
    let stamp = Stamp(archive: archiveStamp, copy: copyStamp)
    lock.lock()
    if !fresh, let known = verified[key], known.stamp == stamp {
      verified[key] = (stamp, known.digest, Date())
      lock.unlock()
      return known.digest
    }
    lock.unlock()
    guard let expected = OfficialArchive.verifiedPayloadDigest(archive: archive, sha: sha, top: top, scratch: scratch),
      PluginPrograms.payloadDigest(copy, keepingCaches: true, skippingReserved: false) == expected
    else {
      lock.lock()
      verified.removeValue(forKey: key)
      lock.unlock()
      return nil
    }
    lock.lock()
    verified[key] = (stamp, expected, Date())
    lock.unlock()
    return expected
  }

  func forget() {
    lock.lock()
    verified.removeAll()
    lock.unlock()
  }
}
