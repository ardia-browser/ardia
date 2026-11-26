import Foundation

struct PluginUtf8Chunks {
  private var carry = Data()

  static func completeLength(_ bytes: Data) -> Int {
    let count = bytes.count
    guard count > 0 else { return 0 }
    var back = 0
    var index = bytes.index(before: bytes.endIndex)
    while back < 3, index >= bytes.startIndex {
      let byte = bytes[index]
      if byte & 0xC0 != 0x80 {
        let needed = byte >= 0xF0 ? 4 : byte >= 0xE0 ? 3 : byte >= 0xC0 ? 2 : 1
        return back + 1 < needed ? count - back - 1 : count
      }
      back += 1
      guard index > bytes.startIndex else { break }
      index = bytes.index(before: index)
    }
    return count
  }

  mutating func text(_ data: Data) -> String {
    var joined = carry
    joined.append(data)
    let usable = Self.completeLength(joined)
    carry = Data(joined.suffix(from: joined.startIndex + usable))
    return String(decoding: joined.prefix(usable), as: UTF8.self)
  }

  mutating func finish() -> String {
    defer { carry = Data() }
    return carry.isEmpty ? "" : String(decoding: carry, as: UTF8.self)
  }
}
