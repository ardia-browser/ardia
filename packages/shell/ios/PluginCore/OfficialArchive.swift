import Compression
import CryptoKit
import Darwin
import Foundation

enum OfficialArchive {
  static let maxDownload: Int64 = 512 << 20
  static let maxExpanded: Int64 = 1 << 30
  static let maxEntries = 20_000
  static let maxDepth = 32
  private static let block = 512
  private static let chunk = 1 << 20

  static func sha256(file path: String) -> String? {
    let fd = open(path, O_RDONLY | O_NOFOLLOW | O_CLOEXEC)
    guard fd >= 0 else { return nil }
    defer { close(fd) }
    var info = stat()
    guard fstat(fd, &info) == 0, (info.st_mode & S_IFMT) == S_IFREG else { return nil }
    var hasher = SHA256()
    let buffer = UnsafeMutableRawPointer.allocate(byteCount: chunk, alignment: 16)
    defer { buffer.deallocate() }
    while true {
      let count = read(fd, buffer, chunk)
      if count < 0 {
        if errno == EINTR { continue }
        return nil
      }
      if count == 0 { break }
      hasher.update(bufferPointer: UnsafeRawBufferPointer(start: buffer, count: count))
    }
    return hasher.finalize().map { String(format: "%02x", $0) }.joined()
  }

  struct Snapshot {
    let fd: Int32
    let sha: String

    func close() { Darwin.close(fd) }
  }

  static func anonymousFile(in folder: String) -> Int32? {
    let path = (folder as NSString).appendingPathComponent(".snapshot-\(getpid())-\(UInt32.random(in: 0...UInt32.max))")
    let fd = open(path, O_RDWR | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0o600)
    guard fd >= 0 else { return nil }
    guard unlink(path) == 0 else {
      Darwin.close(fd)
      return nil
    }
    return fd
  }

  static func snapshot(_ path: String, in scratch: String) -> Snapshot? {
    let input = open(path, O_RDONLY | O_NOFOLLOW | O_CLOEXEC)
    guard input >= 0 else { return nil }
    defer { Darwin.close(input) }
    var info = stat()
    guard fstat(input, &info) == 0, (info.st_mode & S_IFMT) == S_IFREG, info.st_size <= maxDownload, let output = anonymousFile(in: scratch) else { return nil }
    var hasher = SHA256()
    let buffer = UnsafeMutableRawPointer.allocate(byteCount: chunk, alignment: 16)
    defer { buffer.deallocate() }
    var total: Int64 = 0
    while true {
      let count = read(input, buffer, chunk)
      if count < 0 && errno == EINTR { continue }
      if count < 0 {
        Darwin.close(output)
        return nil
      }
      if count == 0 { break }
      total += Int64(count)
      guard total <= maxDownload, writeAll(output, buffer, count) else {
        Darwin.close(output)
        return nil
      }
      hasher.update(bufferPointer: UnsafeRawBufferPointer(start: buffer, count: count))
    }
    guard lseek(output, 0, SEEK_SET) == 0 else {
      Darwin.close(output)
      return nil
    }
    return Snapshot(fd: output, sha: hasher.finalize().map { String(format: "%02x", $0) }.joined())
  }

  static func writeAll(_ fd: Int32, _ bytes: UnsafeRawPointer, _ count: Int) -> Bool {
    var offset = 0
    while offset < count {
      let wrote = write(fd, bytes + offset, count - offset)
      if wrote < 0 {
        if errno == EINTR { continue }
        return false
      }
      offset += wrote
    }
    return true
  }

  static func copyAll(from input: Int32, to output: Int32) -> Bool {
    guard lseek(input, 0, SEEK_SET) == 0 else { return false }
    let buffer = UnsafeMutableRawPointer.allocate(byteCount: chunk, alignment: 16)
    defer { buffer.deallocate() }
    while true {
      let count = read(input, buffer, chunk)
      if count < 0 && errno == EINTR { continue }
      if count < 0 { return false }
      if count == 0 { return true }
      guard writeAll(output, buffer, count) else { return false }
    }
  }

