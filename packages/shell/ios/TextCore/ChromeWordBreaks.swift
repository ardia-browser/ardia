import Foundation

enum ChromeWordBreaks {
  static func words(in text: String, splittingLetterStops: Bool = true) -> [Range<Int>] {
    let string = text as NSString
    var words: [Range<Int>] = []
    string.enumerateSubstrings(in: NSRange(location: 0, length: string.length), options: [.byWords, .substringNotRequired]) { _, range, _, _ in
      let word = range.location..<NSMaxRange(range)
      words += splittingLetterStops ? splitAtLetterStops(word, in: string) : [word]
    }
    return words
  }

  static func wordStart(before offset: Int, in text: String, splittingLetterStops: Bool = true) -> Int {
    words(in: text, splittingLetterStops: splittingLetterStops).last { $0.lowerBound < offset }?.lowerBound ?? 0
  }

  static func wordEnd(after offset: Int, in text: String, splittingLetterStops: Bool = true) -> Int {
    words(in: text, splittingLetterStops: splittingLetterStops).first { $0.upperBound > offset }?.upperBound ?? (text as NSString).length
  }

  static func stop(forward: Bool, from offset: Int, in text: String, splittingLetterStops: Bool = true) -> Int {
    forward
      ? wordEnd(after: offset, in: text, splittingLetterStops: splittingLetterStops)
      : wordStart(before: offset, in: text, splittingLetterStops: splittingLetterStops)
  }

  struct Extension: Equatable {
    let anchor: Int
    let from: Int
    let stop: Int
    var range: Range<Int> { min(anchor, stop)..<max(anchor, stop) }
  }

  static func extend(_ selection: Range<Int>, keptAnchor: Int?, activeEndAtStart: Bool, forward: Bool, in text: String, splittingLetterStops: Bool = true) -> Extension {
    let anchor = keptAnchor.flatMap { $0 == selection.lowerBound || $0 == selection.upperBound ? $0 : nil }
      ?? (activeEndAtStart ? selection.upperBound : selection.lowerBound)
    let from = anchor == selection.lowerBound ? selection.upperBound : selection.lowerBound
    return Extension(anchor: anchor, from: from, stop: stop(forward: forward, from: from, in: text, splittingLetterStops: splittingLetterStops))
  }

  static func countsAsWordMove(from previous: Range<Int>, to next: Range<Int>) -> Bool {
    previous != next
  }

  static func containsRightToLeftText(_ text: String) -> Bool {
    text.unicodeScalars.contains { scalar in rightToLeft.contains { $0.contains(scalar.value) } }
  }

  private static let fullStops: Set<unichar> = [0x2E, 0xFF0E]

  private static let rightToLeft: [ClosedRange<UInt32>] = [
    0x0590...0x08FF, 0xFB1D...0xFDFF, 0xFE70...0xFEFF, 0x10800...0x10FFF, 0x1E800...0x1EFFF,
    0x200F...0x200F, 0x202B...0x202B, 0x202E...0x202E, 0x2067...0x2067,
  ]

  private static func splitAtLetterStops(_ word: Range<Int>, in string: NSString) -> [Range<Int>] {
    var pieces: [Range<Int>] = []
    var start = word.lowerBound
    for offset in word.dropFirst().dropLast() where fullStops.contains(string.character(at: offset)) {
      guard !joinsDigits(at: offset, in: string) else { continue }
      if start < offset { pieces.append(start..<offset) }
      start = offset + 1
    }
    if start < word.upperBound { pieces.append(start..<word.upperBound) }
    return pieces
  }

  private static func joinsDigits(at stop: Int, in string: NSString) -> Bool {
    var before = stop
    var digitBefore = false
    while before > 0, let (scalar, length) = scalar(endingAt: before, in: string) {
      before -= length
      if attachesToPrevious(scalar) { continue }
      digitBefore = CharacterSet.decimalDigits.contains(scalar)
      break
    }
    guard digitBefore, let (after, _) = scalar(startingAt: stop + 1, in: string) else { return false }
    return CharacterSet.decimalDigits.contains(after)
  }

  private static func attachesToPrevious(_ scalar: Unicode.Scalar) -> Bool {
    switch scalar.properties.generalCategory {
    case .nonspacingMark, .spacingMark, .enclosingMark, .format: true
    default: false
    }
  }

  private static func scalar(endingAt end: Int, in string: NSString) -> (Unicode.Scalar, Int)? {
    guard end > 0 else { return nil }
    let low = string.character(at: end - 1)
    if UTF16.isTrailSurrogate(low), end > 1, UTF16.isLeadSurrogate(string.character(at: end - 2)) {
      return pair(string.character(at: end - 2), low).map { ($0, 2) }
    }
    return Unicode.Scalar(UInt32(low)).map { ($0, 1) }
  }

  private static func scalar(startingAt start: Int, in string: NSString) -> (Unicode.Scalar, Int)? {
    guard start < string.length else { return nil }
    let high = string.character(at: start)
    if UTF16.isLeadSurrogate(high), start + 1 < string.length, UTF16.isTrailSurrogate(string.character(at: start + 1)) {
      return pair(high, string.character(at: start + 1)).map { ($0, 2) }
    }
    return Unicode.Scalar(UInt32(high)).map { ($0, 1) }
  }

  private static func pair(_ high: unichar, _ low: unichar) -> Unicode.Scalar? {
    Unicode.Scalar(0x10000 + (UInt32(high) - 0xD800) << 10 + (UInt32(low) - 0xDC00))
  }
}
