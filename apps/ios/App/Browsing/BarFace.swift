import ArdiaDesign
import SwiftUI
import UIKit

struct BarFace: View {
  enum Content: Equatable {
    case address(BarAddress)
    case collapsedAddress(BarAddress)
    case plus
  }

  let content: Content
  let size: CGSize
  var favicon: FaviconImage.Prepared?

  var body: some View {
    Group {
      switch content {
      case .address(let address):
        HStack(spacing: 0) {
          BarAddressLabel(address: address, favicon: favicon)
            .padding(.leading, BrowseLayout.barAddressLead)
            .frame(maxWidth: .infinity, alignment: .leading)
          BarMenuGlyph()
            .padding(.trailing, BrowseLayout.barMenuTrail)
        }
      case .collapsedAddress(let address):
        BarAddressLabel(address: address, compact: true, favicon: favicon)
          .padding(.horizontal, Spacing.small)
      case .plus:
        PlusGlyph()
      }
    }
    .frame(width: size.width, height: size.height)
  }

  private var address: BarAddress? {
    switch content {
    case .address(let address), .collapsedAddress(let address): address
    case .plus: nil
    }
  }

  @MainActor
  static func render(_ content: Content, size: CGSize, isDark: Bool, dynamicType: DynamicTypeSize, scale: CGFloat) async -> UIImage? {
    var face = BarFace(content: content, size: size)
    if let address = face.address, address.showsFavicon {
      face.favicon = await FaviconImage.prepare(iconURL: address.iconURL, pageURL: address.pageURL)
    }
    let renderer = ImageRenderer(
      content: face
        .environment(\.colorScheme, isDark ? .dark : .light)
        .environment(\.dynamicTypeSize, dynamicType)
    )
    renderer.scale = scale
    renderer.isOpaque = false
    return renderer.uiImage
  }
}