  static func unpack(_ archive: Int32, top: String, into stage: Int32, scratch: String) -> String? {
    guard let tar = anonymousFile(in: scratch) else { return "the download couldn't be unpacked" }
    defer { Darwin.close(tar) }
    if let problem = gunzip(input: archive, output: tar, limit: maxExpanded) { return problem }
    return extract(tar: tar, top: top, into: stage, limit: maxExpanded)
  }

  static func gunzip(input: Int32, output: Int32, limit: Int64) -> String? {
    guard lseek(input, 0, SEEK_SET) == 0 else { return "the download couldn't be read" }
    var data = Data()
    var headerLength: Int?
    while headerLength == nil {
      var piece = [UInt8](repeating: 0, count: 64 * 1024)
      let count = read(input, &piece, piece.count)
      if count < 0 && errno == EINTR { continue }
      guard count > 0 else { return "the download isn't a gzip file" }
      data.append(piece, count: count)
      switch gzipHeaderLength(data) {
      case .some(.some(let length)): headerLength = length
      case .some(.none): return "the download isn't a gzip file"
      case .none: if data.count > 1 << 20 { return "the download isn't a gzip file" }
      }
    }
    let stream = UnsafeMutablePointer<compression_stream>.allocate(capacity: 1)
    defer { stream.deallocate() }
    guard compression_stream_init(stream, COMPRESSION_STREAM_DECODE, COMPRESSION_ZLIB) == COMPRESSION_STATUS_OK else { return "the download couldn't be unpacked" }
    defer { compression_stream_destroy(stream) }
    let source = UnsafeMutablePointer<UInt8>.allocate(capacity: chunk)
    let target = UnsafeMutablePointer<UInt8>.allocate(capacity: chunk)
    defer {
      source.deallocate()
      target.deallocate()
    }
    var pending = Data(data.dropFirst(headerLength!))
    var written: Int64 = 0
    var atEnd = false
    var finished = false
    while !finished {
      if pending.isEmpty && !atEnd {
        let count = read(input, source, chunk)
        if count < 0 {
          if errno == EINTR { continue }
          return "the download couldn't be read"
        }
        if count == 0 { atEnd = true } else { pending = Data(bytes: source, count: count) }
      }
      let consumed: Int = pending.withUnsafeBytes { raw -> Int in
        stream.pointee.src_ptr = raw.bindMemory(to: UInt8.self).baseAddress ?? UnsafePointer(source)
        stream.pointee.src_size = raw.count
        stream.pointee.dst_ptr = target
        stream.pointee.dst_size = chunk
        let status = compression_stream_process(stream, atEnd ? Int32(COMPRESSION_STREAM_FINALIZE.rawValue) : 0)
        if status == COMPRESSION_STATUS_ERROR { return -1 }
        if status == COMPRESSION_STATUS_END { finished = true }
        return raw.count - stream.pointee.src_size
      }
      guard consumed >= 0 else { return "the download is damaged" }
      let produced = chunk - stream.pointee.dst_size
      if produced > 0 {
        written += Int64(produced)
        guard written <= limit else { return "the download unpacks to more than \(limit >> 20) MB" }
        var offset = 0
        while offset < produced {
          let count = write(output, target + offset, produced - offset)
          if count < 0 {
            if errno == EINTR { continue }
            return "the download couldn't be unpacked (\(String(cString: strerror(errno))))"
          }
          offset += count
        }
      }
      pending = Data(pending.dropFirst(consumed))
      if !finished && atEnd && pending.isEmpty && produced == 0 { return "the download ends too soon" }
    }
    var info = stat()
    guard fstat(input, &info) == 0, info.st_size >= 18 else { return "the download is damaged" }
    var tail = [UInt8](repeating: 0, count: 8)
    guard pread(input, &tail, 8, info.st_size - 8) == 8 else { return "the download couldn't be read" }
    let size = UInt32(tail[4]) | UInt32(tail[5]) << 8 | UInt32(tail[6]) << 16 | UInt32(tail[7]) << 24
    guard size == UInt32(truncatingIfNeeded: written) else { return "the download is damaged" }
    return nil
  }

