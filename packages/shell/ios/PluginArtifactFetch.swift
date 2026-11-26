import ArdiaCore
import Foundation

final class PluginArtifactFetch: NSObject, URLSessionDownloadDelegate {
  static let shared = PluginArtifactFetch()
  static let idleTimeout: TimeInterval = 60
  static let deadline: TimeInterval = 900
  static let progressEvent = "onArtifactFetch"
  static let sourceKey = "pluginArtifactsFrom"
  private static let offlineCodes: Set<URLError.Code> = [
    .notConnectedToInternet, .networkConnectionLost, .cannotFindHost, .cannotConnectToHost, .dnsLookupFailed, .timedOut, .internationalRoamingOff,
    .dataNotAllowed, .secureConnectionFailed,
  ]

  private struct Running {
    let key: String
    let generation: Int
    var task: URLSessionDownloadTask?
    let finish: (Result<URL, Failure>) -> Void
    var reported: Int64 = 0
  }

  struct Failure: Error {
    let code: String
    let reason: String
    var cause: FailureCause = .other
  }

  private let lock = NSLock()
  private var running: [String: Running] = [:]
  private var cancelled: Set<String> = []
  private var waiters: [String: [([String: Any]) -> Void]] = [:]
  private var generation = 0
  private let work = DispatchQueue(label: "ardia.plugin-artifacts", qos: .userInitiated)
  private lazy var session: URLSession = {
    let configuration = URLSessionConfiguration.ephemeral
    configuration.timeoutIntervalForRequest = Self.idleTimeout
    configuration.timeoutIntervalForResource = Self.deadline
    configuration.httpCookieStorage = nil
    configuration.urlCache = nil
    configuration.requestCachePolicy = .reloadIgnoringLocalCacheData
    configuration.waitsForConnectivity = false
    return URLSession(configuration: configuration, delegate: self, delegateQueue: nil)
  }()

  struct Spec {
    let key: String
    let id: String
    let version: String
    let url: URL
    let sha256: String
    let sizeBytes: Int64
    let official: OfficialProof?

    init?(_ raw: [String: Any]) {
      guard let key = raw["name"] as? String, let id = raw["id"] as? String, PluginStore.id(key) == id, let version = raw["version"] as? String,
        let text = raw["url"] as? String, let url = URL(string: text), url.scheme == "https", url.host?.isEmpty == false, let sha = raw["sha256"] as? String,
        PluginStore.isSha(sha), let size = (raw["sizeBytes"] as? NSNumber)?.int64Value, size > 0, size <= PluginArchive.maxDownload
      else { return nil }
      (self.key, self.id, self.version, self.url, self.sha256, self.sizeBytes) = (key, id, version, url, sha, size)
      if let signature = raw["officialSig"] as? String, let platform = raw["platform"] as? String {
        official = OfficialProof(platform: platform, signature: signature)
      } else {
        official = nil
      }
    }

    var identity: String { [key, version, sha256, url.absoluteString].joined(separator: "\u{0}") }

    var file: String { url.lastPathComponent.isEmpty ? "artifact.tar.gz" : url.lastPathComponent }
  }

  func fetch(_ raw: [String: Any], done: @escaping ([String: Any]) -> Void) {
    guard let spec = Spec(raw) else { return done(["ok": false, "code": "failed", "reason": "fetchArtifact needs name, id, version, an https url, sha256 and sizeBytes"]) }
    let name = spec.identity
    lock.lock()
    if running[name] != nil {
      waiters[name, default: []].append(done)
      lock.unlock()
      return
    }
    generation += 1
    let mine = generation
    waiters[name] = [done]
    running[name] = Running(key: spec.key, generation: mine, task: nil, finish: { _ in })
    lock.unlock()
    work.async { self.run(spec, generation: mine) }
  }

  func cancel(_ key: String) {
    lock.lock()
    let mine = running.filter { $0.value.key == key }
    cancelled.formUnion(mine.keys)
    lock.unlock()
    for found in mine.values { found.task?.cancel() }
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
    NSLog("[plugins] %@ wasn't fetched (%@): %@", String(name.prefix { $0 != "\u{0}" }), failure.code, failure.reason)
    settle(name, ["ok": false, "code": failure.code, "reason": failure.reason, "cause": failure.cause.rawValue])
  }

