import AppKit
import ArdiaCore
import Carbon.HIToolbox
import ExpoModulesCore

enum DocumentStore {
  typealias Done = (Error?) -> Void
  private struct Staged {
    let url: URL
    let generation: UInt64
    let contents: String
    var waiters: [Done]
  }

  private static let queue = DispatchQueue(label: "ardia.documents", qos: .utility)
  private static let lock = NSLock()
  private static var staged: [String: Staged] = [:]
  private static var generation: UInt64 = 0
  private static var closed = false
  private static let flushOnQuit = NotificationCenter.default.addObserver(
    forName: NSApplication.willTerminateNotification, object: nil, queue: nil
  ) { _ in flush() }

  static func url(_ name: String) throws -> URL {
    let dir: URL
    if let custom = LaunchConfig.shared.dataDirectory {
      dir = URL(fileURLWithPath: custom, isDirectory: true)
    } else {
      let base = try FileManager.default.url(for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: true)
      dir = base.appendingPathComponent(Bundle.main.bundleIdentifier ?? "Ardia", isDirectory: true)
    }
    try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    return dir.appendingPathComponent((name as NSString).lastPathComponent)
  }

  static func read(_ name: String) -> String? {
    guard let url = try? url(name) else { return nil }
    lock.lock()
    let pending = staged[url.lastPathComponent]?.contents
    lock.unlock()
    return pending ?? (try? String(contentsOf: url, encoding: .utf8))
  }

  static func exists(_ name: String) -> Bool {
    guard let url = try? url(name) else { return true }
    lock.lock()
    let pending = staged[url.lastPathComponent] != nil
    lock.unlock()
    return pending || !confirmedMissing(url)
  }

  private static func confirmedMissing(_ url: URL) -> Bool {
    var info = stat()
    if lstat(url.path, &info) == 0 { return false }
    guard errno == ENOENT else { return false }
    var parent = stat()
    return stat(url.deletingLastPathComponent().path, &parent) == 0 && (parent.st_mode & S_IFMT) == S_IFDIR
  }

  private static func durable(_ path: String) -> Bool {
    let fd = open(path, O_RDONLY)
    guard fd >= 0 else { return false }
    defer { Darwin.close(fd) }
    if fcntl(fd, F_FULLFSYNC) == 0 { return true }
    let unsupported = errno == ENOTSUP || errno == EINVAL
    return unsupported && fsync(fd) == 0
  }

  struct DocumentGone: Error {}

  static func sync(_ name: String, done: @escaping Done) throws {
    let target = try url(name)
    queue.async {
      if confirmedMissing(target) { return done(DocumentGone()) }
      done(regularFile(target) && durable(target.path) && durable(target.deletingLastPathComponent().path) ? nil : CocoaError(.fileWriteUnknown))
    }
  }

  private static func regularFile(_ url: URL) -> Bool {
    var info = stat()
    return lstat(url.path, &info) == 0 && (info.st_mode & S_IFMT) == S_IFREG
  }

  static func write(_ name: String, _ contents: String, done: Done? = nil) throws {
    _ = flushOnQuit
    let url = try url(name)
    let key = url.lastPathComponent
    lock.lock()
    if closed {
      lock.unlock()
      done?(CocoaError(.fileWriteNoPermission))
      return
    }
    generation += 1
    let mine = generation
    staged[key] = Staged(url: url, generation: mine, contents: contents, waiters: (staged[key]?.waiters ?? []) + (done.map { [$0] } ?? []))
    lock.unlock()
    queue.async { land(key, mine, attempt: 0) }
  }

  static func whenSaved(_ name: String, done: @escaping Done) throws {
    let key = try url(name).lastPathComponent
    lock.lock()
    guard staged[key] != nil else {
      lock.unlock()
      return done(nil)
    }
    staged[key]!.waiters.append(done)
    lock.unlock()
  }

  static func remove(_ name: String) throws {
    let url = try url(name)
    lock.lock()
    if closed { return lock.unlock() }
    generation += 1
    let waiters = staged.removeValue(forKey: url.lastPathComponent)?.waiters ?? []
    lock.unlock()
    queue.async {
      if regularFile(url) { unlink(url.path) }
      for waiter in waiters { waiter(nil) }
    }
  }

  static func list(_ prefix: String) -> [String] {
    guard let directory = try? url(prefix.isEmpty ? "documents" : prefix).deletingLastPathComponent() else { return [] }
    let stored = (try? FileManager.default.contentsOfDirectory(atPath: directory.path)) ?? []
    return stored.filter { $0.hasPrefix(prefix) && !$0.hasPrefix(".") && regularFile(directory.appendingPathComponent($0)) }.sorted()
  }

