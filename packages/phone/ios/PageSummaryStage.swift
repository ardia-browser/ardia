import ArdiaBrowser
import ArdiaDesign
import Observation
import SwiftUI
import UIKit

enum PageSummaryMotion {
  static let perspective: CGFloat = 1.0 / 6
  static let foldedTop: CGFloat = 89 * .pi / 180
  static let foldedBottom: CGFloat = 91 * .pi / 180
  static let restingTop: CGFloat = 20 * .pi / 180
  static let restingBottom: CGFloat = .pi
  static let foldBrightness: CGFloat = 0.15
  static let restingBottomShade: CGFloat = 0.3
  static let restingTopShade: CGFloat = 0.05
  static let restingScale: CGFloat = 0.65
  static let loadingScale: CGFloat = 0.8
  static let restingCorner: CGFloat = 24
  static let topMargin: CGFloat = 64
  static let commit: TimeInterval = 0.5
  static let settle: TimeInterval = 0.7
  static let leave: TimeInterval = 0.45
  static let cancel: TimeInterval = 0.3
  static let footerHeight: CGFloat = 57
  static let dismissPull: CGFloat = 100
}

extension PageSummaryLook {
  var ground: UIColor { UIColor(look.backdropColors(dark: dark, themed: true).first ?? look.surface) }

  var bloom: [Color] { look.deckBlobs(dark: dark) + [look.swatchColor] }

  var discInk: Color {
    var red: CGFloat = 0, green: CGFloat = 0, blue: CGFloat = 0, alpha: CGFloat = 0
    guard UIColor(look.swatchColor).getRed(&red, green: &green, blue: &blue, alpha: &alpha) else { return .white }
    return 0.2126 * red + 0.7152 * green + 0.0722 * blue > 0.6 ? .black : .white
  }
}

@MainActor
@Observable
final class PageSummaryStageModel {
  let look: PageSummaryLook
  var session: PageSummarySession?
  var isCalm = false
  var showsText = false
  var textHeight: CGFloat = 0

  init(look: PageSummaryLook) { self.look = look }
}

final class PageFoldCard: UIView {
  private final class Solid: UIView {
    override class var layerClass: AnyClass { CATransformLayer.self }
  }

  private let solid = Solid()
  private let top = UIImageView()
  private let bottom = UIImageView()
  private let topShade = UIView()
  private let bottomShade = UIView()
  private var link: CADisplayLink?
  private var wobbleStart: CFTimeInterval = 0
  private var wobbleAmount: CGFloat = 0
  private var wobbleTarget: CGFloat = 0
  let pageSize: CGSize

  init(image: UIImage, pageSize: CGSize) {
    self.pageSize = pageSize
    super.init(frame: CGRect(origin: .zero, size: pageSize))
    isUserInteractionEnabled = false
    isAccessibilityElement = false
    var perspective = CATransform3DIdentity
    perspective.m34 = -PageSummaryMotion.perspective / max(pageSize.width, pageSize.height)
    layer.sublayerTransform = perspective
    solid.frame = bounds
    addSubview(solid)

    let half = pageSize.height / 2
    for (panel, shade, isTop) in [(bottom, bottomShade, false), (top, topShade, true)] {
      panel.image = image
      panel.contentMode = .scaleToFill
      panel.clipsToBounds = true
      panel.layer.contentsRect = CGRect(x: 0, y: isTop ? 0 : 0.5, width: 1, height: 0.5)
      panel.layer.anchorPoint = CGPoint(x: 0.5, y: isTop ? 1 : 0)
      panel.layer.isDoubleSided = true
      panel.layer.cornerCurve = .continuous
      panel.layer.maskedCorners = isTop ? [.layerMinXMinYCorner, .layerMaxXMinYCorner] : [.layerMinXMaxYCorner, .layerMaxXMaxYCorner]
      panel.frame = CGRect(x: 0, y: isTop ? 0 : half, width: pageSize.width, height: half)
      shade.frame = panel.bounds
      shade.autoresizingMask = [.flexibleWidth, .flexibleHeight]
      shade.backgroundColor = .black
      shade.alpha = 0
      panel.addSubview(shade)
      solid.addSubview(panel)
    }
    bottom.layer.zPosition = -1
  }

  @available(*, unavailable)
  required init?(coder: NSCoder) { fatalError() }

  deinit { link?.invalidate() }

