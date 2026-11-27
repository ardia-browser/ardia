import CoreGraphics

struct PeekGeometry: Equatable {
  var stage: CGSize
  var page: CGRect
  var tab: CGRect
  var rest: CGRect
  var card: CGRect
  var source: CGRect
  var restRadius: Double
  var tabTopRadius: Double
  var tabBottomRadius: Double
  var fullscreen: Bool

  static let empty = PeekGeometry(stage: .zero, page: .zero, tab: .zero, rest: .zero, card: .zero, source: .zero, restRadius: 0, tabTopRadius: 0, tabBottomRadius: 0, fullscreen: false)

  var valid: Bool {
    let rects = [page, tab, rest, card, source]
    let finite = rects.allSatisfy { $0.minX.isFinite && $0.minY.isFinite && $0.width.isFinite && $0.height.isFinite }
    return finite && stage.width > 0 && stage.height > 0 && page.width > 0 && page.height > 0 && tab.width > 0 && tab.height > 0 && rest.width > 0 && card.width > 0 && card.height > 0
  }

  var restScale: Double { page.width > 0 ? rest.width / page.width : 1 }

  func samePlacement(as other: PeekGeometry) -> Bool {
    var moved = other
    moved.page = page
    return moved == self
  }

  init(stage: CGSize, page: CGRect, tab: CGRect, rest: CGRect, card: CGRect, source: CGRect, restRadius: Double, tabTopRadius: Double, tabBottomRadius: Double, fullscreen: Bool) {
    self.stage = stage
    self.page = page
    self.tab = tab
    self.rest = rest
    self.card = card
    self.source = source
    self.restRadius = restRadius
    self.tabTopRadius = tabTopRadius
    self.tabBottomRadius = tabBottomRadius
    self.fullscreen = fullscreen
  }

  init?(_ dict: [String: Any]) {
    func number(_ key: String) -> Double? { (dict[key] as? NSNumber)?.doubleValue }
    func rect(_ key: String) -> CGRect? {
      guard let r = dict[key] as? [String: Any],
            let x = (r["x"] as? NSNumber)?.doubleValue, let y = (r["y"] as? NSNumber)?.doubleValue,
            let w = (r["width"] as? NSNumber)?.doubleValue, let h = (r["height"] as? NSNumber)?.doubleValue
      else { return nil }
      return CGRect(x: x, y: y, width: w, height: h)
    }
    guard let width = number("width"), let height = number("height"), let page = rect("page"), let rest = rect("rest"),
          let card = rect("card"), let source = rect("source")
    else { return nil }
    self.init(
      stage: CGSize(width: width, height: height), page: page, tab: rect("tab") ?? page, rest: rest, card: card, source: source,
      restRadius: number("restRadius") ?? 0, tabTopRadius: number("tabTopRadius") ?? 0, tabBottomRadius: number("tabBottomRadius") ?? 0,
      fullscreen: dict["fullscreen"] as? Bool ?? false)
    if !valid { return nil }
  }
}
