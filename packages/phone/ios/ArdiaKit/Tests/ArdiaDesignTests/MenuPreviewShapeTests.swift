import ArdiaDesign
import CoreGraphics
import Testing

struct MenuPreviewShapeTests {
  @Test func `a circle button's menu lifts a circle, never its square bounds`() {
    #expect(MenuPreviewShape.radius(given: 22, own: 0, child: 0, size: CGSize(width: 44, height: 44)) == 22)
  }

  @Test func `a given radius past half the short side stays a capsule`() {
    #expect(MenuPreviewShape.radius(given: 100, own: 0, child: 0, size: CGSize(width: 120, height: 40)) == 20)
    #expect(MenuPreviewShape.radius(given: -4, own: 9, child: 9, size: CGSize(width: 120, height: 40)) == 0)
  }

  @Test func `without a given radius the view's own corners are used`() {
    #expect(MenuPreviewShape.radius(given: nil, own: 0, child: 18, size: CGSize(width: 200, height: 300)) == 18)
    #expect(MenuPreviewShape.radius(given: nil, own: 0, child: 0, size: CGSize(width: 200, height: 300)) == 0)
  }
}
