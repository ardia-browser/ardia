import ExpoModulesCore

public class SitesModule: Module {
  public func definition() -> ModuleDefinition {
    Name(Self.calls.moduleName)

    Self.calls.function
  }

  enum EngineName: String {
    case chromium, webkit
  }

  static func engine(_ args: CallArgs) throws -> PageEngine {
    switch try args.choice("engine", EngineName.self) {
    case .chromium: PageEngines.chromium
    case .webkit: PageEngines.webKit
    }
  }

  static let calls = sitesCallTable(
    settings: { args, reply in
      try engine(args).siteSettings(profile: args.profile, origin: try args.text("origin")) { reply.service($0, $1) }
    },
    setSetting: { args, reply in
      let origin = try args.text("origin")
      let type = try args.text("type")
      try engine(args).setSiteSetting(profile: args.profile, origin: origin, type: type, value: try args.text("value"))
      if type == "notifications" { WebKitHub.shared.notifications.refresh(profile: args.profile, origin: origin) }
      reply.ok()
    },
    origins: { args, reply in ArdiaServices.siteSettingsOrigins(profile: args.profile) { reply.service($0, $1) } },
    reset: { args, reply in
      let origin = try args.text("origin")
      ArdiaServices.resetSiteSettings(profile: args.profile, origin: origin)
      WebKitHub.shared.notifications.refresh(profile: args.profile, origin: origin)
      reply.ok()
    },
    clearData: { args, reply in
      try engine(args).clearSiteData(profile: args.profile, origin: try args.text("origin")) { reply.service($0, $1) }
    },
    zoomLevels: { args, reply in ArdiaServices.zoomLevels(profile: args.profile) { reply.service($0, $1) } },
    setZoom: { args, reply in
      ArdiaServices.setZoom(try args.double("zoom"), profile: args.profile, host: try args.text("host"))
      reply.ok()
    },
    preloadPages: { args, reply in
      ArdiaServices.preloadPages(profile: args.profile) { reply.service($0, $1) }
    },
    setPreloadPages: { args, reply in
      ArdiaServices.setPreloadPages(try args.bool("on"), profile: args.profile) { reply.service($0, $1) }
    }
  )
}
