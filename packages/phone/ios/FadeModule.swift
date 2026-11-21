import ExpoModulesCore
import QuartzCore
import UIKit

final class FadeView: ExpoView {
  enum Edge: CaseIterable {
    case top
    case bottom
    case leading
    case trailing
  }

  struct Ramp: Equatable {
    var length: CGFloat
    var floor: CGFloat
  }

  var ramps: [Edge: Ramp] = [:] {
    didSet { if ramps != oldValue { setNeedsLayout() } }
  }

  private var gradients: [CAGradientLayer] = []

  static func ramp(_ value: [String: Double]?) -> Ramp? {
    guard let value, let length = value["length"], length > 0 else { return nil }
    return Ramp(length: CGFloat(length), floor: CGFloat(min(max(value["floor"] ?? 0, 0), 1)))
  }

  override func layoutSubviews() {
    super.layoutSubviews()
    updateMask()
  }

  private func updateMask() {
    let active = Edge.allCases.compactMap { edge in ramps[edge].map { (edge, $0) } }
    CATransaction.begin()
    CATransaction.setDisableActions(true)
    defer { CATransaction.commit() }
    guard !active.isEmpty, bounds.width > 0, bounds.height > 0 else {
      layer.mask = nil
      return
    }
    while gradients.count < active.count { gradients.append(CAGradientLayer()) }
    if gradients.count > active.count { gradients.removeLast(gradients.count - active.count) }
    let rightToLeft = effectiveUserInterfaceLayoutDirection == .rightToLeft
    for (index, (edge, ramp)) in active.enumerated() {
      let gradient = gradients[index]
      gradient.frame = CGRect(origin: .zero, size: bounds.size)
      configure(gradient, edge: edge, ramp: ramp, rightToLeft: rightToLeft)
      gradient.mask = index + 1 < active.count ? gradients[index + 1] : nil
    }
    if layer.mask !== gradients[0] { layer.mask = gradients[0] }
  }

  private func configure(_ gradient: CAGradientLayer, edge: Edge, ramp: Ramp, rightToLeft: Bool) {
    let extent: CGFloat
    let start: CGPoint
    let end: CGPoint
    switch edge {
    case .top:
      extent = bounds.height
      (start, end) = (CGPoint(x: 0.5, y: 0), CGPoint(x: 0.5, y: 1))
    case .bottom:
      extent = bounds.height
      (start, end) = (CGPoint(x: 0.5, y: 1), CGPoint(x: 0.5, y: 0))
    case .leading, .trailing:
      extent = bounds.width
      let fromLeft = (edge == .leading) != rightToLeft
      (start, end) = fromLeft ? (CGPoint(x: 0, y: 0.5), CGPoint(x: 1, y: 0.5)) : (CGPoint(x: 1, y: 0.5), CGPoint(x: 0, y: 0.5))
    }
    let reach = min(ramp.length / extent, 1)
    gradient.startPoint = start
    gradient.endPoint = end
    gradient.colors = [UIColor(white: 1, alpha: ramp.floor).cgColor, UIColor.white.cgColor, UIColor.white.cgColor]
    gradient.locations = [0, NSNumber(value: Double(reach)), 1]
  }
}

public final class FadeModule: Module {
  public func definition() -> ModuleDefinition {
    Name("ArdiaPhoneFade")

    View(FadeView.self) {
      Prop("topFade") { (view: FadeView, value: [String: Double]?) in
        view.ramps[.top] = FadeView.ramp(value)
      }

      Prop("bottomFade") { (view: FadeView, value: [String: Double]?) in
        view.ramps[.bottom] = FadeView.ramp(value)
      }

      Prop("leadingFade") { (view: FadeView, value: [String: Double]?) in
        view.ramps[.leading] = FadeView.ramp(value)
      }

      Prop("trailingFade") { (view: FadeView, value: [String: Double]?) in
        view.ramps[.trailing] = FadeView.ramp(value)
      }
    }
  }
}
