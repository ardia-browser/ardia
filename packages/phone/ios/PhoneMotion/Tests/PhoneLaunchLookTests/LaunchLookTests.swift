import ArdiaDesign
import Foundation
import Testing
@testable import PhoneLaunchLook

@MainActor
@Suite(.serialized) struct LaunchLookTests {
  private func withDefaults(_ body: (UserDefaults) -> Void) {
    let suite = "launch-look-\(UUID().uuidString)"
    let defaults = UserDefaults(suiteName: suite)!
    defer { defaults.removePersistentDomain(forName: suite) }
    body(defaults)
  }

  private static let sunset = ThemeLook(
    stops: [
      ThemeStop(color: ThemeColor(r: 0.85, g: 0.35, b: 0.45), x: 0.8, y: 0.3),
      ThemeStop(color: ThemeColor(r: 0.25, g: 0.45, b: 0.9), x: 0.2, y: 0.6),
    ],
    intensity: 0.7, grain: 0.6, texture: .sand, translucency: 0.4, angle: 30
  )

  private static let night = ThemeLook(
    stops: [ThemeStop(color: ThemeColor(r: 0.1, g: 0.05, b: 0.2), x: 0.3, y: 0.3)],
    texture: .tweed
  )

  @Test func aFirstLaunchDrawsThePlumLookBothAppsDefaultTo() {
    withDefaults { defaults in
      let recalled = LaunchLook.recalled(from: defaults)
      #expect(recalled == LaunchLook.Recalled())
      #expect(recalled.colors.look == ProfileLook.plum)
      #expect(recalled.drawn(appDark: true).colors.themeLook == nil && recalled.drawn(appDark: true).dark == nil)
    }
  }

  @Test func theStartPagesLookComesBackOnTheNextLaunch() {
    withDefaults { defaults in
      let space = LookColors(color: "blue", themeColors: ["#3366FF", "#8844CC"], darkThemeColors: ["#112244"])
      LaunchLook.remember(space, drawnDark: false, appDark: false, in: defaults)
      #expect(LaunchLook.recalled(from: defaults).colors == space)
      let plain = LookColors(color: "green", themeColors: nil, darkThemeColors: nil)
      LaunchLook.remember(plain, drawnDark: false, appDark: false, in: defaults)
      #expect(LaunchLook.recalled(from: defaults).colors == LookColors(color: "green", themeColors: [], darkThemeColors: nil))
      #expect(LaunchLook.recalled(from: defaults).drawn(appDark: false).colors.themeLook == nil)
    }
  }

  @Test func incognitoIsNeverRemembered() {
    withDefaults { defaults in
      let space = LookColors(color: "orange", themeColors: ["#FF8800"], darkThemeColors: nil, themeLook: Self.sunset)
      LaunchLook.remember(space, drawnDark: false, appDark: false, in: defaults)
      LaunchLook.remember(LookColors(color: LookColors.incognito, themeLook: Self.night), drawnDark: true, appDark: true, in: defaults)
      let recalled = LaunchLook.recalled(from: defaults)
      #expect(recalled.colors == space.withoutThemeLook)
      #expect(recalled.drawn(appDark: false).colors == space)
    }
  }

  @Test func aCustomThemeComesBackForEachModeItWasDrawnIn() {
    withDefaults { defaults in
      let colors = LookColors(color: "#D95973", themeColors: ["#D95973", "#4073E6"])
      var light = colors
      light.themeLook = Self.sunset
      var dark = colors
      dark.themeLook = Self.night
      LaunchLook.remember(light, drawnDark: false, appDark: false, in: defaults)
      LaunchLook.remember(dark, drawnDark: true, appDark: true, in: defaults)
      let recalled = LaunchLook.recalled(from: defaults)
      #expect(recalled.drawn(appDark: false).colors == light && recalled.drawn(appDark: false).dark == false)
      #expect(recalled.drawn(appDark: true).colors == dark && recalled.drawn(appDark: true).dark == true)
    }
  }

  @Test func aThemeSeenInOneModeIsDrawnInBothUntilTheOtherIsSeen() {
    withDefaults { defaults in
      var forcedDark = LookColors(color: "#D95973", themeColors: ["#D95973", "#4073E6"])
      forcedDark.themeLook = Self.night
      LaunchLook.remember(forcedDark, drawnDark: true, appDark: false, in: defaults)
      let recalled = LaunchLook.recalled(from: defaults)
      #expect(recalled.drawn(appDark: true).colors == forcedDark && recalled.drawn(appDark: true).dark == true)
      #expect(recalled.drawn(appDark: false).colors == forcedDark && recalled.drawn(appDark: false).dark == true)
    }
  }

  @Test func anotherSpaceOrNoThemeForgetsTheOldThemeLooks() {
    withDefaults { defaults in
      var themed = LookColors(color: "#D95973", themeColors: ["#D95973", "#4073E6"])
      themed.themeLook = Self.sunset
      LaunchLook.remember(themed, drawnDark: false, appDark: false, in: defaults)
      var other = LookColors(color: "#3366FF", themeColors: ["#3366FF"])
      other.themeLook = Self.night
      LaunchLook.remember(other, drawnDark: true, appDark: true, in: defaults)
      #expect(LaunchLook.recalled(from: defaults).lightThemeLook == nil)
      #expect(LaunchLook.recalled(from: defaults).drawn(appDark: false).colors == other)
      LaunchLook.remember(other.withoutThemeLook, drawnDark: true, appDark: true, in: defaults)
      let recalled = LaunchLook.recalled(from: defaults)
      #expect(recalled.lightThemeLook == nil && recalled.darkThemeLook == nil)
      #expect(recalled.drawn(appDark: true).colors == other.withoutThemeLook)
    }
  }
}
