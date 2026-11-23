import ArdiaCore
import Foundation

final class OfficialPluginFetch {
  static let shared = OfficialPluginFetch()
  static let idleTimeout: TimeInterval = 60
  static let deadline: TimeInterval = 900
  static let progressEvent = "onOfficialFetch"

  private struct Running {
    let generation: Int
    var task: URLSessionDownloadTask?
  }

  struct Failure: Error {
    let code: String
    let reason: String
  }

  private let lock = NSLock()
  private var running: [String: Running] = [:]
  private var cancelled: Set<String> = []
  private var waiters: [String: [([String: Any]) -> Void]] = [:]
  private var generation = 0
  private let work = DispatchQueue(label: "ardia.official-plugins", qos: .userInitiated)
  private lazy var downloads = OfficialDownload(idleTimeout: Self.idleTimeout, deadline: Self.deadline) { name, received, total in
    PluginHost.shared.emit(Self.progressEvent, ["name": name, "received": received, "total": total])
  }

  func fetch(_ name: String, done: @escaping ([String: Any]) -> Void) {
    lock.lock()
    if running[name] != nil {
      waiters[name, default: []].append(done)
      lock.unlock()
      return
    }
    generation += 1
    let mine = generation
    waiters[name] = [done]
    running[name] = Running(generation: mine, task: nil)
    lock.unlock()
    work.async { self.run(name, generation: mine) }
  }

  func cancel(_ name: String) {
    lock.lock()
    let task = running[name]?.task
    if running[name] != nil { cancelled.insert(name) }
    lock.unlock()
    task?.cancel()
  }

  private func isCurrent(_ name: String, _ mine: Int) -> Bool {
    lock.lock()
    defer { lock.unlock() }
    return running[name]?.generation == mine && !cancelled.contains(name)
  }

  private func settle(_ name: String, _ reply: [String: Any]) {
    lock.lock()
    let all = waiters.removeValue(forKey: name) ?? []
    running.removeValue(forKey: name)
    cancelled.remove(name)
    lock.unlock()
    for waiter in all { waiter(reply) }
  }

  private func fail(_ name: String, _ failure: Failure) {
    NSLog("[plugins] %@ wasn't fetched (%@): %@", name, failure.code, failure.reason)
    settle(name, ["ok": false, "code": failure.code, "reason": failure.reason])
  }

  private static func milliseconds(since start: DispatchTime) -> Int {
    Int((DispatchTime.now().uptimeNanoseconds - start.uptimeNanoseconds) / 1_000_000)
  }

  private func run(_ name: String, generation mine: Int) {
    guard let folders = PluginFolders.current() else { return fail(name, Failure(code: "failed", reason: "Ardia has no data folder")) }
    guard let pin = PluginFolders.officialPin(), let entry = pin.entry(name) else {
      return fail(name, Failure(code: "unsupported", reason: "this Ardia doesn't pin an official \(name) plugin"))
    }
    let registry = folders.programRegistry(pin: pin)
    let store = folders.officialStore()
    if let copy = store.copy(name, sha: entry.sha256), let text = PluginFolders.manifestText(copy.path).text {
      return settle(name, ["ok": true, "candidate": PluginFolders.candidate(text, folderId: copy.folderId, version: entry.version), "reused": true])
    }
    guard let scratch = store.makeScratch(name, prefix: ".fetch-") else { return fail(name, Failure(code: "failed", reason: "its download folder couldn't be made")) }
    let archive = URL(fileURLWithPath: (scratch as NSString).appendingPathComponent(entry.file))
    let downloadStart = DispatchTime.now()
    let fetched: Result<OfficialDownload.Fetched, Failure>
    if LaunchConfig.shared.isolated, let source = LaunchConfig.shared.instance(OfficialPin.sourceKey) {
      fetched = copyLocal(source, file: entry.file, to: archive)
    } else {
      fetched = download(name, entry.url, to: archive, generation: mine)
    }
    let downloadMs = Self.milliseconds(since: downloadStart)
    let got: OfficialDownload.Fetched
    switch fetched {
    case .failure(let failure):
      PluginPrograms.discard(scratch)
      return fail(name, failure)
    case .success(let done): got = done
    }
    guard isCurrent(name, mine) else {
      PluginPrograms.discard(scratch)
      return fail(name, Failure(code: "cancelled", reason: "Cancelled."))
    }
    let verifyStart = DispatchTime.now()
    let published = OfficialInstaller.verifyAndPublish(entry, archive: archive.path, scratch: scratch, store: store, registry: registry)
    PluginPrograms.discard(scratch)
    switch published {
    case .failure(let failure): fail(name, Failure(code: failure.code, reason: failure.reason))
    case .success(let made):
      let timings: [String: Any] = ["downloadMs": downloadMs, "verifyMs": Self.milliseconds(since: verifyStart), "bytes": got.bytes, "resumes": got.resumes]
      settle(name, ["ok": true, "candidate": PluginFolders.candidate(made.manifest, folderId: made.copy.folderId, version: entry.version), "timings": timings])
    }
  }

  private func copyLocal(_ source: String, file: String, to archive: URL) -> Result<OfficialDownload.Fetched, Failure> {
    let folder = source.hasPrefix("file://") ? (URL(string: source)?.path ?? "") : source
    let path = (folder as NSString).appendingPathComponent(file)
    var info = stat()
    guard lstat(path, &info) == 0, (info.st_mode & S_IFMT) == S_IFREG else { return .failure(Failure(code: "offline", reason: "\(file) isn't in \(folder)")) }
    guard Int64(info.st_size) <= OfficialArchive.maxDownload else { return .failure(Failure(code: "verify", reason: "\(file) is over \(OfficialArchive.maxDownload >> 20) MB")) }
    do {
      try FileManager.default.copyItem(at: URL(fileURLWithPath: path), to: archive)
      return .success(OfficialDownload.Fetched(bytes: Int64(info.st_size), resumes: 0))
    } catch {
      return .failure(Failure(code: "failed", reason: "\(file) couldn't be copied (\(error.localizedDescription))"))
    }
  }

  private func download(_ name: String, _ url: URL, to archive: URL, generation mine: Int) -> Result<OfficialDownload.Fetched, Failure> {
    let result = downloads.fetch(
      name, from: url, to: archive, deadline: Self.deadline,
      isCancelled: { [weak self] in !(self?.isCurrent(name, mine) ?? false) },
      started: { [weak self] task in
        guard let self else { return false }
        self.lock.lock()
        defer { self.lock.unlock() }
        guard self.running[name]?.generation == mine, !self.cancelled.contains(name) else { return false }
        self.running[name]?.task = task
        return true
      })
    return result.mapError { Failure(code: $0.code, reason: $0.reason) }
  }

  static func promote(_ name: String, folderId: String, approved: String) -> [String: Any] {
    guard let folders = PluginFolders.current(), let pin = PluginFolders.officialPin() else { return ["ok": false, "reason": "It isn't an official plugin this Ardia pins."] }
    if let problem = OfficialInstaller.promote(name, folderId: folderId, approved: approved, store: folders.officialStore(), pin: pin) {
      return ["ok": false, "reason": problem]
    }
    return ["ok": true]
  }
}
