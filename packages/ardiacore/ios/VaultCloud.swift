import Foundation

enum VaultCloudOutcome: String, Sendable {
  case off
  case pending
  case waitingForKey
  case failed
  case needsUpdate
  case done
}

final class VaultCloud: NSObject, NSFilePresenter, @unchecked Sendable {
  static let shared = VaultCloud()
  private static let settleDelay: TimeInterval = 1.5
  private static let pushDelay: TimeInterval = 2
  private static let largestFile = 64 * 1024 * 1024
  private static let largestMarker = 4096
  private static let mostConflicts = 8
  private static let markerContext = "marker/deleted"
  private static let deletedMarker = ".ardia-backup-deleted"

  private static func readCapped(_ url: URL, limit: Int = largestFile) -> Data? {
    guard let size = (try? url.resourceValues(forKeys: [.fileSizeKey]))?.fileSize, size <= limit else { return nil }
    return try? Data(contentsOf: url)
  }

  let presentedItemOperationQueue: OperationQueue = {
    let queue = OperationQueue()
    queue.maxConcurrentOperationCount = 1
    queue.qualityOfService = .utility
    queue.name = "ardia.vaults.icloud.presenter"
    return queue
  }()

  private static let io = DispatchQueue(label: "ardia.vaults.icloud.io", qos: .utility)

  static func perform<T: Sendable>(_ body: @escaping @Sendable () -> T) async -> T {
    await withCheckedContinuation { done in io.async { done.resume(returning: body()) } }
  }

  private struct Batch {
    var names: Set<String> = []
    var flush: DispatchWorkItem?
  }

  private let lock = NSLock()
  private let work = DispatchQueue(label: "ardia.vaults.icloud", qos: .utility)
  private var enabled = false
  private var watched: URL?
  private var cloudChanges = Batch()
  private var localChanges = Batch()
  private var lastProblem: [String: String] = [:]

  private var identityWatch: NSObjectProtocol?

  override init() {
    super.init()
    identityWatch = NotificationCenter.default.addObserver(forName: .NSUbiquityIdentityDidChange, object: nil, queue: nil) { [weak self] _ in
      self?.identityChanged()
    }
  }

  private func identityChanged() {
    work.async {
      VaultStoreKey.refresh()
      let on = self.isEnabled
      self.present(on ? Self.driveFolder : nil)
      if on, self.folder != nil { self.schedule(Self.knownNames(), fromHere: false) }
      Task { await ArdiaVaultBackup.shared.cloudChanged(fromHere: false) }
    }
  }

  var presentedItemURL: URL? { lock.withLock { watched } }

  private var isEnabled: Bool { lock.withLock { enabled } }

  static var driveFolder: URL? {
    if let chosen = LaunchConfig.shared.testValue("vaultCloudDirectory"), !chosen.isEmpty {
      return URL(fileURLWithPath: chosen, isDirectory: true)
    }
    guard !LaunchConfig.shared.background, VaultStoreKey.syncs, FileManager.default.ubiquityIdentityToken != nil else { return nil }
    let drive = FileManager.default.homeDirectoryForCurrentUser
      .appendingPathComponent("Library/Mobile Documents/com~apple~CloudDocs", isDirectory: true)
    var isDirectory: ObjCBool = false
    guard FileManager.default.fileExists(atPath: drive.path, isDirectory: &isDirectory), isDirectory.boolValue else { return nil }
    return drive.appendingPathComponent("Ardia", isDirectory: true).appendingPathComponent("Password Managers", isDirectory: true)
  }

  static func folderHasVaultFiles() -> Bool {
    guard let folder = driveFolder else { return false }
    let names = (try? FileManager.default.contentsOfDirectory(atPath: folder.path)) ?? []
    return VaultCloudFiles.holdsSealedFiles(names) { file in
      let url = folder.appendingPathComponent(file)
      let status = (try? url.resourceValues(forKeys: [.ubiquitousItemDownloadingStatusKey]))?.ubiquitousItemDownloadingStatus
      if let status, status != .current { return nil }
      guard let handle = try? FileHandle(forReadingFrom: url) else { return nil }
      defer { try? handle.close() }
      return try? handle.read(upToCount: VaultSealed.shortestSealed)
    }
  }

