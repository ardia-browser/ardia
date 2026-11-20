import AppKit
import ExpoModulesCore

public class VaultsModule: Module {
  private var quitObserver: NSObjectProtocol?

  public func definition() -> ModuleDefinition {
    Name(Self.calls.moduleName)
    Events(Self.calls.domain)
    Self.calls.forwardEvents(to: self)

    OnCreate {
      self.quitObserver = NotificationCenter.default.addObserver(forName: NSApplication.willTerminateNotification, object: nil, queue: nil) { _ in
        VaultCommand.haltAll()
      }
      VaultAutoLock.shared.start()
      DispatchQueue.main.async { MainActor.assumeIsolated { VaultClipboard.clearLeftover() } }
      Task { await VaultBroker.shared.resumeAfterQuit() }
      DispatchQueue.main.async { MainActor.assumeIsolated { VaultPasskeys.install() } }
    }

    OnDestroy {
      if let observer = self.quitObserver { NotificationCenter.default.removeObserver(observer) }
      self.quitObserver = nil
    }

    Self.calls.function

    AsyncFunction("signIn") { (provider: String, fieldsJSON: String, promise: Promise) in
      let fields = VaultSignInFields(json: fieldsJSON)
      Task {
        guard let result = await VaultBroker.shared.signIn(provider, fields: fields) else {
          return promise.reject("ERR_BAD_ARGS", VaultsModule.unknown(provider))
        }
        promise.resolve(VaultJSON.text(result.jsonObject()))
      }
    }

    View(VaultTouchIDView.self) {
      Events("onStatus")
      Prop("armed") { (view: VaultTouchIDView, value: Bool?) in view.armed = value ?? false }
      Prop("grantScope") { (view: VaultTouchIDView, value: String?) in view.grantScope = value ?? "" }
    }

    AsyncFunction("unlock") { (provider: String, password: String?, handOnTab: String?, handOnOrigin: String?, promise: Promise) in
      let typed = VaultTypedPassword(password)
      let handOn = VaultHandOn(tab: handOnTab, origin: handOnOrigin)
      Task {
        let answer: VaultSignInResult? = switch typed {
        case .expired: await VaultBroker.shared.typedPasswordExpired(provider)
        case .typed(let password): await VaultBroker.shared.unlock(provider, password: password)
        case .none: await VaultBroker.shared.unlock(provider, password: nil, handOn: handOn)
        }
        guard let result = answer else {
          return promise.reject("ERR_BAD_ARGS", VaultsModule.unknown(provider))
        }
        promise.resolve(VaultJSON.text(result.jsonObject()))
      }
    }
  }

  static let longestIdleLockMinutes = 10_080
  static let defaultIdleLockMinutes = 30
  static let longestGeneratedLength = 4096

  static func unknown(_ provider: String) -> String { "\(provider) isn't a password manager Ardia knows" }

  static func provider(_ args: CallArgs) throws -> String {
    let id = try args.text("provider")
    guard VaultRegistry.provider(id) != nil || id == ArdiaVault.id else { throw BadCallArgs(message: unknown(id)) }
    return id
  }

  static func optionalProvider(_ args: CallArgs) throws -> String? {
    guard try args.optionalText("provider") != nil else { return nil }
    return try provider(args)
  }

  static func answer(_ reply: CallReply, _ work: @escaping @Sendable () async -> Any?) {
    Task { reply.ok(await work()) }
  }

  static func saveGenerated(id: String, provider: String, username: String?, profile: String) async -> [String: Any] {
    guard let entry = await VaultGenerated.entry(id) else { return ["saved": false, "error": VaultFillError.notFound.rawValue] }
    let typed = VaultNewLogin.cleanedUsername(username)
    let chosen = typed.isEmpty ? entry.username : typed
    guard !chosen.isEmpty else { return ["saved": false, "error": "needsUsername"] }
    let base = await ArdiaVaultStore.baseProfile(profile)
    let saved = await VaultBroker.shared.save(provider: provider, origin: entry.origin, username: chosen, password: entry.password, title: nil,
                                              profile: base)
    switch saved {
    case .success(let item):
      VaultGenerated.saved(password: entry.password, origin: entry.origin)
      return ["saved": true, "item": item.jsonObject()]
    case .failure(let error):
      return ["saved": false, "error": error.rawValue]
    }
  }

