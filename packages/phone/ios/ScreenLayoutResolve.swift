import CoreGraphics
import Foundation

struct ScreenSpace: Equatable, Sendable {
  enum Hinge: String, Sendable {
    case none
    case closed
    case partiallyOpen
    case fullyOpen
  }

  struct Insets: Equatable, Sendable {
    var top: CGFloat = 0
    var leading: CGFloat = 0
    var bottom: CGFloat = 0
    var trailing: CGFloat = 0
  }

  var size: CGSize = .zero
  var safeInsets = Insets()
  var divisions: [CGRect] = []
  var hinge = Hinge.none

  var horizontalFold: ScreenLayout.Fold? {
    let band = divisions.first { $0.width > $0.height && $0.width >= size.width * 0.5 }
    return band.map { ScreenLayout.Fold(top: $0.minY + safeInsets.top, bottom: $0.maxY + safeInsets.top) }
  }
}

enum ScreenLayout: Equatable, Sendable {
  case phone
  case wide
  case split(Fold)

  struct Fold: Equatable, Sendable {
    var top: CGFloat
    var bottom: CGFloat
  }

  static let wideMinimum: CGFloat = 600

  static func resolve(_ space: ScreenSpace) -> ScreenLayout {
    if space.hinge == .partiallyOpen, let fold = space.horizontalFold {
      return .split(fold)
    }
    if space.hinge != .none {
      return .phone
    }
    if space.size.width >= wideMinimum, space.size.height >= wideMinimum {
      return .wide
    }
    return .phone
  }

  var name: String {
    switch self {
    case .phone: "phone"
    case .wide: "wide"
    case .split: "split"
    }
  }
}

enum DuoCanvas {
  enum Mode: String, Sendable {
    case wide
    case split

    init?(argument: String) {
      switch argument.lowercased() {
      case "wide", "open": self = .wide
      case "split", "half": self = .split
      default: return nil
      }
    }
  }

  static let openSize = CGSize(width: 669, height: 951)
  static let foldBand: CGFloat = 20

  static func canvas(for mode: Mode?) -> CGSize? {
    switch mode {
    case .wide, .split: openSize
    case nil: nil
    }
  }

  static func forcedLayout(_ mode: Mode?, for space: ScreenSpace) -> ScreenLayout? {
    switch mode {
    case nil: nil
    case .wide: .wide
    case .split: .split(ScreenLayout.Fold(top: (openSize.height - foldBand) / 2, bottom: (openSize.height + foldBand) / 2))
    }
  }
}

enum ScreenLayoutReport {
  static func payload(space: ScreenSpace, forced mode: DuoCanvas.Mode?) -> [String: Any] {
    let layout = DuoCanvas.forcedLayout(mode, for: space) ?? ScreenLayout.resolve(space)
    var payload: [String: Any] = [
      "layout": layout.name,
      "space": [
        "width": Double(space.size.width),
        "height": Double(space.size.height),
        "safeTop": Double(space.safeInsets.top),
        "safeLeading": Double(space.safeInsets.leading),
        "safeBottom": Double(space.safeInsets.bottom),
        "safeTrailing": Double(space.safeInsets.trailing),
        "hinge": space.hinge.rawValue,
        "divisions": space.divisions.map { ["x": Double($0.minX), "y": Double($0.minY), "width": Double($0.width), "height": Double($0.height)] },
      ] as [String: Any],
      "forced": mode.map { $0.rawValue as Any } ?? NSNull(),
    ]
    if case .split(let fold) = layout { payload["fold"] = ["top": Double(fold.top), "bottom": Double(fold.bottom)] }
    if let canvas = DuoCanvas.canvas(for: mode) { payload["canvas"] = ["width": Double(canvas.width), "height": Double(canvas.height)] }
    return payload
  }
}
