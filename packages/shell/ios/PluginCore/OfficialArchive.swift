import CryptoKit
import Darwin
import Foundation
import zlib

enum OfficialArchive {
  struct Limits {
    var download: Int64 = 512 << 20
    var expanded: Int64 = 1 << 30
    var entries = 20_000
    var depth = 32
    var ratio: Int64 = 100
    var entryRatio: Int64 = 200
    var ratioFloor: Int64 = 4 << 20

    static let standard = Limits()

    func expandedAllowed(compressed: Int64) -> Int64 {
      min(expanded, max(ratioFloor, compressed.multipliedReportingOverflow(by: ratio).overflow ? Int64.max : compressed * ratio))
    }
  }

  static let maxDownload = Limits.standard.download
  static let maxDepth = Limits.standard.depth

  struct Inflation {
    private(set) var produced: [Int64] = [0]
    private(set) var consumed: [Int64] = [0]

    mutating func mark(produced output: Int64, consumed input: Int64) {
      produced.append(output)
      consumed.append(input)
    }

    func compressed(from start: Int64, to end: Int64) -> Int64 {
      var low = 0
      var high = produced.count - 1
      while low < high {
        let middle = (low + high + 1) / 2
        if produced[middle] <= start { low = middle } else { high = middle - 1 }
      }
      let before = consumed[low]
      var first = produced.count - 1
      var lower = 0
      var upper = produced.count - 1
      while lower <= upper {
        let middle = (lower + upper) / 2
        if produced[middle] >= end {
          first = middle
          upper = middle - 1
        } else {
          lower = middle + 1
        }
      }
      return max(1, consumed[first] - before)
    }
  }

  private static let block = 512
  private static let chunk = 1 << 20
  private static let step = 4 << 10

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

