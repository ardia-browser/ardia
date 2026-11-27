import Foundation
import Testing
@testable import ArdiaBrowser

@Suite struct PagePinchTests {
  let page = UUID()

  func moment(zoom: Double = 1, minimum: Double = 1, navigation: Int = 3, page: UUID? = nil, visible: Bool = true, loading: Bool = false) -> PagePinch.Moment {
    PagePinch.Moment(page: page ?? self.page, navigation: navigation, zoomScale: zoom, minimumZoomScale: minimum, isVisible: visible, isLoading: loading)
  }

  func pinch(_ scales: [Double], from start: PagePinch.Moment? = nil) -> PagePinch? {
    guard var pinch = PagePinch(at: start ?? moment(), scale: scales.first ?? 1) else { return nil }
    for scale in scales.dropFirst() { pinch.moved(to: scale) }
    return pinch
  }

  @Test func deliberateInwardPinchAtMinimumZoomFires() throws {
    let pinch = try #require(pinch([0.98, 0.8, 0.6, 0.45]))
    #expect(pinch.fires(.ended, at: moment()))
  }

  @Test func onlyStartsAtTheScrollViewsMinimumZoom() {
    #expect(PagePinch(at: moment(zoom: 1.6, minimum: 1)) == nil)
    #expect(PagePinch(at: moment(zoom: 0.5, minimum: 0.5)) != nil)
    #expect(PagePinch(at: moment(zoom: 0.503, minimum: 0.5)) != nil)
    #expect(PagePinch(at: moment(zoom: 0.6, minimum: 0.5)) == nil)
  }

  @Test func neverStartsOnHiddenOrLoadingPages() {
    #expect(PagePinch(at: moment(visible: false)) == nil)
    #expect(PagePinch(at: moment(loading: true)) == nil)
  }

  @Test func outwardFirstOrOutwardAtAllNeverFires() {
    #expect(PagePinch(at: moment(), scale: 1.3) == nil)
    let outThenIn = pinch([1, 1.5, 1.2, 0.9, 0.4])
    #expect(outThenIn?.fires(.ended, at: moment()) == false)
    #expect(outThenIn?.wentOutward == true)
  }

  @Test func lettingGoBackTowardsRestDoesNotFire() throws {
    let reversed = try #require(pinch([1, 0.7, 0.45, 0.68]))
    #expect(!reversed.fires(.ended, at: moment()))
    #expect(!reversed.fires(.ended, velocity: 0.8, at: moment()))
  }

  @Test func shallowPinchFiresOnlyWhileStillClosingFast() throws {
    let shallow = try #require(pinch([1, 0.9, 0.8]))
    #expect(!shallow.fires(.ended, at: moment()))
    #expect(!shallow.fires(.ended, velocity: -0.6, at: moment()))
    #expect(shallow.fires(.ended, velocity: -1.4, at: moment()))
    let barely = try #require(pinch([1, 0.95]))
    #expect(!barely.fires(.ended, velocity: -3, at: moment()))
  }

  @Test func thePageGivesWayLessTheFurtherTheFingersClose() {
    #expect(PagePinch.shownScale(for: 1.2) == 1)
    #expect(PagePinch.shownScale(for: 0.97) == 0.97)
    #expect(abs(PagePinch.shownScale(for: 0.5) - 0.8788) < 0.001)
    #expect(PagePinch.shownScale(for: 0) > 0.85)
    #expect(abs(PagePinch.shownWidthScale(for: 0.5) - 0.9394) < 0.001)
    #expect(PagePinch.rubberBand(3, in: 0...1, reach: 0.5) > 1)
    #expect(PagePinch.rubberBand(3, in: 0...1, reach: 0.5) < 1.5)
  }

  @Test func theFoldAndTheBackdropFollowTheFingers() {
    #expect(PagePinch.foldProgress(for: 1) == 0)
    #expect(PagePinch.foldProgress(for: 0.9) == 0)
    #expect(abs(PagePinch.foldProgress(for: 0.5) - 0.6) < 0.0001)
    #expect(PagePinch.foldProgress(for: 0.2) == 1)
    #expect(PagePinch.glow(for: 0.95) == 0)
    #expect(abs(PagePinch.glow(for: 0.85) - 0.5) < 0.0001)
    #expect(PagePinch.glow(for: 0.6) == 1)
    #expect(PagePinch.isEngaged(at: 0.89))
    #expect(!PagePinch.isEngaged(at: 0.9))
  }

  @Test func onlyASuccessfulEndFires() throws {
    let pinch = try #require(pinch([1, 0.4]))
    #expect(!pinch.fires(.cancelled, at: moment()))
    #expect(!pinch.fires(.failed, at: moment()))
    #expect(pinch.fires(.ended, at: moment()))
  }

  @Test func navigationReloadOrPageSwitchDuringThePinchDoesNotFire() throws {
    let pinch = try #require(pinch([1, 0.4]))
    #expect(!pinch.fires(.ended, at: moment(navigation: 4)))
    #expect(!pinch.fires(.ended, at: moment(loading: true)))
    #expect(!pinch.fires(.ended, at: moment(page: UUID())))
    #expect(!pinch.fires(.ended, at: moment(visible: false)))
  }

  @Test func webKitZoomingDuringThePinchDoesNotFire() throws {
    let pinch = try #require(pinch([1, 0.4]))
    #expect(!pinch.fires(.ended, at: moment(zoom: 1.4, minimum: 1)))
    #expect(pinch.fires(.ended, at: moment(zoom: 0.92, minimum: 1)))
  }

  @Test func ignoresNonsenseScales() throws {
    var pinch = try #require(pinch([1, 0.4]))
    pinch.moved(to: .nan)
    pinch.moved(to: 0)
    pinch.moved(to: -1)
    #expect(pinch.lastScale == 0.4)
    #expect(pinch.fires(.ended, at: moment()))
  }
}
