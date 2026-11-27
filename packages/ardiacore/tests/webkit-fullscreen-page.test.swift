import AppKit
import Testing
import WebKit

@objc(WKFullScreenPlaceholderView) final class StandInPlaceholder: NSView {
  @objc var scrollViewFrame: NSRect { convert(bounds, to: nil) }
  @objc var hasScrolledContentsUnderTitlebar: Bool { false }
}

final class AdapterWindow: NSWindow {
  var adapters: [ObjectIdentifier: Int] = [:]

  @objc(registerScrollViewSeparatorTrackingAdapter:) @discardableResult func registerAdapter(_ view: NSView) -> Bool {
    adapters[ObjectIdentifier(view), default: 0] += 1
    return true
  }

  @objc(unregisterScrollViewSeparatorTrackingAdapter:) func unregisterAdapter(_ view: NSView) {
    adapters[ObjectIdentifier(view), default: 0] -= 1
  }

  func registered(_ view: NSView) -> Int { adapters[ObjectIdentifier(view)] ?? 0 }

  static func make(width: CGFloat = 400, height: CGFloat = 300) -> AdapterWindow {
    let window = AdapterWindow(contentRect: NSRect(x: 0, y: 0, width: width, height: height), styleMask: [.titled], backing: .buffered, defer: false)
    window.isReleasedWhenClosed = false
    return window
  }
}

@MainActor
struct FullscreenScene {
  let windowed: AdapterWindow
  let fullscreen: NSWindow
  let oldTab = NSView(frame: NSRect(x: 0, y: 0, width: 400, height: 300))
  let page = NSView(frame: NSRect(x: 0, y: 0, width: 400, height: 300))
  let placeholder = StandInPlaceholder(frame: NSRect(x: 0, y: 0, width: 400, height: 300))

  init() {
    windowed = AdapterWindow.make()
    fullscreen = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1280, height: 800), styleMask: [.borderless], backing: .buffered, defer: false)
    fullscreen.isReleasedWhenClosed = false
    windowed.contentView!.addSubview(oldTab)
    oldTab.addSubview(page)
    enterFullscreen()
  }

  func enterFullscreen() {
    oldTab.replaceSubview(page, with: placeholder)
    (placeholder.window as? AdapterWindow)?.registerAdapter(placeholder)
    fullscreen.contentView!.addSubview(page)
  }

  func exitFullscreen() {
    page.removeFromSuperview()
    placeholder.superview?.addSubview(page, positioned: .below, relativeTo: placeholder)
    (placeholder.window as? AdapterWindow)?.unregisterAdapter(placeholder)
    placeholder.removeFromSuperview()
  }
}

@MainActor
@Suite struct WebKitFullscreenPageAcrossTabs {
  @Test func `a tab hides its page only while the page is inside it`() {
    let scene = FullscreenScene()
    #expect(!WebKitFullscreenPage.hidesPage(scene.page, in: scene.oldTab, visible: false))
    scene.exitFullscreen()
    #expect(WebKitFullscreenPage.hidesPage(scene.page, in: scene.oldTab, visible: false))
    #expect(!WebKitFullscreenPage.hidesPage(scene.page, in: scene.oldTab, visible: true))
  }

  @Test func `WebKit's placeholder is told apart from the tab's other views`() {
    #expect(WebKitFullscreenPage.isPlaceholder(StandInPlaceholder()))
    #expect(!WebKitFullscreenPage.isPlaceholder(NSView()))
  }

  @Test func `a page full screen in WebKit's window counts as held elsewhere, a page in its tab or nowhere does not`() {
    let scene = FullscreenScene()
    let newTab = NSView()
    #expect(WebKitFullscreenPage.heldElsewhere(scene.page, from: scene.oldTab, inFullscreen: true))
    #expect(!WebKitFullscreenPage.heldElsewhere(scene.page, from: scene.oldTab, inFullscreen: false))
    scene.exitFullscreen()
    #expect(!WebKitFullscreenPage.heldElsewhere(scene.page, from: scene.oldTab, inFullscreen: true))
    scene.page.removeFromSuperview()
    #expect(!WebKitFullscreenPage.heldElsewhere(scene.page, from: newTab, inFullscreen: true))
  }

  @Test func `moving the page itself during full screen loses it when full screen ends`() {
    let scene = FullscreenScene()
    let newWindow = AdapterWindow.make()
    let newTab = NSView(frame: newWindow.contentView!.bounds)
    newWindow.contentView!.addSubview(newTab)
    scene.page.removeFromSuperview()
    newTab.addSubview(scene.page)
    scene.oldTab.removeFromSuperview()
    scene.exitFullscreen()
    #expect(scene.page.superview !== newTab)
    #expect(scene.page.window == nil)
    #expect(WebKitFullscreenPage.reclaims(scene.page, into: newTab, inFullscreen: false, settled: false))
  }

