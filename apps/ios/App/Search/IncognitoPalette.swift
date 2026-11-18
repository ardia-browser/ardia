import ArdiaDesign
import SwiftUI
import UIKit

extension BrowsePalette {
  static let incognitoField = Color.white.opacity(0.12)
  static let incognitoCaption = Color.white.opacity(0.55)
  static let incognitoPlaceholderOpacity = 0.45
  static let incognitoPlaceholder = Color.white.opacity(incognitoPlaceholderOpacity)
  static let incognitoFieldStroke = Color.white.opacity(0.1)
  static let incognitoRowHighlight = Color.white.opacity(0.1)
  static let incognitoRowText = Color.white.opacity(0.92)
  static let incognitoBadgeLabel = Color.white.opacity(0.75)
  static let incognitoBadgeGlyph = Color.white.opacity(0.85)
}

extension UIColor {
  static let incognitoPlaceholder = UIColor.white.withAlphaComponent(BrowsePalette.incognitoPlaceholderOpacity)
}
