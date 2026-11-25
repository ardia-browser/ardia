import AppKit
import ExpoModulesCore
import NaturalLanguage
import SwiftUI
@_weakLinked import Translation

enum TranslateError: LocalizedError {
  case unavailable, noWindow
  var errorDescription: String? {
    switch self {
    case .unavailable: return ShellL10n.t("needs macOS 26")
    case .noWindow: return ShellL10n.t("no window to ask in")
    }
  }
}
