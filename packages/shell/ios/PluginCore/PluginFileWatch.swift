import CoreServices
import Foundation

final class PluginFileWatcher {
  static let coalescing: TimeInterval = 0.15

  let root: String
  private let queue: DispatchQueue
  private let onChange: ([String]) -> Void
  private let verify: () -> Bool
  private let onGone: () -> Void
  private let queueKey = DispatchSpecificKey<Bool>()
  private var stream: FSEventStreamRef?
  private var pending = Set<String>()
  private var flushScheduled = false
  private var stopped = false

  init(
    root: String, queue: DispatchQueue = DispatchQueue(label: "ardia.plugins.files.watch", qos: .utility), verify: @escaping () -> Bool = { true },
    onGone: @escaping () -> Void = {}, onChange: @escaping ([String]) -> Void
  ) {
    self.root = PluginFileStore.realPath(root) ?? root
    self.queue = queue
    self.verify = verify
    self.onGone = onGone
    self.onChange = onChange
    queue.setSpecific(key: queueKey, value: true)
  }

  static func verified(_ store: PluginFileStore, onGone: @escaping () -> Void, onChange: @escaping ([String]) -> Void) -> Result<PluginFileWatcher, PluginFileFailure> {
    let opened: PluginFileStore.OpenedRoot
    switch store.openRoot() {
    case .failure(let failure): return .failure(failure)
    case .success(let root): opened = root
    }
    var info = stat()
    guard fstat(opened.directory.fd, &info) == 0 else { return .failure(PluginFileFailure(.unavailable, "the folder couldn't be checked")) }
    let identity = PluginFileIdentity(info)
    let directory = opened.directory
    let verify = { () -> Bool in
      var held = stat()
      var named = stat()
      guard fstat(directory.fd, &held) == 0, lstat(opened.real, &named) == 0, (named.st_mode & S_IFMT) == S_IFDIR else { return false }
      return PluginFileIdentity(held) == identity && PluginFileIdentity(named) == identity && (store.identity ?? identity) == identity
    }
    return .success(PluginFileWatcher(root: opened.real, verify: verify, onGone: onGone, onChange: onChange))
  }

  deinit {
    if let stream {
      FSEventStreamStop(stream)
      FSEventStreamInvalidate(stream)
      FSEventStreamRelease(stream)
    }
  }

  func start() -> Bool {
    queue.sync {
      guard stream == nil, !stopped else { return stream != nil }
      var context = FSEventStreamContext(version: 0, info: Unmanaged.passUnretained(self).toOpaque(), retain: nil, release: nil, copyDescription: nil)
      let callback: FSEventStreamCallback = { _, info, count, paths, flags, _ in
        guard let info else { return }
        let watcher = Unmanaged<PluginFileWatcher>.fromOpaque(info).takeUnretainedValue()
        let list = (unsafeBitCast(paths, to: NSArray.self) as? [String]) ?? []
        let rootChanged = (0..<count).contains { flags[$0] & FSEventStreamEventFlags(kFSEventStreamEventFlagRootChanged) != 0 }
        watcher.received(list, rootChanged: rootChanged)
      }
      let flags = FSEventStreamCreateFlags(
        kFSEventStreamCreateFlagFileEvents | kFSEventStreamCreateFlagWatchRoot | kFSEventStreamCreateFlagNoDefer | kFSEventStreamCreateFlagUseCFTypes)
      guard
        let created = FSEventStreamCreate(nil, callback, &context, [root] as CFArray, FSEventStreamEventId(kFSEventStreamEventIdSinceNow), 0.05, flags)
      else { return false }
      FSEventStreamSetDispatchQueue(created, queue)
      guard FSEventStreamStart(created) else {
        FSEventStreamInvalidate(created)
        FSEventStreamRelease(created)
        return false
      }
      stream = created
      return true
    }
  }

  func stop() {
    if DispatchQueue.getSpecific(key: queueKey) == true { return halt() }
    queue.sync { halt() }
  }

  private func halt() {
    stopped = true
    pending = []
    guard let stream else { return }
    FSEventStreamStop(stream)
    FSEventStreamInvalidate(stream)
    FSEventStreamRelease(stream)
    self.stream = nil
  }

  private func stillTheRoot() -> Bool {
    guard !stopped else { return false }
    guard verify() else {
      halt()
      onGone()
      return false
    }
    return true
  }

  static func relative(_ path: String, to root: String) -> String? {
    let trimmed = path.hasSuffix("/") && path.count > 1 ? String(path.dropLast()) : path
    let base = root.hasSuffix("/") ? root : root + "/"
    guard trimmed.hasPrefix(base) else { return nil }
    var parts = trimmed.dropFirst(base.count).split(separator: "/", omittingEmptySubsequences: true).map(String.init)
    guard !parts.isEmpty, !parts.contains(where: PluginFileStore.isTemporary) else { return nil }
    let last = parts[parts.count - 1]
    if last.hasPrefix("."), last.hasSuffix(PluginFileStore.placeholderSuffix), last.count > PluginFileStore.placeholderSuffix.count + 1 {
      let real = String(last.dropFirst().dropLast(PluginFileStore.placeholderSuffix.count))
      guard !PluginFileStore.isTemporary(real) else { return nil }
      parts[parts.count - 1] = real
    }
    return parts.joined(separator: "/")
  }

  private func received(_ paths: [String], rootChanged: Bool) {
    guard stillTheRoot() else { return }
    var added = false
    if rootChanged {
      pending.insert("")
      added = true
    }
    for path in paths {
      guard let relative = Self.relative(path, to: root) else { continue }
      pending.insert(relative)
      added = true
    }
    guard added, !flushScheduled else { return }
    flushScheduled = true
    queue.asyncAfter(deadline: .now() + Self.coalescing) { [weak self] in self?.flush() }
  }

  private func flush() {
    flushScheduled = false
    guard !pending.isEmpty, stillTheRoot() else { return }
    let paths = pending.sorted()
    pending = []
    onChange(paths)
  }
}
