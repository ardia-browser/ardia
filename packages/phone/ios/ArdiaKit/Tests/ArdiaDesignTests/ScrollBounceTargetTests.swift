import ArdiaDesign
import CoreGraphics
import Testing

struct ScrollBounceTargetTests {
  let form = CGRect(x: 0, y: 62, width: 402, height: 812)

  @Test func `the form's own scroll view is the target, the same size or running on under its bars`() {
    #expect(ScrollBounceTarget.matches(className: "UICollectionView", frame: form, mine: form))
    #expect(ScrollBounceTarget.matches(className: "UICollectionView", frame: form.offsetBy(dx: 0, dy: 1.5), mine: form))
    #expect(ScrollBounceTarget.matches(className: "SwiftUI.UpdateCoalescingCollectionView", frame: form, mine: CGRect(x: 0, y: 186, width: 402, height: 654)), "a sheet's list under its navigation and search bars")
  }

  @Test func `a view inside the form, beside it or narrower is never the target`() {
    #expect(!ScrollBounceTarget.matches(className: "UITextView", frame: CGRect(x: 16, y: 300, width: 370, height: 120), mine: form))
    #expect(!ScrollBounceTarget.matches(className: "UICollectionView", frame: CGRect(x: 0, y: 300, width: 402, height: 200), mine: form), "shorter than the form")
    #expect(!ScrollBounceTarget.matches(className: "UICollectionView", frame: CGRect(x: 402, y: 62, width: 402, height: 812), mine: form))
  }

  @Test func `the web page and React Native's own scroll views are never the target`() {
    #expect(!ScrollBounceTarget.matches(className: "WKScrollView", frame: form, mine: form))
    #expect(!ScrollBounceTarget.matches(className: "RCTEnhancedScrollView", frame: CGRect(x: 0, y: 0, width: 402, height: 874), mine: form))
    #expect(!ScrollBounceTarget.matches(className: "UICollectionView", frame: .zero, mine: form))
    #expect(!ScrollBounceTarget.matches(className: "UICollectionView", frame: form, mine: .zero))
  }
}