  static func addTotp(provider: String, id: String, token: String) async -> [String: Any] {
    guard let offer = VaultTotpSetup.offer(token) else { return VaultAddTotpResult.failure(.expired).jsonObject() }
    let result = await VaultBroker.shared.addTotp(provider: provider, id: id, uri: offer.uri)
    if result.item != nil { VaultTotpSetup.forget(token) }
    return result.jsonObject()
  }

  static func edit(provider: String, id: String, username: String?, passwordDraft: String?, url: String?, totpToken: String?, removeTotp: Bool,
                   profile: String) async -> [String: Any]
  {
    var change = VaultLoginChange(username: username, url: url)
    if let passwordDraft {
      guard let password = await MainActor.run(body: { VaultPasswordDrafts.value(passwordDraft) }) else {
        return VaultEditResult.failure(.invalid).jsonObject()
      }
      change.password = password
    }
    if removeTotp {
      change.totp = .remove
    } else if let totpToken {
      guard let offer = VaultTotpSetup.offer(totpToken) else {
        return VaultEditResult.failure(.invalid, "The code expired. Add it again.").jsonObject()
      }
      change.totp = .set(offer.uri)
    }
    let result = provider == ArdiaVault.id
      ? await VaultArdiaLogins.edit(id: id, change: change, profile: profile)
      : await VaultBroker.shared.edit(provider: provider, id: id, change: change)
    if result.item != nil {
      if let totpToken, !removeTotp { VaultTotpSetup.forget(totpToken) }
      if let passwordDraft { await MainActor.run { VaultPasswordDrafts.drop(passwordDraft) } }
    }
    return result.jsonObject()
  }

  static func createLogin(website: String, username: String, passwordDraft: String, profile: String, codeToken: String?) async -> [String: Any] {
    let password = await MainActor.run { VaultPasswordDrafts.value(passwordDraft) }
    var codeURI: String?
    if let codeToken {
      guard let offer = VaultTotpSetup.offer(codeToken) else { return VaultCreateLoginResult.failure(.expired).jsonObject() }
      codeURI = offer.uri
    }
    let result = await VaultArdiaLogins.create(website: website, username: username, password: password, profile: profile, codeURI: codeURI)
    if result.item != nil {
      if let codeToken { VaultTotpSetup.forget(codeToken) }
      await MainActor.run { VaultPasswordDrafts.drop(passwordDraft) }
    }
    return result.jsonObject()
  }

  static func readCode(_ source: VaultCodeSource, origin: String, tabId: String?) async -> [String: Any] {
    switch await VaultTotpSetup.read(source, origin: origin, tabId: tabId) {
    case .success(let offer): return offer
    case .failure(let error): return ["error": error.rawValue]
    }
  }

