import Darwin
import Foundation

extension PluginFileStore {
  static func stagingName(for name: String, stage: String) -> String? {
    guard let id = UUID(uuidString: stage) else { return nil }
    var stem = ""
    for character in name {
      guard stem.utf8.count + String(character).utf8.count + 1 + temporaryMarker.utf8.count + id.uuidString.utf8.count <= maxSegmentBytes else { break }
      stem.append(character)
    }
    return ".\(stem)\(temporaryMarker)\(id.uuidString)"
  }

  private func stagingPlace(_ path: String, stage: String, create: Bool) -> Result<(OpenedRoot, Directory, String, String), PluginFileFailure> {
    let parts: [String]
    switch Self.segments(path, allowRoot: false) {
    case .failure(let failure): return .failure(failure)
    case .success(let found): parts = found
    }
    guard let staging = Self.stagingName(for: parts.last!, stage: stage) else { return .failure(PluginFileFailure(.badPath, "the staging id isn't one Ardia made")) }
    let opened: OpenedRoot
    switch openRoot() {
    case .failure(let failure): return .failure(failure)
    case .success(let root): opened = root
    }
    switch walk(opened, parts.dropLast(), create: create) {
    case .failure(let failure): return .failure(failure)
    case .success(let directory): return .success((opened, directory, parts.last!, staging))
    }
  }

  func stageAppend(_ path: String, stage: String, data: Data, first: Bool) -> Result<[String: Any], PluginFileFailure> {
    guard data.count <= Self.maxData else { return .failure(PluginFileFailure(.tooLarge, "a part carries at most 4 MiB")) }
    let place: (OpenedRoot, Directory, String, String)
    switch stagingPlace(path, stage: stage, create: true) {
    case .failure(let failure): return .failure(failure)
    case .success(let found): place = found
    }
    let (opened, directory, _, staging) = place
    if isData, let quota, usage(opened) + Int64(data.count) > quota.cap {
      return .failure(PluginFileFailure(.quota, "the plugin's files would pass \(quota.cap >> 20) MiB"))
    }
    let flags = O_WRONLY | O_APPEND | O_NOFOLLOW | O_CLOEXEC | (first ? O_CREAT | O_EXCL : 0)
    let fd = openat(directory.fd, staging, flags, fileMode)
    guard fd >= 0 else { return .failure(PluginFileFailure(.unavailable, "the download couldn't be written (\(Self.errnoText(errno)))")) }
    defer { Darwin.close(fd) }
    var info = stat()
    guard fstat(fd, &info) == 0, (info.st_mode & S_IFMT) == S_IFREG, info.st_nlink == 1 else { return .failure(PluginFileFailure(.refused, "the download's file isn't Ardia's own")) }
    let complete = Self.writeAll(fd, data)
    guard fstat(fd, &info) == 0 else { return .failure(PluginFileFailure(.unavailable, "the download couldn't be read back")) }
    if isData { quota?.adjust(root, by: Int64(data.count)) }
    guard complete else { return .failure(PluginFileFailure(.unavailable, "the download couldn't be written")) }
    return .success(["size": Int64(info.st_size)])
  }

  func publishStage(_ path: String, stage: String) -> Result<[String: Any], PluginFileFailure> {
    let place: (OpenedRoot, Directory, String, String)
    switch stagingPlace(path, stage: stage, create: false) {
    case .failure(let failure): return .failure(failure)
    case .success(let found): place = found
    }
    let (opened, directory, name, staging) = place
    return coordinate(path, deleting: false) {
      let fd = openat(directory.fd, staging, O_RDONLY | O_NOFOLLOW | O_CLOEXEC)
      guard fd >= 0 else { return .failure(PluginFileFailure(.unavailable, "the download's file is gone")) }
      let synced = fsync(fd) == 0
      Darwin.close(fd)
      guard synced else { return .failure(PluginFileFailure(.unavailable, "the download couldn't be saved")) }
      if let failure = committed(directory, in: opened, "write") { return .failure(failure) }
      guard renameatx_np(directory.fd, staging, directory.fd, name, UInt32(RENAME_EXCL)) == 0 else {
        let code = errno
        if code == EEXIST { return .failure(PluginFileFailure(.exists, "a file is already at that path")) }
        return .failure(PluginFileFailure(.unavailable, "the download couldn't be saved (\(Self.errnoText(code)))"))
      }
      return result(directory, name)
    }
  }

  func discardStage(_ path: String, stage: String) -> Result<[String: Any], PluginFileFailure> {
    let place: (OpenedRoot, Directory, String, String)
    switch stagingPlace(path, stage: stage, create: false) {
    case .failure(let failure) where failure.code == .notFound: return .success(["removed": false])
    case .failure(let failure): return .failure(failure)
    case .success(let found): place = found
    }
    let (_, directory, _, staging) = place
    var info = stat()
    guard fstatat(directory.fd, staging, &info, AT_SYMLINK_NOFOLLOW) == 0 else { return .success(["removed": false]) }
    guard unlinkat(directory.fd, staging, 0) == 0 else { return .failure(PluginFileFailure(.unavailable, "the download couldn't be removed (\(Self.errnoText(errno)))")) }
    if isData { quota?.adjust(root, by: -Int64(info.st_size)) }
    return .success(["removed": true])
  }
}
