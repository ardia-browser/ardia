import CoreGraphics
import Foundation

struct SidebarEdgeRegions {
  static let innerRevealWidth: CGFloat = 3
  static let innerExpandedWidth: CGFloat = 9
  static let outerApproachReach: CGFloat = 50
  static let outerPersistReach: CGFloat = 250
  static let inactiveEdgeReach: CGFloat = 24
  static let verticalHoldSlack: CGFloat = 24
  static let tabDragBandWidth: CGFloat = 8
  static let innerLinger: TimeInterval = 0.15
  static let outerLinger: TimeInterval = 0.16
  static let mouseStopDelay: TimeInterval = 0.08
}

struct SidebarEdgeTracker {
  struct Geometry {
    let frame: CGRect
    let screen: CGRect
    let right: Bool
    let hold: CGFloat
    let innerReveal: CGFloat
    let innerExpanded: CGFloat
    let outerApproach: CGFloat
    let outerPersist: CGFloat
    let inactiveReach: CGFloat
    let verticalSlack: CGFloat
    let appActive: Bool
    let peeking: Bool
    let immediate: Bool
  }

  struct Regions {
    let inInnerBand: Bool
    let inOuterBand: Bool
    let inWindow: Bool
    let verticalSlack: CGFloat
  }

  struct Decision {
    let over: Bool
    let nextDeadline: TimeInterval?
  }

  private(set) var active = false
  private(set) var inWindow = false
  private var innerEnteredAt: TimeInterval?
  private var outerEnteredAt: TimeInterval?
  private var lastPoint: CGPoint?
  private var lastMovedAt: TimeInterval?

  func regions(for point: CGPoint, geometry g: Geometry) -> Regions {
    let slack = (active || g.peeking) ? g.verticalSlack : 0
    guard point.y >= g.frame.minY - slack, point.y < g.frame.maxY + slack else {
      return Regions(inInnerBand: false, inOuterBand: false, inWindow: g.frame.contains(point), verticalSlack: slack)
    }
    let insideWidth: CGFloat
    if g.hold > 0 {
      insideWidth = max(g.hold, active ? g.innerExpanded : g.innerReveal)
    } else {
      insideWidth = active ? g.innerExpanded : g.innerReveal
    }
    let inInnerBand: Bool
    if g.right {
      inInnerBand = point.x < g.frame.maxX && point.x >= g.frame.maxX - insideWidth
    } else {
      inInnerBand = point.x >= g.frame.minX && point.x < g.frame.minX + insideWidth
    }
    let besideScreenEdge = (g.right ? g.screen.maxX - g.frame.maxX : g.frame.minX - g.screen.minX) <= g.inactiveReach
    let outerReach: CGFloat
    if !g.appActive {
      outerReach = besideScreenEdge ? g.inactiveReach : 0
    } else if active || g.peeking || g.immediate || inWindow || outerEnteredAt != nil {
      outerReach = g.outerPersist
    } else {
      outerReach = g.outerApproach
    }
    let inOuterBand: Bool
    if outerReach <= 0 {
      inOuterBand = false
    } else if g.right {
      inOuterBand = point.x >= g.frame.maxX && point.x < min(g.screen.maxX, g.frame.maxX + outerReach)
    } else {
      inOuterBand = point.x < g.frame.minX && point.x >= max(g.screen.minX, g.frame.minX - outerReach)
    }
    return Regions(inInnerBand: inInnerBand, inOuterBand: inOuterBand, inWindow: g.frame.contains(point), verticalSlack: slack)
  }

  mutating func step(
    point: CGPoint,
    at time: TimeInterval,
    inInnerBand: Bool,
    inOuterBand: Bool,
    inWindow nextInWindow: Bool,
    peeking: Bool,
    immediate: Bool,
    initial: Bool
  ) -> Decision {
    if lastPoint != point || lastMovedAt == nil {
      lastPoint = point
      lastMovedAt = time
    }
    if inInnerBand {
      innerEnteredAt = innerEnteredAt ?? time
    } else {
      innerEnteredAt = nil
    }
    if inOuterBand {
      outerEnteredAt = outerEnteredAt ?? time
    } else {
      outerEnteredAt = nil
    }
    inWindow = nextInWindow
    guard inInnerBand || inOuterBand else {
      active = false
      return Decision(over: false, nextDeadline: nil)
    }
    if active || peeking || immediate || initial {
      active = true
      return Decision(over: true, nextDeadline: nil)
    }
    let stopAt = (lastMovedAt ?? time) + SidebarEdgeRegions.mouseStopDelay
    let lingerCandidates = [
      innerEnteredAt.map { $0 + SidebarEdgeRegions.innerLinger },
      outerEnteredAt.map { $0 + SidebarEdgeRegions.outerLinger },
    ].compactMap { $0 }
    let revealAt = lingerCandidates.reduce(stopAt, min)
    if time + 1e-6 >= revealAt {
      active = true
      return Decision(over: true, nextDeadline: nil)
    }
    active = false
    return Decision(over: false, nextDeadline: revealAt)
  }

  mutating func holdActive() {
    active = true
  }
}
