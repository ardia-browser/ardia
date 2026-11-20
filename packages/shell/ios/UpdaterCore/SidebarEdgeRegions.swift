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
  static let defaultPendingHoldWidth: CGFloat = 280
  static let pendingHoldDuration: TimeInterval = 0.25
  static let stopJitterRadius: CGFloat = 1
}

struct SidebarEdgeTracker {
  struct Geometry {
    let frame: CGRect
    let screen: CGRect
    let right: Bool
    let hold: CGFloat
    let edgeBand: CGFloat
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
    let inInnerEdge: Bool
    let inOuterBand: Bool
    let inWindow: Bool
    let verticalSlack: CGFloat
  }

  struct Decision {
    let over: Bool
    let atEdge: Bool
    let nextDeadline: TimeInterval?
  }

  private(set) var active = false
  private(set) var inWindow = false
  private var hasSample = false
  private var innerEnteredAt: TimeInterval?
  private var outerEnteredAt: TimeInterval?
  private var lastPoint: CGPoint?
  private var lastMovedAt: TimeInterval?

  func regions(for point: CGPoint, geometry g: Geometry) -> Regions {
    let slack = (active || g.peeking) ? g.verticalSlack : 0
    guard point.y >= g.frame.minY - slack, point.y < g.frame.maxY + slack else {
      return Regions(inInnerBand: false, inInnerEdge: false, inOuterBand: false, inWindow: g.frame.contains(point), verticalSlack: slack)
    }
    let fromOutside = hasSample && !inWindow
    let expandedInner = active || g.peeking || innerEnteredAt != nil || outerEnteredAt != nil || fromOutside
    let edgeInsideWidth = max(expandedInner ? g.innerExpanded : g.innerReveal, g.edgeBand)
    let insideWidth = max(g.hold, edgeInsideWidth)
    let inInnerBand: Bool
    let inInnerEdge: Bool
    if g.right {
      inInnerBand = point.x < g.frame.maxX && point.x >= g.frame.maxX - insideWidth
      inInnerEdge = point.x < g.frame.maxX && point.x >= g.frame.maxX - edgeInsideWidth
    } else {
      inInnerBand = point.x >= g.frame.minX && point.x < g.frame.minX + insideWidth
      inInnerEdge = point.x >= g.frame.minX && point.x < g.frame.minX + edgeInsideWidth
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
    return Regions(inInnerBand: inInnerBand, inInnerEdge: inInnerEdge, inOuterBand: inOuterBand, inWindow: g.frame.contains(point), verticalSlack: slack)
  }

  mutating func step(
    point: CGPoint,
    at time: TimeInterval,
    inInnerBand: Bool,
    inInnerEdge: Bool,
    inOuterBand: Bool,
    inWindow nextInWindow: Bool,
    peeking: Bool,
    immediate: Bool,
    initial: Bool
  ) -> Decision {
    let wasInBand = innerEnteredAt != nil || outerEnteredAt != nil
    let inBand = inInnerBand || inOuterBand
    if lastPoint == nil || lastMovedAt == nil || (!wasInBand && inBand) {
      lastPoint = point
      lastMovedAt = time
    } else if let prev = lastPoint {
      let dx = point.x - prev.x
      let dy = point.y - prev.y
      let r = SidebarEdgeRegions.stopJitterRadius
      if dx * dx + dy * dy >= r * r {
        lastPoint = point
        lastMovedAt = time
      }
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
    hasSample = true
    inWindow = nextInWindow
    let atEdge = (inInnerBand && inInnerEdge) || inOuterBand
    guard inBand else {
      active = false
      return Decision(over: false, atEdge: false, nextDeadline: nil)
    }
    if active || peeking || immediate || initial {
      active = true
      return Decision(over: true, atEdge: atEdge, nextDeadline: nil)
    }
    let stopAt = (lastMovedAt ?? time) + SidebarEdgeRegions.mouseStopDelay
    let lingerCandidates = [
      innerEnteredAt.map { $0 + SidebarEdgeRegions.innerLinger },
      outerEnteredAt.map { $0 + SidebarEdgeRegions.outerLinger },
    ].compactMap { $0 }
    let revealAt = lingerCandidates.reduce(stopAt, min)
    if time + 1e-6 >= revealAt {
      active = true
      return Decision(over: true, atEdge: atEdge, nextDeadline: nil)
    }
    active = false
    return Decision(over: false, atEdge: false, nextDeadline: revealAt)
  }

  mutating func holdActive() {
    active = true
  }
}
