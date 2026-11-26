import Foundation

enum VaultActivity {
  static let maxBytes = 4 << 20

  static func append(_ lines: [String], to url: URL, folder: () -> Void) -> Bool {
    guard !lines.isEmpty else { return true }
    folder()
    var data = Data()
    for line in lines {
      data.append(Data(line.utf8))
      data.append(10)
    }
    if !FileManager.default.fileExists(atPath: url.path) {
      guard FileManager.default.createFile(atPath: url.path, contents: nil, attributes: [.posixPermissions: 0o600]) else { return false }
    }
    guard let handle = try? FileHandle(forWritingTo: url) else { return false }
    defer { try? handle.close() }
    guard let end = try? handle.seekToEnd(), (try? handle.write(contentsOf: data)) != nil else { return false }
    if end + UInt64(data.count) > UInt64(maxBytes) { trim(url) }
    return true
  }

  static func read(_ url: URL, limit: Int) -> [String] {
    guard let data = try? Data(contentsOf: url) else { return [] }
    let lines = data.split(separator: 10, omittingEmptySubsequences: true)
    return lines.suffix(limit).map { String(decoding: $0, as: UTF8.self) }
  }

  private static func trim(_ url: URL) {
    guard let data = try? Data(contentsOf: url) else { return }
    let keep = data.suffix(maxBytes / 2)
    guard let start = keep.firstIndex(of: 10) else { return }
    try? Data(keep[keep.index(after: start)...]).write(to: url, options: [.atomic])
    try? FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: url.path)
  }
}
