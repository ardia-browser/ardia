import ExpoModulesCore

public class PasswordsModule: Module {
  public func definition() -> ModuleDefinition {
    Name(Self.calls.moduleName)

    Self.calls.function

    AsyncFunction("save") { (profile: String, origin: String, username: String, password: String, promise: Promise) in
      ArdiaServices.savePassword(profile: profile, origin: origin, username: username, password: password) {
        CallReply(promise: promise).service($0, $1)
        if $1 == nil { ArdiaVaultIndex.noteChanged(profile: profile, origin: origin, username: username, renamed: nil, removed: false) }
        ArdiaVaultBackup.noteChangeSoon()
      }
    }.runOnQueue(.main)

    AsyncFunction("update") {
      (profile: String, origin: String, username: String, newUsername: String?, newPassword: String?, promise: Promise) in
      ArdiaServices.updatePassword(profile: profile, origin: origin, username: username, newUsername: newUsername,
                                   newPassword: newPassword) {
        CallReply(promise: promise).service($0, $1)
        if $1 == nil, let newUsername, newUsername != username {
          ArdiaVaultIndex.noteChanged(profile: profile, origin: origin, username: username, renamed: newUsername, removed: false)
        }
        ArdiaVaultBackup.noteChangeSoon()
      }
    }.runOnQueue(.main)
  }

  static let calls = CallTable(domain: "passwords", handlers: [
    "list": { args, reply in ArdiaServices.listPasswords(profile: args.profile) { reply.service($0, $1) } },
    "unlock": { args, reply in
      ArdiaServices.unlockPasswords(profile: args.profile) { value, error in
        if error == nil, (value as? [String: Any])?["unlocked"] as? Bool == true { VaultOwnerCheck.noteConfirmed() }
        reply.service(value, error)
      }
    },
    "reveal": { args, reply in
      ArdiaServices.password(profile: args.profile, origin: try args.text("origin"), username: try args.text("username")) { reply.service($0, $1) }
    },
    "remove": { args, reply in
      let profile = args.profile
      let origin = try args.text("origin")
      let username = try args.text("username")
      ArdiaServices.deletePassword(profile: profile, origin: origin, username: username) {
        reply.service($0, $1)
        if $1 == nil { ArdiaVaultIndex.noteChanged(profile: profile, origin: origin, username: username, renamed: nil, removed: true) }
        ArdiaVaultBackup.noteChangeSoon()
      }
    },
    "neverSaveOrigins": { args, reply in ArdiaServices.neverSaveOrigins(profile: args.profile) { reply.service($0, $1) } },
    "allowSaving": { args, reply in ArdiaServices.allowSaving(profile: args.profile, origin: try args.text("origin")) { reply.service($0, $1) } },
    "export": { args, reply in ArdiaServices.exportPasswords(profile: args.profile, path: nil) { reply.service($0, $1) } },
    "autofillEnabled": { args, reply in
      ArdiaServices.profileToggles(profile: args.profile, set: nil) { toggles, error in
        guard let toggles = toggles as? [String: Bool], let enabled = toggles["passwords"] else { return reply.service(nil, error ?? "no password setting") }
        reply.ok(enabled)
      }
    },
    "setAutofillEnabled": { args, reply in
      let enabled = try args.bool("enabled")
      ArdiaServices.profileToggles(profile: args.profile, set: ["passwords": NSNumber(value: enabled)]) { _, error in
        reply.service(nil, error)
        Task { _ = await ArdiaVaultIndex.shared.refreshState(explicit: true) }
      }
    },
    "setFieldProviders": { args, reply in
      let generation = try args.double("generation")
      let session = try args.text("session")
      let profiles = try args.dicts("profiles")
      let applied = ArdiaWebView.setFieldProviders(profiles, generation: generation, session: session)
      if applied { WebKitHub.shared.transfers.liveTabs.forEach { $0.pushFieldProvider() } }
      reply.ok(["applied": applied])
    },
    "showSystemPanel": { args, reply in
      let tab = try args.text("tab")
      let generation = try args.optionalDouble("generation") ?? -1
      let via = try args.optionalText("via") == "badge" ? "badge" : "menu"
      if let live = WebKitHub.shared.transfers.liveTab(tab) { return live.showSystemPanel(generation: generation, via: via) { reply.ok($0) } }
      if !ArdiaWebView.showSystemPanel(tab: tab, generation: generation, via: via, completion: { reply.ok($0) }) {
        reply.ok(["shown": false, "reason": "noTab"])
      }
    },
    "systemPanelAvailable": { _, reply in reply.ok(ArdiaWebView.systemPanelAvailability) },
    "otpauthHandler": { _, reply in reply.ok(["app": ArdiaWebView.otpauthHandlerName as Any? ?? NSNull()]) },
    "setUpVerificationCode": { args, reply in
      let tab = try args.text("tab")
      let token = try args.text("token")
      let generation = try args.optionalDouble("generation") ?? -1
      if let live = WebKitHub.shared.transfers.liveTab(tab) { return live.setUpVerificationCode(token, generation: generation) { reply.ok($0) } }
      if !ArdiaWebView.setUpVerificationCode(token, tab: tab, generation: generation, completion: { reply.ok($0) }) {
        reply.ok(["opened": false, "reason": "noTab"])
      }
    },
  ])
}
