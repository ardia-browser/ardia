import ArdiaDesign

struct LookColors: Equatable {
  static let incognito = "incognito"

  var color: String?
  var themeColors: [String]?
  var darkThemeColors: [String]?

  var isIncognito: Bool { color == Self.incognito }

  var look: ProfileLook {
    isIncognito ? .incognito : ProfileLook(colorName: color, themeColors: themeColors ?? [], darkThemeColors: darkThemeColors)
  }
}
