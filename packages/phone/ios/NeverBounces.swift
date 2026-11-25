import ArdiaDesign
import ExpoModulesCore
import SwiftUI
import UIKit

struct NeverBouncesModifier: ViewModifier, Record {
  func body(content: Content) -> some View {
    content.scrollBounceBehavior(.basedOnSize).background(ScrollBounceOff())
  }
}

struct ScrollBounceOff: UIViewRepresentable {
  func makeUIView(context: Context) -> ScrollBounceOffView { ScrollBounceOffView() }
  func updateUIView(_ view: ScrollBounceOffView, context: Context) { view.apply() }
}

final class ScrollBounceOffView: UIView {
  private weak var target: UIScrollView?
  private var watch: NSKeyValueObservation?

  override init(frame: CGRect) {
    super.init(frame: frame)
    isUserInteractionEnabled = false
    isAccessibilityElement = false
  }

  required init?(coder: NSCoder) { nil }

  override func didMoveToWindow() {
    super.didMoveToWindow()
    apply()
  }

  override func layoutSubviews() {
    super.layoutSubviews()
    apply()
  }

  private var checks = 0

  func apply() {
    guard let window else { return }
    if let bound = target, bound.window == nil || !ScrollBounceTarget.matches(className: NSStringFromClass(type(of: bound)), frame: bound.convert(bound.bounds, to: window), mine: convert(bounds, to: window)) {
      target = nil
      watch = nil
    }
    if target == nil, let found = findTarget() {
      target = found
      if PhoneTestBuild.isOn { NSLog("PAGELAB scroll off %@ after %d checks", NSStringFromClass(type(of: found)), checks) }
      watch = found.observe(\.contentSize, options: []) { scroll, _ in
        MainActor.assumeIsolated { ScrollBounceOffView.turnOff(scroll) }
      }
    }
    if let target { Self.turnOff(target) }
    guard checks < ScrollBounceTarget.retries else {
      if target == nil, PhoneTestBuild.isOn {
        let mine = convert(bounds, to: window)
        NSLog("PAGELAB scroll off found no scroll view behind its form at %.0f,%.0f,%.0fx%.0f", mine.minX, mine.minY, mine.width, mine.height)
      }
      return
    }
    checks += 1
    DispatchQueue.main.asyncAfter(deadline: .now() + ScrollBounceTarget.retryGap) { [weak self] in self?.apply() }
  }

  static func turnOff(_ scroll: UIScrollView) {
    if scroll.bouncesVertically { scroll.bouncesVertically = false }
    if scroll.bouncesHorizontally { scroll.bouncesHorizontally = false }
    if scroll.alwaysBounceVertical { scroll.alwaysBounceVertical = false }
    if scroll.alwaysBounceHorizontal { scroll.alwaysBounceHorizontal = false }
  }

  private func findTarget() -> UIScrollView? {
    guard let window else { return nil }
    let mine = convert(bounds, to: window)
    var ancestor = superview
    for _ in 0..<ScrollBounceTarget.ancestorsSearched {
      guard let root = ancestor else { return nil }
      var queue: [UIView] = [root]
      var index = 0
      while index < queue.count, index < ScrollBounceTarget.viewsSearched {
        let view = queue[index]
        index += 1
        if let scroll = view as? UIScrollView, scroll.refreshControl == nil, ScrollBounceTarget.matches(className: NSStringFromClass(type(of: scroll)), frame: scroll.convert(scroll.bounds, to: window), mine: mine) {
          return scroll
        }
        queue.append(contentsOf: view.subviews)
      }
      ancestor = root.superview
    }
    return nil
  }
}