  static func create(_ name: String, _ contents: String, done: @escaping Done) throws {
    let target = try url(name)
    queue.async {
      let temporary = target.deletingLastPathComponent().appendingPathComponent(".\(target.lastPathComponent).\(UUID().uuidString).tmp")
      do {
        try Data(contents.utf8).write(to: temporary, options: [.withoutOverwriting])
      } catch {
        try? FileManager.default.removeItem(at: temporary)
        return done(error)
      }
      guard durable(temporary.path) else {
        unlink(temporary.path)
        return done(CocoaError(.fileWriteUnknown))
      }
      let linked = link(temporary.path, target.path) == 0
      let failure = errno
      unlink(temporary.path)
      guard linked else { return done(CocoaError(failure == EEXIST ? .fileWriteFileExists : .fileWriteUnknown)) }
      done(durable(target.deletingLastPathComponent().path) ? nil : CocoaError(.fileWriteUnknown))
    }
  }

  static func copy(_ name: String, to copyName: String, done: @escaping Done) throws {
    let source = try url(name)
    let target = try url(copyName)
    queue.async {
      if confirmedMissing(source) { return done(DocumentGone()) }
      do {
        let staging = target.deletingLastPathComponent().appendingPathComponent(".\(target.lastPathComponent).\(UUID().uuidString).tmp")
        try FileManager.default.copyItem(at: source, to: staging)
        guard durable(staging.path) else {
          try? FileManager.default.removeItem(at: staging)
          throw CocoaError(.fileWriteUnknown)
        }
        do {
          if FileManager.default.fileExists(atPath: target.path) {
            _ = try FileManager.default.replaceItemAt(target, withItemAt: staging)
          } else {
            try FileManager.default.moveItem(at: staging, to: target)
          }
        } catch {
          try? FileManager.default.removeItem(at: staging)
          throw error
        }
        guard durable(target.deletingLastPathComponent().path) else { throw CocoaError(.fileWriteUnknown) }
        done(nil)
      } catch {
        done(error)
      }
    }
  }

  private static func land(_ key: String, _ generation: UInt64, attempt: Int) {
    lock.lock()
    guard let save = staged[key], save.generation == generation else { return lock.unlock() }
    lock.unlock()
    var failure: Error?
    do {
      try save.contents.write(to: save.url, atomically: true, encoding: .utf8)
    } catch {
      failure = error
    }
    lock.lock()
    var waiters: [Done] = []
    if staged[key]?.generation == generation {
      waiters = staged[key]!.waiters
      if failure == nil { staged[key] = nil } else { staged[key]!.waiters = [] }
    }
    lock.unlock()
    for waiter in waiters { waiter(failure) }
    guard let failure else { return }
    NSLog("Ardia: saving \(key) failed (try \(attempt + 1)): \(failure.localizedDescription)")
    let delay = min(60.0, 2.0 * pow(2.0, Double(min(attempt, 5))))
    queue.asyncAfter(deadline: .now() + delay) { land(key, generation, attempt: attempt + 1) }
  }

  static func close() {
    lock.lock()
    closed = true
    lock.unlock()
  }

  static func writeDurablySync(_ name: String, _ contents: String, allowWhenClosed: Bool = false) -> Bool {
    guard let target = try? url(name) else { return false }
    let key = target.lastPathComponent
    return queue.sync {
      lock.lock()
      if closed && !allowWhenClosed {
        lock.unlock()
        return false
      }
      generation += 1
      let waiters = staged.removeValue(forKey: key)?.waiters ?? []
      lock.unlock()
      let staging = target.deletingLastPathComponent().appendingPathComponent(".\(key).\(UUID().uuidString).tmp")
      var failure: Error?
      do {
        try Data(contents.utf8).write(to: staging, options: [.withoutOverwriting])
        guard durable(staging.path) else {
          try? FileManager.default.removeItem(at: staging)
          throw CocoaError(.fileWriteUnknown)
        }
        do {
          if FileManager.default.fileExists(atPath: target.path) {
            _ = try FileManager.default.replaceItemAt(target, withItemAt: staging)
          } else {
            try FileManager.default.moveItem(at: staging, to: target)
          }
        } catch {
          try? FileManager.default.removeItem(at: staging)
          throw error
        }
        guard durable(target.deletingLastPathComponent().path) else { throw CocoaError(.fileWriteUnknown) }
      } catch {
        failure = error
      }
      for waiter in waiters { waiter(failure) }
      return failure == nil
    }
  }

  static func removeSync(_ name: String, allowWhenClosed: Bool = false) {
    guard let target = try? url(name) else { return }
    let key = target.lastPathComponent
    queue.sync {
      lock.lock()
      if closed && !allowWhenClosed { return lock.unlock() }
      generation += 1
      let waiters = staged.removeValue(forKey: key)?.waiters ?? []
      lock.unlock()
      if regularFile(target) {
        unlink(target.path)
        _ = durable(target.deletingLastPathComponent().path)
      }
      for waiter in waiters { waiter(nil) }
    }
  }

  @discardableResult
  static func flush() -> Bool {
    queue.sync {
      lock.lock()
      let keys = Array(staged.keys)
      lock.unlock()
      for key in keys {
        lock.lock()
        let generation = staged[key]?.generation
        lock.unlock()
        if let generation { land(key, generation, attempt: 99) }
      }
    }
    lock.lock()
    defer { lock.unlock() }
    return staged.isEmpty
  }
}
