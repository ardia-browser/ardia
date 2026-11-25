import ArdiaCore
import Foundation

final class OfficialPluginFetch: NSObject, URLSessionDownloadDelegate {
  static let shared = OfficialPluginFetch()
  static let idleTimeout: TimeInterval = 60
  static let deadline: TimeInterval = 900
  static let progressEvent = "onOfficialFetch"
  private static let offlineCodes: Set<URLError.Code> = [
    .notConnectedToInternet, .networkConnectionLost, .cannotFindHost, .cannotConnectToHost, .dnsLookupFailed, .timedOut, .internationalRoamingOff,
    .dataNotAllowed, .secureConnectionFailed,
  ]

  private struct Running {
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
  private let work = DispatchQueue(label: "ardia.official-plugins", qos: .userInitiated)
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
    running[name] = Running(generation: mine, task: nil, finish: { _ in })
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
    settle(name, ["ok": false, "code": failure.code, "reason": failure.reason, "cause": failure.cause.rawValue])
  }

  private func run(_ name: String, generation mine: Int) {
    guard let folders = PluginFolders.current() else { return fail(name, Failure(code: "failed", reason: "Ardia has no data folder", cause: .folder)) }
    guard let pin = PluginFolders.officialPin(), let entry = pin.entry(name) else {
      return fail(name, Failure(code: "unsupported", reason: "this Ardia doesn't pin an official \(name) plugin"))
    }
    let registry = folders.programRegistry(pin: pin)
    let store = folders.officialStore()
    if let copy = store.copy(name, sha: entry.sha256), let text = PluginFolders.manifestText(copy.path).text {
      return settle(name, ["ok": true, "candidate": PluginFolders.candidate(text, folderId: copy.folderId, version: entry.version), "reused": true])
    }
    guard let scratch = store.makeScratch(name, prefix: ".fetch-") else { return fail(name, Failure(code: "failed", reason: "its download folder couldn't be made", cause: .folder)) }
    let archive = URL(fileURLWithPath: (scratch as NSString).appendingPathComponent(entry.file))
    let fetched: Result<Void, Failure>
    if LaunchConfig.shared.isolated, let source = LaunchConfig.shared.instance(OfficialPin.sourceKey) {
      fetched = copyLocal(source, file: entry.file, to: archive)
    } else {
      fetched = download(name, entry.url, to: archive, generation: mine)
    }
    if case .failure(let failure) = fetched {
      PluginPrograms.discard(scratch)
      return fail(name, failure)
    }
    guard isCurrent(name, mine) else {
      PluginPrograms.discard(scratch)
      return fail(name, Failure(code: "cancelled", reason: "Cancelled."))
    }
    let published = OfficialInstaller.verifyAndPublish(entry, archive: archive.path, scratch: scratch, store: store, registry: registry)
    PluginPrograms.discard(scratch)
    switch published {
    case .failure(let failure): fail(name, Failure(code: failure.code, reason: failure.reason, cause: failure.cause))
    case .success(let made): settle(name, ["ok": true, "candidate": PluginFolders.candidate(made.manifest, folderId: made.copy.folderId, version: entry.version)])
    }
  }

  private func copyLocal(_ source: String, file: String, to archive: URL) -> Result<Void, Failure> {
    let folder = source.hasPrefix("file://") ? (URL(string: source)?.path ?? "") : source
    let path = (folder as NSString).appendingPathComponent(file)
    var info = stat()
    guard lstat(path, &info) == 0, (info.st_mode & S_IFMT) == S_IFREG else { return .failure(Failure(code: "offline", reason: "\(file) isn't in \(folder)", cause: .network)) }
    guard Int64(info.st_size) <= OfficialArchive.maxDownload else { return .failure(Failure(code: "verify", reason: "\(file) is over \(OfficialArchive.maxDownload >> 20) MB", cause: .mismatch)) }
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
    guard running[name]?.generation == mine, !cancelled.contains(name) else {
      lock.unlock()
      return .failure(Failure(code: "cancelled", reason: "Cancelled."))
    }
    running[name] = Running(generation: mine, task: task, finish: { result in
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

  static func promote(_ name: String, folderId: String, approved: String) -> [String: Any] {
    guard let folders = PluginFolders.current(), let pin = PluginFolders.officialPin() else { return ["ok": false, "reason": "It isn't an official plugin this Ardia pins."] }
    if let problem = OfficialInstaller.promote(name, folderId: folderId, approved: approved, store: folders.officialStore(), pin: pin) {
      return ["ok": false, "reason": problem]
    }
    return ["ok": true]
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
    let kept = location.deletingLastPathComponent().appendingPathComponent("ardia-official-\(UUID().uuidString)")
    do {
      try FileManager.default.moveItem(at: location, to: kept)
      found.finish(.success(kept))
    } catch {
      found.finish(.failure(Failure(code: "failed", reason: "the download couldn't be kept", cause: FailureCause(file: error))))
    }
  }

  func urlSession(_ session: URLSession, downloadTask: URLSessionDownloadTask, didWriteData bytesWritten: Int64, totalBytesWritten: Int64, totalBytesExpectedToWrite: Int64) {
    guard let name = downloadTask.taskDescription else { return }
    if totalBytesWritten > OfficialArchive.maxDownload || totalBytesExpectedToWrite > OfficialArchive.maxDownload {
      downloadTask.cancel()
      return
    }
    lock.lock()
    let step = max(totalBytesExpectedToWrite / 50, 1 << 20)
    let due = running[name].map { totalBytesWritten - $0.reported >= step } ?? false
    if due { running[name]?.reported = totalBytesWritten }
    lock.unlock()
    if due { PluginHost.shared.emit(Self.progressEvent, ["name": name, "received": totalBytesWritten, "total": max(totalBytesExpectedToWrite, 0)]) }
  }

  func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) {
    completionHandler(request.url?.scheme == "https" ? request : nil)
  }

  func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
    guard let error, let found = take(task) else { return }
    let code = FailureCause.urlCode(of: error)
    if code == .cancelled {
      let tooBig = task.countOfBytesReceived > OfficialArchive.maxDownload || task.countOfBytesExpectedToReceive > OfficialArchive.maxDownload
      return found.finish(.failure(tooBig ? Failure(code: "verify", reason: "the download is over \(OfficialArchive.maxDownload >> 20) MB", cause: .mismatch) : Failure(code: "cancelled", reason: "Cancelled.")))
    }
    let offline = code.map { Self.offlineCodes.contains($0) } ?? false
    found.finish(.failure(Failure(code: offline ? "offline" : "failed", reason: error.localizedDescription, cause: FailureCause(transfer: error))))
  }
}
