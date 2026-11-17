import CoreGraphics
import Foundation
import Testing
@testable import PhoneScreenLayout

@Suite struct ScreenLayoutTests {
  private func space(_ width: CGFloat, _ height: CGFloat, top: CGFloat = 0, leading: CGFloat = 0, bottom: CGFloat = 0, trailing: CGFloat = 0, bar: ScreenSpace.Edge? = nil) -> ScreenSpace {
    ScreenSpace(size: CGSize(width: width, height: height), safeInsets: .init(top: top, leading: leading, bottom: bottom, trailing: trailing), verticalBarEdge: bar)
  }

  @Test func aPlainIPhoneStaysPhoneInBothOrientations() {
    #expect(ScreenLayout.resolve(space(402, 874, top: 62, bottom: 34)) == .phone)
    #expect(ScreenLayout.resolve(space(874, 402, leading: 62, bottom: 21, trailing: 62)) == .phone)
    #expect(ScreenLayout.resolve(space(852, 393, leading: 59, bottom: 21, trailing: 59)) == .phone)
  }

  @Test func theDuoSizesResolveAsMainsDocsSay() {
    #expect(ScreenLayout.resolve(space(466, 678, trailing: 84)) == .column(edge: .trailing, inset: 84))
    #expect(ScreenLayout.resolve(space(669, 951 - 82, top: 82)) == .wide)
    #expect(ScreenLayout.resolve(space(951, 669)) == .wide)
  }

  @Test func aColumnNeedsSixtyOnOneSideAndRoundsUpToTwelve() {
    #expect(ScreenLayout.resolve(space(500, 500, trailing: 59)) == .phone)
    #expect(ScreenLayout.resolve(space(500, 500, leading: 61)) == .column(edge: .leading, inset: 72))
    #expect(ScreenLayout.resolve(space(500, 500, top: 20, trailing: 84)) == .phone)
    #expect(ScreenLayout.resolve(space(500, 500, leading: 30, trailing: 84)) == .phone)
  }

  @Test func theVerticalBarEdgeWinsOverTheInsetsShape() {
    #expect(ScreenLayout.resolve(space(874, 402, leading: 62, trailing: 62, bar: .trailing)) == .column(edge: .trailing, inset: 72))
    #expect(ScreenLayout.resolve(space(852, 393, leading: 59, trailing: 59, bar: .leading)) == .phone)
  }

  @Test func aHalfOpenHingeWithAWideDivisionSplitsBelowTheSafeTop() {
    var half = space(669, 900, top: 51)
    half.hinge = .partiallyOpen
    half.divisions = [CGRect(x: 0, y: 430, width: 669, height: 20)]
    #expect(ScreenLayout.resolve(half) == .split(.init(top: 481, bottom: 501)))
    half.divisions = [CGRect(x: 300, y: 0, width: 20, height: 900)]
    #expect(ScreenLayout.resolve(half) == .wide)
  }

  @Test func theCanvasSwitchForcesEachLayoutAndTakesMainsNames() {
    let phone = space(402, 874, top: 62, bottom: 34)
    #expect(DuoCanvas.Mode(argument: "open") == .wide)
    #expect(DuoCanvas.Mode(argument: "half") == .split)
    #expect(DuoCanvas.Mode(argument: "column") == .column)
    #expect(DuoCanvas.Mode(argument: "sideways") == nil)
    #expect(DuoCanvas.forcedLayout(.wide, for: phone) == .wide)
    #expect(DuoCanvas.forcedLayout(.split, for: phone) == .split(.init(top: 465.5, bottom: 485.5)))
    #expect(DuoCanvas.forcedLayout(.column, for: phone) == .column(edge: .trailing, inset: 84))
    #expect(DuoCanvas.forcedLayout(nil, for: phone) == nil)
  }

  @Test func theReportCarriesTheLayoutTheSpaceAndWhatWasForced() {
    let report = ScreenLayoutReport.payload(space: space(466, 678, trailing: 84), forced: nil)
    #expect(report["layout"] as? String == "column")
    #expect((report["column"] as? [String: Any])?["inset"] as? Double == 84)
    #expect(report["forced"] is NSNull)
    #expect((report["space"] as? [String: Any])?["verticalBarEdge"] is NSNull)
    let forced = ScreenLayoutReport.payload(space: space(402, 874, top: 62), forced: .split)
    #expect(forced["layout"] as? String == "split")
    #expect(forced["forced"] as? String == "split")
    #expect((forced["canvas"] as? [String: Any])?["height"] as? Double == 951)
    #expect((forced["fold"] as? [String: Any])?["top"] as? Double == 465.5)
  }
}