  private func deliver(_ spec: Spec, copy: StoreCopy, text: String, store: PluginStore, reused: Bool) {
    let name = spec.identity
    guard copy.version == spec.version, copy.sha == spec.sha256 else {
      return fail(name, Failure(code: "verify", reason: "its copy is version \(copy.version), not \(spec.version)", cause: .mismatch))
    }
    if let proof = spec.official {
      guard PluginOfficial.verify(id: spec.id, version: spec.version, sha256: spec.sha256, proof: proof, keys: PluginOfficial.keys(override: LaunchConfig.shared.pluginNativeKeys)) else {
        return fail(name, Failure(code: "verify", reason: "\(spec.id) \(spec.version) isn't signed by Ardia's release key", cause: .mismatch))
      }
      guard store.recordOfficial(copy, proof: proof) else { return fail(name, Failure(code: "failed", reason: "its official signature couldn't be kept", cause: .io)) }
    }
    var reply: [String: Any] = ["ok": true, "candidate": PluginFolders.candidate(text, copy: copy), "official": spec.official != nil]
    if reused { reply["reused"] = true }
    settle(name, reply)
  }

  private func run(_ spec: Spec, generation mine: Int) {
    let name = spec.identity
    guard let folders = PluginFolders.current() else { return fail(name, Failure(code: "failed", reason: "Ardia has no data folder", cause: .folder)) }
    let store = folders.store()
    if let copy = store.copy(spec.key, sha: spec.sha256), let text = PluginFolders.manifestText(copy.path).text {
      return deliver(spec, copy: copy, text: text, store: store, reused: true)
    }
    guard let scratch = store.makeScratch(spec.key, prefix: ".fetch-") else { return fail(name, Failure(code: "failed", reason: "its download folder couldn't be made", cause: .folder)) }
    let archive = URL(fileURLWithPath: (scratch as NSString).appendingPathComponent(spec.file))
    let fetched: Result<Void, Failure>
    if LaunchConfig.shared.isolated, let source = LaunchConfig.shared.instance(Self.sourceKey) {
      fetched = copyLocal(source, file: spec.file, to: archive)
    } else {
      fetched = download(name, spec.url, to: archive, generation: mine)
    }
    if case .failure(let failure) = fetched {
      PluginPrograms.discard(scratch)
      return fail(name, failure)
    }
    guard isCurrent(name, mine) else {
      PluginPrograms.discard(scratch)
      return fail(name, Failure(code: "cancelled", reason: "Cancelled."))
    }
    let expected = StoreExpectation(key: spec.key, id: spec.id, version: spec.version, sha256: spec.sha256)
    let published = PluginInstaller.verifyAndPublish(expected, archive: archive.path, scratch: scratch, store: store)
    PluginPrograms.discard(scratch)
    switch published {
    case .failure(let failure): fail(name, Failure(code: failure.code, reason: failure.reason, cause: failure.cause))
    case .success(let made): deliver(spec, copy: made.copy, text: made.manifest, store: store, reused: false)
    }
  }

  private func copyLocal(_ source: String, file: String, to archive: URL) -> Result<Void, Failure> {
    let folder = source.hasPrefix("file://") ? (URL(string: source)?.path ?? "") : source
    let path = (folder as NSString).appendingPathComponent(file)
    var info = stat()
    guard lstat(path, &info) == 0, (info.st_mode & S_IFMT) == S_IFREG else { return .failure(Failure(code: "offline", reason: "\(file) isn't in \(folder)", cause: .network)) }
    guard Int64(info.st_size) <= PluginArchive.maxDownload else { return .failure(Failure(code: "verify", reason: "\(file) is over \(PluginArchive.maxDownload >> 20) MB", cause: .mismatch)) }
    do {
      try FileManager.default.copyItem(at: URL(fileURLWithPath: path), to: archive)
      return .success(())
    } catch {
      return .failure(Failure(code: "failed", reason: "\(file) couldn't be copied (\(error.localizedDescription))", cause: FailureCause(file: error)))
    }
  }

