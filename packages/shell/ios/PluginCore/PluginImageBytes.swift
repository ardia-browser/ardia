import Darwin
import Foundation

enum PluginImageBytes {
  static let maxBytes = 4 << 20

  static func mimeType(_ data: Data) -> String? {
    let bytes = [UInt8](data.prefix(12))
    if bytes.starts(with: [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]) { return "image/png" }
    if bytes.starts(with: [0xFF, 0xD8, 0xFF]) { return "image/jpeg" }
    if bytes.starts(with: Array("GIF87a".utf8)) || bytes.starts(with: Array("GIF89a".utf8)) { return "image/gif" }
    if bytes.count >= 12, bytes.starts(with: Array("RIFF".utf8)), Array(bytes[8..<12]) == Array("WEBP".utf8) { return "image/webp" }
    return nil
  }

  static func dataURL(_ data: Data) -> String? {
    guard data.count <= maxBytes, let mime = mimeType(data) else { return nil }
    return "data:\(mime);base64,\(data.base64EncodedString())"
  }

  static func read(_ relative: String, in folder: OpenedFolder) -> Result<String, FolderRefusal> {
    guard PluginFiles.pathParts(relative) != nil else { return .failure(FolderRefusal(reason: "the path isn't a plain path inside the plugin's folder")) }
    let fd = PluginFiles.openBeneath(folder.fd, relative, flags: O_RDONLY | O_NONBLOCK)
    if fd < 0 { return .failure(FolderRefusal(reason: errno == ELOOP ? "the path goes through a link" : "the image wasn't found")) }
    defer { Darwin.close(fd) }
    var info = stat()
    guard fstat(fd, &info) == 0, (info.st_mode & S_IFMT) == S_IFREG else { return .failure(FolderRefusal(reason: "the path isn't a file")) }
    guard info.st_size <= off_t(maxBytes), let data = PluginFiles.readAll(fd, limit: maxBytes) else { return .failure(FolderRefusal(reason: "the image is over \(maxBytes >> 20) MB")) }
    guard let url = dataURL(data) else { return .failure(FolderRefusal(reason: "the file isn't a PNG, JPEG, GIF or WebP image")) }
    return .success(url)
  }
}
