import Darwin
import Foundation

extension PluginFileStore {
  struct ListOverflow: Error {}

  func list(_ path: String, recursive: Bool) -> Result<[String: Any], PluginFileFailure> {
    let parts: [String]
    switch Self.segments(path, allowRoot: true) {
    case .failure(let failure): return .failure(failure)
    case .success(let found): parts = found
    }
    let opened: OpenedRoot
    switch openRoot() {
    case .failure(let failure): return .failure(failure)
    case .success(let root): opened = root
    }
    let directory: Directory
    switch walk(opened, parts[...], create: false) {
    case .failure(let failure): return .failure(failure)
    case .success(let found): directory = found
    }
    var entries: [PluginFileEntry] = []
    do {
      try collect(directory, root: opened, prefix: parts.joined(separator: "/"), depth: 0, recursive: recursive, into: &entries)
    } catch {
      return .failure(PluginFileFailure(.tooLarge, "the folder holds over \(Self.maxEntries) entries"))
    }
    entries.sort { Array($0.path.utf8).lexicographicallyPrecedes(Array($1.path.utf8)) }
    return .success(["entries": entries.map(\.reply)])
  }

  private func collect(_ directory: Directory, root: OpenedRoot, prefix: String, depth: Int, recursive: Bool, into entries: inout [PluginFileEntry]) throws {
    guard let names = Self.names(in: directory.fd) else { return }
    let present = Set(names)
    let joined = { (name: String) in prefix.isEmpty ? name : "\(prefix)/\(name)" }
    for name in names {
      if Self.isTemporary(name) { continue }
      var info = stat()
      guard fstatat(directory.fd, name, &info, AT_SYMLINK_NOFOLLOW) == 0 else { continue }
      let kind = info.st_mode & S_IFMT
      if name.hasPrefix("."), name.hasSuffix(Self.placeholderSuffix), name.count > Self.placeholderSuffix.count + 1, kind == S_IFREG {
        let real = String(name.dropFirst().dropLast(Self.placeholderSuffix.count))
        if present.contains(real) || Self.isTemporary(real) { continue }
        entries.append(PluginFileEntry(path: joined(real), kind: "file", size: Self.placeholderSize(in: directory, name), mtimeMs: Self.mtimeMs(info), placeholder: true))
        requestDownload(joined(real))
        if entries.count > Self.maxEntries { throw ListOverflow() }
        continue
      }
      switch kind {
      case S_IFREG:
        let dataless = isDataless(info, joined(name))
        if dataless { requestDownload(joined(name)) }
        entries.append(PluginFileEntry(path: joined(name), kind: "file", size: Int64(info.st_size), mtimeMs: Self.mtimeMs(info), placeholder: dataless))
      case S_IFDIR:
        entries.append(PluginFileEntry(path: joined(name), kind: "dir", size: 0, mtimeMs: Self.mtimeMs(info), placeholder: false))
        if entries.count > Self.maxEntries { throw ListOverflow() }
        guard recursive, depth + 1 < Self.maxDepth else { continue }
        let child = openat(directory.fd, name, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
        guard child >= 0 else { continue }
        let opened = Directory(child)
        Self.commitPoint?("list:\(joined(name))")
        guard confined(opened, in: root) else { continue }
        try collect(opened, root: root, prefix: joined(name), depth: depth + 1, recursive: true, into: &entries)
      default:
        continue
      }
      if entries.count > Self.maxEntries { throw ListOverflow() }
    }
  }

  func remove(_ path: String) -> Result<[String: Any], PluginFileFailure> {
    let parts: [String]
    switch Self.segments(path, allowRoot: false) {
    case .failure(let failure): return .failure(failure)
    case .success(let found): parts = found
    }
    let opened: OpenedRoot
    switch openRoot() {
    case .failure(let failure): return .failure(failure)
    case .success(let root): opened = root
    }
    return coordinate(path, deleting: true) {
      let directory: Directory
      switch walk(opened, parts.dropLast(), create: false) {
      case .failure(let failure) where failure.code == .notFound: return .success(["removed": false])
      case .failure(let failure): return .failure(failure)
      case .success(let found): directory = found
      }
      let name = parts.last!
      if let failure = committed(directory, in: opened, "remove") { return .failure(failure) }
      var info = stat()
      var target = name
      if fstatat(directory.fd, name, &info, AT_SYMLINK_NOFOLLOW) != 0 {
        guard errno == ENOENT else { return .failure(PluginFileFailure(.unavailable, "it couldn't be checked (\(Self.errnoText(errno)))")) }
        guard let placeholder = Self.hasPlaceholder(in: directory, name) else { return .success(["removed": false]) }
        info = placeholder
        target = Self.placeholderName(name)
      }
      let kind = info.st_mode & S_IFMT
      if kind == S_IFLNK { return .failure(PluginFileFailure(.refused, "that's a link")) }
      guard kind == S_IFREG || kind == S_IFDIR else { return .failure(PluginFileFailure(.refused, "that isn't a plain file")) }
      return gated {
        let doomed = Self.temporaryName(for: name)
        mutating("remove")
        guard renameatx_np(directory.fd, target, directory.fd, doomed, UInt32(RENAME_EXCL)) == 0 else {
          if errno == ENOENT { return .success(["removed": false]) }
          return .failure(PluginFileFailure(.unavailable, "it couldn't be removed (\(Self.errnoText(errno)))"))
        }
        let putBack = { _ = renameatx_np(directory.fd, doomed, directory.fd, target, UInt32(RENAME_EXCL)) }
        guard intact(directory, in: opened) else {
          putBack()
          return .failure(Self.movedOut)
        }
        if kind == S_IFDIR {
          guard unlinkat(directory.fd, doomed, AT_REMOVEDIR) == 0 else {
            let code = errno
            putBack()
            if code == ENOTEMPTY || code == EEXIST { return .failure(PluginFileFailure(.refused, "the folder isn't empty")) }
            return .failure(PluginFileFailure(.refused, "the folder couldn't be removed (\(Self.errnoText(code)))"))
          }
          return .success(["removed": true])
        }
        guard unlinkat(directory.fd, doomed, 0) == 0 else {
          let code = errno
          putBack()
          return .failure(PluginFileFailure(.unavailable, "the file couldn't be removed (\(Self.errnoText(code)))"))
        }
        if isData, target == name { quota?.adjust(root, by: -Int64(info.st_size)) }
        return .success(["removed": true])
      }
    }
  }

  func inspect(_ path: String) -> Result<[String: Any], PluginFileFailure> {
    let parts: [String]
    switch Self.segments(path, allowRoot: true) {
    case .failure(let failure): return .failure(failure)
    case .success(let found): parts = found
    }
    let opened: OpenedRoot
    switch openRoot() {
    case .failure(let failure) where failure.code == .unavailable && !isData: return .success(["found": false])
    case .failure(let failure): return .failure(failure)
    case .success(let root): opened = root
    }
    var info = Darwin.stat()
    if parts.isEmpty {
      guard fstat(opened.directory.fd, &info) == 0 else { return .failure(PluginFileFailure(.unavailable, "the folder couldn't be checked")) }
      return .success(["found": true, "kind": "dir", "size": 0, "mtimeMs": Self.mtimeMs(info)])
    }
    let directory: Directory
    switch walk(opened, parts.dropLast(), create: false) {
    case .failure(let failure) where failure.code == .notFound: return .success(["found": false])
    case .failure(let failure): return .failure(failure)
    case .success(let found): directory = found
    }
    let name = parts.last!
    guard fstatat(directory.fd, name, &info, AT_SYMLINK_NOFOLLOW) == 0 else {
      if errno == ENOENT, let placeholder = Self.hasPlaceholder(in: directory, name) {
        return .success(["found": true, "kind": "file", "size": Self.placeholderSize(in: directory, Self.placeholderName(name)), "mtimeMs": Self.mtimeMs(placeholder)])
      }
      return .success(["found": false])
    }
    switch info.st_mode & S_IFMT {
    case S_IFREG: return .success(["found": true, "kind": "file", "size": Int64(info.st_size), "mtimeMs": Self.mtimeMs(info)])
    case S_IFDIR: return .success(["found": true, "kind": "dir", "size": 0, "mtimeMs": Self.mtimeMs(info)])
    case S_IFLNK: return .failure(PluginFileFailure(.refused, "that's a link"))
    default: return .failure(PluginFileFailure(.refused, "that isn't a plain file"))
    }
  }
}
