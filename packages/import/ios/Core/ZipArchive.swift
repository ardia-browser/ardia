import Foundation
import zlib

struct ZipArchive {
  struct Entry {
    var name: String
    var method: UInt16
    var compressedSize: Int
    var size: Int
    var localHeaderOffset: Int
    var crc: UInt32 = 0
    var dataOffset = 0
  }

  struct Limits {
    var entries = 10_000
    var entrySize = 1 << 30
    var expanded = 4 << 30
    var ratio = 200
    var ratioFloor = 4 << 20

    static let standard = Limits()

    func inflatesTooFar(compressed: Int, size: Int) -> Bool {
      size >= ratioFloor && size / max(1, compressed) > ratio
    }
  }

  static let unixHost: UInt16 = 3
  static let fileTypeMask: UInt32 = 0o170000
  static let symbolicLink: UInt32 = 0o120000

  static func isSafeName(_ name: String) -> Bool {
    guard !name.isEmpty, !name.hasPrefix("/"), !name.contains("\\"), !name.contains("\0") else { return false }
    return !name.split(separator: "/", omittingEmptySubsequences: false).contains { $0 == ".." }
  }

  let data: Data
  let entries: [Entry]
  let limits: Limits

  init(_ data: Data, limits: Limits = .standard) throws {
    self.data = data
    self.limits = limits
    let minEOCD = 22
    guard data.count >= minEOCD else { throw ImportError.unreadable("Not a zip file") }
    var eocd: Int?
    var i = data.count - minEOCD
    let floor = max(0, data.count - minEOCD - 0xFFFF)
    while i >= floor {
      if data[i] == 0x50, data[i + 1] == 0x4B, data[i + 2] == 0x05, data[i + 3] == 0x06 { eocd = i; break }
      i -= 1
    }
    guard let eocd else { throw ImportError.unreadable("Not a zip file") }
    var r = ByteReader(data.subdata(in: eocd..<data.count))
    _ = r.skip(10)
    guard let count = r.u16(), let _ = r.u32(), let dirOffset = r.u32() else { throw ImportError.unreadable("Damaged zip file") }
    if count == 0xFFFF || dirOffset == 0xFFFF_FFFF { throw ImportError.unsupported("ZIP64 archives aren't supported") }
    guard Int(count) <= limits.entries else { throw ImportError.unsupported("The zip file has more than \(limits.entries) entries") }

    var list: [Entry] = []
    var ranges: [Range<Int>] = []
    var expanded = 0
    var offset = Int(dirOffset)
    for _ in 0..<count {
      guard offset + 46 <= data.count else { throw ImportError.unreadable("Damaged zip directory") }
      var h = ByteReader(data.subdata(in: offset..<offset + 46))
      guard h.u32() == 0x0201_4B50 else { throw ImportError.unreadable("Damaged zip directory") }
      let madeBy = h.u16() ?? 0
      _ = h.skip(2)
      let flags = h.u16() ?? 0
      let method = h.u16() ?? 0
      _ = h.skip(4)
      let crc = h.u32() ?? 0
      let csize = Int(h.u32() ?? 0)
      let usize = Int(h.u32() ?? 0)
      let nameLength = Int(h.u16() ?? 0)
      let extraLength = Int(h.u16() ?? 0)
      let commentLength = Int(h.u16() ?? 0)
      _ = h.skip(4)
      let external = h.u32() ?? 0
      let local = Int(h.u32() ?? 0)
      guard offset + 46 + nameLength <= data.count else { throw ImportError.unreadable("Damaged zip directory") }
      let nameData = data.subdata(in: offset + 46..<offset + 46 + nameLength)
      let name = String(data: nameData, encoding: flags & 0x800 != 0 ? .utf8 : .isoLatin1) ?? ""
      offset += 46 + nameLength + extraLength + commentLength
      let isLink = madeBy >> 8 == Self.unixHost && (external >> 16) & Self.fileTypeMask == Self.symbolicLink
      guard flags & 0x1 == 0, !isLink, Self.isSafeName(name) else { continue }
      guard usize <= limits.entrySize else { throw ImportError.unsupported("\(name) in the zip file is over \(limits.entrySize >> 20) MB") }
      guard !limits.inflatesTooFar(compressed: csize, size: usize) else {
        throw ImportError.unsupported("\(name) in the zip file unpacks to more than \(limits.ratio) times its size")
      }
      if method == 0, csize != usize { throw ImportError.unreadable("Damaged zip entry") }
      guard csize <= limits.entrySize else { throw ImportError.unsupported("\(name) in the zip file is over \(limits.entrySize >> 20) MB") }
      expanded += usize
      guard expanded <= limits.expanded else { throw ImportError.unsupported("The zip file unpacks to more than \(limits.expanded >> 20) MB") }
      let start = try Self.dataOffset(in: data, local: local)
      guard start <= data.count - csize else { throw ImportError.unreadable("Damaged zip entry") }
      ranges.append(local..<(start + csize))
      list.append(Entry(name: name, method: method, compressedSize: csize, size: usize, localHeaderOffset: local, crc: crc, dataOffset: start))
    }
    let sorted = ranges.sorted { $0.lowerBound < $1.lowerBound }
    for (earlier, later) in zip(sorted, sorted.dropFirst()) where later.lowerBound < earlier.upperBound {
      throw ImportError.unreadable("Damaged zip file: its entries overlap")
    }
    entries = list
  }

