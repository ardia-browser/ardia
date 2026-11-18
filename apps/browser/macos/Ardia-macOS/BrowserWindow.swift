import AppKit
import ArdiaCore

final class BrowserWindow: NSWindow {
  private let trafficLightDesignInset = NSPoint(x: 16, y: 20)

  init() {
    super.init(
      contentRect: NSRect(x: 0, y: 0, width: 1360, height: 860),
      styleMask: [.titled, .closable, .miniaturizable, .resizable, .fullSizeContentView],
      backing: .buffered,
      defer: false
    )
    titlebarAppearsTransparent = true
    titleVisibility = .hidden
    title = "Ardia"
    ArdiaChromeWindowHost.setInterfaceMinSize(NSSize(width: 720, height: 460), of: self)
    isReleasedWhenClosed = false
    backgroundColor = NSColor(name: nil) { appearance in
      appearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua
        ? NSColor(srgbRed: 0.17, green: 0.12, blue: 0.14, alpha: 1)
        : NSColor(srgbRed: 0.93, green: 0.91, blue: 0.90, alpha: 1)
    }

    for name in [NSWindow.didResizeNotification, NSWindow.didExitFullScreenNotification, NSWindow.didBecomeKeyNotification] {
      NotificationCenter.default.addObserver(self, selector: #selector(layoutTrafficLights), name: name, object: self)
    }
    NotificationCenter.default.addObserver(self, selector: #selector(layoutTrafficLights), name: .ArdiaInterfaceScaleDidChange, object: nil)
    layoutTrafficLights()
  }

  override func layoutIfNeeded() {
    super.layoutIfNeeded()
    layoutTrafficLights()
  }

  @objc private func layoutTrafficLights() {
    guard !styleMask.contains(.fullScreen),
          let close = standardWindowButton(.closeButton),
          let mini = standardWindowButton(.miniaturizeButton),
          let zoom = standardWindowButton(.zoomButton),
          let container = close.superview?.superview else { return }

    let scale = InterfaceScale.scale
    let size = close.frame.size
    let center = NSPoint(x: (trafficLightDesignInset.x + size.width / 2) * scale, y: (trafficLightDesignInset.y + size.height / 2) * scale)
    let height = center.y * 2
    var frame = container.frame
    frame.size.height = height
    frame.origin.y = self.frame.height - height
    container.frame = frame

    let spacing = mini.frame.minX - close.frame.minX
    for (i, button) in [close, mini, zoom].enumerated() {
      button.setFrameOrigin(NSPoint(
        x: center.x - size.width / 2 + CGFloat(i) * spacing,
        y: (height - button.frame.height) / 2
      ))
    }
  }
}
