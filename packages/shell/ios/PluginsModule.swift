import AppKit
import ArdiaCore
import ExpoModulesCore
import Foundation

public class PluginsModule: Module {
  static let storageQueue = DispatchQueue(label: "ardia.plugins.storage", qos: .userInitiated)

  public func definition() -> ModuleDefinition {
    Name("ArdiaPlugins")

    Events("onLine", "onExit", "onCredentialRunWanted", OfficialPluginFetch.progressEvent)

    OnCreate {
      PluginHost.shared.attach(self) { [weak self] name, body in self?.sendEvent(name, body) }
    }

    Function("folder") { () -> String in Self.folder() }

    AsyncFunction("list") { () -> [[String: Any]] in Self.list() }
      .runOnQueue(DispatchQueue.global(qos: .utility))

    AsyncFunction("start") { (spec: [String: Any], promise: Promise) in Self.start(spec, promise) }

    AsyncFunction("stop") { (name: String, run: Int, graceMs: Int, promise: Promise) in
      PluginHost.shared.stop(name, run: run, graceMs: graceMs) { promise.resolve(nil) }
    }

    Function("reply") { (name: String, run: Int, line: String) in PluginHost.shared.reply(name, run: run, line) }

    Function("event") { (name: String, run: Int, line: String) in PluginHost.shared.event(name, run: run, line) }

    Function("call") { (name: String, run: Int, line: String) in PluginHost.shared.call(name, run: run, line) }

    AsyncFunction("setCredentialProvider") { (name: String, enabled: Bool, promise: Promise) in
      PluginHost.shared.setCredentialProvider(name, enabled: enabled) { promise.resolve($0) }
    }

    AsyncFunction("forgetCredentialProvider") { (name: String, promise: Promise) in
      PluginHost.shared.forgetCredentialProvider(name) { promise.resolve($0) }
    }

    AsyncFunction("linkPrograms") { (spec: [String: Any], promise: Promise) in PluginProgramLinks.link(spec) { promise.resolve($0) } }

    AsyncFunction("takeAfterUpdateQuitStops") { (promise: Promise) in PluginProgramLinks.takeQuitStops { promise.resolve($0) } }

    Function("setAfterUpdateQuitConsent") { (consent: String) in PluginProgramLinks.setQuitStopsConsent(consent) }

    AsyncFunction("legacyProgramsInstalled") { (promise: Promise) in PluginProgramLinks.legacyInstalled { promise.resolve($0) } }

    AsyncFunction("programRegistry") { (promise: Promise) in PluginProgramLinks.registry { promise.resolve($0) } }

    AsyncFunction("sweepPrograms") { (active: [String], promise: Promise) in PluginProgramLinks.sweep(keeping: active) { promise.resolve(nil) } }

    AsyncFunction("unlinkPrograms") { (name: String, programs: [String], remove: Bool, promise: Promise) in
      PluginProgramLinks.unlink(name, programs: programs, remove: remove) { promise.resolve($0) }
    }

    AsyncFunction("officialPlugins") { () -> [[String: Any]]? in
      PluginFolders.officialPin().map { pin in pin.entries.map { ["name": $0.name, "version": $0.version, "folderId": $0.folderId] } }
    }
    .runOnQueue(DispatchQueue.global(qos: .utility))

    AsyncFunction("fetchOfficial") { (name: String, promise: Promise) in OfficialPluginFetch.shared.fetch(name) { promise.resolve($0) } }

    Function("cancelOfficialFetch") { (name: String) in OfficialPluginFetch.shared.cancel(name) }

    AsyncFunction("promoteOfficial") { (name: String, folderId: String, approved: String) -> [String: Any] in
      OfficialPluginFetch.promote(name, folderId: folderId, approved: approved)
    }
    .runOnQueue(DispatchQueue.global(qos: .userInitiated))

    AsyncFunction("hostFetch") { (spec: [String: Any], promise: Promise) in PluginHostFetch.run(spec) { promise.resolve($0) } }

    AsyncFunction("storageRead") { (name: String) -> [String: Any] in Self.storageRead(name) }
      .runOnQueue(Self.storageQueue)

    AsyncFunction("storageWrite") { (name: String, text: String) -> [String: Any] in Self.storageWrite(name, text) }
      .runOnQueue(Self.storageQueue)

    AsyncFunction("readPluginFile") { (name: String, folderId: String, approved: String, path: String) -> [String: Any] in
      Self.readPluginFile(name, folderId: folderId, approved: approved, path: path)
    }
    .runOnQueue(DispatchQueue.global(qos: .userInitiated))

    AsyncFunction("remove") { (name: String, official: Bool, folderId: String?, promise: Promise) in Self.remove(name, official: official, folderId: folderId, promise) }
      .runOnQueue(.main)

    Function("revealLog") { (name: String) in DispatchQueue.main.async { Self.revealLog(name) } }

    Function("revealFolder") { () in DispatchQueue.main.async { Self.revealFolder() } }

    AsyncFunction("devSnapshotPage") { (name: String, path: String, promise: Promise) in Self.snapshot(name, path, promise) }
      .runOnQueue(.main)

    View(PluginPageView.self) {
      Events("onLoaded", "onTitleChange", "onNavigationChange", "onMessage")
      Prop("plugin") { (view: PluginPageView, value: String) in view.plugin = value }
      Prop("url") { (view: PluginPageView, value: String) in view.url = value }
      Prop("network") { (view: PluginPageView, value: Bool) in view.network = value }
      Prop("folderId") { (view: PluginPageView, value: String) in view.folderId = value }
      Prop("approved") { (view: PluginPageView, value: String) in view.approved = value }
      Prop("run") { (view: PluginPageView, value: Int) in view.run = value }
      Prop("context") { (view: PluginPageView, value: String) in view.context = value }
      Prop("themeCss") { (view: PluginPageView, value: String?) in view.themeCss = value ?? "" }
    }

    OnDestroy {
      PluginHost.shared.detach(self)
    }
  }

