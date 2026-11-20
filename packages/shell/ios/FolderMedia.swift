import Foundation
import UniformTypeIdentifiers

enum FolderMedia {
  enum Status: String {
    case ok, missing, denied, unavailable
  }

  private static let keys: [URLResourceKey] = [
    .isRegularFileKey, .contentTypeKey, .fileSizeKey, .contentModificationDateKey, .addedToDirectoryDateKey, .creationDateKey,
  ]

  static func kind(of type: UTType) -> String? {
    if type.conforms(to: .image) { return "image" }
    if type.conforms(to: .movie) { return "video" }
    if type.conforms(to: .audio) { return "audio" }
    return nil
  }

  static func list(_ folder: String, limit: Int) -> [String: Any] {
    let (status, files) = listing(folder, limit: limit)
    return ["status": status.rawValue, "files": files]
  }

  static func listing(_ folder: String, limit: Int) -> (Status, [[String: Any]]) {
    guard limit > 0, folder.hasPrefix("/") else { return (.unavailable, []) }
    let base = URL(fileURLWithPath: folder, isDirectory: true)
    let urls: [URL]
    do {
      urls = try FileManager.default.contentsOfDirectory(
        at: base,
        includingPropertiesForKeys: keys,
        options: [.skipsHiddenFiles, .skipsSubdirectoryDescendants, .skipsPackageDescendants]
      )
    } catch {
      return (status(of: error, at: folder), [])
    }
    var found: [(added: Double, file: [String: Any])] = []
    found.reserveCapacity(min(urls.count, limit * 2))
    for url in urls {
      guard let values = try? url.resourceValues(forKeys: Set(keys)), values.isRegularFile == true,
            let type = values.contentType, let kind = kind(of: type) else { continue }
      let modified = values.contentModificationDate ?? values.creationDate ?? .distantPast
      let added = values.addedToDirectoryDate ?? values.creationDate ?? modified
      let name = url.lastPathComponent
      found.append((added.timeIntervalSince1970 * 1000, [
        "path": (folder as NSString).appendingPathComponent(name),
        "name": name,
        "size": values.fileSize ?? 0,
        "added": added.timeIntervalSince1970 * 1000,
        "modified": modified.timeIntervalSince1970 * 1000,
        "kind": kind,
      ]))
    }
    found.sort { $0.added > $1.added }
    return (.ok, found.prefix(limit).map(\.file))
  }

  static func status(of error: Error, at folder: String) -> Status {
    let failure = error as NSError
    let underlying = failure.userInfo[NSUnderlyingErrorKey] as? NSError
    let posix = underlying?.domain == NSPOSIXErrorDomain ? Int32(truncatingIfNeeded: underlying?.code ?? 0) : 0
    if failure.domain == NSCocoaErrorDomain, failure.code == NSFileReadNoPermissionError { return .denied }
    if posix == EACCES || posix == EPERM { return .denied }
    let gone = (failure.domain == NSCocoaErrorDomain && [NSFileReadNoSuchFileError, NSFileNoSuchFileError].contains(failure.code)) || posix == ENOENT || posix == ENOTDIR
    guard gone else { return .unavailable }
    return volumeMissing(for: folder) ? .unavailable : .missing
  }

  static func volumeMissing(for folder: String) -> Bool {
    let parts = (folder as NSString).standardizingPath.split(separator: "/", omittingEmptySubsequences: true)
    guard parts.count >= 2, parts[0] == "Volumes" else { return false }
    var isFolder: ObjCBool = false
    return !FileManager.default.fileExists(atPath: "/Volumes/\(parts[1])", isDirectory: &isFolder) || !isFolder.boolValue
  }
}