  var folder: URL? {
    guard isEnabled, let drive = Self.driveFolder else { return nil }
    return Self.markerHolds(in: drive) ? nil : drive
  }

  private static func markerHolds(in drive: URL) -> Bool {
    let marker = drive.appendingPathComponent(deletedMarker)
    guard FileManager.default.fileExists(atPath: marker.path), let sealed = readCapped(marker, limit: largestMarker) else { return false }
    return VaultSealed.open(sealed, keys: VaultStoreKey.candidates(), context: markerContext).plain != nil
  }

  var isOn: Bool { folder != nil }

  var isDeletedEverywhere: Bool {
    guard isEnabled, let drive = Self.driveFolder else { return false }
    return Self.markerHolds(in: drive)
  }

  func deleteEverywhere() -> Bool {
    guard isEnabled, let drive = Self.driveFolder, VaultStoreKey.cloudReady, let key = VaultStoreKey.current(creating: false),
      let body = try? JSONSerialization.data(withJSONObject: ["deletedAt": Date().timeIntervalSince1970]),
      let sealed = VaultSealed.seal(body, with: key, context: Self.markerContext)
    else { return false }
    let marker = drive.appendingPathComponent(Self.deletedMarker)
    var written = false
    var problem: NSError?
    NSFileCoordinator(filePresenter: self).coordinate(writingItemAt: marker, options: [.forReplacing], error: &problem) { target in
      written = (try? sealed.write(to: target, options: [.atomic])) != nil
    }
    guard written, problem == nil else { return false }
    removeOurFiles(in: drive)
    return true
  }

  func resume() {
    guard let drive = Self.driveFolder else { return }
    let marker = drive.appendingPathComponent(Self.deletedMarker)
    guard FileManager.default.fileExists(atPath: marker.path) else { return }
    coordinatedDelete(marker)
    schedule(Self.knownNames(), fromHere: false)
    Task { await ArdiaVaultBackup.shared.cloudSettingChanged(on: true) }
  }

  func setEnabled(_ on: Bool) {
    let changed = lock.withLock {
      defer { enabled = on }
      return enabled != on
    }
    work.async {
      self.present(on ? Self.driveFolder : nil)
      if changed, on { self.schedule(Self.knownNames(), fromHere: false) }
      if changed { Task { await ArdiaVaultBackup.shared.cloudSettingChanged(on: on) } }
    }
  }

  private static func knownNames() -> Set<String> { Set(VaultRegistry.providers.map(\.id) + [ArdiaVault.id]) }

