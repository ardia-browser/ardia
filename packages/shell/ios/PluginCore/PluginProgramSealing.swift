import Darwin
import Foundation

extension PluginPrograms {
  static let runtimeNames: Set<String> = [leasesName, afterUpdateMarker, afterUpdateClaim]

  @discardableResult
  static func seal(_ root: String, keepingRootWritable: Bool) -> Bool {
    guard let walker = FileManager.default.enumerator(atPath: root) else { return false }
    var folders: [String] = []
    var sealed = true
    while let relative = walker.nextObject() as? String {
      if keepingRootWritable && runtimeNames.contains(relative) {
        walker.skipDescendants()
        continue
      }
      let path = (root as NSString).appendingPathComponent(relative)
      var info = stat()
      guard lstat(path, &info) == 0 else { return false }
      switch info.st_mode & S_IFMT {
      case S_IFREG: if chmod(path, info.st_mode & 0o111 != 0 ? 0o555 : 0o444) != 0 { sealed = false }
      case S_IFDIR: folders.append(path)
      default: return false
      }
    }
    for folder in folders.reversed() where chmod(folder, 0o555) != 0 { sealed = false }
    if !keepingRootWritable && chmod(root, 0o555) != 0 { sealed = false }
    return sealed && isSealed(root, keepingRootWritable: keepingRootWritable)
  }

  static func hasPrivateAncestry(_ path: String, followingLinks: Bool = false) -> Bool {
    guard path.hasPrefix("/"), let resolved = realpath(path, nil) else { return false }
    var current = String(cString: resolved)
    free(resolved)
    let lexical = path.count > 1 && path.hasSuffix("/") ? String(path.dropLast()) : path
    if !followingLinks && current != lexical { return false }
    if followingLinks {
      var parent = (lexical as NSString).deletingLastPathComponent
      while true {
        guard isPrivateDirectory(parent, following: true) else { return false }
        if parent == "/" { break }
        parent = (parent as NSString).deletingLastPathComponent
      }
    }
    while true {
      guard isPrivateDirectory(current, following: false) else { return false }
      if current == "/" { return true }
      current = (current as NSString).deletingLastPathComponent
    }
  }

  private static func isPrivateDirectory(_ path: String, following: Bool) -> Bool {
    var info = stat()
    guard (following ? stat(path, &info) : lstat(path, &info)) == 0, (info.st_mode & S_IFMT) == S_IFDIR, info.st_uid == getuid() || info.st_uid == 0 else { return false }
    if info.st_mode & 0o022 != 0 && info.st_mode & S_ISVTX == 0 { return false }
    return !aclGrantsChanges(path, following: following)
  }

  private static func aclGrantsChanges(_ path: String, following: Bool) -> Bool {
    guard let acl = following ? acl_get_file(path, ACL_TYPE_EXTENDED) : acl_get_link_np(path, ACL_TYPE_EXTENDED) else { return errno != ENOENT }
    defer { acl_free(UnsafeMutableRawPointer(acl)) }
    let changes: [acl_perm_t] = [ACL_ADD_FILE, ACL_ADD_SUBDIRECTORY, ACL_DELETE_CHILD, ACL_DELETE, ACL_WRITE_SECURITY, ACL_CHANGE_OWNER]
    var entry: acl_entry_t?
    var which = ACL_FIRST_ENTRY.rawValue
    while acl_get_entry(acl, which, &entry) == 0, let found = entry {
      which = ACL_NEXT_ENTRY.rawValue
      var tag = ACL_UNDEFINED_TAG
      var permissions: acl_permset_t?
      guard acl_get_tag_type(found, &tag) == 0, tag == ACL_EXTENDED_ALLOW, acl_get_permset(found, &permissions) == 0, let permissions else { continue }
      if changes.contains(where: { acl_get_perm_np(permissions, $0) == 1 }) { return true }
    }
    return false
  }

  static func isSealed(_ root: String, keepingRootWritable: Bool) -> Bool {
    var info = stat()
    guard lstat(root, &info) == 0, (info.st_mode & S_IFMT) == S_IFDIR else { return false }
    if !keepingRootWritable && info.st_mode & 0o222 != 0 { return false }
    guard let walker = FileManager.default.enumerator(atPath: root) else { return false }
    while let relative = walker.nextObject() as? String {
      if keepingRootWritable && runtimeNames.contains(relative) {
        walker.skipDescendants()
        continue
      }
      guard lstat((root as NSString).appendingPathComponent(relative), &info) == 0, info.st_mode & 0o222 == 0 else { return false }
    }
    return true
  }
}
