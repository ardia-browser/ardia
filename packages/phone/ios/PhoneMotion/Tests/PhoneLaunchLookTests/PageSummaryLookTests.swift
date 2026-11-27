import ArdiaDesign
import Foundation
import Testing
@testable import PhoneLaunchLook

@Suite struct PageSummaryLookTests {
  private let personal = LookColors(color: "pink", themeColors: [], darkThemeColors: nil)
  private let work = LookColors(color: "blue", themeColors: ["#3366FF", "#8844CC"], darkThemeColors: nil)

  @Test func aSummaryTakesTheLookOfItsTabsSpaceNotTheLastOneRemembered() {
    let suite = "summary-look-\(UUID().uuidString)"
    let defaults = UserDefaults(suiteName: suite)!
    defer { defaults.removePersistentDomain(forName: suite) }
    LaunchLook.remember(work, drawnDark: false, appDark: false, in: defaults)
    let summary = PageSummaryLook(isPrivate: false, colors: personal, dark: false)
    #expect(summary.look == personal.look)
    #expect(summary.look != LaunchLook.recalled(from: defaults).colors.look)
    #expect(summary.themeLook == nil)
    #expect(summary.dark == false)
  }

  @Test func aSpacesThemeAndDarkModeCarryIntoItsSummary() {
    let theme = ThemeLook(stops: [ThemeStop(color: ThemeColor(r: 0.9, g: 0.4, b: 0.6), x: 0.5, y: 0.5)], texture: .grain)
    var themed = personal
    themed.themeLook = theme
    let summary = PageSummaryLook(isPrivate: false, colors: themed, dark: true)
    #expect(summary.themeLook == theme)
    #expect(summary.dark && summary.inkIsLight)
  }

  @Test func aPrivateTabsSummaryIsIncognitoWhateverItsSpace() {
    let summary = PageSummaryLook(isPrivate: true, colors: work, dark: false)
    #expect(summary.look == .incognito && summary.themeLook == nil && summary.dark)
  }
}