  static func dataOffset(in data: Data, local: Int) throws -> Int {
    guard local >= 0, local <= data.count - 30 else { throw ImportError.unreadable("Damaged zip entry") }
    var h = ByteReader(data.subdata(in: local..<local + 30))
    guard h.u32() == 0x0403_4B50 else { throw ImportError.unreadable("Damaged zip entry") }
    _ = h.skip(22)
    return local + 30 + Int(h.u16() ?? 0) + Int(h.u16() ?? 0)
  }

  func extract(_ entry: Entry) throws -> Data {
    guard entry.size <= limits.entrySize, !limits.inflatesTooFar(compressed: entry.compressedSize, size: entry.size) else {
      throw ImportError.unsupported("\(entry.name) in the zip file is too large")
    }
    let start = entry.dataOffset
    guard start >= 0, entry.compressedSize >= 0, start <= data.count - entry.compressedSize else { throw ImportError.unreadable("Damaged zip entry") }
    let body = data[(data.startIndex + start)..<(data.startIndex + start + entry.compressedSize)]
    let out: Data
    switch entry.method {
    case 0:
      out = Data(body)
    case 8:
      out = try Self.inflated(body, size: entry.size, name: entry.name)
    default:
      throw ImportError.unsupported("Unsupported zip compression method \(entry.method)")
    }
    let check = out.withUnsafeBytes { raw in raw.isEmpty ? crc32(0, nil, 0) : crc32(0, raw.bindMemory(to: Bytef.self).baseAddress, uInt(raw.count)) }
    guard UInt32(check) == entry.crc else { throw ImportError.unreadable("\(entry.name) is damaged") }
    return out
  }

  static func inflated(_ body: Data, size: Int, name: String) throws -> Data {
    var out = Data(count: size + 1)
    var stream = z_stream()
    guard inflateInit2_(&stream, -15, zlibVersion(), Int32(MemoryLayout<z_stream>.size)) == Z_OK else { throw ImportError.unreadable("Couldn't inflate \(name)") }
    defer { inflateEnd(&stream) }
    let (status, left, room) = out.withUnsafeMutableBytes { dst in
      body.withUnsafeBytes { src -> (Int32, uInt, uInt) in
        stream.next_in = UnsafeMutablePointer(mutating: src.bindMemory(to: Bytef.self).baseAddress)
        stream.avail_in = uInt(src.count)
        stream.next_out = dst.bindMemory(to: Bytef.self).baseAddress
        stream.avail_out = uInt(dst.count)
        let status = inflate(&stream, Z_FINISH)
        return (status, stream.avail_in, stream.avail_out)
      }
    }
    guard status == Z_STREAM_END, left == 0, room == 1 else { throw ImportError.unreadable("Couldn't inflate \(name)") }
    out.removeLast()
    return out
  }
}
