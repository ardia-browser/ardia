import ArdiaDesign

struct LookColors: Equatable {
  static let incognito = "incognito"

  var color: String?
  var themeColors: [String]?
  var darkThemeColors: [String]?
  var themeLook: ThemeLook?

  var isIncognito: Bool { color == Self.incognito }

  var look: ProfileLook {
    isIncognito ? .incognito : ProfileLook(colorName: color, themeColors: themeColors ?? [], darkThemeColors: darkThemeColors)
  }

  var shownThemeLook: ThemeLook? { isIncognito ? nil : themeLook }

  var withoutThemeLook: LookColors {
    var colors = self
    colors.themeLook = nil
    return colors
  }
}
