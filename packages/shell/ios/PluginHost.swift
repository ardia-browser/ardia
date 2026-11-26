import AppKit
import Foundation

final class PluginHost {
  static let shared = PluginHost()
  static let quitGrace: TimeInterval = 1

  typealias Sink = (_ name: String, _ body: [String: Any]) -> Void

  private let queue = DispatchQueue(label: "ardia.plugins", qos: .userInitiated)
  private var sink: (owner: ObjectIdentifier, send: Sink)?
  private var attachment = 0
  private let runs = PluginRuns<PluginProcess>()
  private let live = PluginLiveRuns()
  private let lifecycle = PluginLifecycle()
  private let outbox = PluginPageOutbox()
  private var nextRun = 0
  private var quitObserver: NSObjectProtocol?

  private init() {}

  func isLive(_ name: String, run: Int) -> Bool { live.contains(name, run: run) }

  private func publishLive() {
    live.replace(with: runs.current.values.filter { !$0.exited && $0.connection?.closed == false }.map { (name: $0.name, run: $0.run) })
  }

  func attach(_ owner: AnyObject, send: @escaping Sink) {
    let id = ObjectIdentifier(owner)
    queue.sync { sink = (id, send) }
    if quitObserver == nil {
      quitObserver = NotificationCenter.default.addObserver(forName: NSApplication.willTerminateNotification, object: nil, queue: nil) { [weak self] _ in
        self?.queue.sync { self?.terminateAll() }
      }
    }
  }

  func emit(_ name: String, _ body: [String: Any]) {
    queue.async { [self] in sink?.send(name, body) }
  }

  func detach(_ owner: AnyObject) {
    let id = ObjectIdentifier(owner)
    queue.async { [self] in
      guard sink?.owner == id else { return }
      sink = nil
      terminateAll()
    }
  }

  private func terminateAll() {
    attachment += 1
    let all = runs.all
    runs.removeAll()
    publishLive()
    for process in all { process.terminateForQuit(within: Self.quitGrace / Double(max(1, all.count))) }
  }

  func start(_ spec: PluginProcess.Spec, done: @escaping ([String: Any]) -> Void) {
    queue.async { [self] in
      lifecycle.enqueue(spec.runKey, .start, cancelled: { done(["ok": false, "reason": "a later stop or removal replaced this start"]) }) { [self] complete in
        runs.stopAll(spec.runKey, graceMs: 0) { [self] in
          publishLive()
          let attached = attachment
          PluginProcess.prepareCertificates(for: spec, deliverOn: queue) { [self] certificates in
            if attachment == attached {
              spawn(spec, certificates: certificates, done: done)
            } else {
              done(["ok": false, "reason": "Ardia closed its plugins while this one was starting"])
            }
            complete()
          }
        }
        publishLive()
      }
    }
  }

  private func spawn(_ spec: PluginProcess.Spec, certificates: PluginSandbox.PreparedCertificates, done: @escaping ([String: Any]) -> Void) {
    guard let folders = PluginFolders.current() else { return done(["ok": false, "reason": "Ardia has no data folder"]) }
    nextRun += 1
    let result = PluginProcess.spawn(
      spec, run: nextRun, folders: folders, queue: queue, certificates: certificates,
      onLine: { [weak self] process, line in
        self?.sink?.send("onLine", ["name": process.name, "run": process.run, "launch": process.launch, "line": line])
      },
      onClose: { [weak self] process in
        guard let self else { return }
        self.live.markClosed(process.name, run: process.run)
        self.publishLive()
        PluginNetChannels.shared.closeAll(process.name, run: process.run)
      },
      onExit: { [weak self] process, status, signal, overMemory in
        guard let self else { return }
        self.live.markClosed(process.name, run: process.run)
        self.runs.exited(process)
        self.publishLive()
        PluginNetChannels.shared.closeAll(process.name, run: process.run)
        self.sink?.send(
          "onExit",
          ["name": process.name, "run": process.run, "status": status.map { Int($0) } ?? NSNull(), "signal": signal.map { Int($0) } ?? NSNull(), "overMemory": overMemory])
      })
    switch result {
    case .success(let process):
      runs.installed(process)
      publishLive()
      process.onPagePost = { [weak self] process, post in self?.post(post, from: process) }
      done(["ok": true, "run": process.run, "pid": Int(process.pid)])
    case .failure(let failure):
      NSLog("[plugins] %@ didn't start: %@", spec.name, failure.reason)
      done(["ok": false, "reason": failure.reason])
    }
  }

