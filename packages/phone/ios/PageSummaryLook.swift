import ArdiaDesign

struct PageSummaryLook: Equatable {
  var look: ProfileLook
  var themeLook: ThemeLook?
  var dark: Bool

  init(isPrivate: Bool, colors: LookColors, dark: Bool) {
    guard !isPrivate, !colors.isIncognito else {
      look = .incognito
      themeLook = nil
      self.dark = true
      return
    }
    look = colors.look
    themeLook = colors.shownThemeLook
    self.dark = dark
  }

  var inkIsLight: Bool { themeLook != nil ? dark : look.inkIsLight(dark: dark, themed: true) }
}
