import QuartzCore
import UIKit

@MainActor
enum KeyboardWarmUp {
  private static var warmed = false
  private static var finished = false
  private static let quietAfterTouch: CFTimeInterval = 1
  private static var watcher: TouchWatcher?

  private static var activation: NSObjectProtocol?

  static func watchTouches() {
    guard watcher == nil, !finished else { return }
    guard let window = mainWindow() else { return watchWhenActive() }
    let touches = TouchWatcher()
    window.addGestureRecognizer(touches)
    watcher = touches
    if let activation { NotificationCenter.default.removeObserver(activation) }
    activation = nil
  }

  static func finish() {
    finished = true
    if let watcher { watcher.view?.removeGestureRecognizer(watcher) }
    watcher = nil
    if let activation { NotificationCenter.default.removeObserver(activation) }
    activation = nil
  }

  private static func watchWhenActive() {
    guard activation == nil else { return }
    activation = NotificationCenter.default.addObserver(forName: UIScene.didActivateNotification, object: nil, queue: .main) { _ in
      MainActor.assumeIsolated { watchTouches() }
    }
  }

  static func attempt() -> [String: Any] {
    if warmed || finished { return ["outcome": "done"] }
    guard UIApplication.shared.applicationState == .active else { return ["outcome": "inactive"] }
    guard let scene = activeScene(), let main = mainWindow(in: scene), scene.keyWindow === main else { return ["outcome": "notMainWindow"] }
    watchTouches()
    guard let watcher else { return ["outcome": "notWatching"] }
    if let holder = focusHolder(in: scene) { return ["outcome": "focused", "holder": String(describing: type(of: holder))] }
    if RunLoop.main.currentMode == .tracking || scene.windows.contains(where: { scrolling($0) }) { return ["outcome": "scrolling"] }
    if watcher.down > 0 { return ["outcome": "touching"] }
    if let ended = watcher.lastEnded, CACurrentMediaTime() - ended < quietAfterTouch { return ["outcome": "recentTouch"] }
    if presenting(main.rootViewController) { return ["outcome": "presenting"] }
    let started = CACurrentMediaTime()
    let field = UITextField(frame: CGRect(x: -100, y: -100, width: 1, height: 1))
    field.alpha = 0
    field.isAccessibilityElement = false
    field.autocorrectionType = .no
    field.spellCheckingType = .no
    main.addSubview(field)
    let took = field.becomeFirstResponder()
    field.resignFirstResponder()
    field.removeFromSuperview()
    warmed = took
    if took { finish() }
    return ["outcome": took ? "warmed" : "refused", "ms": (CACurrentMediaTime() - started) * 1000]
  }

  private static func activeScene() -> UIWindowScene? {
    UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first { $0.activationState == .foregroundActive }
  }

  private static func mainWindow() -> UIWindow? {
    mainWindow(in: activeScene())
  }

  private static func mainWindow(in scene: UIWindowScene?) -> UIWindow? {
    guard let scene else { return nil }
    if let window = (scene.delegate as? UIWindowSceneDelegate)?.window ?? nil { return window }
    return scene.windows.first { !$0.isHidden && $0.windowLevel == .normal }
  }

  fileprivate static var answered: UIResponder?

  private static func focusHolder(in scene: UIWindowScene) -> UIResponder? {
    answered = nil
    UIApplication.shared.sendAction(#selector(UIResponder.ardiaAnswerFocusProbe(_:)), to: nil, from: nil, for: nil)
    let first = answered
    answered = nil
    if let first, !(first is UIWindow), !(first is UIApplication), !(first is UIApplicationDelegate) { return first }
    for window in scene.windows {
      if let view = firstResponderView(in: window) { return view }
    }
    return nil
  }

  private static func firstResponderView(in view: UIView) -> UIView? {
    if view.isFirstResponder { return view }
    for subview in view.subviews {
      if let found = firstResponderView(in: subview) { return found }
    }
    return nil
  }

  private static func scrolling(_ view: UIView) -> Bool {
    if let scroll = view as? UIScrollView, scroll.isDragging || scroll.isDecelerating { return true }
    return view.subviews.contains { scrolling($0) }
  }

  private static func presenting(_ controller: UIViewController?) -> Bool {
    guard let controller else { return false }
    if controller.presentedViewController != nil || controller.transitionCoordinator != nil { return true }
    return controller.children.contains { presenting($0) }
  }
}

extension UIResponder {
  @objc func ardiaAnswerFocusProbe(_ sender: Any?) {
    MainActor.assumeIsolated { KeyboardWarmUp.answered = self }
  }
}

final class TouchWatcher: UIGestureRecognizer, UIGestureRecognizerDelegate {
  private(set) var down = 0
  private(set) var lastEnded: CFTimeInterval?

  init() {
    super.init(target: nil, action: nil)
    cancelsTouchesInView = false
    delaysTouchesBegan = false
    delaysTouchesEnded = false
    requiresExclusiveTouchType = false
    delegate = self
  }

  override func touchesBegan(_ touches: Set<UITouch>, with event: UIEvent) {
    down += touches.count
  }

  override func touchesEnded(_ touches: Set<UITouch>, with event: UIEvent) {
    release(touches.count, event)
  }

  override func touchesCancelled(_ touches: Set<UITouch>, with event: UIEvent) {
    release(touches.count, event)
  }

  private func release(_ count: Int, _ event: UIEvent) {
    down = max(0, down - count)
    lastEnded = CACurrentMediaTime()
    if down == 0 { state = .failed }
  }

  override func reset() {
    down = 0
  }

  func gestureRecognizer(_ gestureRecognizer: UIGestureRecognizer, shouldRecognizeSimultaneouslyWith other: UIGestureRecognizer) -> Bool {
    true
  }
}
