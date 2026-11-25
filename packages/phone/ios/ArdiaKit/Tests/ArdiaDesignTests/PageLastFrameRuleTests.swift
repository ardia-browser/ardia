import ArdiaDesign
import CoreGraphics
import Testing

struct PageLastFrameRuleTests {
  let size = CGSize(width: 402, height: 874)

  @Test func `a tab coming back shows its last frame only for the same document at the same size`() {
    #expect(PageLastFrameRule.usable(savedDocument: 3, savedSize: size, document: 3, size: size))
    #expect(PageLastFrameRule.usable(savedDocument: 3, savedSize: size, document: 3, size: CGSize(width: 402.5, height: 874)))
    #expect(!PageLastFrameRule.usable(savedDocument: 3, savedSize: size, document: 4, size: size), "it navigated or reloaded since")
    #expect(!PageLastFrameRule.usable(savedDocument: 3, savedSize: size, document: 3, size: CGSize(width: 874, height: 402)), "rotated")
    #expect(!PageLastFrameRule.usable(savedDocument: 3, savedSize: .zero, document: 3, size: .zero))
  }

  @Test func `only the last few tabs keep a frame`() {
    var kept: [Int] = []
    for tab in 1...7 { kept = PageLastFrameRule.trimmed(kept, adding: tab) }
    #expect(kept == [4, 5, 6, 7])
  }
}
