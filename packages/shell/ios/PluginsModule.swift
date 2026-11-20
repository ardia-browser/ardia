import AppKit
import ExpoModulesCore
import Foundation

public class PluginsModule: Module {
  public func definition() -> ModuleDefinition {
    Name("ArdiaPlugins")

    Events("onLine", "onExit")

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

    AsyncFunction("linkPrograms") { (spec: [String: Any], promise: Promise) in PluginProgramLinks.link(spec) { promise.resolve($0) } }

    AsyncFunction("legacyProgramsInstalled") { (promise: Promise) in PluginProgramLinks.legacyInstalled { promise.resolve($0) } }

    AsyncFunction("sweepPrograms") { (active: [String], promise: Promise) in PluginProgramLinks.sweep(keeping: active) { promise.resolve(nil) } }

    AsyncFunction("unlinkPrograms") { (name: String, programs: [String], remove: Bool, promise: Promise) in
      PluginProgramLinks.unlink(name, programs: programs, remove: remove) { promise.resolve($0) }
    }

    AsyncFunction("remove") { (name: String, promise: Promise) in Self.remove(name, promise) }
      .runOnQueue(.main)

    Function("revealLog") { (name: String) in DispatchQueue.main.async { Self.revealLog(name) } }

    Function("revealFolder") { () in DispatchQueue.main.async { Self.revealFolder() } }

    AsyncFunction("devSnapshotPage") { (name: String, path: String, promise: Promise) in Self.snapshot(name, path, promise) }
      .runOnQueue(.main)

    View(PluginPageView.self) {
      Events("onLoaded")
      Prop("plugin") { (view: PluginPageView, value: String) in view.plugin = value }
      Prop("url") { (view: PluginPageView, value: String) in view.url = value }
      Prop("network") { (view: PluginPageView, value: Bool) in view.network = value }
      Prop("folderId") { (view: PluginPageView, value: String) in view.folderId = value }
      Prop("approved") { (view: PluginPageView, value: String) in view.approved = value }
      Prop("run") { (view: PluginPageView, value: Int) in view.run = value }
      Prop("context") { (view: PluginPageView, value: String) in view.context = value }
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
    guard PluginFolders.isName(name), !run.isEmpty, memoryMB > 0, let network = spec["network"] as? Bool, let folderId = spec["folderId"] as? String,
      let approved = spec["approved"] as? String, let hasPage = spec["page"] as? Bool, let launch = spec["launch"] as? Int
    else {
      promise.reject("ERR_BAD_ARGS", "start needs name, run, memoryMB, network, folderId, approved, page and launch")
      return
    }
    let process = PluginProcess.Spec(name: name, run: run, memoryMB: memoryMB, network: network, folderId: folderId, approved: approved, hasPage: hasPage, launch: launch)
    PluginHost.shared.start(process) { reply in promise.resolve(reply) }
  }

  private static func remove(_ name: String, _ promise: Promise) {
    PluginHost.shared.remove(name) { problem in
      if let problem { return promise.resolve(["ok": false, "reason": problem]) }
      PluginPageView.removeData(name) { promise.resolve(["ok": true]) }
    }
  }

  private static func revealLog(_ name: String) {
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
