import SwiftUI
import UIKit

struct TrayStage: UIViewControllerRepresentable {
  let motion: TrayMotion
  let content: AnyView?
  let commandTop: CGFloat?

  func makeUIViewController(context: Context) -> TrayStageController {
    motion.controller
  }

  func updateUIViewController(_ controller: TrayStageController, context: Context) {
    controller.show(content, commandTop: commandTop)
  }
}

final class TrayStageController: UIViewController {
  let dim = TrayDimView()
  let tray = TrayContainerView()
  let keyboardSentinel = UIView()
  let stageView = TrayStageView()
  var onResize: (() -> Void)?
  private(set) var trayHeight: CGFloat = 0
  private var placedIn: [CGFloat?] = []
  private(set) var commandTop: CGFloat?
  private let host = UIHostingController<AnyView?>(rootView: nil)

  var isAnimating: Bool {
    [tray.layer, dim.layer, keyboardSentinel.layer].contains { !($0.animationKeys() ?? []).isEmpty }
  }

  override func loadView() {
    view = stageView
  }

  override func viewDidLoad() {
    super.viewDidLoad()
    view.backgroundColor = .clear
    dim.alpha = 0
    dim.isUserInteractionEnabled = false
    tray.isHidden = true
    keyboardSentinel.isHidden = true
    host.safeAreaRegions = []
    host.sizingOptions = .preferredContentSize
    host.view.backgroundColor = .clear
    addChild(host)
    tray.addSubview(host.view)
    view.addSubview(keyboardSentinel)
    view.addSubview(dim)
    view.addSubview(tray)
    host.didMove(toParent: self)
  }

  func show(_ content: AnyView?, commandTop: CGFloat?) {
    host.rootView = content
    self.commandTop = commandTop
    view.setNeedsLayout()
  }

  override func preferredContentSizeDidChange(forChildContentContainer container: any UIContentContainer) {
    super.preferredContentSizeDidChange(forChildContentContainer: container)
    view.setNeedsLayout()
  }

  override func viewDidLayoutSubviews() {
    super.viewDidLayoutSubviews()
    let bounds = view.bounds
    dim.frame = bounds
    let height = host.rootView == nil ? 0 : host.sizeThatFits(in: CGSize(width: bounds.width, height: .greatestFiniteMagnitude)).height
    tray.bounds = CGRect(x: 0, y: 0, width: bounds.width, height: height)
    tray.layer.anchorPoint = CGPoint(x: 0.5, y: commandTop == nil ? 1 : 0)
    tray.center = CGPoint(x: bounds.midX, y: commandTop ?? bounds.maxY)
    host.view.frame = tray.bounds
    trayHeight = height
    let space: [CGFloat?] = [height, bounds.width, bounds.height, view.window?.safeAreaInsets.bottom ?? 0, commandTop]
    guard space != placedIn else { return }
    placedIn = space
    onResize?()
  }
}

final class TrayStageView: UIView {
  var absorbsTouches = false

  override func hitTest(_ point: CGPoint, with event: UIEvent?) -> UIView? {
    let hit = super.hitTest(point, with: event)
    guard hit === self else { return hit }
    return absorbsTouches ? self : nil
  }
}

final class TrayContainerView: UIView {
  var takesTouches = true

  override func hitTest(_ point: CGPoint, with event: UIEvent?) -> UIView? {
    takesTouches ? super.hitTest(point, with: event) : nil
  }
}

final class TrayDimView: UIView {
  var onTap: (() -> Void)?

  override init(frame: CGRect) {
    super.init(frame: frame)
    isAccessibilityElement = true
    accessibilityLabel = String(localized: "Close Search")
    accessibilityTraits = .button
    addGestureRecognizer(UITapGestureRecognizer(target: self, action: #selector(tapped)))
  }

  required init?(coder: NSCoder) { nil }

  @objc private func tapped() { onTap?() }

  override func accessibilityActivate() -> Bool {
    onTap?()
    return true
  }
}