  func bindPage(_ binding: PageBinding) {
    queue.async { [self] in outbox.bind(binding) }
  }

  func revokePage(_ binding: PageBinding) {
    queue.async { [self] in outbox.revoke(binding) }
  }

  func pageMessage(_ binding: PageBinding, body: Any) {
    guard let line = PluginPageMessages.fromPage(body, view: binding.view) else { return }
    queue.async { [self] in
      guard outbox.isBound(binding), let process = runs.current[binding.plugin], process.run == binding.run, process.approved == binding.approved, !process.exited
      else { return }
      process.connection?.send(line)
    }
  }

  private func post(_ post: PagePost, from process: PluginProcess) -> String? {
    switch outbox.post(plugin: process.name, approved: process.approved, run: process.run, view: post.view, json: post.json) {
    case .overloaded: return "overloaded"
    case .queued(let targets):
      targets.forEach(pump)
      return nil
    }
  }

  private func pump(_ binding: PageBinding) {
    while let json = outbox.take(binding) {
      DispatchQueue.main.async {
        PluginPageMessageBridge.deliver(binding, json) { [weak self] in
          self?.queue.async {
            self?.outbox.delivered(binding)
            self?.pump(binding)
          }
        }
      }
    }
  }

  func stop(_ name: String, run: Int, graceMs: Int, done: @escaping () -> Void) {
    queue.async { [self] in
      lifecycle.enqueue(name, run == 0 ? .stop : .stopRun) { [self] complete in
        runs.stopAll(name, onlyRun: run, graceMs: graceMs) { [self] in
          publishLive()
          done()
          complete()
        }
        publishLive()
      }
    }
  }

  private static func framed(_ line: String) -> Data {
    var data = Data(line.utf8)
    data.append(10)
    return data
  }

  func reply(_ name: String, run: Int, _ line: String) {
    let data = Self.framed(line)
    queue.async { [self] in
      guard let process = runs.current[name], process.run == run else { return }
      process.connection?.reply(data, ticket: 0)
    }
  }

  func call(_ name: String, run: Int, _ line: String) {
    let data = Self.framed(line)
    queue.async { [self] in
      guard let process = runs.current[name], process.run == run else { return }
      process.connection?.send(data)
    }
  }

  func deliver(_ name: String, run: Int, _ line: String, still: @escaping () -> Bool = { true }, then: @escaping (_ backlog: Int?) -> Void) {
    let data = Self.framed(line)
    queue.async { [self] in
      guard still(), let process = runs.current[name], process.run == run, !process.exited, let connection = process.connection, !connection.closed else { return then(nil) }
      connection.send(data)
      then(connection.closed ? nil : connection.pendingBytes)
    }
  }

  func runningProcesses(_ answer: @escaping ([(name: String, run: Int, pid: pid_t)]) -> Void) {
    queue.async { [self] in
      let running = runs.current.values.filter { !$0.exited }.map { (name: $0.name, run: $0.run, pid: $0.pid) }
      DispatchQueue.global(qos: .utility).async { answer(running) }
    }
  }

  func backlog(_ name: String, run: Int, then: @escaping (_ backlog: Int?) -> Void) {
    queue.async { [self] in
      guard let process = runs.current[name], process.run == run, !process.exited, let connection = process.connection, !connection.closed else { return then(nil) }
      then(connection.pendingBytes)
    }
  }

  func event(_ name: String, run: Int, _ line: String) {
    let data = Self.framed(line)
    queue.async { [self] in
      guard let process = runs.current[name], process.run == run else { return }
      process.connection?.event(data)
    }
  }

  func remove(_ name: String, source: String, folderId: String?, done: @escaping (String?) -> Void) {
    queue.async { [self] in
      lifecycle.enqueue(name, .remove) { [self] complete in
        let retiring = runs.all.filter { $0.name == name || $0.name == name + PluginProcess.Spec.sidecarSuffix }
        runs.stopAll(name + PluginProcess.Spec.sidecarSuffix, graceMs: 1000) {}
        runs.stopAll(name, graceMs: 1000) {
          let problem = PluginFolders.current().map { $0.remove(name, source: source, folderId: folderId) } ?? "Ardia has no data folder."
          DispatchQueue.main.async { done(problem) }
          complete()
        }
        for process in retiring { live.markClosed(process.name, run: process.run) }
        publishLive()
        for process in retiring { PluginNetChannels.shared.closeAll(process.name, run: process.run) }
      }
    }
  }
}
