import ExpoModulesCore

public class ProfilesModule: Module {
  public func definition() -> ModuleDefinition {
    Name(Self.calls.moduleName)
    Events(Self.calls.domain)
    Self.calls.forwardEvents(to: self)

    Self.calls.function
  }

  static let calls = CallTable(domain: "profiles", handlers: [
    "loaded": { _, reply in reply.ok(["profiles": ArdiaHost.loadedProfiles]) },
    "chromePrefs": { args, reply in
      let prefs = try args.strings("paths")
      let paths = ArdiaHost.loadedProfilePaths
      DispatchQueue.global(qos: .utility).async {
        let values = paths.compactMapValues { ChromeProfilePrefs.booleans(prefs, inProfileAt: $0) }
        DispatchQueue.main.async { reply.ok(["profiles": values]) }
      }
    },
    "release": { args, reply in
      ArdiaHost.releaseProfile(args.profile)
      reply.ok()
    },
    "unloadIdle": { args, reply in reply.ok(ArdiaHost.unloadIdleProfile(args.profile)) },
    "deleteData": { args, reply in PageEngines.deleteProfileData(profile: args.profile) { reply.ok(["remaining": $0]) } },
    "clearBrowsingData": { args, reply in
      PageEngines.clearBrowsingData(profile: args.profile, types: try args.strings("types"), since: try args.optionalDouble("since") ?? 0) { reply.service(nil, $0) }
    },
  ])
}
