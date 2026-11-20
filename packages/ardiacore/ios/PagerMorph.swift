import AppKit
import ExpoModulesCore
import QuartzCore

struct MorphConfig: Record {
  @Field var clip: Int = 0
  @Field var spacer: Int = 0
  @Field var sidebar: Double = 0
  @Field var library: Double = 0
  @Field var still: Bool = false
  @Field var right: Bool = false
  @Field var content: Int = 0
}

private final class MorphFrames: NSObject {
  weak var morph: PagerMorph?

  init(_ morph: PagerMorph) { self.morph = morph }

  @objc func frame(_ link: CADisplayLink) {
    guard let morph, morph.stepRoom(MorphFrame(link)) else { return link.invalidate() }
  }
}

final class PagerMorph {
  private static var counts = (frames: 0, late: 0)
  private static let countsLock = NSLock()

  static func takeCounts() -> [String: Int] {
    let taken = countsLock.withLock {
      defer { counts = (0, 0) }
      return counts
    }
    return ["frames": taken.frames, "late": taken.late]
  }

  private var counter = MorphFrameCounter()
  private var layout: ArdiaMorphLayout
  private var config: MorphConfig
  private weak var view: NSView?
  private var room: Double
  private var roomTarget: Double
  private var roomSpring: RoomSpring?
  private var link: CADisplayLink?
  private var frameWatch = FrameWatch()
  private var deadlineCheck: DispatchWorkItem?
  private var lead = 0.0
  private var leading = false
  private var pagerMoving = false
  private var applied: (width: Double, growth: Double, laidOut: Double, masked: Bool)?
  #if DEBUG
  private(set) var log: [(time: CFTimeInterval, width: Double, moving: Bool, shownSpacer: Double, shownMask: Double)] = []
  #endif

  init(config: MorphConfig, uiManager: AnyObject?, view: NSView?) {
    self.config = config
    self.view = view
    layout = ArdiaMorphLayout(uiManager: uiManager)
    room = config.library
    roomTarget = config.library
    watchMissing()
  }

  deinit { link?.invalidate() }

  private func watchMissing() {
    layout.onMissing = { [weak self] _ in self?.applied = nil }
  }

  func update(_ next: MorphConfig, uiManager manager: AnyObject?, from view: NSView?) {
    if let manager, manager !== layout.uiManager as AnyObject? {
      layout = ArdiaMorphLayout(uiManager: manager)
      watchMissing()
      applied = nil
    }
    if let view { self.view = view }
    let retagged = next.clip != config.clip || next.spacer != config.spacer || next.right != config.right || next.content != config.content
    config = next
    if retagged { applied = nil }
    if next.library != roomTarget { moveRoom(to: next.library) }
    apply(frame: nil)
  }

  private func moveRoom(to target: Double) {
    let now = CACurrentMediaTime()
    let animates = shownLead > 0 && !config.still && view?.inLiveResize != true && view?.window?.screen != nil
    guard animates else {
      stopLink()
      roomSpring = nil
      room = target
      roomTarget = target
      return
    }
    let velocity = roomSpring?.state(at: now).velocity ?? 0
    roomSpring = RoomSpring(from: room, target: target, velocity: velocity, start: now)
    roomTarget = target
    if !pagerMoving { startLink() }
  }

  func follow(lead next: Double, leading atLeading: Bool, moving: Bool, frame: MorphFrame? = nil) {
    lead = next
    leading = atLeading
    pagerMoving = moving
    if roomSpring != nil {
      if moving {
        stopLink()
        advanceRoom(to: frame?.target ?? CACurrentMediaTime())
      } else if link == nil {
        startLink()
      }
    }
    apply(frame: moving ? frame : nil)
  }

  func release() {
    stopLink()
    roomSpring = nil
    if config.content != 0 { layout.clip(NSNumber(value: config.content), to: -1, fromRight: config.right) }
    if config.spacer != 0 { layout.set(width: 0, of: NSNumber(value: config.spacer)) }
  }

  private var shownLead: Double { config.still ? (leading ? 1 : 0) : min(1, max(0, lead)) }

