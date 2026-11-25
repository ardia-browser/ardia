import Foundation
import Testing
@testable import ArdiaBrowser

@Suite struct PageSummaryDigestTests {
  func content(_ paragraphs: [String], title: String = "Autumn leaf color", site: String = "Wikipedia", excerpt: String? = nil) -> ReadableContent {
    ReadableContent(url: "https://en.wikipedia.org/wiki/Autumn_leaf_color", title: title, siteName: site, byline: nil, excerpt: excerpt, leadImage: nil, language: "en", paragraphs: paragraphs, html: "", wordCount: 0, isArticle: true)
  }

  let article = [
    "Autumn leaf color is a phenomenon that affects the normal green leaves of many deciduous trees and shrubs. They take on various shades of red, yellow, purple and brown.",
    "Short line.",
    "Chlorophyll breaks down in autumn as days shorten. The yellow and orange carotenoids that were always present become visible.",
    "Red and purple come from anthocyanins, which some trees make in late summer. Bright sunny days and cool nights strengthen them.",
  ]

  @Test func onlyPagesWithEnoughTextAreSummarized() {
    #expect(PageSummaryDigest.isSummarizable(content(article)))
    #expect(!PageSummaryDigest.isSummarizable(content(["Sign in", "Menu", "Search"])))
  }

  @Test func promptNamesThePageAndStaysInBudget() {
    let prompt = PageSummaryDigest.prompt(content(article), characterBudget: 200)
    #expect(prompt.hasPrefix("Page: Autumn leaf color (Wikipedia)\n\n"))
    #expect(prompt.hasSuffix("Summarize this page."))
    let body = prompt.replacingOccurrences(of: "Page: Autumn leaf color (Wikipedia)\n\n", with: "").replacingOccurrences(of: "\n\nSummarize this page.", with: "")
    #expect(body.count <= 200)
    #expect(body.hasPrefix("Autumn leaf color is a phenomenon"))
  }

  @Test func promptSkipsARepeatedSiteName() {
    #expect(PageSummaryDigest.prompt(content(article, title: "Example", site: "Example"), characterBudget: 500).hasPrefix("Page: Example\n\n"))
  }

  @Test func excerptsTakeTheDescriptionThenEachParagraphsLead() {
    let lines = PageSummaryDigest.excerpts(content(article, excerpt: "How and why leaves change colour before they fall in autumn.")).split(separator: "\n").map(String.init)
    #expect(lines == [
      "- How and why leaves change colour before they fall in autumn.",
      "- Autumn leaf color is a phenomenon that affects the normal green leaves of many deciduous trees and shrubs.",
      "- Chlorophyll breaks down in autumn as days shorten.",
      "- Red and purple come from anthocyanins, which some trees make in late summer.",
    ])
    #expect(ResearchAnswer.blocks(lines.joined(separator: "\n")).allSatisfy { if case .bullet = $0 { true } else { false } })
  }

  @Test func excerptsFallBackToAClippedParagraph() {
    let long = String(repeating: "word ", count: 120)
    let lines = PageSummaryDigest.excerpts(content([long]))
    #expect(lines.hasPrefix("- word"))
    #expect(lines.count <= 2 + PageSummaryDigest.excerptLineLengths.upperBound)
  }
}
