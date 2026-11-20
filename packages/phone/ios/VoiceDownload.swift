import AppleArchive
import CryptoKit
import Foundation
import System

enum VoiceDownload {
  static let url = URL(string: "https://github.com/ardia-browser/ardia-voices/releases/download/phonon-31m-en-v0.7.1/phonon-31m-en.aar")!
  static let bytes = 132_936_282
  static let sha256 = "f72408f24f92dd92682819709aaca0d525d5f2fcea26243be90063e9d9df6579"

  enum Problem: Error {
    case status(Int)
    case wrongSize(Int)
    case wrongHash
    case unreadable
    case noModels
  }

  static let folderName = "TalkToMe"
  static let markerName = "voice.sha256"
  static let incomingPrefix = "TalkToMe-incoming-"

  static var support: URL {
    FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
  }

  static var folder: URL {
    support.appending(path: folderName, directoryHint: .isDirectory)
  }

  static func installed() -> URL? {
    let folder = folder
    guard FileManager.default.fileExists(atPath: folder.appending(path: "bundle.json").path),
          let marker = try? String(contentsOf: folder.appending(path: markerName), encoding: .utf8),
          marker.trimmingCharacters(in: .whitespacesAndNewlines) == sha256 else { return nil }
    return folder
  }

  static func removeOutdated() {
    guard installed() == nil, FileManager.default.fileExists(atPath: folder.path) else { return }
    try? FileManager.default.removeItem(at: folder)
  }

  static func remove() {
    try? FileManager.default.removeItem(at: folder)
    removeIncoming()
  }

  static func removeIncoming() {
    let names = (try? FileManager.default.contentsOfDirectory(atPath: support.path)) ?? []
    for name in names where name.hasPrefix(incomingPrefix) {
      try? FileManager.default.removeItem(at: support.appending(path: name, directoryHint: .isDirectory))
    }
  }

  static func fetch(progress: @escaping @Sendable (Double) -> Void) async throws {
    let incoming = support.appending(path: incomingPrefix + UUID().uuidString, directoryHint: .isDirectory)
    removeIncoming()
    try FileManager.default.createDirectory(at: incoming, withIntermediateDirectories: true)
    try excludeFromBackup(incoming)
    defer { try? FileManager.default.removeItem(at: incoming) }
    let archive = incoming.appending(path: url.lastPathComponent)
    try await VoiceTransfer(destination: archive, progress: progress).run(url)
    let work = Task.detached(priority: .userInitiated) { try install(archive, in: incoming) }
    try await withTaskCancellationHandler { try await work.value } onCancel: { work.cancel() }
  }

  static func install(_ archive: URL, in incoming: URL) throws {
    do {
      try verify(archive)
    } catch {
      try? FileManager.default.removeItem(at: archive)
      throw error
    }
    try Task.checkCancellation()
    let unpacked = incoming.appending(path: "unpacked", directoryHint: .isDirectory)
    try FileManager.default.createDirectory(at: unpacked, withIntermediateDirectories: true)
    try extract(archive, to: unpacked)
    try? FileManager.default.removeItem(at: archive)
    let staged = unpacked.appending(path: folderName, directoryHint: .isDirectory)
    guard FileManager.default.fileExists(atPath: staged.appending(path: "bundle.json").path) else { throw Problem.noModels }
    try Data(sha256.utf8).write(to: staged.appending(path: markerName))
    try Task.checkCancellation()
    if FileManager.default.fileExists(atPath: folder.path) {
      _ = try FileManager.default.replaceItemAt(folder, withItemAt: staged)
    } else {
      try FileManager.default.moveItem(at: staged, to: folder)
    }
    if Task.isCancelled {
      try? FileManager.default.removeItem(at: folder)
      throw CancellationError()
    }
    try excludeFromBackup(folder)
  }

