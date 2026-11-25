import AppKit
import Testing

private let card = NSColor(srgbRed: 0.16, green: 0.12, blue: 0.13, alpha: 1)

@Suite struct WebKitPageBackdropUnderOtherTabs {
  @Test func `a hidden tab paints no backdrop over the tabs beneath it`() {
    let backdrop = WebKitPageBackdrop(color: card, awaitingFirstPaint: false)
    #expect(backdrop.layerColor(visible: false) == nil)
  }

  @Test func `a hidden tab still waiting for its first paint paints no backdrop either`() {
    let backdrop = WebKitPageBackdrop(color: card, awaitingFirstPaint: true)
    #expect(backdrop.layerColor(visible: false) == nil)
  }

  @Test func `a shown tab paints its backdrop`() {
    let backdrop = WebKitPageBackdrop(color: card, awaitingFirstPaint: false)
    #expect(backdrop.layerColor(visible: true) == card.cgColor)
  }

  @Test func `a tab with no backdrop colour paints nothing`() {
    #expect(WebKitPageBackdrop().layerColor(visible: true) == nil)
  }

  @Test func `hiding a tab whose backdrop was painted counts as uncovering the tabs beneath it`() {
    let backdrop = WebKitPageBackdrop(color: card, awaitingFirstPaint: false)
    #expect(backdrop.uncovers(card.cgColor, visible: false))
    #expect(!backdrop.uncovers(nil, visible: false))
    #expect(!backdrop.uncovers(card.cgColor, visible: true))
  }

  @Test func `the page draws its own background except while the backdrop stands in for its first paint`() {
    #expect(WebKitPageBackdrop(color: card, awaitingFirstPaint: true).pageDrawsBackground == false)
    #expect(WebKitPageBackdrop(color: card, awaitingFirstPaint: false).pageDrawsBackground)
    #expect(WebKitPageBackdrop(color: nil, awaitingFirstPaint: true).pageDrawsBackground)
  }
}
