import AppKit
import ExpoModulesCore
import QuartzCore

public class SwipeModule: Module {
  public func definition() -> ModuleDefinition {
    Name("ArdiaSwipe")

    Function("haptic") { (pattern: String) in
      DispatchQueue.main.async { ArdiaSwipe.performHaptic(pattern) }
    }

    AsyncFunction("switchPager") { (key: String, index: Int, order: [String]?) -> Bool in
      Pager.existing(key)?.switchTo(index, order: order) ?? false
    }.runOnQueue(.main)

    AsyncFunction("selectPager") { (key: String, profileId: String, order: [String]) -> Bool in
      Pager.existing(key)?.select(profileId, order: order) ?? false
    }.runOnQueue(.main)

    AsyncFunction("stepPager") { (key: String, delta: Int, wrap: Bool, order: [String]?) -> Bool in
      Pager.existing(key)?.step(delta, wrap: wrap, order: order) ?? false
    }.runOnQueue(.main)

    AsyncFunction("leadPager") { (key: String, open: Bool, animated: Bool) -> Bool in
      Pager.existing(key)?.lead(open, animated: animated) ?? false
    }.runOnQueue(.main)

    Function("pagerState") { (key: String) -> [String: Any]? in Pager.snapshot(key) }

    AsyncFunction("morphPager") { (key: String, config: MorphConfig?) -> Bool in
      guard let pager = Pager.existing(key) else { return false }
      pager.configureMorph(config, uiManager: self.appContext?.reactBridge?.uiManager)
      return true
    }.runOnQueue(.main)

    Function("takeMorphCounts") { () -> [String: Int] in PagerMorph.takeCounts() }

    AsyncFunction("devMorph") { (key: String, clear: Bool, hoverPasses: Int) -> [String: Any]? in
      #if DEBUG
      var out = Pager.existing(key)?.morphDebug(clear: clear) ?? [:]
      if hoverPasses > 0 { out["hoverCheckMs"] = ArdiaMorphLayout.hoverCheckMilliseconds(hoverPasses) }
      return out
      #else
      return nil
      #endif
    }.runOnQueue(.main)

    AsyncFunction("devPagerState") { (key: String) -> [String: Any]? in
      #if DEBUG
      return Pager.existing(key)?.debug()
      #else
      return nil
      #endif
    }.runOnQueue(.main)

    AsyncFunction("devSimulate") { (x: Double, y: Double, windowNumber: Int, steps: [[String: Any]], ignorePreference: Bool, promise: Promise) in
      #if DEBUG
      guard let window = NSApp.window(withWindowNumber: windowNumber) else {
        promise.resolve(["error": "no window \(windowNumber)"])
        return
      }
      ArdiaSwipe.simulate(in: window, point: NSPoint(x: x, y: y), steps: steps, ignoreSystemPreference: ignorePreference) {
        promise.resolve($0)
      }
      #else
      promise.resolve(["error": "DEV builds only"])
      #endif
    }.runOnQueue(.main)

    View(SwipeArea.self) {
      Events("onSwipe", "onPagerPosition", "onPagerState")
      Prop("canSwipeBack") { (view: SwipeArea, value: Bool?) in view.canSwipeBack = value ?? false }
      Prop("canSwipeForward") { (view: SwipeArea, value: Bool?) in view.canSwipeForward = value ?? false }
      Prop("tracksUnavailableDirections") { (view: SwipeArea, value: Bool?) in view.tracksUnavailableDirections = value ?? false }
      Prop("allowsVerticalMotion") { (view: SwipeArea, value: Bool?) in view.allowsVerticalMotion = value ?? false }
      Prop("isPager") { (view: SwipeArea, value: Bool?) in view.isPager = value ?? false }
      Prop("nativePager") { (view: SwipeArea, config: PagerConfig?) in view.configurePager(config) }
      AsyncFunction("devLocate") { (view: SwipeArea) -> [String: Any]? in
        guard let window = view.window, let root = InterfaceScale.root(of: window) ?? window.contentView else { return nil }
        let frame = root.convert(view.bounds, from: view)
        let left = frame.minX - root.bounds.minX
        let top = root.isFlipped ? frame.minY - root.bounds.minY : root.bounds.maxY - frame.maxY
        return ["windowNumber": window.windowNumber, "x": left, "y": top, "width": frame.width, "height": frame.height]
      }.runOnQueue(.main)
    }
  }
}