  static func gzipHeaderLength(_ data: Data) -> Int?? {
    let bytes = [UInt8](data.prefix(1 << 20))
    guard bytes.count >= 10 else { return .none }
    guard bytes[0] == 0x1f, bytes[1] == 0x8b, bytes[2] == 8, bytes[3] & 0xe0 == 0 else { return .some(nil) }
    let flags = bytes[3]
    var at = 10
    if flags & 0x04 != 0 {
      guard bytes.count >= at + 2 else { return .none }
      at += 2 + Int(bytes[at]) + Int(bytes[at + 1]) << 8
    }
    for flag: UInt8 in [0x08, 0x10] where flags & flag != 0 {
      guard let end = bytes[min(at, bytes.count)...].firstIndex(of: 0) else { return .none }
      at = end + 1
    }
    if flags & 0x02 != 0 { at += 2 }
    return bytes.count >= at ? .some(at) : .none
  }

  struct Header {
    let path: String
    let type: UInt8
    let mode: Int
    let size: Int64
  }

  static func octal(_ bytes: ArraySlice<UInt8>) -> Int64? {
    var value: Int64 = 0
    var seen = false
    for byte in bytes {
      if byte == 0 || byte == 0x20 {
        if seen { break } else { continue }
      }
      guard byte >= 0x30 && byte <= 0x37 else { return nil }
      seen = true
      value = value * 8 + Int64(byte - 0x30)
      guard value < 1 << 40 else { return nil }
    }
    return seen ? value : 0
  }

  static func text(_ bytes: ArraySlice<UInt8>) -> String? {
    let used = bytes.prefix { $0 != 0 }
    return String(bytes: used, encoding: .utf8)
  }

  static func header(_ raw: [UInt8]) -> Header?? {
    if raw.allSatisfy({ $0 == 0 }) { return .some(nil) }
    guard let sum = octal(raw[148..<156]) else { return .none }
    var computed: Int64 = 0
    for (index, byte) in raw.enumerated() { computed += Int64(index >= 148 && index < 156 ? 0x20 : byte) }
    guard computed == sum, let name = text(raw[0..<100]), let mode = octal(raw[100..<108]), let size = octal(raw[124..<136]) else { return .none }
    var path = name
    if Array(raw[257..<262]) == Array("ustar".utf8), let prefix = text(raw[345..<500]), !prefix.isEmpty { path = prefix + "/" + name }
    return .some(Header(path: path, type: raw[156], mode: Int(mode), size: size))
  }

  static func parts(_ path: String, top: String) -> [String]? {
    var trimmed = path
    while trimmed.hasSuffix("/") { trimmed.removeLast() }
    let pieces = trimmed.split(separator: "/", omittingEmptySubsequences: false).map(String.init)
    guard let first = pieces.first, first == top, pieces.count <= maxDepth else { return nil }
    for piece in pieces {
      guard !piece.isEmpty, piece != ".", piece != "..", piece.utf8.count <= 255,
        !piece.unicodeScalars.contains(where: { $0.value < 0x20 || $0.value == 0x7f })
      else { return nil }
    }
    return Array(pieces.dropFirst())
  }

  static func paxPath(_ data: Data) -> String?? {
    let bytes = [UInt8](data)
    var path: String?
    var at = 0
    while at < bytes.count {
      guard let space = bytes[at...].firstIndex(of: 0x20), let length = Int(String(decoding: bytes[at..<space], as: UTF8.self)), length > space - at + 1,
        at + length <= bytes.count, bytes[at + length - 1] == 0x0a, let equals = bytes[(space + 1)..<(at + length)].firstIndex(of: 0x3d)
      else { return .none }
      let key = String(decoding: bytes[(space + 1)..<equals], as: UTF8.self)
      if key == "size" || key == "linkpath" { return .none }
      if key == "path" {
        guard let value = String(bytes: bytes[(equals + 1)..<(at + length - 1)], encoding: .utf8) else { return .none }
        path = value
      }
      at += length
    }
    return .some(path)
  }