  static let calls = CallTable(domain: "vaults", handlers: [
    "claimChromeDropdowns": { args, reply in
      let usernames = try args.optionalBool("anyLogin") == true ? nil : try args.strings("usernames")
      reply.ok(ArdiaHost.claimChromeDropdowns(try args.strings("kinds"), usernames: usernames, tabId: try args.text("tabId")))
    },
    "providers": { _, reply in VaultsModule.answer(reply) { await VaultBroker.shared.providerStates().map { $0.jsonObject() } } },
    "refresh": { args, reply in
      let id = try VaultsModule.provider(args)
      if id == ArdiaVault.id, let profiles = try args.optionalStrings("ardiaProfiles") { ArdiaVaultStore.setArdiaProfiles(profiles) }
      VaultsModule.answer(reply) { await VaultBroker.shared.refresh(id, explicit: true)?.jsonObject() }
    },
    "items": { args, reply in
      let id = try VaultsModule.optionalProvider(args)
      Task {
        if let json = await VaultBroker.shared.itemsJSON(id) { return reply.promise.resolve(json) }
        reply.ok(await VaultBroker.shared.items(id).map { $0.jsonObject() })
      }
    },
    "lock": { args, reply in
      let id = try VaultsModule.provider(args)
      VaultsModule.answer(reply) { await VaultBroker.shared.lock(id)?.jsonObject() }
    },
    "signOut": { args, reply in
      let id = try VaultsModule.provider(args)
      VaultsModule.answer(reply) { await VaultBroker.shared.signOut(id)?.jsonObject() }
    },
    "configure": { args, reply in
      let id = try VaultsModule.provider(args)
      let server = try args.optionalText("server")
      VaultsModule.answer(reply) { await VaultBroker.shared.configure(id, server: server)?.jsonObject() }
    },
    "cancelSignIn": { args, reply in
      let id = try VaultsModule.provider(args)
      VaultsModule.answer(reply) { await VaultBroker.shared.cancelSignIn(id)?.jsonObject() }
    },
    "copy": { args, reply in
      let id = try VaultsModule.provider(args)
      let item = try args.text("id")
      guard let field = VaultCopyField(rawValue: try args.text("field")) else { return reply.ok(VaultCopyResult.refused(.notFound).jsonObject()) }
      VaultsModule.answer(reply) { await VaultBroker.shared.copy(id, item: item, field: field).jsonObject() }
    },
    "totp": { args, reply in
      let id = try VaultsModule.provider(args)
      let item = try args.text("id")
      VaultsModule.answer(reply) { await VaultBroker.shared.totp(id, item: item)?.jsonObject() }
    },
    "biometrics": { _, reply in reply.ok(["available": VaultOwnerCheck.biometricsAvailable]) },
    "keychainCounts": { _, reply in
      let counts = VaultKeychain.takeCounts()
      let store = VaultStoreCounts.take()
      reply.ok([
        "reads": counts.reads, "readsFromMemory": counts.readsFromMemory, "writesSkipped": counts.writesSkipped,
        "loginKeychainCalls": counts.loginKeychainCalls, "storeLegacyMigrated": store.legacyMigrated,
        "storeNewerFormatKept": store.newerFormatKept, "storeUnreadableKept": store.unreadableKept,
        "storeKeyReadFailed": store.keyReadFailed, "staleWorkDropped": store.staleWorkDropped,
        "storeResealed": store.resealed, "storeSetAside": store.setAside, "storeKeyNotNoted": store.keyNotNoted,
        "storeCloudNewerFormatKept": store.cloudNewerFormatKept,
      ])
    },
    "sync": { _, reply in VaultsModule.answer(reply) { await VaultBroker.shared.sync().jsonObject() } },
    "syncStatus": { _, reply in VaultsModule.answer(reply) { await VaultBroker.shared.syncStatus().jsonObject() } },
    "backupStatus": { args, reply in
      let profiles = try args.strings("profiles")
      VaultsModule.answer(reply) { await ArdiaVaultBackup.shared.status(profiles: profiles).jsonObject() }
    },
    "restoreBackup": { args, reply in
      let profiles = try args.strings("profiles")
      VaultsModule.answer(reply) { await ArdiaVaultBackup.shared.restore(profiles: profiles).jsonObject() }
    },
    "updateFromBackup": { args, reply in
      let profiles = try args.strings("profiles")
      VaultsModule.answer(reply) { await ArdiaVaultBackup.shared.updateChanged(profiles: profiles).jsonObject() }
    },
    "deleteBackup": { _, reply in VaultsModule.answer(reply) { await ArdiaVaultBackup.shared.deleteEverywhere() } },
    "resumeBackup": { _, reply in VaultsModule.answer(reply) { await ArdiaVaultBackup.shared.resumeEverywhere(); return [String: Any]() } },
    "warm": { args, reply in
      let origin = try args.text("origin")
      Task { await VaultBroker.shared.warm(origin: origin) }
      reply.ok([String: Any]())
    },
    "generate": { args, reply in
      let style = VaultPasswordStyle(named: try args.optionalText("style"))
      let maxLength = try args.optionalDouble("maxLength").flatMap { $0.isFinite ? Int(min(max($0, 0), Double(VaultsModule.longestGeneratedLength))) : nil }
      reply.ok(["length": VaultPasswordGenerator.generate(style: style, maxLength: maxLength).count])
    },
    "export": { args, reply in
      let id = try VaultsModule.provider(args)
      VaultsModule.answer(reply) { await VaultBroker.shared.export(id).jsonObject() }
    },
    "setOptions": { args, reply in
      let minutes = try args.double("idleLockMinutes")
      let touchID = try args.bool("touchID")
      let askBeforeFilling = try args.optionalBool("askBeforeFilling") ?? true
      let iCloudSync = try args.optionalBool("iCloudSync") ?? true
      let lockOnQuit = try args.optionalBool("lockOnQuit") ?? true
      let lockOnScreenLock = try args.optionalBool("lockOnScreenLock") ?? true
      let idle = minutes.isFinite ? Int(min(max(minutes, 0), Double(VaultsModule.longestIdleLockMinutes))) : VaultsModule.defaultIdleLockMinutes
      VaultsModule.answer(reply) {
        await VaultBroker.shared.setOptions(
          idleLockMinutes: idle, touchID: touchID, askBeforeFilling: askBeforeFilling, iCloudSync: iCloudSync,
          lockOnQuit: lockOnQuit, lockOnScreenLock: lockOnScreenLock)
        return [String: Any]()
      }
    },
    "listGenerated": { _, reply in VaultsModule.answer(reply) { await VaultGenerated.list() } },
    "copyGenerated": { args, reply in
      let id = try args.text("id")
      VaultsModule.answer(reply) {
        guard let entry = await VaultGenerated.entry(id) else { return VaultCopyResult.refused(.notFound).jsonObject() }
        guard await VaultBroker.shared.ownerAllows("copy your password") else { return VaultCopyResult.declined.jsonObject() }
        return (await VaultClipboard.copy(entry.password) ? VaultCopyResult.copied : .clipboardFailed).jsonObject()
      }
    },
    "saveGenerated": { args, reply in
      let id = try args.text("id")
      let provider = try VaultsModule.provider(args)
      let username = try args.optionalText("username")
      let profile = args.profile
      VaultsModule.answer(reply) { await VaultsModule.saveGenerated(id: id, provider: provider, username: username, profile: profile) }
    },
    "deleteGenerated": { args, reply in
      let id = try args.text("id")
      VaultsModule.answer(reply) { ["deleted": await VaultGenerated.delete(id: id)] }
    },
    "setGeneratedRetention": { args, reply in
      let days = try args.double("days")
      VaultGenerated.setKeepDays(days.isFinite ? Int(max(min(days, Double(VaultGenerated.longestKeep)), -1)) : VaultGenerated.defaultKeepDays)
      reply.ok([String: Any]())
    },
    "addTotp": { args, reply in
      let provider = try VaultsModule.provider(args)
      let id = try args.text("id")
      let token = try args.text("token")
      VaultsModule.answer(reply) { await VaultsModule.addTotp(provider: provider, id: id, token: token) }
    },
    "edit": { args, reply in
      let provider = try VaultsModule.provider(args)
      let id = try args.text("id")
      let username = try args.optionalText("username")
      let passwordDraft = try args.optionalText("passwordDraft")
      let url = try args.optionalText("url")
      let profile = args.profile
      let raw = args.values["totp"]
      let totp = raw as? [String: Any]
      if let raw, !(raw is NSNull), totp == nil { throw BadCallArgs(message: "totp isn't an object") }
      let removeTotp = totp.map { VaultJSON.bool($0["remove"]) == true } ?? false
      let totpToken = totp.flatMap { VaultJSON.string($0["token"]) }
      if totp != nil, !removeTotp, totpToken == nil { throw BadCallArgs(message: "totp needs a token or remove") }
      VaultsModule.answer(reply) {
        await VaultsModule.edit(provider: provider, id: id, username: username, passwordDraft: passwordDraft, url: url, totpToken: totpToken,
                                removeTotp: removeTotp, profile: profile)
      }
    },
    "removeTotp": { args, reply in
      let provider = try VaultsModule.provider(args)
      let id = try args.text("id")
      VaultsModule.answer(reply) { await VaultBroker.shared.removeTotp(provider: provider, id: id).jsonObject() }
    },
    "readCode": { args, reply in
      guard let source = VaultCodeSource(rawValue: try args.text("source")) else { throw BadCallArgs(message: "source isn't clipboard, image or page") }
      let origin = try args.optionalText("origin") ?? ""
      let tabId = try args.optionalText("tabId")
      VaultsModule.answer(reply) { await VaultsModule.readCode(source, origin: origin, tabId: tabId) }
    },
    "forgetCode": { args, reply in
      VaultTotpSetup.forget(try args.text("token"))
      reply.ok([String: Any]())
    },
    "copyCode": { args, reply in
      let provider = try VaultsModule.provider(args)
      let id = try args.text("id")
      VaultsModule.answer(reply) {
        guard provider == ArdiaVault.id else { return VaultCopyResult.refused(.notFound).jsonObject() }
        return await VaultArdiaCodes.copy(id: id).jsonObject()
      }
    },
    "ardiaLoginChanged": { args, reply in
      let profile = args.profile
      let origin = try args.text("origin")
      let username = try args.text("username")
      let renamed = try args.optionalText("to")
      VaultsModule.answer(reply) { await VaultArdiaCodes.loginChanged(profile: profile, origin: origin, username: username, to: renamed) }
    },
    "copyConcealed": { args, reply in
      let text = try args.text("text")
      VaultsModule.answer(reply) { (await VaultClipboard.copy(text) ? VaultCopyResult.copied : .clipboardFailed).jsonObject() }
    },
    "dropTouchGrant": { _, reply in
      VaultOwnerCheck.dropGrant()
      reply.ok([String: Any]())
    },
    "newPasswordDraft": { args, reply in
      let style = try args.optionalText("style").map { VaultPasswordStyle(named: $0) }
      Task { @MainActor in reply.ok(VaultPasswordDrafts.blank(style: style)) }
    },
    "dropPasswordDraft": { args, reply in
      let token = try args.text("token")
      Task { @MainActor in
        if VaultPasswordDrafts.outlivesField(token) { VaultPasswordDrafts.drop(token) }
        reply.ok([String: Any]())
      }
    },
    "createLogin": { args, reply in
      let website = try args.text("website")
      let username = try args.optionalText("username") ?? ""
      let passwordDraft = try args.text("passwordDraft")
      let codeToken = try args.optionalText("codeToken")
      let profile = args.profile
      VaultsModule.answer(reply) {
        await VaultsModule.createLogin(website: website, username: username, passwordDraft: passwordDraft, profile: profile, codeToken: codeToken)
      }
    },
    "passkeys": { _, reply in VaultsModule.answer(reply) { await VaultPasskeys.list() } },
    "deletePasskey": { args, reply in
      let id = try args.text("id")
      VaultsModule.answer(reply) { await VaultPasskeys.delete(id: id) }
    },
    "passkeyAnswer": { args, reply in
      let requestId = try args.text("requestId")
      let choice = try args.text("choice")
      let target = try args.optionalText("target")
      Task { @MainActor in reply.ok(await VaultPasskeys.shared.answer(requestId: requestId, choice: choice, target: target)) }
    },
    "setPasskeys": { args, reply in
      let source = try args.optionalText("source")
      let extensions = (args.values["extensions"] as? [Any] ?? []).compactMap { raw -> VaultPasskeyExtension? in
        guard let entry = raw as? [String: Any], let id = entry["id"] as? String, VaultPasskeyExtension.isId(id) else { return nil }
        return VaultPasskeyExtension(id: id, name: VaultPasskey.cleaned(entry["name"] as? String ?? ""), known: entry["known"] as? Bool == true)
      }
      Task { @MainActor in
        if let source { VaultPasskeys.shared.configure(source: source, extensions: extensions) }
        reply.ok([String: Any]())
      }
    },
    "codes": { _, reply in VaultsModule.answer(reply) { await VaultArdiaCodes.standaloneList() } },
    "addCode": { args, reply in
      let token = try args.text("token")
      let label = try args.text("label")
      let issuer = try args.optionalText("issuer")
      let website = try args.optionalText("website")
      VaultsModule.answer(reply) { await VaultArdiaCodes.addStandalone(token: token, label: label, issuer: issuer, website: website) }
    },
    "editCode": { args, reply in
      let id = try args.text("id")
      let label = try args.text("label")
      let website = try args.optionalText("website")
      VaultsModule.answer(reply) { await VaultArdiaCodes.editStandalone(id: id, label: label, website: website) }
    },
    "deleteCode": { args, reply in
      let id = try args.text("id")
      VaultsModule.answer(reply) { await VaultArdiaCodes.deleteStandalone(id: id) }
    },
    "importCodes": { args, reply in
      let profile = args.profile
      let path = try args.text("path")
      VaultsModule.answer(reply) {
        let result = await VaultArdiaCodes.importCodes(profile: profile, path: path)
        return ["imported": result.imported, "standalone": result.standalone]
      }
    },
  ])
}