  private static func folder() -> String {
    PluginFolders.current()?.pluginsLexical ?? ""
  }

  private static func list() -> [[String: Any]] {
    PluginFolders.current()?.list() ?? []
  }

  private static func start(_ spec: [String: Any], _ promise: Promise) {
    let name = spec["name"] as? String ?? ""
    let run = spec["run"] as? [String] ?? []
    let memoryMB = spec["memoryMB"] as? Int ?? 0
    let runtime = spec["runtime"] as? String ?? "process"
    let entry = spec["entry"] as? String
    let launchable = runtime == "js" ? entry?.isEmpty == false : runtime == "process" && !run.isEmpty
    guard PluginFolders.isName(name), launchable, memoryMB > 0, let network = spec["network"] as? Bool, let folderId = spec["folderId"] as? String,
      let approved = spec["approved"] as? String, let hasPage = spec["page"] as? Bool, let launch = spec["launch"] as? Int
    else {
      promise.reject("ERR_BAD_ARGS", "start needs name, run (or runtime js and entry), memoryMB, network, folderId, approved, page and launch")
      return
    }
    var process = PluginProcess.Spec(name: name, run: run, memoryMB: memoryMB, network: network, folderId: folderId, approved: approved, hasPage: hasPage, launch: launch)
    process.runtime = runtime
    process.entry = entry
    PluginHost.shared.start(process) { reply in promise.resolve(reply) }
  }

  private static func storageRead(_ name: String) -> [String: Any] {
    guard let data = PluginFolders.current()?.dataFolder(name) else { return PluginStorageRead.error("its data folder couldn't be opened").reply }
    defer { data.close() }
    let read = PluginStorage.read(in: data.fd)
    if case .error(let reason) = read { NSLog("[plugins] %@'s storage wasn't read: %@", name, reason) }
    return read.reply
  }

  private static func storageWrite(_ name: String, _ text: String) -> [String: Any] {
    guard let data = PluginFolders.current()?.dataFolder(name) else { return ["ok": false, "reason": "its data folder couldn't be made"] }
    defer { data.close() }
    if let refusal = PluginStorage.write(in: data.fd, text: text) { return ["ok": false, "reason": refusal.reason] }
    return ["ok": true]
  }

  private static func readPluginFile(_ name: String, folderId: String, approved: String, path: String) -> [String: Any] {
    guard let folders = PluginFolders.current() else { return ["ok": false, "reason": "Ardia has no data folder"] }
    let folder: OpenedFolder
    switch folders.approvedFolder(name, folderId: folderId, approved: approved) {
    case .success(let opened): folder = opened
    case .failure(let refusal): return ["ok": false, "reason": refusal.reason]
    }
    defer { folder.close() }
    switch PluginFiles.readText(path, in: folder) {
    case .success(let text): return ["ok": true, "text": text]
    case .failure(let refusal): return ["ok": false, "reason": refusal.reason]
    }
  }

  private static func remove(_ name: String, official: Bool, folderId: String?, _ promise: Promise) {
    PluginHost.shared.remove(name, official: official, folderId: folderId) { problem in
      if let problem { return promise.resolve(["ok": false, "reason": problem]) }
      if official { return promise.resolve(["ok": true]) }
      PluginPageView.removeData(name) { promise.resolve(["ok": true]) }
    }
  }

  private static func revealLog(_ name: String) {
    guard CredentialPluginHost.shared.enabledPlugins[name] == nil, CredentialPluginHost.shared.endpoint(name) == nil else { return }
    guard let data = PluginFolders.current()?.dataFolder(name) else { return }
    defer { data.close() }
    let log = URL(fileURLWithPath: (data.path as NSString).appendingPathComponent("plugin.log"))
    NSWorkspace.shared.activateFileViewerSelecting([log])
  }

  private static func revealFolder() {
    guard let folders = PluginFolders.current() else { return }
    if FileManager.default.fileExists(atPath: folders.pluginsLexical) {
      NSWorkspace.shared.activateFileViewerSelecting([URL(fileURLWithPath: folders.pluginsLexical)])
    } else {
      NSWorkspace.shared.open(URL(fileURLWithPath: folders.config))
    }
  }

  private static func snapshot(_ name: String, _ path: String, _ promise: Promise) {
    guard let view = PluginPageView.live[name] else {
      promise.resolve(false)
      return
    }
    view.snapshot(to: path) { ok in promise.resolve(ok) }
  }
}
