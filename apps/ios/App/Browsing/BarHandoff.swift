import Observation
import SwiftUI
import UIKit

@MainActor
@Observable
final class BarHandoff {
  private(set) var anchors: [BarOwner: BarAnchor] = [:]
  var morphsIntoBar = false
  private(set) var isLanding = false
  @ObservationIgnored private var landingEnd: Task<Void, Never>?

  func report(_ anchor: BarAnchor) {
    guard anchors[anchor.owner] != anchor else { return }
    anchors[anchor.owner] = anchor
  }

  func withdraw(_ owner: BarOwner, reporter: UUID) {
    if anchors[owner]?.reporter == reporter { anchors[owner] = nil }
  }

  func land(for duration: TimeInterval) {
    landingEnd?.cancel()
    isLanding = true
    landingEnd = Task { [weak self] in
      try? await Task.sleep(for: .seconds(duration))
      guard !Task.isCancelled else { return }
      self?.isLanding = false
    }
  }

  func stopLanding() {
    landingEnd?.cancel()
    isLanding = false
  }
}

enum BarOwner: Hashable {
  case start
  case page
}

struct BarAnchor: Equatable {
  var owner: BarOwner
  var frame: CGRect
  var isDark: Bool
  var content: BarFace.Content
  var reporter: UUID

  var style: UIUserInterfaceStyle { isDark ? .dark : .light }
}

struct BarFaceImage {
  private let owner: BarOwner
  private let content: BarFace.Content
  private let isDark: Bool
  private let size: CGSize
  private let image: UIImage

  init(image: UIImage, of anchor: BarAnchor) {
    owner = anchor.owner
    content = anchor.content
    isDark = anchor.isDark
    size = anchor.frame.size
    self.image = image
  }

  func fits(_ anchor: BarAnchor) -> Bool {
    owner == anchor.owner && content == anchor.content && isDark == anchor.isDark
      && abs(size.width - anchor.frame.width) < 1 && abs(size.height - anchor.frame.height) < 1
  }

  @MainActor
  func makeView() -> UIView {
    let face = UIImageView(image: image)
    face.frame = CGRect(origin: .zero, size: size)
    face.isUserInteractionEnabled = false
    return face
  }
}

extension AppModel {
  var barAnchor: BarAnchor? {
    let owner: BarOwner
    switch surface {
    case .search: owner = .start
    case .browsing: owner = .page
    default: return nil
    }
    guard let anchor = browse.bar.anchors[owner], !anchor.frame.isEmpty else { return nil }
    return anchor
  }
}

extension ScreenLayout {
  func morphsSearchIntoBar(reduceMotion: Bool) -> Bool {
    !reduceMotion && self == .phone
  }
}