  private func apply(frame: MorphFrame?) {
    #if DEBUG
    let shownSpacer = config.spacer != 0 ? Double(ArdiaMorphLayout.shownWidth(of: NSNumber(value: config.spacer), in: layout.uiManager)) : -1
    let shownMask = config.content != 0 ? Double(ArdiaMorphLayout.maskWidth(of: NSNumber(value: config.content), in: layout.uiManager)) : -1
    #endif
    let sidebar = config.sidebar
    let shown = shownLead
    let growth = max(0, room - sidebar) * shown
    let width = sidebar + growth
    let masked = roomSpring != nil || (shown > 0 && shown < 1)
    let laidOut = masked ? max(sidebar, room, roomTarget, roomSpring?.from ?? 0) : width
    if let applied, abs(applied.width - width) < 0.01, abs(applied.growth - growth) < 0.01, applied.masked == masked {
      countSkipped()
      return
    }
    if config.content != 0 {
      layout.clip(NSNumber(value: config.content), to: masked ? width : -1, fromRight: config.right)
    }
    if config.clip != 0, applied.map({ abs($0.laidOut - laidOut) >= 0.01 }) ?? true {
      layout.set(width: laidOut, of: NSNumber(value: config.clip))
    }
    if config.spacer != 0, applied.map({ abs($0.growth - growth) >= 0.01 }) ?? true {
      layout.set(width: growth, of: NSNumber(value: config.spacer))
    }
    applied = (width, growth, laidOut, masked)
    if let frame { countDrawn(frame) } else { countSkipped() }
    #if DEBUG
    log.append((frame?.target ?? CACurrentMediaTime(), width, frame != nil, shownSpacer, shownMask))
    if log.count > 720 { log.removeFirst(log.count - 720) }
    #endif
  }

  private func countDrawn(_ frame: MorphFrame) {
    let kind = counter.drawn(frame)
    guard kind != .first else { return }
    PagerMorph.countsLock.withLock {
      PagerMorph.counts.frames += 1
      if kind == .late { PagerMorph.counts.late += 1 }
    }
  }

  private func countSkipped() { counter.skipped() }

  private func advanceRoom(to time: CFTimeInterval) {
    guard let spring = roomSpring else { return }
    if spring.settled(at: time) {
      room = spring.target
      roomSpring = nil
    } else {
      room = spring.width(at: time)
    }
  }

  fileprivate func stepRoom(_ frame: MorphFrame) -> Bool {
    guard roomSpring != nil, !pagerMoving else {
      stopLink()
      return false
    }
    frameWatch.framed(at: CACurrentMediaTime())
    advanceRoom(to: frame.target)
    apply(frame: frame)
    if roomSpring == nil {
      stopLink()
      return false
    }
    return true
  }

  private func startLink() {
    guard link == nil, let view, view.window?.screen != nil else {
      if let spring = roomSpring, link == nil, view?.window?.screen == nil {
        room = spring.target
        roomSpring = nil
      }
      return
    }
    let link = view.displayLink(target: MorphFrames(self), selector: #selector(MorphFrames.frame(_:)))
    link.add(to: .main, forMode: .common)
    self.link = link
    frameWatch.started(at: CACurrentMediaTime())
    checkFrames(after: FrameWatch.deadline)
  }

  private func stopLink() {
    link?.invalidate()
    link = nil
    deadlineCheck?.cancel()
    deadlineCheck = nil
  }

  private func checkFrames(after seconds: Double) {
    deadlineCheck?.cancel()
    let check = DispatchWorkItem { [weak self] in self?.frameDeadlinePassed() }
    deadlineCheck = check
    DispatchQueue.main.asyncAfter(deadline: .now() + seconds, execute: check)
  }

  private func frameDeadlinePassed() {
    deadlineCheck = nil
    guard link != nil, let spring = roomSpring else { return }
    switch frameWatch.check(at: CACurrentMediaTime()) {
    case .waiting(let seconds):
      checkFrames(after: seconds)
    case .restart:
      stopLink()
      startLink()
    case .finish:
      stopLink()
      room = spring.target
      roomSpring = nil
      apply(frame: nil)
    }
  }

  #if DEBUG
  func debug() -> [String: Any] {
    [
      "room": room, "roomTarget": roomTarget, "lead": lead, "leading": leading, "sidebar": config.sidebar, "library": config.library,
      "clip": config.clip, "spacer": config.spacer, "still": config.still, "linked": link != nil,
      "applied": applied.map { [$0.width, $0.growth, $0.laidOut, $0.masked ? 1 : 0] } ?? NSNull(),
      "log": log.map { [$0.time * 1000, $0.width, $0.moving ? 1 : 0, $0.shownSpacer, $0.shownMask] },
    ]
  }

  func clearLog() { log.removeAll() }
  #endif
}
