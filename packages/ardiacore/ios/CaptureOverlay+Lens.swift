import AppKit
import QuartzCore

extension CaptureOverlay {
  func startTicking() {
    guard ticker == nil, window != nil else { return }
    let link = displayLink(target: self, selector: #selector(tick(_:)))
    link.add(to: .main, forMode: .common)
    ticker = link
    lastTick = 0
  }

  func stopTicking() {
    ticker?.invalidate()
    ticker = nil
  }

  @objc private func tick(_ link: CADisplayLink) {
    let elapsed = lastTick == 0 ? link.duration : link.timestamp - lastTick
    lastTick = link.timestamp
    spring.advance(by: min(max(elapsed, 0), Self.longestFrame))
    if spring.settled { stopTicking() }
    showLens()
  }
}
