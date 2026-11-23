import ArdiaCoreRS
import Foundation

public struct ChromiumBookmarksRead {
  public var tree: Result<BookmarkNode, ImportError>
  public var core: ImportCoreRead
}

public enum ChromiumBookmarks {
  public static func load(profile: URL) throws -> BookmarkNode {
    try read(profile: profile).tree.get()
  }

  public static func read(profile: URL) -> ChromiumBookmarksRead {
    let local = ProfileFile(profile.appendingPathComponent("Bookmarks"))
    let account = ProfileFile(profile.appendingPathComponent("AccountBookmarks"))
    var out = ardia_import_buf(ptr: nil, len: 0)
    let status = local.withArgument { localArgument in
      account.withArgument { accountArgument in
        ardia_import_chromium_bookmarks(localArgument, accountArgument, &out)
      }
    }
    let body = out.ptr.map { Data(bytes: $0, count: out.len) } ?? Data()
    ardia_import_buf_free(&out)
    let outcome = ImportCoreRead.Outcome(status)
    let core = ImportCoreRead(format: .chromiumBookmarks, backend: .rust, outcome: outcome)
    guard outcome == .ok else { return ChromiumBookmarksRead(tree: .failure(outcome.importError), core: core) }
    guard let tree = try? JSONDecoder().decode(BookmarkNode.self, from: body) else {
      return ChromiumBookmarksRead(tree: .failure(ImportCoreRead.Outcome.unreadable.importError),
                                   core: ImportCoreRead(format: .chromiumBookmarks, backend: .rust, outcome: .unreadable))
    }
    return ChromiumBookmarksRead(tree: .success(tree), core: core)
  }
}

enum ProfileFile: Equatable {
  static let maxInputBytes = 64 * 1024 * 1024

  case missing
  case unreadable
  case oversized(Int)
  case bytes(Data)

  init(_ url: URL) {
    let descriptor = open(url.path, O_RDONLY | O_NONBLOCK | O_CLOEXEC)
    guard descriptor >= 0 else {
      let failure = errno
      self = failure == ENOENT || failure == ENOTDIR ? .missing : .unreadable
      return
    }
    defer { close(descriptor) }
    var status = stat()
    guard fstat(descriptor, &status) == 0, status.st_mode & S_IFMT == S_IFREG else {
      self = .unreadable
      return
    }
    guard status.st_size <= Int64(Self.maxInputBytes) else {
      self = .oversized(Int(clamping: status.st_size))
      return
    }
    self = Self.readBounded(descriptor, expected: Int(status.st_size))
  }

  private static func readBounded(_ descriptor: Int32, expected: Int) -> ProfileFile {
    let capacity = maxInputBytes + 1
    var buffer = Data(count: min(capacity, expected + 1))
    var filled = 0
    while filled < capacity {
      if filled == buffer.count { buffer.count = min(capacity, buffer.count * 2) }
      let count = buffer.withUnsafeMutableBytes { raw in
        read(descriptor, raw.baseAddress! + filled, raw.count - filled)
      }
      if count == 0 { break }
      if count < 0 {
        if errno == EINTR { continue }
        return .unreadable
      }
      filled += count
    }
    guard filled <= maxInputBytes else { return .oversized(filled) }
    buffer.count = filled
    return .bytes(buffer)
  }

  func withArgument<T>(_ body: (UnsafePointer<ardia_import_bytes>?) -> T) -> T {
    switch self {
    case .missing:
      return body(nil)
    case .unreadable:
      var argument = ardia_import_bytes(ptr: nil, len: 0)
      return withUnsafePointer(to: &argument) { body($0) }
    case .oversized(let length):
      var argument = ardia_import_bytes(ptr: nil, len: length)
      return withUnsafePointer(to: &argument) { body($0) }
    case .bytes(let bytes):
      return bytes.withUnsafeBytes { raw in
        var argument = ardia_import_bytes(ptr: raw.bindMemory(to: UInt8.self).baseAddress, len: raw.count)
        return withUnsafePointer(to: &argument) { body($0) }
      }
    }
  }
}

extension ImportCoreRead.Outcome {
  init(_ status: ardia_import_status) {
    switch status {
    case ARDIA_IMPORT_STATUS_OK: self = .ok
    case ARDIA_IMPORT_STATUS_NOT_FOUND: self = .notFound
    case ARDIA_IMPORT_STATUS_TOO_LARGE: self = .tooLarge
    case ARDIA_IMPORT_STATUS_INVALID_ARGUMENT: self = .argument
    default: self = .unreadable
    }
  }

  var importError: ImportError {
    switch self {
    case .notFound: .notFound("No bookmarks in this profile")
    case .tooLarge: .unreadable("Bookmarks file is over 64 MB")
    case .ok, .unreadable, .argument: .unreadable("Bookmarks file is not Chromium bookmarks JSON")
    }
  }
}
