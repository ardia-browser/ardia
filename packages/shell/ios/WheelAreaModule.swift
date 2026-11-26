import AppKit
import ExpoModulesCore

public class WheelAreaModule: Module, WheelAreaNative {
  static func devWheel(_ windowId: String, _ x: Double, _ y: Double, _ steps: [[String: Any]], _ promise: Promise) {
    #if DEBUG
    WheelArea.devWheel(windowId: windowId, x: x, y: y, steps: steps, promise: promise)
    #else
    promise.resolve(["error": "DEV builds only"])
    #endif
  }

  func glideScroll(_ tag: Int, _ y: Double, _ durationMs: Double) {
    guard let host = self.appContext?.findView(withTag: tag, ofType: NSView.self), let scroll = WheelArea.scrollView(in: host) else { return }
    WheelArea.glide(scroll, to: CGFloat(y), duration: durationMs)
    WheelArea.owner(of: scroll)?.glided(ms: durationMs)
  }

  func steerScroll(_ tag: Int, _ lo: Double, _ hi: Double, _ glideMs: Double, _ canForward: Bool, _ canBack: Bool) {
    guard let host = self.appContext?.findView(withTag: tag, ofType: NSView.self), let scroll = WheelArea.scrollView(in: host),
      let area = WheelArea.owner(of: scroll)
    else { return }
    area.steer(scroll, range: WheelRange(lo: lo, hi: hi, forward: canForward, back: canBack), glideMs: glideMs)
  }

  public func definition() -> ModuleDefinition {
    Name(Self.moduleName)

    Self.devWheelFunction
    glideScrollFunction
    steerScrollFunction

    View(WheelArea.self) {
      Events("onStep")
    }
  }
}
