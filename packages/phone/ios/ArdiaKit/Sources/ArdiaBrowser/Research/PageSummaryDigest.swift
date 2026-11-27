import Foundation

public enum PageSummaryDigest {
  public static let minimumCharacters = 200
  public static let excerptLineLimit = 4
  public static let excerptLineLengths = 40...320

  public static let instructions = """
    You summarize one web page using only the page text you are given. \
    First write one line starting with "= " that gives the page's main point in one or two sentences. \
    Then write three to five lines for its key points in the order they matter, each as "- symbol | Label | detail": \
    symbol is an SF Symbol name that fits the point, such as heart.fill, drop.fill, clock, dollarsign.circle or leaf.fill, \
    Label is two to five words in title case, and detail is one or two short, specific sentences. \
    Start every "= " and "- " line on a new line, like this:
    = The main point in one or two sentences.
    - leaf.fill | Short Label | One or two sentences.
    - clock | Another Label | One or two sentences.
    Keep every line plain. Never add facts, opinions or links that are not in the text.
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
