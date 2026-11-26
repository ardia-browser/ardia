import AppKit
import ExpoModulesCore
import Foundation

extension PluginsModule {
  static func fetchStream(_ spec: [String: Any], _ promise: Promise) { PluginNetChannels.shared.fetchStream(spec) { promise.resolve($0) } }

  static func cancelStream(_ name: String, _ run: Int, _ stream: String) { PluginNetChannels.shared.cancelStream(name, run, stream) }

  static func wsConnect(_ spec: [String: Any], _ promise: Promise) { PluginNetChannels.shared.connect(spec) { promise.resolve($0) } }

  static func wsSend(_ name: String, _ run: Int, _ socket: String, _ data: String, _ binary: Bool, _ promise: Promise) {
    PluginNetChannels.shared.send(name, run, socket, data, binary: binary) { promise.resolve($0) }
  }

  static func wsClose(_ name: String, _ run: Int, _ socket: String, _ code: Int, _ reason: String) { PluginNetChannels.shared.close(name, run, socket, code: code, reason: reason) }

  static func closeNet(_ name: String, _ run: Int) { PluginNetChannels.shared.closeAll(name, run: run) }

  static func usage(_ promise: Promise) {
    PluginHost.shared.runningProcesses { running in
      let rows: [[String: Any]] = running.compactMap { entry in
        guard let sample = PluginUsage.sample(entry.pid) else { return nil }
        let open = PluginNetChannels.shared.counts(entry.name)
        return ["name": entry.name, "run": entry.run, "memoryBytes": Double(sample.memoryBytes), "cpuMs": Double(sample.cpuNanos / 1_000_000), "streams": open.streams, "sockets": open.sockets]
      }
      promise.resolve(rows)
    }
  }

  static func authSignIn(_ spec: [String: Any], _ promise: Promise) { PluginAuthSession.start(spec) { promise.resolve($0) } }

  static func pickFiles(_ spec: [String: Any], _ promise: Promise) { PluginFilePanels.pick(spec) { promise.resolve($0) } }

  static func openDroppedFiles(_ spec: [String: Any], _ promise: Promise) { PluginFilePanels.dropped(spec) { promise.resolve($0) } }

  static func readFileChunk(_ name: String, _ run: Int, _ handle: String, _ offset: Int, _ length: Int) -> [String: Any] {
    PluginFileHandles.shared.readChunk(name, run, handle, offset: offset, length: length)
  }

  static func saveBegin(_ spec: [String: Any], _ promise: Promise) { PluginFilePanels.saveBegin(spec) { promise.resolve($0) } }

  static func saveChunk(_ name: String, _ run: Int, _ handle: String, _ data: String) -> [String: Any] {
    guard let bytes = Data(base64Encoded: data) else { return ["ok": false, "reason": "data isn't base64"] }
    return PluginFileHandles.shared.writeChunk(name, run, handle, data: bytes)
  }

  static func finishFile(_ name: String, _ run: Int, _ handle: String, _ commit: Bool) -> [String: Any] {
    PluginFileHandles.shared.finish(name, run, handle, commit: commit)
  }

  static func loadImage(_ spec: [String: Any], _ promise: Promise) { PluginImageLoader.load(spec) { promise.resolve($0) } }

  static func readPluginAsset(_ name: String, _ folderId: String, _ approved: String, _ path: String) -> [String: Any] {
    PluginImageLoader.asset(name, folderId: folderId, approved: approved, path: path)
  }
}
