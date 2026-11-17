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

  @Test func aFirstLaunchDrawsThePlumLookBothAppsDefaultTo() {
    withDefaults { defaults in
      #expect(LaunchLook.recalled(from: defaults) == LookColors())
      #expect(LaunchLook.recalled(from: defaults).look == ProfileLook.plum)
    }
  }

  @Test func theStartPagesLookComesBackOnTheNextLaunch() {
    withDefaults { defaults in
      let space = LookColors(color: "blue", themeColors: ["#3366FF", "#8844CC"], darkThemeColors: ["#112244"])
      LaunchLook.remember(space, in: defaults)
      #expect(LaunchLook.recalled(from: defaults) == space)
      let plain = LookColors(color: "green", themeColors: nil, darkThemeColors: nil)
      LaunchLook.remember(plain, in: defaults)
      #expect(LaunchLook.recalled(from: defaults) == LookColors(color: "green", themeColors: [], darkThemeColors: nil))
    }
  }

  @Test func incognitoIsNeverRemembered() {
    withDefaults { defaults in
      let space = LookColors(color: "orange", themeColors: ["#FF8800"], darkThemeColors: nil)
      LaunchLook.remember(space, in: defaults)
      LaunchLook.remember(LookColors(color: LookColors.incognito), in: defaults)
      #expect(LaunchLook.recalled(from: defaults) == space)
    }
  }
}
