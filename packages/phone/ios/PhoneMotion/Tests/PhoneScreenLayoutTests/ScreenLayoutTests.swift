import CoreGraphics
import Foundation
import Testing
@testable import PhoneScreenLayout

@Suite struct ScreenLayoutTests {
  private func space(_ width: CGFloat, _ height: CGFloat, top: CGFloat = 0, leading: CGFloat = 0, bottom: CGFloat = 0, trailing: CGFloat = 0, hinge: ScreenSpace.Hinge = .none) -> ScreenSpace {
    ScreenSpace(size: CGSize(width: width, height: height), safeInsets: .init(top: top, leading: leading, bottom: bottom, trailing: trailing), hinge: hinge)
  }

  @Test func aPlainIPhoneStaysPhoneInBothOrientations() {
    #expect(ScreenLayout.resolve(space(402, 874, top: 62, bottom: 34)) == .phone)
    #expect(ScreenLayout.resolve(space(874, 402, leading: 62, bottom: 21, trailing: 62)) == .phone)
    #expect(ScreenLayout.resolve(space(852, 393, leading: 59, bottom: 21, trailing: 59)) == .phone)
  }

  @Test func theClosedDuoFillsTheScreenLikeAnyIPhone() {
    #expect(ScreenLayout.resolve(space(382, 644, bottom: 34, trailing: 84, hinge: .closed)) == .phone)
  }

  @Test func theOpenDuoFillsTheScreenLikeAnyIPhone() {
    #expect(ScreenLayout.resolve(space(867, 635, bottom: 34, trailing: 84, hinge: .fullyOpen)) == .phone)
  }

  @Test func aFullScreenIPadIsWide() {
    #expect(ScreenLayout.resolve(space(834, 1158, top: 24, bottom: 20)) == .wide)
    #expect(ScreenLayout.resolve(space(1032, 1376, top: 24, bottom: 20)) == .wide)
  }

  @Test func aHalfOpenDuoSplitsAtAWideDivisionAndOtherwiseStaysPhone() {
    var half = space(669, 900, top: 51, hinge: .partiallyOpen)
    half.divisions = [CGRect(x: 0, y: 430, width: 669, height: 20)]
    #expect(ScreenLayout.resolve(half) == .split(.init(top: 481, bottom: 501)))
    half.divisions = [CGRect(x: 300, y: 0, width: 20, height: 900)]
    #expect(ScreenLayout.resolve(half) == .phone)
  }

  @Test func theCanvasSwitchForcesWideAndSplitOnly() {
    let phone = space(402, 874, top: 62, bottom: 34)
    #expect(DuoCanvas.Mode(argument: "open") == .wide)
    #expect(DuoCanvas.Mode(argument: "wide") == .wide)
    #expect(DuoCanvas.Mode(argument: "half") == .split)
    #expect(DuoCanvas.Mode(argument: "column") == nil)
    #expect(DuoCanvas.Mode(argument: "closed") == nil)
    #expect(DuoCanvas.forcedLayout(.wide, for: phone) == .wide)
    #expect(DuoCanvas.forcedLayout(.split, for: phone) == .split(.init(top: 465.5, bottom: 485.5)))
    #expect(DuoCanvas.forcedLayout(nil, for: phone) == nil)
  }

  @Test func theReportCarriesTheLayoutTheSpaceAndWhatWasForced() {
    let report = ScreenLayoutReport.payload(space: space(382, 644, bottom: 34, trailing: 84, hinge: .closed), forced: nil)
    #expect(report["layout"] as? String == "phone")
    #expect(report["forced"] is NSNull)
    #expect(report["canvas"] == nil)
    #expect((report["space"] as? [String: Any])?["hinge"] as? String == "closed")
    #expect((report["space"] as? [String: Any])?["safeTrailing"] as? Double == 84)
    let forced = ScreenLayoutReport.payload(space: space(402, 874, top: 62), forced: .split)
    #expect(forced["layout"] as? String == "split")
    #expect(forced["forced"] as? String == "split")
    #expect((forced["canvas"] as? [String: Any])?["height"] as? Double == 951)
    #expect((forced["fold"] as? [String: Any])?["top"] as? Double == 465.5)
  }
}
