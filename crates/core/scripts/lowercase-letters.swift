import Foundation

var ranges: [(UInt32, UInt32)] = []
var start: UInt32?
for value in UInt32(0)...UInt32(0x10FFFF) {
  let member = Unicode.Scalar(value).map { CharacterSet.lowercaseLetters.contains($0) } ?? false
  if member, start == nil { start = value }
  if !member, let first = start {
    ranges.append((first, value - 1))
    start = nil
  }
}
if let first = start { ranges.append((first, 0x10FFFF)) }
var out = "#[rustfmt::skip]\npub(crate) const LOWERCASE_LETTERS: [(u32, u32); \(ranges.count)] = [\n"
for (first, last) in ranges { out += String(format: "    (0x%X, 0x%X),\n", first, last) }
out += "];\n"
FileHandle.standardOutput.write(Data(out.utf8))
