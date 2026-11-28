import ArdiaDesign
import ExpoModulesCore
import SwiftUI
import UIKit

struct NeverBouncesModifier: ViewModifier, Record {
  func body(content: Content) -> some View {
    content.scrollBounceBehavior(.basedOnSize).background(ScrollBounceGuard(mode: .never))
  }
}

struct BouncesWhenLongModifier: ViewModifier, Record {
  func body(content: Content) -> some View {
    content.scrollBounceBehavior(.basedOnSize).background(ScrollBounceGuard(mode: .whenLong))
  }
}

struct ScrollBounceGuard: UIViewRepresentable {
  let mode: ScrollBounceMode

  func makeUIView(context: Context) -> ScrollBounceGuardView { ScrollBounceGuardView(mode: mode) }
  func updateUIView(_ view: ScrollBounceGuardView, context: Context) {
    view.mode = mode
    view.apply()
  }
}

final class ScrollBounceGuardView: UIView {
  private weak var target: UIScrollView?
  private var watch: NSKeyValueObservation?
  var mode: ScrollBounceMode

  init(mode: ScrollBounceMode) {
    self.mode = mode
    super.init(frame: .zero)
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
      if PhoneTestBuild.isOn { NSLog("PAGELAB scroll %@ %@ after %d checks", mode.rawValue, NSStringFromClass(type(of: found)), checks) }
      let held = self.mode
      watch = found.observe(\.contentSize, options: []) { scroll, _ in
        MainActor.assumeIsolated { ScrollBounceGuardView.hold(scroll, to: held) }
      }
    }
    if let target { Self.hold(target, to: mode) }
    guard checks < ScrollBounceTarget.retries else {
      if target == nil, PhoneTestBuild.isOn {
        let mine = convert(bounds, to: window)
        NSLog("PAGELAB scroll %@ found no scroll view behind its form at %.0f,%.0f,%.0fx%.0f", mode.rawValue, mine.minX, mine.minY, mine.width, mine.height)
      }
      return
    }
    checks += 1
    DispatchQueue.main.asyncAfter(deadline: .now() + ScrollBounceTarget.retryGap) { [weak self] in self?.apply() }
  }

  static func hold(_ scroll: UIScrollView, to mode: ScrollBounceMode) {
    let vertical = mode.bouncesVertically
    if scroll.bouncesVertically != vertical { scroll.bouncesVertically = vertical }
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