  @Test func `carrying the placeholder to the new tab brings the page back into it when full screen ends`() {
    let scene = FullscreenScene()
    let newWindow = AdapterWindow.make(width: 500, height: 320)
    let newTab = NSView(frame: newWindow.contentView!.bounds)
    newWindow.contentView!.addSubview(newTab)
    let carried = WebKitFullscreenPage.takePlaceholders(from: scene.oldTab)
    #expect(carried.count == 1)
    #expect(scene.oldTab.subviews.isEmpty)
    #expect(scene.page.window === scene.fullscreen)
    WebKitFullscreenPage.give(carried, to: newTab)
    #expect(scene.placeholder.frame == newTab.bounds)
    scene.oldTab.removeFromSuperview()
    scene.exitFullscreen()
    #expect(scene.page.superview === newTab)
    #expect(scene.page.window === newWindow)
    #expect(!WebKitFullscreenPage.reclaims(scene.page, into: newTab, inFullscreen: false, settled: true))
  }

  @Test func `a page left outside its tab after full screen is reclaimed, at once when orphaned and once settled otherwise`() {
    let scene = FullscreenScene()
    #expect(!WebKitFullscreenPage.reclaims(scene.page, into: scene.oldTab, inFullscreen: true, settled: true))
    #expect(!WebKitFullscreenPage.reclaims(scene.page, into: scene.oldTab, inFullscreen: false, settled: false))
    #expect(WebKitFullscreenPage.reclaims(scene.page, into: scene.oldTab, inFullscreen: false, settled: true))
    scene.page.removeFromSuperview()
    #expect(WebKitFullscreenPage.reclaims(scene.page, into: scene.oldTab, inFullscreen: false, settled: false))
  }

  @Test func `moving the placeholder moves WebKit's window registration with it, and the source window that stays open ends balanced`() {
    let scene = FullscreenScene()
    let newWindow = AdapterWindow.make(width: 500, height: 320)
    let newTab = NSView(frame: newWindow.contentView!.bounds)
    newWindow.contentView!.addSubview(newTab)
    #expect(scene.windowed.registered(scene.placeholder) == 1)
    WebKitFullscreenPage.give(WebKitFullscreenPage.takePlaceholders(from: scene.oldTab), to: newTab)
    #expect(scene.windowed.registered(scene.placeholder) == 0)
    #expect(newWindow.registered(scene.placeholder) == 1)
    scene.exitFullscreen()
    #expect(scene.oldTab.window === scene.windowed)
    #expect(scene.windowed.registered(scene.placeholder) == 0)
    #expect(newWindow.registered(scene.placeholder) == 0)
    #expect(scene.page.superview === newTab)
  }

  @Test func `a placeholder handed to a tab outside any window registers once the tab joins one`() {
    let scene = FullscreenScene()
    let newWindow = AdapterWindow.make()
    let newTab = NSView(frame: NSRect(x: 0, y: 0, width: 400, height: 300))
    WebKitFullscreenPage.give(WebKitFullscreenPage.takePlaceholders(from: scene.oldTab), to: newTab)
    #expect(scene.windowed.registered(scene.placeholder) == 0)
    newWindow.contentView!.addSubview(newTab)
    WebKitFullscreenPage.register(WebKitFullscreenPage.placeholders(in: newTab), with: newTab.window)
    #expect(newWindow.registered(scene.placeholder) == 1)
    WebKitFullscreenPage.unregister(WebKitFullscreenPage.placeholders(in: newTab), from: newTab.window)
    newTab.removeFromSuperview()
    #expect(newWindow.registered(scene.placeholder) == 0)
  }

  @Test func `a tab adopting a page already in full screen reports the exit when full screen ends`() {
    let adopted = WebKitFullscreenPage.isOn(.inFullscreen)
    #expect(adopted)
    #expect(WebKitFullscreenPage.reportsChange(was: adopted, now: .notInFullscreen))
    #expect(!WebKitFullscreenPage.reportsChange(was: false, now: .notInFullscreen))
    #expect(!WebKitFullscreenPage.reportsChange(was: adopted, now: .inFullscreen))
    #expect(WebKitFullscreenPage.isOn(.enteringFullscreen))
    #expect(!WebKitFullscreenPage.isOn(.exitingFullscreen))
  }

  @Test func `picking another tab behind a page held in full screen opens no automatic Picture in Picture`() {
    var rule = WebKitAutoPictureInPicture()
    #expect(rule.sight(WebKitFullscreenPage.seen(visible: true, heldInFullscreen: true, windowSeen: true, fullscreenWindowSeen: true), userIn: true, enabled: true, playing: true) == .none)
    #expect(rule.sight(WebKitFullscreenPage.seen(visible: false, heldInFullscreen: true, windowSeen: true, fullscreenWindowSeen: true), userIn: true, enabled: true, playing: true) == .none)
    #expect(rule.sight(WebKitFullscreenPage.seen(visible: false, heldInFullscreen: false, windowSeen: true, fullscreenWindowSeen: false), userIn: true, enabled: true, playing: true) == .open)
    var old = WebKitAutoPictureInPicture()
    #expect(old.sight(false, userIn: true, enabled: true, playing: true) == .open)
  }

