import AppKit
import ArdiaCore
import Foundation

final class PluginHost {
  static let shared = PluginHost()
  static let quitGrace: TimeInterval = 1

  typealias Sink = (_ name: String, _ body: [String: Any]) -> Void

  private let queue = DispatchQueue(label: "ardia.plugins", qos: .userInitiated)
  private var sink: (owner: ObjectIdentifier, send: Sink)?
  private var attachment = 0
  private let runs = PluginRuns<PluginProcess>()
  private let lifecycle = PluginLifecycle()
  private let outbox = PluginPageOutbox()
  private var nextRun = 0
  private var quitObserver: NSObjectProtocol?
  private var restoredProviders = false
  static let credentialProvidersFile = "credential-providers.json"

  func attach(_ owner: AnyObject, send: @escaping Sink) {
    let id = ObjectIdentifier(owner)
    queue.sync { sink = (id, send) }
    prepareCredentialProviders()
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
    for process in all { process.terminateForQuit(within: Self.quitGrace / Double(max(1, all.count))) }
  }

  func start(_ spec: PluginProcess.Spec, done: @escaping ([String: Any]) -> Void) {
    queue.async { [self] in
      lifecycle.enqueue(spec.name, .start, cancelled: { done(["ok": false, "reason": "a later stop or removal replaced this start"]) }) { [self] complete in
        runs.stopAll(spec.name, graceMs: 0) { [self] in
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
      }
    }
  }

  private func spawn(_ given: PluginProcess.Spec, certificates: PluginSandbox.PreparedCertificates, done: @escaping ([String: Any]) -> Void) {
    guard let folders = PluginFolders.current() else { return done(["ok": false, "reason": "Ardia has no data folder"]) }
    var spec = given
    let plan: PluginCredentialPlan?
    switch PluginCredentialPlan.make(for: spec, folders: folders) {
    case .failure(let refusal):
      NSLog("[plugins] %@ didn't start: %@", spec.name, refusal.reason)
      if PluginCredentialProviders.saved()[spec.name] != nil { CredentialPluginHost.shared.markDamaged(spec.name) }
      return done(["ok": false, "reason": refusal.reason])
    case .success(let made): plan = made
    }
    if let plan {
      spec.memoryMB = max(spec.memoryMB, plan.memoryMB)
      spec.closedOutput = true
    }
    nextRun += 1
    let result = PluginProcess.spawn(
      spec, run: nextRun, folders: folders, queue: queue, certificates: certificates,
      onLine: { [weak self] process, line in
        self?.sink?.send("onLine", ["name": process.name, "run": process.run, "launch": process.launch, "line": line])
      },
      onExit: { [weak self] process, status, signal, overMemory in
        guard let self else { return }
        self.runs.exited(process)
        self.sink?.send(
          "onExit",
          PluginExitReport.payload(name: process.name, run: process.run, status: status, signal: signal, overMemory: overMemory, stopRequested: process.stopRequested))
      })
    switch result {
    case .success(let process):
      runs.installed(process)
      process.onPagePost = { [weak self] process, post in self?.post(post, from: process) }
      if let plan { pinCredentialProvider(process, plan) }
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
        runs.stopAll(name, onlyRun: run, graceMs: graceMs) {
          done()
          complete()
        }
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
      guard let process = runs.current[name], process.run == run, process.credential == nil else { return }
      process.connection?.send(data)
    }
  }

  func event(_ name: String, run: Int, _ line: String) {
    let data = Self.framed(line)
    queue.async { [self] in
      guard let process = runs.current[name], process.run == run else { return }
      process.connection?.event(data)
    }
  }

  func remove(_ name: String, official: Bool, folderId: String?, done: @escaping (String?) -> Void) {
    if CredentialPluginHost.shared.enabledPlugins[name] != nil || PluginCredentialProviders.saved()[name] != nil {
      forgetCredentialProvider(name) { _ in }
    }
    queue.async { [self] in
      lifecycle.enqueue(name, .remove) { [self] complete in
        runs.stopAll(name, graceMs: 1000) {
          let problem = PluginFolders.current().map { $0.remove(name, official: official, folderId: folderId) } ?? "Ardia has no data folder."
          DispatchQueue.main.async { done(problem) }
          complete()
        }
      }
    }
  }

  private func pinCredentialProvider(_ process: PluginProcess, _ plan: PluginCredentialPlan) {
    let link = PluginCredentialLink(
      queue: queue, process: process,
      forward: { [weak self] process, line in
        self?.sink?.send("onLine", ["name": process.name, "run": process.run, "launch": process.launch, "line": line])
      },
      stop: { [weak self] process in self?.stop(process.name, run: process.run, graceMs: 0) {} })
    guard let endpoint = CredentialPluginHost.shared.pin(
      plugin: process.name, run: process.run, approved: process.approved, attachment: attachment, manifest: plan.manifest, link: link)
    else {
      NSLog("[plugins] %@ declares a password manager Ardia can't read, so it runs closed with no credential access", process.name)
      return
    }
    process.credential = endpoint
  }

  private func prepareCredentialProviders() {
    let wanted: @Sendable (String) -> Void = { name in
      PluginHost.shared.emit("onCredentialRunWanted", ["name": name])
    }
    CredentialPluginHost.shared.onRunWanted(wanted)
    queue.async { [self] in
      guard !restoredProviders, let folders = PluginFolders.current() else { return }
      restoredProviders = true
      CredentialPluginHost.refuseProgramRoots(PluginCredentialPlan.refusedProgramRoots(folders))
      for (name, approved) in PluginCredentialProviders.saved().sorted(by: { $0.key < $1.key }) {
        guard let manifest = PluginCredentialPlan.officialManifest(name, approved: approved, folders: folders) else {
          NSLog("[plugins] %@'s official copy changed or is missing, so its password manager stays off until it starts again", name)
          continue
        }
        if let problem = CredentialPluginHost.shared.restore(plugin: name, approved: approved, manifest: manifest) {
          NSLog("[plugins] %@ wasn't restored: %@", name, problem)
        }
      }
    }
  }

  func setCredentialProvider(_ name: String, enabled: Bool, done: @escaping ([String: Any]) -> Void) {
    guard enabled else {
      Task {
        await CredentialPluginHost.shared.disable(name, forget: false)
        PluginCredentialProviders.save(name, approved: nil)
        done(["ok": true])
      }
      return
    }
    queue.async { [self] in
      guard let process = runs.current[name], !process.exited, process.credential != nil else {
        return done(["ok": false, "reason": "Ardia runs password managers only from its official plugins, and \(name) isn't running as one."])
      }
      if let problem = CredentialPluginHost.shared.enable(name) { return done(["ok": false, "reason": problem]) }
      PluginCredentialProviders.save(name, approved: process.approved)
      done(["ok": true])
    }
  }

  func forgetCredentialProvider(_ name: String, done: @escaping ([String: Any]) -> Void) {
    Task {
      await CredentialPluginHost.shared.disable(name, forget: true)
      PluginCredentialProviders.save(name, approved: nil)
      done(["ok": true])
    }
  }
}