  private func turn(_ panel: UIView, to angle: CGFloat) {
    panel.layer.setValue(angle, forKeyPath: "transform.rotation.x")
  }

  private func shade(top: CGFloat, bottom: CGFloat) {
    topShade.backgroundColor = top < 0 ? .white : .black
    topShade.alpha = abs(top)
    bottomShade.alpha = bottom
  }

  func hold(fold progress: CGFloat, corner: CGFloat) {
    CATransaction.begin()
    CATransaction.setDisableActions(true)
    turn(top, to: progress * PageSummaryMotion.foldedTop)
    turn(bottom, to: -progress * PageSummaryMotion.foldedBottom)
    let light = sin(min(progress / 1.5, 1) * .pi / 2) * PageSummaryMotion.foldBrightness
    shade(top: -light, bottom: light)
    top.layer.cornerRadius = corner
    bottom.layer.cornerRadius = corner
    CATransaction.commit()
  }

  private func spring(_ layer: CALayer, _ keyPath: String, to value: CGFloat, duration: TimeInterval) {
    let animation = CASpringAnimation(perceptualDuration: duration, bounce: 0)
    animation.keyPath = keyPath
    animation.fromValue = layer.presentation()?.value(forKeyPath: keyPath) ?? layer.value(forKeyPath: keyPath)
    animation.toValue = value
    layer.setValue(value, forKeyPath: keyPath)
    layer.add(animation, forKey: keyPath)
  }

  private func move(top topAngle: CGFloat, bottom bottomAngle: CGFloat, topShade topAlpha: CGFloat, bottomShade bottomAlpha: CGFloat, corner: CGFloat, duration: TimeInterval) {
    spring(top.layer, "transform.rotation.x", to: topAngle, duration: duration)
    spring(bottom.layer, "transform.rotation.x", to: bottomAngle, duration: duration)
    spring(top.layer, "cornerRadius", to: corner, duration: duration)
    spring(bottom.layer, "cornerRadius", to: corner, duration: duration)
    UIView.animate(springDuration: duration, bounce: 0, options: [.beginFromCurrentState]) {
      self.shade(top: topAlpha, bottom: bottomAlpha)
    }
  }

  func rest(duration: TimeInterval, reduced: Bool) {
    if reduced {
      hold(fold: 0, corner: PageSummaryMotion.restingCorner)
      CATransaction.begin()
      CATransaction.setDisableActions(true)
      turn(bottom, to: -PageSummaryMotion.restingBottom)
      CATransaction.commit()
      return
    }
    move(top: -PageSummaryMotion.restingTop, bottom: -PageSummaryMotion.restingBottom, topShade: PageSummaryMotion.restingTopShade,
         bottomShade: PageSummaryMotion.restingBottomShade, corner: PageSummaryMotion.restingCorner, duration: duration)
  }

  func flatten(duration: TimeInterval, reduced: Bool) {
    wobble(false)
    if reduced { return hold(fold: 0, corner: 0) }
    move(top: 0, bottom: 0, topShade: 0, bottomShade: 0, corner: 0, duration: duration)
  }

  func stop() {
    wobbleTarget = 0
    wobbleAmount = 0
    link?.invalidate()
    link = nil
  }

  override func didMoveToWindow() {
    super.didMoveToWindow()
    if window == nil { stop() }
  }

  func wobble(_ on: Bool) {
    wobbleTarget = on ? 1 : 0
    guard link == nil, on, window != nil else { return }
    wobbleStart = CACurrentMediaTime()
    let made = CADisplayLink(target: self, selector: #selector(sway(_:)))
    made.add(to: .main, forMode: .common)
    link = made
  }

  @objc private func sway(_ link: CADisplayLink) {
    let step = CGFloat(link.targetTimestamp - link.timestamp) / 0.25
    wobbleAmount += (wobbleTarget - wobbleAmount) * min(step, 1)
    if wobbleTarget == 0, wobbleAmount < 0.003 {
      wobbleAmount = 0
      link.invalidate()
      self.link = nil
    }
    let time = CGFloat(link.targetTimestamp - wobbleStart)
    let degree = CGFloat.pi / 180
    var sway = CATransform3DMakeTranslation(0, 5 * wobbleAmount * sin(1.9 * .pi * time) / max(transform.a, 0.1), 0)
    let lower = pageSize.height / 2
    sway = CATransform3DTranslate(sway, 0, lower, 0)
    sway = CATransform3DRotate(sway, 3 * degree * wobbleAmount * sin(0.9 * .pi * time), 0, 0.7071, 0.7071)
    sway = CATransform3DTranslate(sway, 0, -lower, 0)
    sway = CATransform3DRotate(sway, 2 * degree * wobbleAmount * sin(1.2 * .pi * time), 1, 0, 0)
    CATransaction.begin()
    CATransaction.setDisableActions(true)
    solid.layer.transform = sway
    CATransaction.commit()
  }
}

final class PageSummaryStage: UIView, UIScrollViewDelegate {
  enum Phase {
    case held
    case loading
    case settled
    case leaving
  }