  static func verify(_ archive: URL) throws {
    let size = (try? archive.resourceValues(forKeys: [.fileSizeKey]))?.fileSize ?? -1
    guard size == bytes else { throw Problem.wrongSize(size) }
    let handle = try FileHandle(forReadingFrom: archive)
    defer { try? handle.close() }
    var hash = SHA256()
    while let chunk = try handle.read(upToCount: 4 << 20), !chunk.isEmpty {
      try Task.checkCancellation()
      hash.update(data: chunk)
    }
    let digest = hash.finalize().map { String(format: "%02x", $0) }.joined()
    guard digest == sha256 else { throw Problem.wrongHash }
  }

  static func extract(_ archive: URL, to destination: URL) throws {
    guard let file = ArchiveByteStream.fileStream(path: FilePath(archive.path), mode: .readOnly, options: [], permissions: FilePermissions(rawValue: 0o644)) else { throw Problem.unreadable }
    defer { try? file.close() }
    guard let decompressed = ArchiveByteStream.decompressionStream(readingFrom: file) else { throw Problem.unreadable }
    defer { try? decompressed.close() }
    guard let decoded = ArchiveStream.decodeStream(readingFrom: decompressed) else { throw Problem.unreadable }
    defer { try? decoded.close() }
    guard let extracted = ArchiveStream.extractStream(extractingTo: FilePath(destination.path), flags: [.ignoreOperationNotPermitted]) else { throw Problem.unreadable }
    _ = try ArchiveStream.process(readingFrom: decoded, writingTo: extracted)
    try extracted.close()
  }

  static func excludeFromBackup(_ url: URL) throws {
    var url = url
    var values = URLResourceValues()
    values.isExcludedFromBackup = true
    try url.setResourceValues(values)
  }
}

final class VoiceTransfer: NSObject, URLSessionDownloadDelegate, @unchecked Sendable {
  private let destination: URL
  private let progress: @Sendable (Double) -> Void
  private let lock = NSLock()
  private var continuation: CheckedContinuation<Void, Error>?
  private var moved: Result<Void, Error>?
  private var reported = -1.0

  init(destination: URL, progress: @escaping @Sendable (Double) -> Void) {
    self.destination = destination
    self.progress = progress
  }

  func run(_ url: URL) async throws {
    let configuration = URLSessionConfiguration.default
    configuration.requestCachePolicy = .reloadIgnoringLocalCacheData
    configuration.urlCache = nil
    let session = URLSession(configuration: configuration, delegate: self, delegateQueue: nil)
    let task = session.downloadTask(with: url)
    try await withTaskCancellationHandler {
      try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
        lock.withLock { self.continuation = continuation }
        task.resume()
        if Task.isCancelled { task.cancel() }
      }
    } onCancel: {
      task.cancel()
    }
  }

  func urlSession(_ session: URLSession, downloadTask: URLSessionDownloadTask, didWriteData bytesWritten: Int64, totalBytesWritten: Int64, totalBytesExpectedToWrite: Int64) {
    let total = totalBytesExpectedToWrite > 0 ? Double(totalBytesExpectedToWrite) : Double(VoiceDownload.bytes)
    let fraction = min(1, Double(totalBytesWritten) / total)
    let report = lock.withLock {
      guard fraction - reported >= 0.005 || fraction == 1 else { return false }
      reported = fraction
      return true
    }
    if report { progress(fraction) }
  }

  func urlSession(_ session: URLSession, downloadTask: URLSessionDownloadTask, didFinishDownloadingTo location: URL) {
    let result = Result<Void, Error> {
      if let status = (downloadTask.response as? HTTPURLResponse)?.statusCode, !(200..<300).contains(status) { throw VoiceDownload.Problem.status(status) }
      try? FileManager.default.removeItem(at: destination)
      try FileManager.default.moveItem(at: location, to: destination)
    }
    lock.withLock { moved = result }
  }

  func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
    session.finishTasksAndInvalidate()
    let (continuation, moved) = lock.withLock {
      defer { self.continuation = nil }
      return (self.continuation, self.moved)
    }
    if let error {
      continuation?.resume(throwing: error)
    } else {
      continuation?.resume(with: moved ?? .failure(VoiceDownload.Problem.unreadable))
    }
  }
}
