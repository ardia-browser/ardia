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
    #expect(blue.drawsTheSameSpace(as: LaunchLook.recalled(saved: Self.plain("blue"))))
    #expect(!blue.drawsTheSameSpace(as: LaunchLook.recalled(saved: Self.plain("green"))))
    #expect(!blue.drawsTheSameSpace(as: LaunchLook.recalled(saved: Self.plain("blue", forced: true))))
    #expect(!blue.drawsTheSameSpace(as: LaunchLook.recalled(saved: Self.themed)))
    let older = LaunchLook.Recalled(colors: LookColors(color: "blue", themeColors: [], darkThemeColors: nil))
    #expect(older.drawsTheSameSpace(as: blue))
  }
}
