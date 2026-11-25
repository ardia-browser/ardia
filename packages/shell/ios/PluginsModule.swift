import AppKit
import ExpoModulesCore
import Foundation

public class PluginsModule: Module, PluginsNative {
  static let storageQueue = DispatchQueue(label: "ardia.plugins.storage", qos: .userInitiated)

  static var queue: DispatchQueue { storageQueue }

  static func stop(_ name: String, _ run: Int, _ graceMs: Int, _ promise: Promise) { PluginHost.shared.stop(name, run: run, graceMs: graceMs) { promise.resolve(nil) } }

  static func reply(_ name: String, _ run: Int, _ line: String) { PluginHost.shared.reply(name, run: run, line) }

  static func event(_ name: String, _ run: Int, _ line: String) { PluginHost.shared.event(name, run: run, line) }

  static func call(_ name: String, _ run: Int, _ line: String) { PluginHost.shared.call(name, run: run, line) }

  static func linkPrograms(_ spec: [String: Any], _ promise: Promise) { PluginProgramLinks.link(spec) { promise.resolve($0) } }

  static func takeAfterUpdateQuitStops(_ promise: Promise) { PluginProgramLinks.takeQuitStops { promise.resolve($0) } }

  static func setAfterUpdateQuitConsent(_ consent: String) { PluginProgramLinks.setQuitStopsConsent(consent) }

  static func legacyProgramsInstalled(_ promise: Promise) { PluginProgramLinks.legacyInstalled { promise.resolve($0) } }

  static func programRegistry(_ promise: Promise) { PluginProgramLinks.registry { promise.resolve($0) } }

  static func sweepPrograms(_ active: [String], _ promise: Promise) { PluginProgramLinks.sweep(keeping: active) { promise.resolve(nil) } }

  static func unlinkPrograms(_ name: String, _ programs: [String], _ remove: Bool, _ promise: Promise) { PluginProgramLinks.unlink(name, programs: programs, remove: remove) { promise.resolve($0) } }

  static func officialPlugins() -> [[String: Any]]? { PluginFolders.officialPin().map { pin in pin.entries.map { ["name": $0.name, "version": $0.version, "folderId": $0.folderId] } } }

  static func fetchOfficial(_ name: String, _ promise: Promise) { OfficialPluginFetch.shared.fetch(name) { promise.resolve($0) } }

  static func cancelOfficialFetch(_ name: String) { OfficialPluginFetch.shared.cancel(name) }

  static func promoteOfficial(_ name: String, _ folderId: String, _ approved: String) -> [String: Any] { OfficialPluginFetch.promote(name, folderId: folderId, approved: approved) }

  static func hostFetch(_ spec: [String: Any], _ promise: Promise) { PluginHostFetch.run(spec) { promise.resolve($0) } }

  static func readPluginFile(_ name: String, _ folderId: String, _ approved: String, _ path: String) -> [String: Any] { Self.readPluginFile(name, folderId: folderId, approved: approved, path: path) }

  static func remove(_ name: String, _ official: Bool, _ folderId: String?, _ promise: Promise) { Self.remove(name, official: official, folderId: folderId, promise) }

  static func revealLog(_ name: String) { DispatchQueue.main.async { Self.showLog(name) } }

  static func revealFolder() { DispatchQueue.main.async { Self.showFolder() } }

  static func devSnapshotPage(_ name: String, _ path: String, _ promise: Promise) { Self.snapshot(name, path, promise) }

  public func definition() -> ModuleDefinition {
    Name(Self.moduleName)

    Self.eventsDefinition

    OnCreate {
      PluginHost.shared.attach(self) { [weak self] name, body in self?.sendEvent(name, body) }
    }

    Self.folderFunction

    Self.listFunction

    Self.startFunction

    Self.stopFunction

    Self.replyFunction

    Self.eventFunction

    Self.callFunction

    Self.linkProgramsFunction

    Self.takeAfterUpdateQuitStopsFunction

    Self.setAfterUpdateQuitConsentFunction

    Self.legacyProgramsInstalledFunction

    Self.programRegistryFunction

    Self.sweepProgramsFunction

    Self.unlinkProgramsFunction

    Self.officialPluginsFunction

    Self.fetchOfficialFunction

    Self.cancelOfficialFetchFunction

    Self.promoteOfficialFunction

    Self.hostFetchFunction

    Self.storageReadFunction

    Self.storageWriteFunction

    Self.readPluginFileFunction

    Self.removeFunction

    Self.revealLogFunction

    Self.revealFolderFunction

    Self.devSnapshotPageFunction

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

  static func folder() -> String {
    PluginFolders.current()?.pluginsLexical ?? ""
  }

  static func list() -> [[String: Any]] {
    PluginFolders.current()?.list() ?? []
  }

  static func start(_ spec: [String: Any], _ promise: Promise) {
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

  static func storageRead(_ name: String) -> [String: Any] {
    guard let data = PluginFolders.current()?.dataFolder(name) else { return PluginStorageRead.error("its data folder couldn't be opened").reply }
    defer { data.close() }
    let read = PluginStorage.read(in: data.fd)
    if case .error(let reason) = read { NSLog("[plugins] %@'s storage wasn't read: %@", name, reason) }
    return read.reply
  }

  static func storageWrite(_ name: String, _ text: String) -> [String: Any] {
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

  private static func showLog(_ name: String) {
    guard let data = PluginFolders.current()?.dataFolder(name) else { return }
    defer { data.close() }
    let log = URL(fileURLWithPath: (data.path as NSString).appendingPathComponent("plugin.log"))
    NSWorkspace.shared.activateFileViewerSelecting([log])
  }

  private static func showFolder() {
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