  private func download(_ name: String, _ url: URL, to archive: URL, generation mine: Int) -> Result<Void, Failure> {
    let finished = DispatchSemaphore(value: 0)
    var outcome: Result<URL, Failure> = .failure(Failure(code: "failed", reason: "the download didn't finish"))
    var request = URLRequest(url: url)
    request.setValue("Ardia", forHTTPHeaderField: "User-Agent")
    let task = session.downloadTask(with: request)
    lock.lock()
    guard let key = running[name]?.key, running[name]?.generation == mine, !cancelled.contains(name) else {
      lock.unlock()
      return .failure(Failure(code: "cancelled", reason: "Cancelled."))
    }
    running[name] = Running(key: key, generation: mine, task: task, finish: { result in
      if case .success(let temporary) = result {
        do {
          try FileManager.default.moveItem(at: temporary, to: archive)
        } catch {
          outcome = .failure(Failure(code: "failed", reason: "the download couldn't be kept (\(error.localizedDescription))", cause: FailureCause(file: error)))
          finished.signal()
          return
        }
      }
      outcome = result
      finished.signal()
    })
    lock.unlock()
    task.taskDescription = name
    task.resume()
    if finished.wait(timeout: .now() + Self.deadline + 30) == .timedOut {
      task.cancel()
      return .failure(Failure(code: "offline", reason: "the download took too long", cause: .timeout))
    }
    return outcome.map { _ in () }
  }

  private func take(_ task: URLSessionTask) -> Running? {
    guard let name = task.taskDescription else { return nil }
    lock.lock()
    defer { lock.unlock() }
    guard let found = running[name], found.task === task else { return nil }
    return found
  }

  func urlSession(_ session: URLSession, downloadTask: URLSessionDownloadTask, didFinishDownloadingTo location: URL) {
    guard let found = take(downloadTask) else { return }
    if let response = downloadTask.response as? HTTPURLResponse, response.statusCode != 200 {
      return found.finish(.failure(Failure(code: "failed", reason: "the server answered \(response.statusCode)", cause: .server)))
    }
    let kept = location.deletingLastPathComponent().appendingPathComponent("ardia-plugin-\(UUID().uuidString)")
    do {
      try FileManager.default.moveItem(at: location, to: kept)
      found.finish(.success(kept))
    } catch {
      found.finish(.failure(Failure(code: "failed", reason: "the download couldn't be kept", cause: FailureCause(file: error))))
    }
  }

  func urlSession(_ session: URLSession, downloadTask: URLSessionDownloadTask, didWriteData bytesWritten: Int64, totalBytesWritten: Int64, totalBytesExpectedToWrite: Int64) {
    guard let identity = downloadTask.taskDescription else { return }
    if totalBytesWritten > PluginArchive.maxDownload || totalBytesExpectedToWrite > PluginArchive.maxDownload {
      downloadTask.cancel()
      return
    }
    lock.lock()
    let step = max(totalBytesExpectedToWrite / 50, 1 << 20)
    let due = running[identity].map { totalBytesWritten - $0.reported >= step } ?? false
    if due { running[identity]?.reported = totalBytesWritten }
    let name = running[identity]?.key ?? ""
    lock.unlock()
    if due, !name.isEmpty { PluginHost.shared.emit(Self.progressEvent, ["name": name, "received": totalBytesWritten, "total": max(totalBytesExpectedToWrite, 0)]) }
  }

  func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) {
    completionHandler(request.url?.scheme == "https" ? request : nil)
  }

  func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
    guard let error, let found = take(task) else { return }
    let code = FailureCause.urlCode(of: error)
    if code == .cancelled {
      let tooBig = task.countOfBytesReceived > PluginArchive.maxDownload || task.countOfBytesExpectedToReceive > PluginArchive.maxDownload
      return found.finish(.failure(tooBig ? Failure(code: "verify", reason: "the download is over \(PluginArchive.maxDownload >> 20) MB", cause: .mismatch) : Failure(code: "cancelled", reason: "Cancelled.")))
    }
    let offline = code.map { Self.offlineCodes.contains($0) } ?? false
    found.finish(.failure(Failure(code: offline ? "offline" : "failed", reason: error.localizedDescription, cause: FailureCause(transfer: error))))
  }
}
