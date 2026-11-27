import QuartzCore
import UIKit

@MainActor
enum KeyboardWarmUp {
  private static var warmed = false
  private static var watcher: TouchWatcher?

  static func watchTouches() {
    guard watcher == nil, let window = mainWindow() else { return }
    let touches = TouchWatcher()
    window.addGestureRecognizer(touches)
    watcher = touches
  }

  static func attempt() -> [String: Any] {
    if warmed { return ["outcome": "done"] }
    guard UIApplication.shared.applicationState == .active else { return ["outcome": "inactive"] }
    guard let scene = activeScene(), let main = mainWindow(in: scene), scene.keyWindow === main else { return ["outcome": "notMainWindow"] }
    watchTouches()
    if scene.windows.contains(where: { holdsFocus($0) }) { return ["outcome": "focused"] }
    if RunLoop.main.currentMode == .tracking { return ["outcome": "scrolling"] }
    if (watcher?.down ?? 0) > 0 { return ["outcome": "touching"] }
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
    return ["outcome": took ? "warmed" : "refused", "ms": (CACurrentMediaTime() - started) * 1000]
  }

  private static func activeScene() -> UIWindowScene? {
    UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first { $0.activationState == .foregroundActive }
  }

  private static func mainWindow(in scene: UIWindowScene? = activeScene()) -> UIWindow? {
    guard let scene else { return nil }
    if let window = (scene.delegate as? UIWindowSceneDelegate)?.window ?? nil { return window }
    return scene.windows.first { !$0.isHidden && $0.windowLevel == .normal }
  }

  private static func holdsFocus(_ view: UIView) -> Bool {
    if view.isFirstResponder { return true }
    return view.subviews.contains { holdsFocus($0) }
  }

  private static func presenting(_ controller: UIViewController?) -> Bool {
    guard let controller else { return false }
    if controller.presentedViewController != nil || controller.transitionCoordinator != nil { return true }
    return controller.children.contains { presenting($0) }
  }
}

final class TouchWatcher: UIGestureRecognizer, UIGestureRecognizerDelegate {
  private(set) var down = 0

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
    if down == 0 { state = .failed }
  }

  override func reset() {
    down = 0
  }

  func gestureRecognizer(_ gestureRecognizer: UIGestureRecognizer, shouldRecognizeSimultaneouslyWith other: UIGestureRecognizer) -> Bool {
    true
  }
}