  @Test func `a page held in full screen opens no automatic Picture in Picture while Ardia's own window is occluded`() {
    var rule = WebKitAutoPictureInPicture()
    #expect(WebKitFullscreenPage.seen(visible: true, heldInFullscreen: true, windowSeen: false, fullscreenWindowSeen: true))
    #expect(WebKitFullscreenPage.seen(visible: false, heldInFullscreen: true, windowSeen: false, fullscreenWindowSeen: true))
    #expect(rule.sight(WebKitFullscreenPage.seen(visible: true, heldInFullscreen: true, windowSeen: false, fullscreenWindowSeen: true), userIn: true, enabled: true, playing: true) == .none)
    #expect(rule.sight(WebKitFullscreenPage.seen(visible: false, heldInFullscreen: true, windowSeen: false, fullscreenWindowSeen: true), userIn: true, enabled: true, playing: true) == .none)
    #expect(!WebKitFullscreenPage.seen(visible: true, heldInFullscreen: false, windowSeen: false, fullscreenWindowSeen: false))
    #expect(rule.sight(WebKitFullscreenPage.seen(visible: true, heldInFullscreen: false, windowSeen: false, fullscreenWindowSeen: false), userIn: true, enabled: true, playing: true) == .open)
  }

  @Test func `a page held in full screen asks for automatic Picture in Picture once its full-screen window leaves sight, not before`() {
    var rule = WebKitAutoPictureInPicture()
    #expect(rule.sight(WebKitFullscreenPage.seen(visible: false, heldInFullscreen: true, windowSeen: false, fullscreenWindowSeen: true), userIn: true, enabled: true, playing: true) == .none)
    #expect(rule.sight(WebKitFullscreenPage.seen(visible: false, heldInFullscreen: true, windowSeen: false, fullscreenWindowSeen: false), userIn: true, enabled: true, playing: true) == .open)
    #expect(rule.sight(WebKitFullscreenPage.seen(visible: false, heldInFullscreen: true, windowSeen: false, fullscreenWindowSeen: true), userIn: true, enabled: true, playing: true) == .close)
    #expect(WebKitFullscreenPage.seen(visible: true, heldInFullscreen: false, windowSeen: true, fullscreenWindowSeen: false))
  }

  @Test func `a page whose full screen ends while it is parked for a move lands windowed in its new tab, with every registration undone`() {
    let scene = FullscreenScene()
    let carried = WebKitFullscreenPage.takePlaceholders(from: scene.oldTab)
    scene.oldTab.removeFromSuperview()
    #expect(scene.windowed.registered(scene.placeholder) == 0)
    scene.exitFullscreen()
    #expect(scene.page.superview == nil)
    #expect(!WebKitFullscreenPage.isOn(.notInFullscreen))
    let newWindow = AdapterWindow.make()
    let newTab = NSView(frame: newWindow.contentView!.bounds)
    newWindow.contentView!.addSubview(newTab)
    #expect(!WebKitFullscreenPage.heldElsewhere(scene.page, from: newTab, inFullscreen: false))
    newTab.addSubview(scene.page)
    #expect(!carried.isEmpty)
    #expect(newTab.subviews.allSatisfy { !WebKitFullscreenPage.isPlaceholder($0) })
    #expect(newWindow.registered(scene.placeholder) == 0)
    #expect(scene.windowed.registered(scene.placeholder) == 0)
    #expect(scene.page.window === newWindow)
  }

  @Test func `a deferred reclaim acts only for the exit and page it was scheduled for`() {
    let scene = FullscreenScene()
    var exits = WebKitFullscreenExits()
    let first = exits.changed()
    let ticket = WebKitFullscreenReclaim(generation: first, epoch: "a", page: scene.page)
    #expect(ticket.belongs(to: exits.generation, page: scene.page))
    _ = exits.changed()
    #expect(!ticket.belongs(to: exits.generation, page: scene.page))
    #expect(!ticket.belongs(to: first, page: NSView()))
    var gone: NSView? = NSView()
    let orphaned = WebKitFullscreenReclaim(generation: first, epoch: "a", page: gone)
    gone = nil
    #expect(!orphaned.belongs(to: first, page: nil))
  }

  @Test func `a deferred reclaim counts only under the consent period it was scheduled in`() {
    let ticket = WebKitFullscreenReclaim(generation: 1, epoch: "sharing-1", page: nil)
    #expect(ticket.counts(under: "sharing-1"))
    #expect(!ticket.counts(under: "sharing-2"))
    #expect(!ticket.counts(under: ""))
  }
}
