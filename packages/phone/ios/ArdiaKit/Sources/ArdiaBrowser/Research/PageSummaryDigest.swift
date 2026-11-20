import Foundation

public enum PageSummaryDigest {
  public static let minimumCharacters = 200
  public static let excerptLineLimit = 4
  public static let excerptLineLengths = 40...320

  public static let instructions = """
    You summarize one web page using only the page text you are given. \
    Write two to four lines, each starting with "- ", with the page's main points in the order they matter. \
    Keep every line short and plain. Never add facts, opinions or links that are not in the text.
    """

  public static func isSummarizable(_ content: ReadableContent) -> Bool {
    content.paragraphs.reduce(0) { $0 + $1.count } >= minimumCharacters
  }

  public static func prompt(_ content: ReadableContent, characterBudget: Int) -> String {
    let heading = content.siteName.isEmpty || content.siteName == content.title ? content.title : "\(content.title) (\(content.siteName))"
    let body = ResearchDigest.excerpt(content.paragraphs, query: content.title, characterBudget: characterBudget)
    return "Page: \(heading)\n\n\(body)\n\nSummarize this page."
  }

  public static func excerpts(_ content: ReadableContent) -> String {
    var lines: [String] = []
    var seen: Set<String> = []
    func add(_ sentence: String) {
      let text = sentence.trimmingCharacters(in: .whitespacesAndNewlines)
      guard excerptLineLengths.contains(text.count), lines.count < excerptLineLimit else { return }
      guard seen.insert(String(text.lowercased().prefix(60))).inserted else { return }
      lines.append("- \(text)")
    }
    if let description = content.excerpt { add(description) }
    for paragraph in content.paragraphs.prefix(40) where lines.count < excerptLineLimit {
      if let first = ResearchDigest.sentences(in: [paragraph]).first { add(first) }
    }
    if lines.isEmpty, let paragraph = content.paragraphs.first(where: { $0.count >= excerptLineLengths.lowerBound }) {
      lines.append("- " + ResearchDigest.clipped(paragraph, to: excerptLineLengths.upperBound))
    }
    return lines.joined(separator: "\n")
  }
}
