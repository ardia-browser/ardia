import Darwin
import Foundation

public struct ControlApproval: Codable, Equatable {
  public let key: String
  public let name: String
  public let signedBy: String
  public let path: String?
  public let added: Double
  public let until: Double?

  public init(key: String, name: String, signedBy: String, path: String?, added: Double, until: Double?) {
    self.key = key
    self.name = name
    self.signedBy = signedBy
    self.path = path
    self.added = added
    self.until = until
  }

  public init(peer: ControlPeer, key: String, added: Date, until: Date?) {
    self.init(
      key: key, name: peer.name, signedBy: peer.signedBy, path: peer.path.map { ControlPeer.plain($0, limit: 1024) }, added: added.timeIntervalSince1970,
      until: until?.timeIntervalSince1970)
  }

  public func live(at now: Date) -> Bool {
    guard let until else { return true }
    return now.timeIntervalSince1970 < until
  }

  public var dictionary: [String: Any] {
    var out: [String: Any] = ["key": key, "name": name, "signedBy": signedBy, "added": added * 1000]
    if let path { out["path"] = path }
    if let until { out["until"] = until * 1000 }
    return out
  }
}

public final class ControlApprovals {
  public static let fileName = "ArdiaControlApprovals.json"
  public static let maxEntries = 64
  public static let maxBytes = 256 * 1024

  public let directory: String
  public private(set) var problem: String?

  public init(directory: String) {
    self.directory = directory
  }

  public var path: String { (directory as NSString).appendingPathComponent(Self.fileName) }

  public func load(now: Date = Date()) -> [ControlApproval] {
    problem = nil
    let folder = PrivateFolder.openFolder(directory)
    guard folder.fd >= 0 else {
      problem = folder.problem
      return []
    }
    defer { Darwin.close(folder.fd) }
    let fd = openat(folder.fd, Self.fileName, O_RDONLY | O_NOFOLLOW | O_CLOEXEC | O_NONBLOCK)
    guard fd >= 0 else {
      if errno != ENOENT { problem = "Couldn't read \(Self.fileName) (\(String(cString: strerror(errno))))." }
      return []
    }
    defer { Darwin.close(fd) }
    var info = stat()
    guard PrivateFolder.privateFile(fd), fstat(fd, &info) == 0, info.st_size <= Self.maxBytes else {
      problem = "\(Self.fileName) isn't a private file of yours, so Ardia ignores it."
      return []
    }
    var data = Data(count: Int(info.st_size))
    let read = data.withUnsafeMutableBytes { Darwin.read(fd, $0.baseAddress, Int(info.st_size)) }
    guard read == Int(info.st_size), let entries = try? JSONDecoder().decode([ControlApproval].self, from: data) else {
      problem = "\(Self.fileName) is damaged, so Ardia ignores it."
      return []
    }
    return Array(entries.filter { $0.live(at: now) }.suffix(Self.maxEntries))
  }

  @discardableResult
  public func add(_ approval: ControlApproval, now: Date = Date()) -> Bool {
    var entries = load(now: now).filter { $0.key != approval.key }
    entries.append(approval)
    return save(Array(entries.suffix(Self.maxEntries)))
  }

  @discardableResult
  public func revoke(_ key: String, now: Date = Date()) -> Bool {
    let entries = load(now: now)
    let kept = entries.filter { $0.key != key }
    guard kept.count != entries.count else { return false }
    return save(kept)
  }

  func save(_ entries: [ControlApproval]) -> Bool {
    guard let data = try? JSONEncoder().encode(entries) else { return false }
    let folder = PrivateFolder.openFolder(directory)
    guard folder.fd >= 0 else {
      problem = folder.problem
      return false
    }
    defer { Darwin.close(folder.fd) }
    let temporary = ".\(Self.fileName).\(getpid()).\(UInt32.random(in: 0...UInt32.max))"
    let fd = openat(folder.fd, temporary, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0o600)
    guard fd >= 0 else { return false }
    let wrote = PrivateFolder.onlyOwnerCanRead(fd) ? data.withUnsafeBytes { Darwin.write(fd, $0.baseAddress, data.count) } : -1
    let durable = wrote == data.count && Self.flush(fd)
    Darwin.close(fd)
    guard durable, renameat(folder.fd, temporary, folder.fd, Self.fileName) == 0 else {
      unlinkat(folder.fd, temporary, 0)
      return false
    }
    return Self.flush(folder.fd)
  }

  static func flush(_ fd: Int32) -> Bool {
    if fcntl(fd, F_FULLFSYNC) == 0 { return true }
    return errno == ENOTSUP && fsync(fd) == 0
  }
}
