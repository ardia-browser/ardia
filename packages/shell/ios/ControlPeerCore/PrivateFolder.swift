import Darwin
import Foundation

public enum PrivateFolder {
  private typealias UUIDOfUser = @convention(c) (uid_t, UnsafeMutablePointer<UInt8>) -> Int32

  private static let ownerUUID: UUIDOfUser = {
    guard let symbol = dlsym(UnsafeMutableRawPointer(bitPattern: -2), "mbr_uid_to_uuid") else { return { _, _ in -1 } }
    return unsafeBitCast(symbol, to: UUIDOfUser.self)
  }()

  public enum Access: Equatable {
    case none
    case denyOnly
    case allowsOthers
    case unknown
  }

  public static func extendedAccess(_ fd: Int32) -> Access {
    guard let acl = acl_get_fd_np(fd, ACL_TYPE_EXTENDED) else {
      return errno == ENOENT || errno == ENOTSUP ? .none : .unknown
    }
    defer { acl_free(UnsafeMutableRawPointer(acl)) }
    return classify(acl, modifyingOnly: false)
  }

  public static func othersCanModify(path: String) -> Access {
    guard let acl = acl_get_link_np(path, ACL_TYPE_EXTENDED) else {
      return errno == ENOENT || errno == ENOTSUP ? .none : .unknown
    }
    defer { acl_free(UnsafeMutableRawPointer(acl)) }
    return classify(acl, modifyingOnly: true)
  }

  private static let modifyingPermissions: [acl_perm_t] = [ACL_WRITE_DATA, ACL_APPEND_DATA, ACL_DELETE, ACL_DELETE_CHILD, ACL_WRITE_SECURITY, ACL_CHANGE_OWNER]

  private static func classify(_ acl: acl_t, modifyingOnly: Bool) -> Access {
    var owner = uuid_t(0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0)
    let ownerKnown = withUnsafeMutableBytes(of: &owner) { ownerUUID(geteuid(), $0.baseAddress!.assumingMemoryBound(to: UInt8.self)) } == 0
    var entry: acl_entry_t?
    var id = ACL_FIRST_ENTRY.rawValue
    var entries = 0
    while acl_get_entry(acl, id, &entry) == 0, let entry {
      id = ACL_NEXT_ENTRY.rawValue
      entries += 1
      var tag = ACL_UNDEFINED_TAG
      guard acl_get_tag_type(entry, &tag) == 0 else { return .allowsOthers }
      if tag == ACL_EXTENDED_DENY { continue }
      guard tag == ACL_EXTENDED_ALLOW else { return .allowsOthers }
      if modifyingOnly {
        var permissions: acl_permset_t?
        guard acl_get_permset(entry, &permissions) == 0, let permissions else { return .allowsOthers }
        if !modifyingPermissions.contains(where: { acl_get_perm_np(permissions, $0) != 0 }) { continue }
      }
      guard ownerKnown, let qualifier = acl_get_qualifier(entry) else { return .allowsOthers }
      let namesOwner = withUnsafeBytes(of: &owner) { mine in
        memcmp(qualifier, mine.baseAddress, MemoryLayout<uuid_t>.size) == 0
      }
      acl_free(qualifier)
      if !namesOwner { return .allowsOthers }
    }
    return entries == 0 ? .none : .denyOnly
  }

  public static func ancestorProblem(_ fd: Int32) -> String? {
    var buffer = [CChar](repeating: 0, count: Int(MAXPATHLEN))
    guard fcntl(fd, F_GETPATH, &buffer) == 0 else { return "Couldn't tell where the data folder is (\(String(cString: strerror(errno))))." }
    var path = (String(cString: buffer) as NSString).deletingLastPathComponent
    while true {
      if let problem = replaceableBySomeoneElse(path) { return problem }
      if path == "/" || path.isEmpty { return nil }
      path = (path as NSString).deletingLastPathComponent
    }
  }

  static func replaceableBySomeoneElse(_ path: String) -> String? {
    var info = stat()
    guard lstat(path, &info) == 0 else { return "Couldn't read \(path) (\(String(cString: strerror(errno))))." }
    guard (info.st_mode & S_IFMT) == S_IFDIR else { return "\(path), which holds the data folder, isn't a real folder." }
    guard info.st_uid == 0 || info.st_uid == geteuid() else { return "\(path), which holds the data folder, belongs to another user, who could swap it." }
    guard info.st_mode & (S_IWGRP | S_IWOTH) == 0 || info.st_mode & S_ISVTX != 0 else { return "Others can write to \(path), which holds the data folder, so they could swap it." }
    switch othersCanModify(path: path) {
    case .none, .denyOnly: return nil
    case .allowsOthers: return "\(path), which holds the data folder, has an access list that lets someone else change it."
    case .unknown: return "Couldn't read the access list of \(path), which holds the data folder."
    }
  }

  public static func problem(_ fd: Int32, path: String) -> String? {
    var info = stat()
    guard fstat(fd, &info) == 0 else { return "Couldn't read the data folder \(path) (\(String(cString: strerror(errno))))." }
    guard (info.st_mode & S_IFMT) == S_IFDIR else { return "The data folder \(path) isn't a real folder." }
    guard info.st_uid == geteuid() else { return "The data folder \(path) belongs to another user." }
    guard info.st_mode & (S_IWGRP | S_IWOTH) == 0 else { return "Others can write to the data folder \(path)." }
    var volume = statfs()
    guard fstatfs(fd, &volume) == 0 else { return "Couldn't read the disk the data folder \(path) is on (\(String(cString: strerror(errno))))." }
    guard volume.f_flags & UInt32(MNT_IGNORE_OWNERSHIP) == 0 else { return "The data folder \(path) is on a disk that ignores ownership, so anyone could use the socket there." }
    switch extendedAccess(fd) {
    case .none, .denyOnly: return nil
    case .allowsOthers: return "The data folder \(path) has an access list that lets someone else in."
    case .unknown: return "Couldn't read the data folder \(path)'s access list."
    }
  }

  public static func openFolder(_ path: String) -> (fd: Int32, problem: String?) {
    let fd = Darwin.open(path, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
    guard fd >= 0 else {
      let reason = errno == ELOOP || errno == ENOTDIR ? "The data folder \(path) isn't a real folder." : "Couldn't read the data folder \(path) (\(String(cString: strerror(errno))))."
      return (-1, reason)
    }
    if let problem = problem(fd, path: path) {
      Darwin.close(fd)
      return (-1, problem)
    }
    return (fd, nil)
  }

  public static func onlyOwnerCanRead(_ fd: Int32) -> Bool {
    guard fchmod(fd, 0o600) == 0 else { return false }
    if extendedAccess(fd) != .none {
      guard let empty = acl_init(0) else { return false }
      let cleared = acl_set_fd_np(fd, empty, ACL_TYPE_EXTENDED) == 0
      acl_free(UnsafeMutableRawPointer(empty))
      guard cleared, extendedAccess(fd) == .none else { return false }
    }
    var info = stat()
    return fstat(fd, &info) == 0 && (info.st_mode & S_IFMT) == S_IFREG && info.st_uid == geteuid() && info.st_mode & 0o7777 == 0o600
  }

  public static func privateFile(_ fd: Int32) -> Bool {
    var info = stat()
    guard fstat(fd, &info) == 0, (info.st_mode & S_IFMT) == S_IFREG, info.st_uid == geteuid(), info.st_mode & 0o077 == 0 else { return false }
    let access = extendedAccess(fd)
    return access == .none || access == .denyOnly
  }
}