  let model: PageSummaryStageModel
  var onClose: (() -> Void)?
  private(set) var phase = Phase.held
  private let backdrop: UIHostingController<PageSummaryBackdrop>
  private let scroll = UIScrollView()
  private let titleLabel = UILabel()
  private let statusLabel = UILabel()
  private let text: UIHostingController<PageSummaryText>
  private let footer: UIHostingController<PageSummaryFooter>
  private let card: PageFoldCard
  let reduced = UIAccessibility.isReduceMotionEnabled
  var pageSize: CGSize { card.pageSize }
  private var watching = 0
  private var laidOutSize = CGSize.zero

  init(image: UIImage, pageSize: CGSize, look: PageSummaryLook) {
    card = PageFoldCard(image: image, pageSize: pageSize)
    model = PageSummaryStageModel(look: look)
    backdrop = UIHostingController(rootView: PageSummaryBackdrop(model: model))
    text = UIHostingController(rootView: PageSummaryText(model: model))
    footer = UIHostingController(rootView: PageSummaryFooter(model: model, onClose: {}))
    super.init(frame: .zero)
    footer.rootView = PageSummaryFooter(model: model) { [weak self] in self?.onClose?() }
    backgroundColor = .clear
    overrideUserInterfaceStyle = look.inkIsLight ? .dark : .light
    backdrop.safeAreaRegions = []
    text.safeAreaRegions = []
    footer.safeAreaRegions = []
    for view in [backdrop.view, text.view, footer.view] { view?.backgroundColor = .clear }
    backdrop.view.isUserInteractionEnabled = false
    backdrop.view.alpha = 0
    addSubview(backdrop.view)

    scroll.contentInsetAdjustmentBehavior = .never
    scroll.showsVerticalScrollIndicator = false
    scroll.alwaysBounceVertical = true
    scroll.delegate = self
    scroll.isScrollEnabled = false
    scroll.clipsToBounds = false
    addSubview(scroll)

    titleLabel.font = UIFontMetrics(forTextStyle: .footnote).scaledFont(for: .systemFont(ofSize: 13, weight: .semibold), maximumPointSize: 20)
    titleLabel.textColor = .label
    titleLabel.textAlignment = .center
    titleLabel.lineBreakMode = .byTruncatingTail
    titleLabel.alpha = 0
    titleLabel.isAccessibilityElement = false
    scroll.addSubview(titleLabel)

    statusLabel.text = String(localized: "Summarizing…")
    statusLabel.font = UIFontMetrics(forTextStyle: .headline).scaledFont(for: .systemFont(ofSize: 17, weight: .medium))
    statusLabel.adjustsFontForContentSizeCategory = true
    statusLabel.textColor = .secondaryLabel
    statusLabel.textAlignment = .center
    statusLabel.alpha = 0
    scroll.addSubview(statusLabel)

    text.view.alpha = 0
    scroll.addSubview(text.view)
    scroll.addSubview(card)

    footer.view.alpha = 0
    footer.view.isUserInteractionEnabled = false
    addSubview(footer.view)
    isUserInteractionEnabled = false

    addGestureRecognizer(UIPinchGestureRecognizer(target: self, action: #selector(pinchedOut(_:))))
  }

  @available(*, unavailable)
  required init?(coder: NSCoder) { fatalError() }

  func stop() {
    watching += 1
    card.stop()
  }

  override func safeAreaInsetsDidChange() {
    super.safeAreaInsetsDidChange()
    if phase == .loading || phase == .settled { place(phase) }
  }

  override func accessibilityPerformEscape() -> Bool {
    onClose?()
    return true
  }

  @objc private func pinchedOut(_ recognizer: UIPinchGestureRecognizer) {
    if recognizer.state == .ended, recognizer.scale > 1.25, phase == .loading || phase == .settled { onClose?() }
  }

  func scrollViewDidEndDragging(_ scrollView: UIScrollView, willDecelerate decelerate: Bool) {
    if scrollView.contentOffset.y < -PageSummaryMotion.dismissPull, phase == .settled { onClose?() }
  }


  private func flapHeight(_ scale: CGFloat) -> CGFloat { card.pageSize.height / 2 * scale }

  private var settledScale: CGFloat {
    let fitted = min(bounds.width * PageSummaryMotion.restingScale, 300) / max(card.pageSize.width, 1)
    return min(fitted, bounds.height * 0.36 / max(card.pageSize.height / 2, 1))
  }

  private func scale(_ phase: Phase) -> CGFloat {
    phase == .settled ? settledScale : settledScale * PageSummaryMotion.loadingScale
  }

  private var settledTop: CGFloat { safeAreaInsets.top + PageSummaryMotion.topMargin }

  private func crease(_ phase: Phase) -> CGFloat {
    let settled = settledTop + flapHeight(settledScale)
    return phase == .settled ? settled : settled - flapHeight(settledScale) / 2 + flapHeight(scale(.loading)) / 2
  }

  private func place(_ phase: Phase) {
    let scale = scale(phase)
    let crease = crease(phase)
    card.center = CGPoint(x: bounds.midX, y: crease)
    card.transform = CGAffineTransform(scaleX: scale, y: scale)
    let titleHeight = ceil(titleLabel.font.lineHeight)
    titleLabel.bounds = CGRect(x: 0, y: 0, width: min(bounds.width - 48, max(card.pageSize.width * settledScale, 240)), height: titleHeight)
    titleLabel.center = CGPoint(x: bounds.midX, y: crease - flapHeight(scale) - 8 - titleHeight / 2)
    let shrink = phase == .settled ? 1 : 0.92
    titleLabel.transform = CGAffineTransform(scaleX: shrink, y: shrink)
    let statusHeight = ceil(statusLabel.font.lineHeight)
    statusLabel.bounds = CGRect(x: 0, y: 0, width: bounds.width - 48, height: statusHeight)
    statusLabel.center = CGPoint(x: bounds.midX, y: self.crease(.loading) + 40)
    placeText()
  }

  private func placeText() {
    let width = bounds.width
    text.view.frame = CGRect(x: 0, y: crease(.settled) + 26, width: width, height: max(ceil(model.textHeight), 1))
    let bottom = safeAreaInsets.bottom + PageSummaryMotion.footerHeight
    scroll.contentSize = CGSize(width: width, height: text.view.frame.maxY + bottom + 28)
  }

  override func layoutSubviews() {
    super.layoutSubviews()
    backdrop.view.frame = bounds
    scroll.frame = bounds
    let footerHeight = PageSummaryMotion.footerHeight + safeAreaInsets.bottom
    footer.view.frame = CGRect(x: 0, y: bounds.height - footerHeight, width: bounds.width, height: footerHeight)
    guard laidOutSize != bounds.size else { return }
    laidOutSize = bounds.size
    if phase == .loading || phase == .settled { place(phase) }
  }


  func hold(over pageFrame: CGRect, transform: CGAffineTransform, fold: CGFloat, glow: CGFloat, corner: CGFloat) {
    guard phase == .held else { return }
    card.center = CGPoint(x: pageFrame.midX, y: pageFrame.midY)
    card.transform = transform
    card.hold(fold: reduced ? 0 : fold, corner: corner)
    backdrop.view.alpha = glow
  }

  func fadeOut(_ done: @escaping () -> Void) {
    phase = .leaving
    watching += 1
    isUserInteractionEnabled = false
    accessibilityViewIsModal = false
    card.wobble(false)
    UIView.animate(withDuration: 0.25, delay: 0, options: [.curveEaseOut, .beginFromCurrentState]) {
      self.alpha = 0
    } completion: { _ in done() }
  }

  func release(to pageFrame: CGRect, done: @escaping () -> Void) {
    phase = .leaving
    accessibilityViewIsModal = false
    if reduced { return fadeOut(done) }
    card.flatten(duration: PageSummaryMotion.cancel, reduced: false)
    UIView.animate(springDuration: PageSummaryMotion.cancel, bounce: 0, options: [.beginFromCurrentState]) {
      self.backdrop.view.alpha = 0
      self.card.center = CGPoint(x: pageFrame.midX, y: pageFrame.midY)
      self.card.transform = .identity
    } completion: { _ in done() }
  }

  func commit(_ session: PageSummarySession) {
    guard phase == .held else { return }
    phase = .loading
    isUserInteractionEnabled = true
    footer.view.isUserInteractionEnabled = true
    accessibilityViewIsModal = true
    model.session = session
    titleLabel.text = session.title
    layoutIfNeeded()
    if reduced {
      card.alpha = 0
      UIView.performWithoutAnimation {
        self.card.rest(duration: 0, reduced: true)
        self.place(.loading)
      }
      UIView.animate(withDuration: 0.25) {
        self.backdrop.view.alpha = 1
        self.card.alpha = 1
        self.statusLabel.alpha = 1
        self.titleLabel.alpha = 1
        self.footer.view.alpha = 1
      }
    } else {
      card.rest(duration: PageSummaryMotion.commit, reduced: false)
      statusLabel.transform = CGAffineTransform(scaleX: 0.5, y: 0.5)
      UIView.animate(springDuration: PageSummaryMotion.commit, bounce: 0, options: [.beginFromCurrentState]) {
        self.backdrop.view.alpha = 1
        self.place(.loading)
        self.statusLabel.transform = .identity
        self.statusLabel.alpha = 1
        self.footer.view.alpha = 1
      }
      UIView.animate(withDuration: 0.3, delay: 0.3, options: [.curveEaseInOut]) { self.titleLabel.alpha = 1 }
      card.wobble(true)
    }
    UIAccessibility.post(notification: .screenChanged, argument: statusLabel)
    watch()
    follow()
  }

  private func watch() {
    watching += 1
    let generation = watching
    withObservationTracking {
      _ = model.session?.phase
      _ = model.session?.text
      _ = model.session?.title
      _ = model.textHeight
    } onChange: { [weak self] in
      Task { @MainActor [weak self] in
        guard let self, self.watching == generation else { return }
        self.follow()
        self.watch()
      }
    }
  }

  private func follow() {
    guard let session = model.session, phase == .loading || phase == .settled else { return }
    if titleLabel.text != session.title { titleLabel.text = session.title }
    let readable: Bool = {
      switch session.phase {
      case .done, .interrupted, .failed: true
      case .reading: false
      case .writing: !session.outline(finished: false).isEmpty
      }
    }()
    if phase == .loading, readable { return settle() }
    if phase == .settled { placeText() }
  }

  private func settle() {
    phase = .settled
    card.wobble(false)
    scroll.isScrollEnabled = true
    text.view.alpha = 1
    model.showsText = true
    if reduced {
      UIView.transition(with: scroll, duration: 0.25, options: [.transitionCrossDissolve, .allowUserInteraction]) {
        UIView.performWithoutAnimation {
          self.statusLabel.alpha = 0
          self.place(.settled)
        }
      }
      model.isCalm = true
    } else {
      UIView.animate(springDuration: PageSummaryMotion.commit, bounce: 0, options: [.beginFromCurrentState]) {
        self.statusLabel.alpha = 0
        self.statusLabel.transform = CGAffineTransform(scaleX: 0.5, y: 0.5)
      }
      UIView.animate(springDuration: PageSummaryMotion.settle, bounce: 0, options: [.beginFromCurrentState]) { self.place(.settled) }
      withAnimation(.easeOut(duration: 2).delay(0.5)) { model.isCalm = true }
    }
    UIAccessibility.post(notification: .screenChanged, argument: text.view)
  }

  func leave(to pageFrame: CGRect, done: @escaping () -> Void) {
    phase = .leaving
    watching += 1
    isUserInteractionEnabled = false
    accessibilityViewIsModal = false
    card.wobble(false)
    if reduced { return fadeOut(done) }
    card.center = scroll.convert(card.center, to: self)
    addSubview(card)
    let target = CGPoint(x: pageFrame.midX, y: pageFrame.midY)
    card.flatten(duration: PageSummaryMotion.leave, reduced: false)
    UIView.animate(withDuration: 0.15) {
      self.titleLabel.alpha = 0
      self.statusLabel.alpha = 0
      self.text.view.alpha = 0
      self.footer.view.alpha = 0
    }
    UIView.animate(springDuration: PageSummaryMotion.leave, bounce: 0, options: [.beginFromCurrentState]) {
      self.card.transform = .identity
      self.card.center = target
      self.backdrop.view.alpha = 0
    } completion: { _ in done() }
  }
}
