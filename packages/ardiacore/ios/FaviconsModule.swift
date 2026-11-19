import ExpoModulesCore

public class FaviconsModule: Module {
  public func definition() -> ModuleDefinition {
    Name(Self.calls.moduleName)

    Constant("storesIcons") { true }

    Function("token") { (profile: String) -> String? in ArdiaFaviconStore.token(profile) }

    Function("saveLaunchIcons") { (profile: String, uris: [String]) -> [String] in ArdiaFaviconStore.saveLaunchIcons(uris, profile: profile) }

    Self.calls.function
  }

  static let calls = CallTable(domain: "favicons", handlers: [
    "get": { args, reply in ArdiaFaviconStore.lookUp(args.json, profile: args.profile) { reply.service($0, $1) } },
    "set": { args, reply in ArdiaFaviconStore.set(args.json, profile: args.profile) { reply.service($0, $1) } },
    "fetch": { args, reply in
      ArdiaFavicons.fetch(try args.text("url"), profile: args.profile, page: try args.optionalText("page")) { reply.ok($0) }
    },
    "forget": { args, reply in
      ArdiaFaviconStore.forget(args.profile)
      reply.ok()
    },
    "counts": { _, reply in reply.ok(ArdiaFaviconStore.takeCounts()) },
  ])
}
