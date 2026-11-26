import UIKit

@MainActor
enum ScrollBounceProbe {
  private static var timer: Timer?

  static func startIfAsked() {
    let every = UserDefaults.standard.double(forKey: "ArdiaScrollProbe")
    guard PhoneTestBuild.isOn, every > 0, timer == nil else { return }
    timer = Timer.scheduledTimer(withTimeInterval: every, repeats: true) { _ in
      MainActor.assumeIsolated { dump() }
    }
  }

  private static func dump() {
    let windows = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.flatMap(\.windows)
    for window in windows where !window.isHidden {
      var queue: [UIView] = [window]
      var index = 0
      while index < queue.count {
        let view = queue[index]
        index += 1
        if let scroll = view as? UIScrollView, scroll.window != nil, !scroll.isHidden, scroll.alpha > 0, scroll.bounds.height > 40 {
          let frame = scroll.convert(scroll.bounds, to: nil)
          NSLog("PAGELAB scroll %@ vertical=%d horizontal=%d always=%d refresh=%d frame=%.0f,%.0f,%.0fx%.0f", NSStringFromClass(type(of: scroll)), scroll.bouncesVertically ? 1 : 0, scroll.bouncesHorizontally ? 1 : 0, scroll.alwaysBounceVertical ? 1 : 0, scroll.refreshControl == nil ? 0 : 1, frame.minX, frame.minY, frame.width, frame.height)
        }
        queue.append(contentsOf: view.subviews)
      }
    }
    NSLog("PAGELAB scroll dump end")
  }
}