  static func openParent(_ stage: Int32, of path: String) -> (folder: Int32, name: String)? {
    let parts = path.split(separator: "/", omittingEmptySubsequences: false).map(String.init)
    guard let name = parts.last, !name.isEmpty, parts.allSatisfy({ !$0.isEmpty && $0 != "." && $0 != ".." }) else { return nil }
    var current = dup(stage)
    guard current >= 0 else { return nil }
    for part in parts.dropLast() {
      let next = openat(current, part, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
      Darwin.close(current)
      guard next >= 0 else { return nil }
      current = next
    }
    return (current, name)
  }

  static func extract(tar: Int32, top: String, into stage: Int32, limit: Int64) -> String? {
    var out: Int32 = -1
    let problem = walk(
      tar: tar, top: top, limit: limit,
      folder: { path in
        guard let parent = openParent(stage, of: path) else { return "\(path) couldn't be made (its folder changed while it was unpacked)" }
        defer { Darwin.close(parent.folder) }
        return mkdirat(parent.folder, parent.name, 0o755) == 0 ? nil : "\(path) couldn't be made (\(String(cString: strerror(errno))))"
      },
      file: { path, _ in
        guard let parent = openParent(stage, of: path) else { return "\(path) couldn't be written (its folder changed while it was unpacked)" }
        defer { Darwin.close(parent.folder) }
        out = openat(parent.folder, parent.name, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0o600)
        return out >= 0 ? nil : "\(path) couldn't be written (\(String(cString: strerror(errno))))"
      },
      bytes: { path, chunk in
        var offset = 0
        while offset < chunk.count {
          let count = chunk.withUnsafeBytes { write(out, $0.baseAddress! + offset, chunk.count - offset) }
          if count < 0 {
            if errno == EINTR { continue }
            return "\(path) couldn't be written (\(String(cString: strerror(errno))))"
          }
          offset += count
        }
        return nil
      },
      done: { path, executable in
        defer {
          close(out)
          out = -1
        }
        return fchmod(out, executable ? 0o755 : 0o644) == 0 ? nil : "\(path) couldn't be written"
      })
    if out >= 0 { Darwin.close(out) }
    return problem
  }

  static func verifiedPayloadDigest(archive: String, sha: String, top: String, scratch: String, limit: Int64 = maxExpanded) -> String? {
    guard let held = snapshot(archive, in: scratch) else { return nil }
    defer { held.close() }
    guard held.sha == sha else { return nil }
    return payloadDigest(archive: held.fd, top: top, scratch: scratch, limit: limit)
  }

  static func payloadDigest(archive: Int32, top: String, scratch: String, limit: Int64 = maxExpanded) -> String? {
    guard let tar = anonymousFile(in: scratch) else { return nil }
    defer { Darwin.close(tar) }
    guard gunzip(input: archive, output: tar, limit: limit) == nil else { return nil }
    var listing: [(String, String)] = []
    var hasher = SHA256()
    let skipped: (String) -> Bool = { _ in false }
    let problem = walk(
      tar: tar, top: top, limit: limit,
      folder: { path in
        if !skipped(path) { listing.append((path, "d \(path)\n")) }
        return nil
      },
      file: { _, _ in
        hasher = SHA256()
        return nil
      },
      bytes: { _, chunk in
        hasher.update(data: chunk)
        return nil
      },
      done: { path, executable in
        let digest = hasher.finalize().map { String(format: "%02x", $0) }.joined()
        if !skipped(path) { listing.append((path, "f \(executable ? "755" : "644") \(digest) \(path)\n")) }
        return nil
      })
    guard problem == nil else { return nil }
    var whole = Data()
    for (_, line) in listing.sorted(by: { Array($0.0.utf8).lexicographicallyPrecedes(Array($1.0.utf8)) }) { whole.append(Data(line.utf8)) }
    return SHA256.hash(data: whole).map { String(format: "%02x", $0) }.joined()
  }

  private static func walk(
    tar fd: Int32, top: String, limit: Int64, folder: (String) -> String?, file: (String, Int64) -> String?, bytes: (String, Data) -> String?,
    done: (String, Bool) -> String?
  ) -> String? {
    guard lseek(fd, 0, SEEK_SET) == 0 else { return "the download couldn't be unpacked" }
    func readExactly(_ count: Int) -> [UInt8]? {
      var bytes = [UInt8](repeating: 0, count: count)
      var offset = 0
      while offset < count {
        let got = bytes.withUnsafeMutableBytes { read(fd, $0.baseAddress! + offset, count - offset) }
        if got < 0 && errno == EINTR { continue }
        guard got > 0 else { return nil }
        offset += got
      }
      return bytes
    }
    var seen: Set<String> = []
    var folders: Set<String> = [""]
    var files: Set<String> = []
    func makeFolders(_ relative: [String]) -> String? {
      var path = ""
      for part in relative {
        path = path.isEmpty ? part : "\(path)/\(part)"
        if folders.contains(path) { continue }
        guard !files.contains(path) else { return "\(path) is both a file and a folder" }
        if let problem = folder(path) { return problem }
        folders.insert(path)
      }
      return nil
    }
    var total: Int64 = 0
    var entries = 0
    var nextPath: String?
    while true {
      guard let raw = readExactly(block) else { return "the archive ends too soon" }
      guard let parsed = header(raw) else { return "the archive is damaged" }
      guard let entry = parsed else { break }
      entries += 1
      guard entries <= maxEntries else { return "the archive has more than \(maxEntries) entries" }
      let padded = Int((entry.size + Int64(block) - 1) / Int64(block)) * block
      if entry.type == UInt8(ascii: "x") {
        guard nextPath == nil, entry.size <= 64 * 1024, let body = readExactly(padded) else { return "the archive is damaged" }
        guard let path = paxPath(Data(body.prefix(Int(entry.size)))) else { return "the archive has an extended header Ardia doesn't accept" }
        nextPath = path ?? ""
        continue
      }
      let path = nextPath.flatMap { $0.isEmpty ? nil : $0 } ?? entry.path
      nextPath = nil
      guard let relative = parts(path, top: top) else { return "\(path) isn't inside \(top)/" }
      if relative.contains(where: { PluginPrograms.folded($0) == PluginPrograms.caches }) || relative.first.map(PluginPrograms.isReserved) == true {
        return "\(path) is a name Ardia keeps for itself"
      }
      let joined = relative.joined(separator: "/")
      guard !seen.contains(joined) else { return "\(path) is in the archive twice" }
      seen.insert(joined)
      switch entry.type {
      case UInt8(ascii: "5"):
        guard entry.size == 0 else { return "the archive is damaged" }
        if relative.isEmpty { continue }
        if let problem = makeFolders(relative) { return problem }
      case UInt8(ascii: "0"), 0:
        guard !relative.isEmpty else { return "\(path) isn't inside \(top)/" }
        total += entry.size
        guard total <= limit else { return "the archive unpacks to more than \(limit >> 20) MB" }
        if relative.count > 1, let problem = makeFolders(Array(relative.dropLast())) { return problem }
        guard !folders.contains(joined) else { return "\(path) is both a file and a folder" }
        if let problem = file(joined, entry.size) { return problem }
        files.insert(joined)
        var left = entry.size
        while left > 0 {
          let take = Int(min(left, Int64(chunk)))
          guard let chunkBytes = readExactly(take) else { return "the archive ends too soon" }
          if let problem = bytes(joined, Data(chunkBytes)) { return problem }
          left -= Int64(take)
        }
        if let problem = done(joined, entry.mode & 0o111 != 0) { return problem }
        let skip = padded - Int(entry.size)
        if skip > 0 && readExactly(skip) == nil { return "the archive ends too soon" }
      default:
        return "\(path) is a link or a special file; an official plugin has only files and folders"
      }
    }
    guard files.contains(PluginFiles.manifestName) else { return "the archive has no \(top)/\(PluginFiles.manifestName)" }
    return nil
  }
}