  private func present(_ folder: URL?) {
    let current = lock.withLock { watched }
    guard current?.standardizedFileURL != folder?.standardizedFileURL else { return }
    if current != nil { NSFileCoordinator.removeFilePresenter(self) }
    if let folder { try? FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true) }
    lock.withLock { watched = folder }
    if folder != nil { NSFileCoordinator.addFilePresenter(self) }
  }

  func presentedSubitemDidChange(at url: URL) { noteRemoteFile(url) }

  func presentedSubitemDidAppear(at url: URL) { noteRemoteFile(url) }

  func presentedSubitem(at oldURL: URL, didMoveTo newURL: URL) { noteRemoteFile(newURL) }

  func accommodatePresentedSubitemDeletion(at url: URL, completionHandler: @escaping (Error?) -> Void) { completionHandler(nil) }

  private func noteRemoteFile(_ url: URL) {
    if url.lastPathComponent == Self.deletedMarker {
      Task { await ArdiaVaultBackup.shared.cloudChanged(fromHere: false) }
      return
    }
    guard let name = VaultCloudFiles.name(ofFile: url.lastPathComponent) else { return }
    schedule([name], fromHere: false)
  }

  func noteLocalChange(_ name: String) {
    guard isOn else { return }
    schedule([name], fromHere: true)
  }

  private func withBatch<T>(fromHere: Bool, _ body: (inout Batch) -> T) -> T {
    lock.withLock { fromHere ? body(&localChanges) : body(&cloudChanges) }
  }

  private func schedule(_ names: Set<String>, fromHere: Bool) {
    let flush = DispatchWorkItem { [weak self] in self?.flush(fromHere: fromHere) }
    withBatch(fromHere: fromHere) { batch in
      batch.names.formUnion(names)
      batch.flush?.cancel()
      batch.flush = flush
    }
    work.asyncAfter(deadline: .now() + (fromHere ? Self.pushDelay : Self.settleDelay), execute: flush)
  }

  private func flush(fromHere: Bool) {
    let names = withBatch(fromHere: fromHere) { batch in
      defer { batch = Batch() }
      return batch.names
    }
    route(names, fromHere: fromHere)
  }

  private func route(_ names: Set<String>, fromHere: Bool) {
    guard isOn else { return }
    for name in names {
      if name == ArdiaVault.id {
        Task { await ArdiaVaultBackup.shared.cloudChanged(fromHere: fromHere) }
      } else if VaultRegistry.provider(name) != nil {
        Task { await VaultBroker.shared.cloudChanged(name, fromHere: fromHere) }
      }
    }
  }

  private struct Remote {
    var plains: [Data] = []
    var merged: [NSFileVersion] = []
    var unopened = 0
    var stamp: Date?
    var exists = false
    var damaged = false
    var sealedWithOldKey = false
  }

  private enum RemoteRead {
    case read(Remote)
    case newerFormat
    case pending
    case waitingForKey
    case failed
  }

  func reconcile(_ name: String, _ merge: ([Data]) -> VaultCloudMerge) -> VaultCloudOutcome {
    guard let folder else { return .off }
    VaultStoreKey.refresh()
    let url = folder.appendingPathComponent(name + VaultCloudFiles.suffix)
    for _ in 0..<2 {
      let remote: Remote
      switch read(url, name: name) {
      case .pending: return .pending
      case .newerFormat:
        VaultStoreCounts.note(\.cloudNewerFormatKept)
        note(name, "an iCloud copy was written by a newer Ardia, so this Mac leaves it alone")
        return .needsUpdate
      case .waitingForKey: return .waitingForKey
      case .failed: return .failed
      case .read(let found): remote = found
      }
      let plain: Data
      switch merge(remote.plains) {
      case .newerFormat:
        VaultStoreCounts.note(\.newerFormatKept)
        note(name, "the iCloud copy was written by a newer Ardia, so this Mac only reads it")
        return .needsUpdate
      case .keep:
        if !remote.merged.isEmpty, remote.exists { resolve(remote.merged, at: url) }
        guard VaultStoreKey.cloudReady else { return .waitingForKey }
        guard remote.sealedWithOldKey, let main = remote.plains.first else { return remote.unopened > 0 ? .waitingForKey : .done }
        plain = main
      case .push(let merged):
        plain = merged
      }
      guard VaultStoreKey.cloudReady, let key = VaultStoreKey.current(creating: false), let sealed = VaultSealed.seal(plain, with: key, context: VaultCache.storeContext(name)) else {
        return .waitingForKey
      }
      switch write(sealed, to: url, name: name, expecting: remote) {
      case .some(true): return remote.unopened > 0 ? .waitingForKey : .done
      case .some(false): return .failed
      case .none: continue
      }
    }
    return .pending
  }

  private func read(_ url: URL, name: String) -> RemoteRead {
    let manager = FileManager.default
    let placeholder = url.deletingLastPathComponent().appendingPathComponent(".\(url.lastPathComponent).icloud")
    let exists = manager.fileExists(atPath: url.path)
    if !exists {
      guard manager.fileExists(atPath: placeholder.path) else { return .read(Remote()) }
      try? manager.startDownloadingUbiquitousItem(at: url)
      return .pending
    }
    let status = (try? url.resourceValues(forKeys: [.ubiquitousItemDownloadingStatusKey]))?.ubiquitousItemDownloadingStatus
    if let status, status != .current {
      try? manager.startDownloadingUbiquitousItem(at: url)
      return .pending
    }
    var data: Data?
    var stamp: Date?
    var versions: [NSFileVersion] = []
    var problem: NSError?
    NSFileCoordinator(filePresenter: self).coordinate(readingItemAt: url, options: [.withoutChanges], error: &problem) { source in
      data = Self.readCapped(source)
      stamp = (try? source.resourceValues(forKeys: [.contentModificationDateKey]))?.contentModificationDate
      versions = Array((NSFileVersion.unresolvedConflictVersionsOfItem(at: source) ?? []).prefix(Self.mostConflicts))
    }
    if let problem {
      note(name, "couldn't read the iCloud copy: \(problem.localizedDescription)")
      return .failed
    }
    guard let data else {
      note(name, "couldn't read the iCloud copy")
      return .failed
    }
    var remote = Remote(stamp: stamp, exists: true)
    let keys = VaultStoreKey.candidates()
    let context = VaultCache.storeContext(name)
    switch VaultCloudFiles.classify(data, keys: keys, context: context) {
    case .opened(let plain, let current):
      remote.plains.append(plain)
      remote.sealedWithOldKey = !current
    case .unknownKey: return .waitingForKey
    case .newerFormat: return .newerFormat
    case .damaged: remote.damaged = true
    }
    for version in versions {
      guard let sealed = Self.readCapped(version.url) else {
        remote.unopened += 1
        continue
      }
      switch VaultCloudFiles.classify(sealed, keys: keys, context: context) {
      case .opened(let plain, _):
        remote.plains.append(plain)
        remote.merged.append(version)
      case .unknownKey:
        remote.unopened += 1
      case .newerFormat:
        return .newerFormat
      case .damaged:
        remote.merged.append(version)
      }
    }
    return .read(remote)
  }

  private func write(_ sealed: Data, to url: URL, name: String, expecting remote: Remote) -> Bool? {
    let manager = FileManager.default
    do {
      try manager.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
    } catch {
      note(name, "couldn't make the iCloud folder: \(error.localizedDescription)")
      return false
    }
    var outcome: Bool?
    var problem: NSError?
    NSFileCoordinator(filePresenter: self).coordinate(writingItemAt: url, options: [.forReplacing], error: &problem) { target in
      let exists = manager.fileExists(atPath: target.path)
      let stamp = exists ? (try? target.resourceValues(forKeys: [.contentModificationDateKey]))?.contentModificationDate : nil
      guard exists == remote.exists, stamp == remote.stamp else { return }
      do {
        if remote.damaged, exists {
          let damaged = target.deletingLastPathComponent().appendingPathComponent(target.lastPathComponent + ".damaged")
          try? manager.removeItem(at: damaged)
          try? manager.moveItem(at: target, to: damaged)
        }
        try sealed.write(to: target, options: [.atomic])
        outcome = true
      } catch {
        note(name, "couldn't write the iCloud copy: \(error.localizedDescription)")
        outcome = false
      }
    }
    if let problem {
      note(name, "couldn't reach iCloud Drive: \(problem.localizedDescription)")
      return false
    }
    if outcome == true {
      forget(name)
      if !remote.merged.isEmpty { resolve(remote.merged, at: url) }
    }
    return outcome
  }

  private func resolve(_ versions: [NSFileVersion], at url: URL) {
    var problem: NSError?
    NSFileCoordinator(filePresenter: self).coordinate(writingItemAt: url, options: [], error: &problem) { _ in
      for version in versions {
        version.isResolved = true
        try? version.remove()
      }
    }
  }

  func delete(_ name: String) {
    guard let folder else { return }
    work.async { self.coordinatedDelete(folder.appendingPathComponent(name + VaultCloudFiles.suffix)) }
  }

  private func coordinatedDelete(_ url: URL) {
    guard FileManager.default.fileExists(atPath: url.path) else { return }
    var problem: NSError?
    NSFileCoordinator(filePresenter: self).coordinate(writingItemAt: url, options: [.forDeleting], error: &problem) { target in
      try? FileManager.default.removeItem(at: target)
    }
  }

  private func removeOurFiles(in directory: URL) {
    let files = (try? FileManager.default.contentsOfDirectory(atPath: directory.path)) ?? []
    for file in files where file.hasSuffix(VaultCloudFiles.suffix) || file.hasSuffix(VaultCloudFiles.suffix + ".damaged") {
      coordinatedDelete(directory.appendingPathComponent(file))
    }
  }

  private func note(_ name: String, _ problem: String) {
    let repeated = lock.withLock {
      defer { lastProblem[name] = problem }
      return lastProblem[name] == problem
    }
    if !repeated { NSLog("[vaults] %@: %@", name, problem) }
  }

  private func forget(_ name: String) {
    lock.withLock { lastProblem[name] = nil }
  }
}
