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

  private static func plain(_ color: String, forced dark: Bool? = nil) -> [String: Any] {
    ["color": color, "themeColors": [String](), "themeLooks": ["light": ["dark": dark ?? false], "dark": ["dark": dark ?? true]]]
  }

  private static let themed: [String: Any] = [
    "color": "#D95973",
    "themeColors": ["#D95973", "#4073E6"],
    "themeLooks": ["light": ["look": sunset.dictionary, "dark": false], "dark": ["look": night.dictionary, "dark": true]],
  ]

  @Test func aFirstLaunchDrawsThePlumLookBothAppsDefaultTo() {
    withDefaults { defaults in
      let recalled = LaunchLook.recalled(from: defaults)
      #expect(recalled == LaunchLook.Recalled())
      #expect(recalled.colors.look == ProfileLook.plum)
      #expect(recalled.drawn(appDark: true).colors.themeLook == nil && recalled.drawn(appDark: true).dark == nil)
    }
  }

  @Test func theCurrentSpaceSavedLastIsTheOneTheNextLaunchDraws() {
    withDefaults { defaults in
      LaunchLook.remember(LaunchLook.recalled(saved: Self.plain("blue")), in: defaults)
      LaunchLook.remember(LaunchLook.recalled(saved: Self.plain("green")), in: defaults)
      let recalled = LaunchLook.recalled(from: defaults)
      #expect(recalled.colors == LookColors(color: "green", themeColors: [], darkThemeColors: nil))
      #expect(recalled.drawn(appDark: false).dark == false && recalled.drawn(appDark: true).dark == true)
    }
  }

  @Test func eachSystemAppearanceDrawsTheThemeAndModeTheAppDrawsInIt() {
    withDefaults { defaults in
      LaunchLook.remember(LaunchLook.recalled(saved: Self.themed), in: defaults)
      let recalled = LaunchLook.recalled(from: defaults)
      #expect(recalled.drawn(appDark: false).colors.themeLook == Self.sunset && recalled.drawn(appDark: false).dark == false)
      #expect(recalled.drawn(appDark: true).colors.themeLook == Self.night && recalled.drawn(appDark: true).dark == true)
    }
  }

  @Test func aForcedAppearanceIsDrawnEvenWithoutATheme() {
    withDefaults { defaults in
      LaunchLook.remember(LaunchLook.recalled(saved: Self.plain("blue", forced: true)), in: defaults)
      let recalled = LaunchLook.recalled(from: defaults)
      #expect(recalled.drawn(appDark: false).dark == true && recalled.drawn(appDark: false).colors.themeLook == nil)
    }
  }

  @Test func incognitoIsNeverRemembered() {
    withDefaults { defaults in
      LaunchLook.remember(LaunchLook.recalled(saved: Self.plain("orange")), in: defaults)
      #expect(!LaunchLook.remember(LaunchLook.recalled(saved: Self.plain(LookColors.incognito, forced: true)), in: defaults))
      #expect(LaunchLook.recalled(from: defaults).colors.color == "orange")
    }
  }

  @Test func theSameLookIsNotWrittenTwice() {
    withDefaults { defaults in
      #expect(LaunchLook.remember(LaunchLook.recalled(saved: Self.themed), in: defaults))
      #expect(!LaunchLook.remember(LaunchLook.recalled(saved: Self.themed), in: defaults))
      #expect(LaunchLook.remember(LaunchLook.recalled(saved: Self.plain("blue")), in: defaults))
    }
  }

  @Test func aSavedLookFromBeforeTheWriteRuleStillDraws() {
    withDefaults { defaults in
      defaults.set(["color": "#D95973", "themeColors": ["#D95973"], "themeLooks": ["dark": ["look": Self.night.dictionary, "dark": true]]], forKey: LaunchLook.key)
      let recalled = LaunchLook.recalled(from: defaults)
      #expect(recalled.drawn(appDark: false).colors.themeLook == Self.night && recalled.drawn(appDark: false).dark == true)
    }
  }

  @Test func anotherSpaceIsSeenAsStaleButTheSameSpaceIsNot() {
    let blue = LaunchLook.recalled(saved: Self.plain("blue"))
    for appDark in [false, true] {
      #expect(blue.drawsTheSameSpace(as: LaunchLook.recalled(saved: Self.plain("blue")), appDark: appDark))
      #expect(!blue.drawsTheSameSpace(as: LaunchLook.recalled(saved: Self.plain("green")), appDark: appDark))
      #expect(!blue.drawsTheSameSpace(as: LaunchLook.recalled(saved: Self.themed), appDark: appDark))
    }
    #expect(!blue.drawsTheSameSpace(as: LaunchLook.recalled(saved: Self.plain("blue", forced: true)), appDark: false))
    let older = LaunchLook.Recalled(colors: LookColors(color: "blue", themeColors: [], darkThemeColors: nil))
    #expect(older.drawsTheSameSpace(as: blue, appDark: false) && older.drawsTheSameSpace(as: blue, appDark: true))
  }

  @Test func aThemeSurvivesTheRoundTripSoTheSameSpaceIsNeverStale() {
    var odd = Self.sunset
    odd.angle = 359.999_999_999_9
    var saved = Self.themed
    saved["themeLooks"] = ["light": ["look": odd.dictionary, "dark": false], "dark": ["look": Self.night.dictionary, "dark": true]]
    let fromJS = LaunchLook.recalled(saved: saved)
    let fromDisk = LaunchLook.recalled(saved: LaunchLook.saved(LaunchLook.normalized(fromJS)))
    #expect(fromDisk.drawsTheSameSpace(as: fromJS, appDark: false))
  }

  @Test func aDarkLaunchIsNotStaleWhenOnlyTheLightSlotDiffers() {
    let shown = LaunchLook.recalled(saved: Self.plain("blue"))
    let forcedDark = LaunchLook.recalled(saved: Self.plain("blue", forced: true))
    #expect(shown.drawsTheSameSpace(as: forcedDark, appDark: true))
  }

  @Test func aDifferentTextureWithTheSameStopsIsStale() {
    var denim = Self.night
    denim.texture = .denim
    denim.grain = 0.8
    var other = Self.themed
    other["themeLooks"] = ["light": ["look": Self.sunset.dictionary, "dark": false], "dark": ["look": denim.dictionary, "dark": true]]
    #expect(!LaunchLook.recalled(saved: Self.themed).drawsTheSameSpace(as: LaunchLook.recalled(saved: other), appDark: true))
  }

  @Test func aLightLaunchIsNotStaleWhenOnlyTheDarkPaletteChanged() {
    func saved(dark: String) -> LaunchLook.Recalled {
      LaunchLook.recalled(saved: ["color": "blue", "themeColors": ["#112233", "#223344"], "darkThemeColors": [dark, "#556677"], "themeLooks": ["light": ["dark": false], "dark": ["dark": true]]])
    }
    #expect(saved(dark: "#445566").drawsTheSameSpace(as: saved(dark: "#778899"), appDark: false))
    #expect(!saved(dark: "#445566").drawsTheSameSpace(as: saved(dark: "#778899"), appDark: true))
  }

  @Test func aBackdropIsCountedStaleOnlyWhenSharingWasOnWhenItWasShown() {
    let blue = LaunchLook.recalled(saved: Self.plain("blue"))
    let green = LaunchLook.recalled(saved: Self.plain("green"))
    #expect(LaunchLook.countsAsStale(shown: blue, appDark: false, shownWindow: 3, next: green, currentWindow: 3))
    #expect(!LaunchLook.countsAsStale(shown: blue, appDark: false, shownWindow: nil, next: green, currentWindow: 3))
    #expect(!LaunchLook.countsAsStale(shown: blue, appDark: false, shownWindow: 2, next: green, currentWindow: 3))
    #expect(!LaunchLook.countsAsStale(shown: blue, appDark: false, shownWindow: 3, next: green, currentWindow: nil))
    #expect(!LaunchLook.countsAsStale(shown: blue, appDark: false, shownWindow: 3, next: blue, currentWindow: 3))
  }

  @Test func aDarkLaunchIsNotStaleWhenOnlyTheLightVariantOfACustomThemeChanged() {
    var dawn = Self.sunset
    dawn.angle = 120
    dawn.texture = .denim
    let before = LaunchLook.recalled(saved: Self.themed)
    let after = LaunchLook.recalled(saved: [
      "color": "#40A0E0",
      "themeColors": ["#40A0E0", "#E0A040"],
      "themeLooks": ["light": ["look": dawn.dictionary, "dark": false], "dark": ["look": Self.night.dictionary, "dark": true]],
    ])
    #expect(before.drawsTheSameSpace(as: after, appDark: true))
    #expect(!before.drawsTheSameSpace(as: after, appDark: false))
  }

  @Test func anOpaqueThemeIsNotStaleWhenOnlyItsIntensityChanged() {
    func saved(intensity: Double, translucency: Double) -> LaunchLook.Recalled {
      var look = Self.night
      look.intensity = intensity
      look.translucency = translucency
      return LaunchLook.recalled(saved: ["color": "#1A0D33", "themeColors": ["#1A0D33"], "themeLooks": ["light": ["look": look.dictionary, "dark": true], "dark": ["look": look.dictionary, "dark": true]]])
    }
    #expect(saved(intensity: 0.2, translucency: 0).drawsTheSameSpace(as: saved(intensity: 0.9, translucency: 0), appDark: true))
    #expect(!saved(intensity: 0.2, translucency: 1).drawsTheSameSpace(as: saved(intensity: 0.9, translucency: 1), appDark: true))
  }

  @Test func aOneColourThemeIsNotStaleWhenOnlyItsAngleChanged() {
    func saved(_ stops: [ThemeStop], angle: Double) -> LaunchLook.Recalled {
      var look = Self.night
      look.stops = stops
      look.angle = angle
      return LaunchLook.recalled(saved: ["color": "#1A0D33", "themeColors": ["#1A0D33"], "themeLooks": ["light": ["look": look.dictionary, "dark": true], "dark": ["look": look.dictionary, "dark": true]]])
    }
    let flat = [ThemeStop(color: ThemeColor(r: 0.1, g: 0.05, b: 0.2), x: 0.3, y: 0.3)]
    let same = flat + [ThemeStop(color: ThemeColor(r: 0.1, g: 0.05, b: 0.2), x: 0.7, y: 0.7)]
    let two = flat + [ThemeStop(color: ThemeColor(r: 0.6, g: 0.2, b: 0.3), x: 0.7, y: 0.7)]
    #expect(saved(flat, angle: 45).drawsTheSameSpace(as: saved(flat, angle: 130), appDark: true))
    #expect(saved(same, angle: 45).drawsTheSameSpace(as: saved(same, angle: 130), appDark: true))
    #expect(!saved(two, angle: 45).drawsTheSameSpace(as: saved(two, angle: 130), appDark: true))
  }
}
