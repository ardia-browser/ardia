import Foundation
import NaturalLanguage

public enum SpokenAnswer {
  public enum Language: Equatable, Sendable {
    case undecided
    case english
    case other(String)
  }

  public static let decidingLetters = 40

  public static func text(_ answer: String) -> String {
    answer.components(separatedBy: .newlines).compactMap(block).map(closed).joined(separator: "\n")
  }

  public static func blocks(_ answer: String) -> [String] {
    text(answer).split(whereSeparator: \.isNewline).map(String.init)
  }

  public static func isReadable(_ answer: String) -> Bool {
    let spoken = text(answer)
    guard !spoken.isEmpty else { return false }
    switch language(of: spoken) {
    case .english: return true
    case .other: return false
    case .undecided: return !spoken.unicodeScalars.contains(where: isNonLatinLetter)
    }
  }

  static func isNonLatinLetter(_ scalar: Unicode.Scalar) -> Bool {
    CharacterSet.letters.contains(scalar) && scalar.value > 0x24F && !(0x1E00...0x1EFF).contains(scalar.value)
  }

  public static func language(of text: String) -> Language {
    guard text.unicodeScalars.filter(CharacterSet.letters.contains).count >= decidingLetters else { return .undecided }
    let recognizer = NLLanguageRecognizer()
    recognizer.processString(text)
    guard let dominant = recognizer.dominantLanguage else { return .undecided }
    return dominant == .english ? .english : .other(dominant.rawValue)
  }

  static func block(_ rawLine: String) -> String? {
    let line = rawLine.trimmingCharacters(in: .whitespaces)
    guard !line.isEmpty else { return nil }
    guard let parsed = ResearchAnswer.blocks(withoutListNumber(line)).first else { return nil }
    let text = inline(parsed.text)
    return text.isEmpty ? nil : text
  }

  static func withoutListNumber(_ line: String) -> String {
    guard let match = line.prefixMatch(of: listNumberPattern) else { return line }
    return String(line[match.range.upperBound...])
  }

  static func inline(_ text: String) -> String {
    var cleaned = ResearchAnswer.withoutCitations(text)
    cleaned = cleaned.replacing(linkPattern) { String($0.output.1) }
    cleaned = cleaned.replacingOccurrences(of: "*", with: "").replacingOccurrences(of: "`", with: "").replacingOccurrences(of: "__", with: "")
    cleaned = cleaned.replacing(spacesPattern, with: " ")
    return cleaned.trimmingCharacters(in: .whitespaces)
  }

  static func closed(_ text: String) -> String {
    guard let last = text.last else { return text }
    return ".!?:;…".contains(last) || closers.contains(last) ? text : text + "."
  }

  static let closers: Set<Character> = ["\"", "'", "”", "’", ")", "]"]
  nonisolated(unsafe) static let listNumberPattern = /\d{1,3}[.)]\s+/
  nonisolated(unsafe) static let linkPattern = /\[([^\]\[]+)\]\([^)\s]*\)/
  nonisolated(unsafe) static let spacesPattern = /[ \t]{2,}/
}