  static func snapshot(_ path: String, in scratch: String, limits: Limits = .standard) -> Snapshot? {
    let input = open(path, O_RDONLY | O_NOFOLLOW | O_CLOEXEC)
    guard input >= 0 else { return nil }
    defer { Darwin.close(input) }
    var info = stat()
    guard fstat(input, &info) == 0, (info.st_mode & S_IFMT) == S_IFREG, info.st_size <= limits.download, let output = anonymousFile(in: scratch) else { return nil }
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
      guard total <= limits.download, writeAll(output, buffer, count) else {
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

  static func unpack(_ archive: Int32, top: String, into stage: Int32, scratch: String, limits: Limits = .standard) -> String? {
    guard let tar = anonymousFile(in: scratch) else { return "the download couldn't be unpacked" }
    defer { Darwin.close(tar) }
    var inflation = Inflation()
    if let problem = gunzip(input: archive, output: tar, limits: limits, inflation: &inflation) { return problem }
    return extract(tar: tar, top: top, into: stage, limits: limits, inflation: inflation)
  }

  static func gunzip(input: Int32, output: Int32, limits: Limits, inflation: inout Inflation) -> String? {
    guard lseek(input, 0, SEEK_SET) == 0 else { return "the download couldn't be read" }
    var sized = stat()
    guard fstat(input, &sized) == 0 else { return "the download couldn't be read" }
    var magic = [UInt8](repeating: 0, count: 3)
    guard pread(input, &magic, 3, 0) == 3, magic == [0x1f, 0x8b, 8] else { return "the download isn't a gzip file" }
    let limit = limits.expandedAllowed(compressed: Int64(sized.st_size))
    var stream = z_stream()
    guard inflateInit2_(&stream, 15 + 16, zlibVersion(), Int32(MemoryLayout<z_stream>.size)) == Z_OK else { return "the download couldn't be unpacked" }
    defer { inflateEnd(&stream) }
    let source = UnsafeMutablePointer<UInt8>.allocate(capacity: chunk)
    let target = UnsafeMutablePointer<UInt8>.allocate(capacity: chunk)
    defer {
      source.deallocate()
      target.deallocate()
    }
    var fed: Int64 = 0
    var written: Int64 = 0
    var buffered = 0
    func flush() -> String? {
      var offset = 0
      while offset < buffered {
        let count = write(output, target + offset, buffered - offset)
        if count < 0 {
          if errno == EINTR { continue }
          return "the download couldn't be unpacked (\(String(cString: strerror(errno))))"
        }
        offset += count
      }
      buffered = 0
      return nil
    }
    var atEnd = false
    while true {
      if stream.avail_in == 0 && !atEnd {
        let count = read(input, source, chunk)
        if count < 0 {
          if errno == EINTR { continue }
          return "the download couldn't be read"
        }
        atEnd = count == 0
        stream.next_in = source
        stream.avail_in = uInt(count)
      }
      if buffered + step > chunk, let problem = flush() { return problem }
      let before = stream.avail_in
      stream.next_out = target + buffered
      stream.avail_out = uInt(step)
      let status = inflate(&stream, Z_NO_FLUSH)
      let produced = step - Int(stream.avail_out)
      fed += Int64(before - stream.avail_in)
      if produced > 0 {
        buffered += produced
        written += Int64(produced)
        inflation.mark(produced: written, consumed: fed)
        guard written <= limits.expanded else { return "the download unpacks to more than \(limits.expanded >> 20) MB" }
        guard written <= limit else { return "the download unpacks to more than \(limits.ratio) times its size" }
      }
      if status == Z_STREAM_END { break }
      if status == Z_BUF_ERROR && atEnd && stream.avail_in == 0 { return "the download ends too soon" }
      guard status == Z_OK || status == Z_BUF_ERROR else { return "the download is damaged" }
    }
    if let problem = flush() { return problem }
    var extra: UInt8 = 0
    guard stream.avail_in == 0, fed == Int64(sized.st_size), read(input, &extra, 1) == 0 else { return "the download has data after its archive" }
    return nil
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

  static func parts(_ path: String, top: String, depth: Int = maxDepth) -> [String]? {
    var trimmed = path
    while trimmed.hasSuffix("/") { trimmed.removeLast() }
    let pieces = trimmed.split(separator: "/", omittingEmptySubsequences: false).map(String.init)
    guard let first = pieces.first, first == top, pieces.count <= depth else { return nil }
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
        length <= bytes.count - at, bytes[at + length - 1] == 0x0a, let equals = bytes[(space + 1)..<(at + length)].firstIndex(of: 0x3d)
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

  static func extract(tar: Int32, top: String, into stage: Int32, limits: Limits, inflation: Inflation) -> String? {
    var out: Int32 = -1
    let problem = walk(
      tar: tar, top: top, limits: limits, inflation: inflation,
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

  static func verifiedPayloadDigest(archive: String, sha: String, top: String, scratch: String, limits: Limits = .standard) -> String? {
    guard let held = snapshot(archive, in: scratch, limits: limits) else { return nil }
    defer { held.close() }
    guard held.sha == sha else { return nil }
    return payloadDigest(archive: held.fd, top: top, scratch: scratch, limits: limits)
  }

  static func payloadDigest(archive: Int32, top: String, scratch: String, limits: Limits = .standard) -> String? {
    guard let tar = anonymousFile(in: scratch) else { return nil }
    defer { Darwin.close(tar) }
    var inflation = Inflation()
    guard gunzip(input: archive, output: tar, limits: limits, inflation: &inflation) == nil else { return nil }
    var listing: [(String, String)] = []
    var hasher = SHA256()
    let skipped: (String) -> Bool = { _ in false }
    let problem = walk(
      tar: tar, top: top, limits: limits, inflation: inflation,
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
    tar fd: Int32, top: String, limits: Limits, inflation: Inflation, folder: (String) -> String?, file: (String, Int64) -> String?,
    bytes: (String, Data) -> String?, done: (String, Bool) -> String?
  ) -> String? {
    guard lseek(fd, 0, SEEK_SET) == 0 else { return "the download couldn't be unpacked" }
    var position: Int64 = 0
    func readExactly(_ count: Int) -> [UInt8]? {
      var bytes = [UInt8](repeating: 0, count: count)
      var offset = 0
      while offset < count {
        let got = bytes.withUnsafeMutableBytes { read(fd, $0.baseAddress! + offset, count - offset) }
        if got < 0 && errno == EINTR { continue }
        guard got > 0 else { return nil }
        offset += got
      }
      position += Int64(count)
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
        guard folders.count + files.count <= limits.entries else { return "the archive has more than \(limits.entries) entries" }
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
      guard entries <= limits.entries else { return "the archive has more than \(limits.entries) entries" }
      let padded = Int((entry.size + Int64(block) - 1) / Int64(block)) * block
      if entry.type == UInt8(ascii: "x") {
        guard nextPath == nil, entry.size <= 64 * 1024, let body = readExactly(padded) else { return "the archive is damaged" }
        guard let path = paxPath(Data(body.prefix(Int(entry.size)))) else { return "the archive has an extended header Ardia doesn't accept" }
        nextPath = path ?? ""
        continue
      }
      let path = nextPath.flatMap { $0.isEmpty ? nil : $0 } ?? entry.path
      nextPath = nil
      guard let relative = parts(path, top: top, depth: limits.depth) else { return "\(path) isn't inside \(top)/ or is more than \(limits.depth) folders deep" }
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
        guard total <= limits.expanded else { return "the archive unpacks to more than \(limits.expanded >> 20) MB" }
        if relative.count > 1, let problem = makeFolders(Array(relative.dropLast())) { return problem }
        guard !folders.contains(joined) else { return "\(path) is both a file and a folder" }
        guard folders.count + files.count <= limits.entries else { return "the archive has more than \(limits.entries) entries" }
        let start = position
        if entry.size >= limits.ratioFloor, entry.size / inflation.compressed(from: start, to: start + entry.size) > limits.entryRatio {
          return "\(path) unpacks to more than \(limits.entryRatio) times its compressed size"
        }
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
