import Darwin
import Foundation

final class PluginFileHandles {
  static let shared = PluginFileHandles()
  static let maxChunk = 512 * 1024
  static let maxHandles = 32
  static let maxSaveBytes = 64 << 20
  static let maxClosedRuns = 1024

  private final class Handle {
    let fd: Int32
    let size: Int
    let temporary: String?
    let destination: URL?
    var written = 0
    var inFlight = 0
    var closed = false
    var failed = false

    init(fd: Int32, size: Int, temporary: String? = nil, destination: URL? = nil) {
      self.fd = fd
      self.size = size
      self.temporary = temporary
      self.destination = destination
    }

    var writes: Bool { destination != nil }

    func release() {
      Darwin.close(fd)
      if let temporary { unlink(temporary) }
    }
  }

  private let lock = NSLock()
  private var handles: [String: Handle] = [:]
  private var closedRuns: [String] = []
  private var next = 0

  private static func runKey(_ name: String, _ run: Int) -> String { "\(name)#\(run)" }
  private static func runPrefix(_ name: String, _ run: Int) -> String { runKey(name, run) + "/" }

  private func add(_ name: String, _ run: Int, _ handle: Handle, live: () -> Bool) -> String? {
    lock.lock()
    let prefix = Self.runPrefix(name, run)
    guard !closedRuns.contains(Self.runKey(name, run)), live(), handles.keys.filter({ $0.hasPrefix(prefix) }).count < Self.maxHandles else {
      lock.unlock()
      handle.release()
      return nil
    }
    next += 1
    let id = "h\(next)"
    handles[prefix + id] = handle
    lock.unlock()
    return id
  }

  func addRead(_ name: String, _ run: Int, fd: Int32, size: Int, live: () -> Bool = { true }) -> String? {
    add(name, run, Handle(fd: fd, size: size), live: live)
  }

  func addWrite(_ name: String, _ run: Int, fd: Int32, temporary: String, destination: URL, live: () -> Bool = { true }) -> String? {
    add(name, run, Handle(fd: fd, size: 0, temporary: temporary, destination: destination), live: live)
  }

  func isClosed(_ name: String, _ run: Int) -> Bool {
    lock.lock()
    defer { lock.unlock() }
    return closedRuns.contains(Self.runKey(name, run))
  }

  func isOpen(_ name: String, _ run: Int, _ id: String) -> Bool {
    lock.lock()
    defer { lock.unlock() }
    return handles[Self.runPrefix(name, run) + id] != nil
  }

  private func begin(_ name: String, _ run: Int, _ id: String, writes: Bool) -> Handle? {
    lock.lock()
    defer { lock.unlock() }
    guard let handle = handles[Self.runPrefix(name, run) + id], !handle.closed, handle.writes == writes else { return nil }
    handle.inFlight += 1
    return handle
  }

  private func end(_ handle: Handle) {
    lock.lock()
    handle.inFlight -= 1
    let release = handle.closed && handle.inFlight == 0
    lock.unlock()
    if release { handle.release() }
  }

  func readChunk(_ name: String, _ run: Int, _ id: String, offset: Int, length: Int) -> [String: Any] {
    guard let handle = begin(name, run, id, writes: false) else { return ["ok": false, "reason": "that file isn't open"] }
    defer { end(handle) }
    let wanted = min(max(0, length), Self.maxChunk)
    guard offset >= 0, offset <= handle.size, let data = PluginBoundedFile.read(handle.fd, offset: offset, length: min(wanted, handle.size - offset)) else { return ["ok": false, "reason": "the file couldn't be read"] }
    return ["ok": true, "data": data.base64EncodedString(), "eof": offset + data.count >= handle.size]
  }

  func writeChunk(_ name: String, _ run: Int, _ id: String, data: Data) -> [String: Any] {
    guard let handle = begin(name, run, id, writes: true) else { return ["ok": false, "reason": "that file isn't open for saving"] }
    defer { end(handle) }
    lock.lock()
    let offset = handle.written
    let broken = handle.failed
    let room = !broken && data.count <= Self.maxChunk && offset + data.count <= Self.maxSaveBytes
    if room { handle.written = offset + data.count }
    lock.unlock()
    if broken { return ["ok": false, "reason": "an earlier part of the file couldn't be written, so it can't be saved"] }
    guard room else { return ["ok": false, "reason": "the file would be over \(Self.maxSaveBytes >> 20) MB"] }
    var done = 0
    while done < data.count {
      let step = data.withUnsafeBytes { pwrite(handle.fd, $0.baseAddress!.advanced(by: done), data.count - done, off_t(offset + done)) }
      if step < 0 && errno == EINTR { continue }
      if step <= 0 {
        lock.lock()
        handle.failed = true
        lock.unlock()
        return ["ok": false, "reason": "the file couldn't be written"]
      }
      done += step
    }
    return ["ok": true]
  }

  func finish(_ name: String, _ run: Int, _ id: String, commit: Bool) -> [String: Any] {
    let key = Self.runPrefix(name, run) + id
    lock.lock()
    guard let handle = handles[key] else {
      lock.unlock()
      return ["ok": false, "reason": "that file isn't open"]
    }
    if commit && handle.inFlight > 0 {
      lock.unlock()
      return ["ok": false, "reason": "the file is still being written"]
    }
    handles[key] = nil
    handle.closed = true
    let idle = handle.inFlight == 0
    let broken = handle.failed
    lock.unlock()
    guard let destination = handle.destination, let temporary = handle.temporary else {
      if idle { handle.release() }
      return ["ok": true]
    }
    guard commit else {
      if idle { handle.release() }
      return ["ok": true]
    }
    guard !broken else {
      handle.release()
      return ["ok": false, "reason": "part of the file couldn't be written, so it wasn't saved"]
    }
    let synced = fsync(handle.fd) == 0
    Darwin.close(handle.fd)
    guard synced, rename(temporary, destination.path) == 0 else {
      unlink(temporary)
      return ["ok": false, "reason": "the file couldn't be saved"]
    }
    return ["ok": true, "saved": true, "name": destination.lastPathComponent]
  }

  func discard(_ name: String, _ run: Int, _ ids: [String]) {
    for id in ids { _ = finish(name, run, id, commit: false) }
  }

  func closeAll(_ name: String, run: Int) {
    let prefix = run == 0 ? "\(name)#" : Self.runPrefix(name, run)
    lock.lock()
    if run != 0 {
      closedRuns.append(Self.runKey(name, run))
      if closedRuns.count > Self.maxClosedRuns { closedRuns.removeFirst(closedRuns.count - Self.maxClosedRuns) }
    }
    let closing = handles.filter { $0.key.hasPrefix(prefix) }.map(\.value)
    for key in handles.keys where key.hasPrefix(prefix) { handles[key] = nil }
    var idle: [Handle] = []
    for handle in closing {
      handle.closed = true
      if handle.inFlight == 0 { idle.append(handle) }
    }
    lock.unlock()
    idle.forEach { $0.release() }
  }

  func count(_ name: String, _ run: Int) -> Int {
    lock.lock()
    defer { lock.unlock() }
    return handles.keys.filter { $0.hasPrefix(Self.runPrefix(name, run)) }.count
  }
}
