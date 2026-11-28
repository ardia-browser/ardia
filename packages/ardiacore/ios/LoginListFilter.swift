import Foundation

enum LoginListFilter {
  struct Hit: Equatable {
    let index: Int
    let bold: NSRange
  }

  private static let folding: String.CompareOptions = [.caseInsensitive, .diacriticInsensitive]
  private static let wordBreaks: Set<Character> = ["@", ".", "_", "-", " "]

  static func hits(_ names: [String], typed: String) -> [Hit] {
    guard !typed.isEmpty else { return names.indices.map { Hit(index: $0, bold: NSRange(location: 0, length: 0)) } }
    let ranked = names.enumerated().compactMap { index, name in best(typed, in: name).map { (rank: $0.rank, hit: Hit(index: index, bold: NSRange($0.run, in: name))) } }
    return ranked.enumerated().sorted { ($0.element.rank, $0.offset) < ($1.element.rank, $1.offset) }.map(\.element.hit)
  }

  private static func best(_ typed: String, in name: String) -> (rank: Int, run: Range<String.Index>)? {
    var found: (rank: Int, run: Range<String.Index>)?
    var from = name.startIndex
    while from < name.endIndex, let run = name.range(of: typed, options: folding, range: from..<name.endIndex) {
      let rank = run.lowerBound == name.startIndex ? 0 : wordBreaks.contains(name[name.index(before: run.lowerBound)]) ? 1 : 2
      if found.map({ rank < $0.rank }) ?? true { found = (rank, run) }
      if rank <= 1 { break }
      from = name.index(after: run.lowerBound)
    }
    return found
  }
}
