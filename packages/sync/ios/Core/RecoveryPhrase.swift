import ArdiaCoreRS
import Foundation

public enum RecoveryPhrase {
  public static let wordCount = 24
  static let entropyBytes = Int(ARDIA_ENTROPY_BYTES)

  public enum Problem: Error, Equatable {
    case wordCount(Int)
    case unknownWord(String)
    case checksum
  }

  public static func generateEntropy() -> Data {
    do {
      return try CoreCall.mapped { ardia_phrase_generate_entropy($0) }
    } catch {
      preconditionFailure("the system random source failed: \(error)")
    }
  }

  public static func words(for entropy: Data) -> [String] {
    precondition(entropy.count == entropyBytes)
    return CoreCall.text { out in CoreCall.bytes(entropy) { ardia_phrase_from_entropy($0, $1, out) } }.split(separator: " ").map(String.init)
  }

  public static func tokens(in text: String) -> [String] {
    text.lowercased().components(separatedBy: CharacterSet.lowercaseLetters.inverted).filter { !$0.isEmpty }
  }

  public static func entropy(from text: String) throws -> Data {
    let tokens = tokens(in: text)
    guard tokens.count == wordCount else { throw Problem.wordCount(tokens.count) }
    let words = tokens.map { token in
      token.count <= longestWord && token.unicodeScalars.allSatisfy { ("a"..."z").contains($0) } ? token : unknownToken
    }.joined(separator: " ")
    do {
      return try CoreCall.data { out in CoreCall.bytes(words) { ardia_phrase_to_entropy($0, $1, out) } }
    } catch let refused as CoreCall.Refused {
      guard refused.detail["code"] as? String == "unknownWord", let index = refused.detail["index"] as? Int, tokens.indices.contains(index) else {
        throw Problem.checksum
      }
      throw Problem.unknownWord(tokens[index])
    }
  }

  static let longestWord = Wordlist.english.map(\.count).max() ?? 0
  static let unknownToken = "x"
}
