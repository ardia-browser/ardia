import AppKit
import Testing
import WebKit

private class Flipped: NSView {
  override var isFlipped: Bool { true }
}

private final class ScaledTab: Flipped {
  var scale: CGFloat = 1
  var place: (() -> Void)?

  override func setFrameSize(_ newSize: NSSize) {
    super.setFrameSize(newSize)
    fit()
  }

  override func resizeSubviews(withOldSize oldSize: NSSize) { place?() }

  override func layout() {
    super.layout()
    place?()
  }

  func fit() {
    setBoundsSize(NSSize(width: frame.width * scale, height: frame.height * scale))
    place?()
  }
}

@MainActor private final class Rig {
  let window: NSWindow
  let root = Flipped(frame: NSRect(x: 0, y: 0, width: 1200, height: 800))
  let tab = ScaledTab(frame: .zero)
  let container = WebKitPageContainer()
  let page = WKWebView(frame: .zero)

  init(scale: CGFloat, contained: Bool = true) {
    _ = NSApplication.shared
    window = NSWindow(contentRect: root.frame, styleMask: [.borderless], backing: .buffered, defer: false)
    window.isReleasedWhenClosed = false
    let content = Flipped(frame: root.frame)
    content.wantsLayer = true
    window.contentView = content
    content.addSubview(root)
    root.setBoundsSize(NSSize(width: 1200 / scale, height: 800 / scale))
    let label = NSTextField(labelWithString: "auto layout")
    label.translatesAutoresizingMaskIntoConstraints = false
    content.addSubview(label)
    NSLayoutConstraint.activate([
      label.leadingAnchor.constraint(equalTo: content.leadingAnchor),
      label.topAnchor.constraint(equalTo: content.topAnchor),
    ])
    tab.scale = scale
    root.addSubview(tab)
    if contained {
      tab.place = { [unowned self] in container.fill(tab) }
      tab.addSubview(container)
      container.hold(page)
    } else {
      tab.place = { [unowned self] in if page.frame != tab.bounds { page.frame = tab.bounds } }
      page.autoresizingMask = [.width, .height]
      tab.addSubview(page)
    }
    resize(900, 700)
  }

  func resize(_ width: CGFloat, _ height: CGFloat) {
    tab.frame = NSRect(x: 0, y: 0, width: width / tab.scale, height: height / tab.scale)
    settle()
  }

  func settle() {
    window.contentView?.layoutSubtreeIfNeeded()
    window.contentView?.layoutSubtreeIfNeeded()
  }

  var layerHost: NSSize { page.subviews.first?.frame.size ?? .zero }
}

private func close(_ a: NSSize, _ b: NSSize) -> Bool { abs(a.width - b.width) <= 1 && abs(a.height - b.height) <= 1 }

@MainActor @Suite(.serialized) struct WebKitPageContainerTests {
  @Test func aMaskedPageDirectlyInAScaledTabIsClipped() {
    let rig = Rig(scale: 1.1, contained: false)
    #expect(!close(rig.layerHost, rig.page.bounds.size))
  }

  @Test(arguments: [0.8, 1, 1.05, 1.1, 1.5])
  func thePageAndWebKitsLayerHostFillTheTab(scale: Double) {
    let rig = Rig(scale: scale)
    for (width, height) in [(900.0, 700.0), (640.0, 480.0), (0.0, 0.0), (1100.0, 760.0)] {
      rig.resize(width, height)
      #expect(close(rig.page.frame.size, NSSize(width: width, height: height)))
      #expect(close(rig.layerHost, rig.page.bounds.size))
    }
  }

  @Test(arguments: [0.8, 1, 1.1])
  func thePageFollowsTheFullscreenWindowAndReturnsToTheResizedTab(scale: Double) {
    let rig = Rig(scale: scale)
    let placeholder = NSView(frame: rig.page.frame)
    placeholder.autoresizingMask = rig.page.autoresizingMask
    rig.container.addSubview(placeholder)
    let screen = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 2560, height: 1080), styleMask: [.borderless], backing: .buffered, defer: false)
    screen.isReleasedWhenClosed = false
    let clip = NSView(frame: NSRect(x: 0, y: 0, width: 2560, height: 1080))
    screen.contentView = clip
    rig.page.removeFromSuperview()
    clip.addSubview(rig.page)
    rig.page.frame = clip.bounds

    rig.resize(1100, 760)
    #expect(close(rig.page.frame.size, NSSize(width: 2560, height: 1080)))
    screen.setContentSize(NSSize(width: 1920, height: 1000))
    screen.contentView?.layoutSubtreeIfNeeded()
    #expect(close(rig.page.frame.size, NSSize(width: 1920, height: 1000)))

    rig.page.removeFromSuperview()
    rig.page.frame = placeholder.frame
    rig.page.autoresizingMask = placeholder.autoresizingMask
    rig.container.addSubview(rig.page, positioned: .below, relativeTo: placeholder)
    placeholder.removeFromSuperview()
    rig.settle()
    #expect(close(rig.page.frame.size, NSSize(width: 1100, height: 760)))
    #expect(close(rig.layerHost, rig.page.bounds.size))
  }

  @Test(arguments: [1, 1.1])
  func aDockedInspectorKeepsItsShareWhenTheTabResizes(scale: Double) {
    let rig = Rig(scale: scale)
    let inspector = NSView(frame: NSRect(x: 0, y: 0, width: 900, height: 300))
    inspector.autoresizingMask = [.width, .maxYMargin]
    rig.page.frame = NSRect(x: 0, y: 300, width: 900, height: 400)
    rig.container.addSubview(inspector, positioned: .below, relativeTo: rig.page)
    rig.resize(800, 640)
    #expect(close(inspector.frame.size, NSSize(width: 800, height: 300)))
    #expect(close(rig.page.frame.size, NSSize(width: 800, height: 340)))
    #expect(abs(rig.page.frame.minY - 300) <= 1)
  }
}
