import Foundation

enum PackedPassages {
  static let separator = " · "
  static let defaultLimit = 600
  static let defaultCount = 24
  static let longPassage = 200

  static func size(_ passage: [String]) -> Int { passage.reduce(0) { $0 + $1.count } }

  static func packs(_ passages: [[String]], limit: Int = defaultLimit, count: Int = defaultCount) -> [Range<Int>] {
    var out: [Range<Int>] = []
    var start = 0
    var used = 0
    for (i, passage) in passages.enumerated() {
      if size(passage) >= longPassage {
        if i > start { out.append(start..<i) }
        out.append(i..<(i + 1))
        start = i + 1
        used = 0
        continue
      }
      let length = size(passage) + (i > start ? separator.count : 0)
      if i > start, used + length > limit || i - start >= count {
        out.append(start..<i)
        start = i
        used = size(passage)
        continue
      }
      used += length
    }
    if start < passages.count { out.append(start..<passages.count) }
    return out
  }

  static func text(_ passages: [[String]]) -> AttributedString {
    var text = AttributedString()
    for (p, pieces) in passages.enumerated() {
      if p > 0 {
        var gap = AttributedString(separator)
        gap.link = URL(string: "ac-gap:\(p)")
        text += gap
      }
      for (i, piece) in pieces.enumerated() {
        var run = AttributedString(piece)
        run.link = URL(string: "ac-piece:\(p).\(i)")
        text += run
      }
    }
    return text
  }

  static func parts(of translated: AttributedString, over passages: [[String]]) -> [[String]?] {
    var parts = passages.map { Array(repeating: "", count: $0.count) }
    var tagged = passages.map { Array(repeating: false, count: $0.count) }
    var broken = Array(repeating: false, count: passages.count)
    var left: Set<Int> = []
    var current: Int?
    var gapBefore: Int?
    var last: (passage: Int, piece: Int)?
    var lead = ""
    for run in translated.runs {
      let words = String(translated[run.range].characters)
      guard let link = run.link else {
        if let last { parts[last.passage][last.piece] += words } else { lead += words }
        continue
      }
      if link.scheme == "ac-gap" {
        last = nil
        lead = ""
        let next = Int(link.absoluteString.dropFirst("ac-gap:".count)) ?? -1
        gapBefore = next
        if words.contains(where: { !$0.isWhitespace && !separator.contains($0) }) {
          if let current { broken[current] = true }
          if broken.indices.contains(next) { broken[next] = true }
        }
        continue
      }
      guard link.scheme == "ac-piece", let (p, i) = index(link), passages.indices.contains(p), passages[p].indices.contains(i) else {
        return passages.map { _ in nil }
      }
      if let current, current != p {
        if gapBefore != p {
          broken[p] = true
          if gapBefore == nil { broken[current] = true }
        }
        left.insert(current)
        if left.contains(p) { broken[p] = true }
      } else if let current, gapBefore != nil {
        broken[current] = true
      } else if current == nil, gapBefore ?? 0 != p {
        broken[p] = true
      }
      current = p
      gapBefore = nil
      if last == nil {
        parts[p][i] += lead
        lead = ""
      }
      tagged[p][i] = true
      parts[p][i] += words
      last = (p, i)
    }
    let mark = separator.trimmingCharacters(in: .whitespaces)
    return passages.indices.map { p in
      guard !broken[p], !tagged[p].contains(false), !parts[p].contains(where: { $0.allSatisfy(\.isWhitespace) }) else { return nil }
      if !passages[p].joined().contains(mark), parts[p].contains(where: { $0.contains(mark) }) { return nil }
      return withSourceEdges(parts[p], of: passages[p])
    }
  }

  static func withSourceEdges(_ parts: [String], of pieces: [String]) -> [String] {
    guard let first = pieces.first, let last = pieces.last, !parts.isEmpty else { return parts }
    var out = parts
    out[0] = leadingSpace(first) + String(out[0].drop(while: \.isWhitespace))
    let end = out.count - 1
    out[end] = String(out[end].reversed().drop(while: \.isWhitespace).reversed()) + trailingSpace(last)
    return out
  }

  private static func leadingSpace(_ text: String) -> String { String(text.prefix(while: \.isWhitespace)) }

  private static func trailingSpace(_ text: String) -> String { String(text.reversed().prefix(while: \.isWhitespace).reversed()) }

  private static func index(_ link: URL) -> (Int, Int)? {
    let numbers = link.absoluteString.dropFirst("ac-piece:".count).split(separator: ".")
    guard numbers.count == 2, let p = Int(numbers[0]), let i = Int(numbers[1]) else { return nil }
    return (p, i)
  }
}
