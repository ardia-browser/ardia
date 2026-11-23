import Foundation

final class OfficialDownload: NSObject, URLSessionDownloadDelegate {
  struct Failure: Error, Equatable {
    let code: String
    let reason: String
  }

  struct Fetched: Equatable {
    let bytes: Int64
    let resumes: Int
  }

  static let offlineCodes: Set<URLError.Code> = [
    .notConnectedToInternet, .networkConnectionLost, .cannotFindHost, .cannotConnectToHost, .dnsLookupFailed, .timedOut, .internationalRoamingOff,
    .dataNotAllowed, .secureConnectionFailed,
  ]
  static let resumeWaits: [TimeInterval] = [1, 2, 4]
  static let cancelPoll: TimeInterval = 0.1

  enum Ending {
    case downloaded(URL, resumed: Bool)
    case failed(Failure, resumeData: Data?, received: Int64)
  }

  private struct Attempt {
    let key: String
    let resumed: Bool
    var reported: Int64
    let finish: (Ending) -> Void
  }

  private let lock = NSLock()
  private var attempts: [Int: Attempt] = [:]
  private let progress: (String, Int64, Int64) -> Void
  private let configuration: URLSessionConfiguration
  private let maxBytes: Int64
  private lazy var session = URLSession(configuration: configuration, delegate: self, delegateQueue: nil)

  init(idleTimeout: TimeInterval, deadline: TimeInterval, maxBytes: Int64 = OfficialArchive.maxDownload, progress: @escaping (String, Int64, Int64) -> Void) {
    let configuration = URLSessionConfiguration.ephemeral
    configuration.timeoutIntervalForRequest = idleTimeout
    configuration.timeoutIntervalForResource = deadline
    configuration.httpCookieStorage = nil
    configuration.urlCache = nil
    configuration.requestCachePolicy = .reloadIgnoringLocalCacheData
    configuration.waitsForConnectivity = false
    self.configuration = configuration
    self.maxBytes = maxBytes
    self.progress = progress
  }

  static func shouldResume(_ failure: Failure, resumeData: Data?, received: Int64) -> Bool {
    failure.code == "offline" && (resumeData != nil || received > 0)
  }

  func fetch(
    _ key: String, from url: URL, to archive: URL, deadline: TimeInterval, waits: [TimeInterval] = resumeWaits, isCancelled: @escaping () -> Bool,
    started: @escaping (URLSessionDownloadTask) -> Bool
  ) -> Result<Fetched, Failure> {
    let giveUp = DispatchTime.now() + deadline
    var resumeData: Data?
    var resumes = 0
    var retries = waits.makeIterator()
    while true {
      var request = URLRequest(url: url)
      request.setValue("Ardia", forHTTPHeaderField: "User-Agent")
      let task = resumeData.map { session.downloadTask(withResumeData: $0) } ?? session.downloadTask(with: request)
      let ending = run(key, task: task, resumed: resumeData != nil, until: giveUp, started: started)
      switch ending {
      case .downloaded(let temporary, _):
        defer { try? FileManager.default.removeItem(at: temporary) }
        do {
          try FileManager.default.moveItem(at: temporary, to: archive)
        } catch {
          return .failure(Failure(code: "failed", reason: "the download couldn't be kept (\(error.localizedDescription))"))
        }
        var info = stat()
        let bytes = lstat(archive.path, &info) == 0 ? Int64(info.st_size) : 0
        return .success(Fetched(bytes: bytes, resumes: resumes))
      case .failed(let failure, let data, let received):
        guard !isCancelled() else { return .failure(Failure(code: "cancelled", reason: "Cancelled.")) }
        let wasResumed = resumeData != nil
        guard Self.shouldResume(failure, resumeData: data, received: received) || (wasResumed && failure.code == "failed"),
          let wait = retries.next(), DispatchTime.now() + wait < giveUp
        else { return .failure(failure) }
        guard pause(until: DispatchTime.now() + wait, giveUp: giveUp, isCancelled: isCancelled) else { return .failure(Failure(code: "cancelled", reason: "Cancelled.")) }
        resumeData = wasResumed && failure.code == "failed" ? nil : data
        if resumeData != nil { resumes += 1 }
      }
    }
  }

  private func pause(until wanted: DispatchTime, giveUp: DispatchTime, isCancelled: () -> Bool) -> Bool {
    let until = min(wanted, giveUp)
    while true {
      let now = DispatchTime.now()
      guard now < until else { break }
      if isCancelled() { return false }
      Thread.sleep(forTimeInterval: min(Self.cancelPoll, Double(until.uptimeNanoseconds - now.uptimeNanoseconds) / 1e9))
    }
    return !isCancelled()
  }

  private func run(_ key: String, task: URLSessionDownloadTask, resumed: Bool, until giveUp: DispatchTime, started: (URLSessionDownloadTask) -> Bool) -> Ending {
    let finished = DispatchSemaphore(value: 0)
    var ending = Ending.failed(Failure(code: "failed", reason: "the download didn't finish"), resumeData: nil, received: 0)
    lock.lock()
    attempts[task.taskIdentifier] = Attempt(key: key, resumed: resumed, reported: 0, finish: { result in
      ending = result
      finished.signal()
    })
    lock.unlock()
    guard started(task) else {
      lock.lock()
      attempts.removeValue(forKey: task.taskIdentifier)
      lock.unlock()
      return .failed(Failure(code: "cancelled", reason: "Cancelled."), resumeData: nil, received: 0)
    }
    task.taskDescription = key
    task.resume()
    if finished.wait(timeout: giveUp) == .timedOut {
      lock.lock()
      let stillRunning = attempts.removeValue(forKey: task.taskIdentifier) != nil
      lock.unlock()
      if stillRunning {
        task.cancel()
        return .failed(Failure(code: "offline", reason: "the download took too long"), resumeData: nil, received: 0)
      }
      finished.wait()
    }
    return ending
  }

  private func take(_ task: URLSessionTask) -> Attempt? {
    lock.lock()
    defer { lock.unlock() }
    return attempts.removeValue(forKey: task.taskIdentifier)
  }

  func urlSession(_ session: URLSession, downloadTask: URLSessionDownloadTask, didFinishDownloadingTo location: URL) {
    guard let found = take(downloadTask) else { return }
    let status = (downloadTask.response as? HTTPURLResponse)?.statusCode
    let accepted = status == 200 || (found.resumed && status == 206)
    if let status, !accepted {
      return found.finish(.failed(Failure(code: "failed", reason: "the server answered \(status)"), resumeData: nil, received: downloadTask.countOfBytesReceived))
    }
    let kept = location.deletingLastPathComponent().appendingPathComponent("ardia-official-\(UUID().uuidString)")
    do {
      try FileManager.default.moveItem(at: location, to: kept)
      found.finish(.downloaded(kept, resumed: found.resumed))
    } catch {
      found.finish(.failed(Failure(code: "failed", reason: "the download couldn't be kept"), resumeData: nil, received: 0))
    }
  }

  func urlSession(_ session: URLSession, downloadTask: URLSessionDownloadTask, didResumeAtOffset fileOffset: Int64, expectedTotalBytes: Int64) {
    report(downloadTask, received: fileOffset, total: expectedTotalBytes, force: true)
  }

  func urlSession(_ session: URLSession, downloadTask: URLSessionDownloadTask, didWriteData bytesWritten: Int64, totalBytesWritten: Int64, totalBytesExpectedToWrite: Int64) {
    report(downloadTask, received: totalBytesWritten, total: totalBytesExpectedToWrite, force: false)
  }

  private func report(_ downloadTask: URLSessionDownloadTask, received: Int64, total: Int64, force: Bool) {
    if received > maxBytes || total > maxBytes {
      downloadTask.cancel()
      return
    }
    lock.lock()
    let step = max(total / 50, 1 << 20)
    let key = attempts[downloadTask.taskIdentifier]?.key
    let due = attempts[downloadTask.taskIdentifier].map { force || received - $0.reported >= step } ?? false
    if due { attempts[downloadTask.taskIdentifier]?.reported = received }
    lock.unlock()
    if due, let key { progress(key, received, max(total, 0)) }
  }

  func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) {
    completionHandler(request.url?.scheme == "https" ? request : nil)
  }

  func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
    guard let error, let found = take(task) else { return }
    let urlError = error as? URLError
    let received = task.countOfBytesReceived
    if urlError?.code == .cancelled {
      let tooBig = received > maxBytes || task.countOfBytesExpectedToReceive > maxBytes
      return found.finish(.failed(tooBig ? Failure(code: "verify", reason: "the download is over \(maxBytes >> 20) MB") : Failure(code: "cancelled", reason: "Cancelled."), resumeData: nil, received: received))
    }
    let offline = urlError.map { Self.offlineCodes.contains($0.code) } ?? false
    let resumeData = (error as NSError).userInfo[NSURLSessionDownloadTaskResumeData] as? Data
    found.finish(.failed(Failure(code: offline ? "offline" : "failed", reason: error.localizedDescription), resumeData: resumeData, received: received))
  }
}
