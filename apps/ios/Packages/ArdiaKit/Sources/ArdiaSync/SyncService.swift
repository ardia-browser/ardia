@preconcurrency import ArdiaSyncCore
import Foundation
import Observation
#if canImport(UIKit)
import UIKit
#endif
#if os(iOS)
import BackgroundTasks
#endif

@MainActor
@Observable
public final class SyncService {
  public static let backgroundTaskIdentifier = "com.ardia.browser.ios.sync"
  public static let wordCount = RecoveryPhrase.wordCount

  public private(set) var phase: SyncPhase = .off
  public private(set) var snapshot: SyncSnapshot = .empty {
    didSet { settlePins() }
  }
  private var pinnedThisSession: Set<PinnedPage> = []
  public private(set) var pendingDownloads = 0
  public private(set) var lastSynced: Date?
  public private(set) var isEnabled = false
  public var isCycleRunning: Bool { running }
  public private(set) var folderName: String?
  public private(set) var nextcloudHost: String?
  public let isDemo: Bool

  public var usesNextcloud: Bool { nextcloudHost != nil }

  public var deviceName: String {
    didSet {
      guard deviceName != oldValue else { return }
      let trimmed = deviceName.trimmingCharacters(in: .whitespacesAndNewlines)
      meta.deviceName = trimmed.isEmpty ? SyncMeta.defaultDeviceName : trimmed
      saveMeta()
      localDidChange()
    }
  }

  public var selectedProfileId: String? {
    didSet {
      guard selectedProfileId != oldValue else { return }
      meta.selectedProfileId = selectedProfileId
      saveMeta()
    }
  }

  public var devicesThatReceiveTabs: [SyncedDevice] { devicesThatReceiveTabs(in: selectedProfileId) }

  public func devicesThatReceiveTabs(in profileSyncId: String?) -> [SyncedDevice] {
    guard let profile = snapshot.profile(profileSyncId) else { return [] }
    return (profile.sendTargets ?? []).compactMap { id in snapshot.devices.first { $0.id == id && $0.canReceiveTabs && !$0.isCurrent } }
  }

  public var selectedProfile: SyncedProfile? { snapshot.profile(selectedProfileId) }

  public func isPinned(_ url: URL, profileSyncId: String? = nil) -> Bool {
    let page = url.absoluteString
    let profile = snapshot.profile(profileSyncId ?? selectedProfileId)
    let pin = PinnedPage(profile: profile?.syncId ?? profileSyncId ?? "", url: page)
    return pinnedThisSession.contains(pin) || (profile?.bookmarks.containsPage(page) ?? false)
  }

  private func settlePins() {
    guard !pinnedThisSession.isEmpty else { return }
    let left: Set<PinnedPage> = snapshot == .empty ? [] : pinnedThisSession.filter { pin in
      snapshot.profiles.first { $0.syncId == pin.profile }.map { !$0.bookmarks.containsPage(pin.url) } ?? true
    }
    if left != pinnedThisSession { pinnedThisSession = left }
  }

  public var statusText: String {
    switch phase {
    case .off: return "Off"
    case .starting: return "Starting up"
    case .updating: return "Updating" + waitingText
    case .updated: return "Updated just now" + waitingText
    case .stalled:
      guard let lastSynced else { return "Not syncing" }
      return "Not syncing · Last synced \(Self.relative.localizedString(for: lastSynced, relativeTo: now()))"
    case .offline: return "Offline"
    case .needsFolderAccess: return usesNextcloud ? "Sign in to Nextcloud again to keep syncing." : "Choose your sync folder again to keep syncing."
    case .locked: return "Enter your recovery phrase to keep syncing on this iPhone."
    case .reset: return Self.resetMessage
    }
  }

  @ObservationIgnored public weak var source: (any LocalBrowsingSource)?
  @ObservationIgnored private let files: SyncFiles
  @ObservationIgnored private let keyStore: any SyncKeyStore
  @ObservationIgnored private let resolver: SyncStoreResolver
  @ObservationIgnored var revocations: [Task<Void, Never>] = []
  @ObservationIgnored private var meta: SyncMeta
  @ObservationIgnored private var engine: SyncEngine?
  @ObservationIgnored private var locationGeneration = 0
  @ObservationIgnored private var joining = 0
  @ObservationIgnored private var releaseAfterJoining: [NextcloudAccount] = []
  @ObservationIgnored private var running = false
  @ObservationIgnored private var again = false
  @ObservationIgnored private var idle: [CheckedContinuation<Void, Never>] = []
  @ObservationIgnored private var visitsDue = true
  @ObservationIgnored private var visitGeneration = 0
  @ObservationIgnored private var dueVisits: Set<String> = []
  @ObservationIgnored private var stopping = false
  @ObservationIgnored private var localDirty = false
  @ObservationIgnored private var foreground = false
  @ObservationIgnored private var missingSince: Date?
  @ObservationIgnored private var foregroundLoop: Task<Void, Never>?
  @ObservationIgnored private var debounce: Task<Void, Never>?
  @ObservationIgnored private var retiring: Task<Void, Never>?
  @ObservationIgnored private let now: @Sendable () -> Date
  @ObservationIgnored private let coordinationTimeout: TimeInterval

  public static let defaultDirectory = URL.applicationSupportDirectory.appending(path: "Sync", directoryHint: .isDirectory)
  static let cycleInterval: Duration = .seconds(15)
  static let afterEdit: Duration = .seconds(3)
  static let historyWindow: TimeInterval = 90 * 86_400
  static let resetConfirmation: TimeInterval = 60
  static let visitOverlap: TimeInterval = 300

  private static weak var active: SyncService?

  public init(
    directory: URL = SyncService.defaultDirectory,
    keyStore: any SyncKeyStore = KeychainKeyStore(service: "Ardia Sync Key"),
    coordinationTimeout: TimeInterval = SyncFolderAccess.defaultTimeout,
    nextcloudPasswords: any SyncKeyStore = KeychainKeyStore(service: "Ardia Nextcloud"),
    nextcloudTransport: NextcloudTransport = .live,
    now: @escaping @Sendable () -> Date = Date.init
  ) {
    files = SyncFiles(directory: directory)
    self.keyStore = keyStore
    resolver = SyncStoreResolver(passwords: nextcloudPasswords, transport: nextcloudTransport)
    self.now = now
    self.coordinationTimeout = coordinationTimeout
    meta = files.loadMeta()
    deviceName = meta.deviceName
    selectedProfileId = meta.selectedProfileId
    lastSynced = meta.lastSyncedAt
    folderName = meta.nextcloud?.path ?? meta.folder?.name
    nextcloudHost = meta.nextcloud?.host
    isDemo = false
  }

  private init(demo snapshot: SyncSnapshot) {
    files = SyncFiles(directory: URL(filePath: "/dev/null"))
    keyStore = DemoKeyStore()
    resolver = SyncStoreResolver(passwords: DemoKeyStore(), transport: .live)
    now = Date.init
    coordinationTimeout = SyncFolderAccess.defaultTimeout
    meta = SyncMeta(deviceName: "iPhone", enabled: true)
    deviceName = "iPhone"
    isDemo = true
    self.snapshot = snapshot
    phase = .updated
    isEnabled = true
    folderName = "Ardia Sync"
    lastSynced = .now
  }

  public static var demo: SyncService { SyncService(demo: .demo) }

  public func start() {
    guard !isDemo, engine == nil else { return }
    Self.active = self
    meta = files.loadMeta()
    refreshLocationName()
    if meta.retiringDeviceId != nil, retiring == nil {
      retiring = Task { await retirePending() }
    }
    if meta.outOfSync {
      set(\.isEnabled, false)
      set(\.phase, .reset)
      return
    }
    guard meta.enabled, let deviceId = meta.deviceId, meta.folder != nil || meta.nextcloud != nil else {
      set(\.isEnabled, false)
      set(\.phase, .off)
      return
    }
    set(\.isEnabled, true)
    guard let entropy = keyStore.load(account: deviceId), entropy.count == 32 else {
      set(\.phase, .locked)
      return
    }
    guard case .ready(let location, let refreshed) = resolver.resolve(meta) else {
      set(\.phase, .needsFolderAccess)
      return
    }
    if let refreshed {
      meta.folder = refreshed
      saveMeta()
    }
    guard let engine = makeEngine(deviceId: deviceId, entropy: entropy, location: location) else { return }
    set(\.phase, .starting)
    Task {
      if let cached = await engine.cachedSnapshot(), snapshot == .empty { snapshot = cached }
      await runCycle()
    }
  }

  public func check(phrase: String) -> PhraseCheck {
    let count = RecoveryPhrase.tokens(in: phrase).count
    let tooLong = count > Self.wordCount
    var problem: String?
    var valid = false
    if count == Self.wordCount {
      do {
        _ = try RecoveryPhrase.entropy(from: phrase)
        valid = true
      } catch let failure as RecoveryPhrase.Problem {
        problem = Self.message(for: failure)
      } catch {
        problem = Self.message(for: .checksum)
      }
    }
    return PhraseCheck(wordCount: count, counterText: tooLong ? "too many words" : "\(count)/\(Self.wordCount) words", isTooLong: tooLong, problem: problem, isValid: valid)
  }

  public func connect(phrase: String, folder: URL) async -> ConnectResult {
    await connect(phrase: phrase, to: .folder(folder))
  }

  public func connect(phrase: String, to destination: SyncDestination) async -> ConnectResult {
    guard !isDemo else { return .connected }
    guard !stopping else { return .busy }
    foreground = true
    let entropy: Data
    do {
      entropy = try RecoveryPhrase.entropy(from: phrase)
    } catch let failure as RecoveryPhrase.Problem {
      return .invalidPhrase(Self.message(for: failure))
    } catch {
      return .invalidPhrase(Self.message(for: .checksum))
    }
    joining += 1
    defer { finishJoining() }
    let prepared: Prepared
    switch await prepare(destination, entropy: entropy) {
    case .success(let ready): prepared = ready
    case .failure(let failure): return failure
    }
    guard !stopping else { return .busy }
    if let retiring { await retiring.value }
    let abandoned = await finishPendingRetire(giveUp: true)
    if let old = engine {
      await old.retire()
      engine = nil
    }
    let reuse = phase == .locked ? meta.deviceId.flatMap { id in Self.opensState(files, entropy: entropy) ? id : nil } : nil
    let deviceId = reuse ?? SyncKeys.newFileId()
    guard let saved = commit(prepared.draft) else { return .keychainFailed }
    guard keyStore.save(entropy, account: deviceId) else {
      resolver.discard(saved)
      return .keychainFailed
    }
    if reuse == nil {
      let previous = meta.deviceId
      do {
        try SyncEngine.prepareFresh(directory: files.directory, deviceId: deviceId, ghosts: [abandoned, previous].compactMap(\.self))
      } catch {
        keyStore.delete(account: deviceId)
        resolver.discard(saved)
        return .keychainFailed
      }
      if let previous { keyStore.delete(account: previous) }
      meta.setupAt = now()
      meta.lastSyncedAt = nil
      meta.visitsSyncedThrough = nil
      meta.chainSeen = false
      lastSynced = nil
      snapshot = .empty
    }
    meta.deviceId = deviceId
    if let replaced = adopt(saved) { forget(replaced, keeping: meta.nextcloud) }
    meta.enabled = true
    meta.outOfSync = false
    saveMeta()
    Self.active = self
    missingSince = nil
    guard makeEngine(deviceId: deviceId, entropy: entropy, location: prepared.location) != nil else { return .connected }
    set(\.isEnabled, true)
    set(\.phase, .starting)
    visitsDue = true
    startForegroundLoop()
    Task { await runCycle() }
    return .connected
  }

  @discardableResult
  public func changeFolder(_ folder: URL) async -> ConnectResult {
    await changeLocation(.folder(folder))
  }

  @discardableResult
  public func changeLocation(_ destination: SyncDestination) async -> ConnectResult {
    guard !isDemo else { return .connected }
    guard meta.enabled, let deviceId = meta.deviceId, let entropy = keyStore.load(account: deviceId) else { return .keychainFailed }
    joining += 1
    defer { finishJoining() }
    let prepared: Prepared
    switch await prepare(destination, entropy: entropy) {
    case .success(let ready): prepared = ready
    case .failure(let failure): return failure
    }
    guard meta.enabled, meta.deviceId == deviceId, let saved = commit(prepared.draft) else { return .keychainFailed }
    let replaced = adopt(saved)
    locationGeneration += 1
    meta.chainSeen = false
    saveMeta()
    missingSince = nil
    var unfinished: ConnectResult?
    if let engine {
      do {
        try await engine.changeLocation(prepared.location, generation: locationGeneration)
      } catch {
        unfinished = if case .nextcloud = destination { .serverUnavailable } else { .folderUnavailable }
      }
    } else if makeEngine(deviceId: deviceId, entropy: entropy, location: prepared.location) == nil {
      unfinished = .connected
    }
    if let replaced, replaced != meta.nextcloud { forget(replaced, keeping: meta.nextcloud) }
    if let unfinished { return unfinished }
    set(\.phase, .starting)
    if foreground { startForegroundLoop() }
    Task { await runCycle() }
    return .connected
  }

  public func acknowledgeReset() {
    guard !isDemo, phase == .reset else { return }
    if let deviceId = meta.deviceId { keyStore.delete(account: deviceId) }
    forgetNextcloud()
    meta.deviceId = nil
    meta.enabled = false
    meta.outOfSync = false
    meta.lastSyncedAt = nil
    meta.visitsSyncedThrough = nil
    saveMeta()
    lastSynced = nil
    set(\.isEnabled, false)
    set(\.phase, .off)
  }

  public func syncNow() async {
    if let retiring { await retiring.value }
    guard running else { return await runCycle() }
    again = true
    await withCheckedContinuation { idle.append($0) }
  }

  public func localDidChange() {
    guard isEnabled, !isDemo else { return }
    localDirty = true
    visitsDue = true
    visitGeneration += 1
    debounce?.cancel()
    debounce = Task { [weak self] in
      try? await Task.sleep(for: Self.afterEdit)
      guard !Task.isCancelled else { return }
      await self?.runCycle()
    }
  }

  public func appBecameActive() {
    guard !isDemo else { return }
    foreground = true
    if meta.retiringDeviceId != nil, retiring == nil { retiring = Task { await retirePending() } }
    if phase == .locked || (meta.enabled && !meta.outOfSync && engine == nil && phase != .needsFolderAccess) { start() }
    guard isEnabled, engine != nil else { return }
    startForegroundLoop()
    Task { await runCycle() }
  }

  public func appWillResignActive() {
    guard !isDemo else { return }
    foreground = false
    missingSince = nil
    foregroundLoop?.cancel()
    foregroundLoop = nil
    meta.lastSyncedAt = lastSynced
    saveMeta()
    guard isEnabled, let engine else { return }
    scheduleBackgroundRefresh()
    guard running || localDirty || debounce != nil else { return }
    let flush = localDirty || debounce != nil
    debounce?.cancel()
    debounce = nil
    #if canImport(UIKit)
    let assertion = BackgroundAssertion()
    assertion.begin {
      engine.cancelCoordination()
    }
    Task {
      if flush { await syncNow() } else { await untilIdle() }
      assertion.end()
    }
    #else
    Task { if flush { await syncNow() } }
    #endif
  }

  public func close() async {
    foregroundLoop?.cancel()
    foregroundLoop = nil
    debounce?.cancel()
    debounce = nil
    meta.lastSyncedAt = lastSynced
    saveMeta()
    guard let engine else { return }
    self.engine = nil
    await engine.retire()
  }

  private func untilIdle() async {
    guard running else { return }
    await withCheckedContinuation { idle.append($0) }
  }

  public func stopSyncing() async {
    guard !isDemo, !stopping else { return }
    stopping = true
    defer { stopping = false }
    let deviceId = meta.deviceId
    foregroundLoop?.cancel()
    foregroundLoop = nil
    debounce?.cancel()
    debounce = nil
    set(\.isEnabled, false)
    let local = LocalBrowsing(deviceName: meta.deviceName, tabs: nil, visits: nil)
    var landed = false
    if let engine {
      self.engine = nil
      if case .locked = phase {
        await engine.forget()
        landed = true
      } else {
        do {
          landed = try await engine.stop(local)
        } catch SyncError.stateUnreadable {
          await engine.forget()
          if let deviceId { await retireAsGhost(deviceId) }
          landed = true
        } catch {
          await engine.retire()
        }
      }
    } else if deviceId == nil || keyStore.load(account: deviceId!) == nil {
      files.removeSyncData()
      landed = true
    }
    guard meta.deviceId == deviceId else { return }
    if landed {
      if let deviceId { keyStore.delete(account: deviceId) }
      forgetNextcloud()
    } else {
      meta.retiringDeviceId = deviceId
    }
    meta.enabled = false
    meta.deviceId = nil
    meta.lastSyncedAt = nil
    meta.outOfSync = false
    meta.visitsSyncedThrough = nil
    saveMeta()
    snapshot = .empty
    lastSynced = nil
    missingSince = nil
    set(\.pendingDownloads, 0)
    set(\.phase, .off)
  }

  @discardableResult
  public func send(url: URL, title: String, to device: SyncedDevice, profileSyncId: String? = nil, key: UUID = UUID()) async -> Bool {
    guard !isDemo else { return true }
    guard let engine, let profile = profileSyncId ?? selectedProfile?.syncId,
          devicesThatReceiveTabs(in: profile).contains(where: { $0.id == device.id })
    else { return false }
    do {
      try await engine.send(url: url.absoluteString, title: title, to: device.id, profileSyncId: profile, key: key)
    } catch {
      return false
    }
    Task { await runCycle() }
    return true
  }

  @discardableResult
  public func addBookmark(url: URL, title: String, profileSyncId: String? = nil) async -> PinOutcome {
    let page = url.absoluteString
    guard !isDemo else {
      pinnedThisSession.insert(PinnedPage(profile: profileSyncId ?? selectedProfile?.syncId ?? "", url: page))
      return .pinned
    }
    guard let engine, let profile = profileSyncId ?? selectedProfile?.syncId else { return .failed }
    let added: Bool
    do {
      added = try await engine.addBookmark(url: page, title: title, profileSyncId: profile)
    } catch {
      return .failed
    }
    guard added else { return .alreadyPinned }
    pinnedThisSession.insert(PinnedPage(profile: profile, url: page))
    Task { await runCycle() }
    return .pinned
  }

  public static func registerBackgroundRefresh() {
    #if os(iOS)
    BGTaskScheduler.shared.register(forTaskWithIdentifier: backgroundTaskIdentifier, using: .main) { task in
      MainActor.assumeIsolated {
        guard let task = task as? BGAppRefreshTask else {
          task.setTaskCompleted(success: false)
          return
        }
        let completion = BackgroundCompletion(task)
        let work = Task { @MainActor in await SyncService.active?.backgroundCycle() ?? true }
        task.expirationHandler = {
          Task { @MainActor in
            SyncService.active?.cancelCoordination()
            work.cancel()
            completion.finish(success: false)
          }
        }
        Task { @MainActor in
          let success = await work.value
          SyncService.active?.scheduleBackgroundRefresh()
          completion.finish(success: success)
        }
      }
    }
    #endif
  }

  public func scheduleBackgroundRefresh() {
    #if os(iOS)
    guard isEnabled || meta.retiringDeviceId != nil, !isDemo else { return }
    let request = BGAppRefreshTaskRequest(identifier: Self.backgroundTaskIdentifier)
    request.earliestBeginDate = now().addingTimeInterval(15 * 60)
    try? BGTaskScheduler.shared.submit(request)
    #endif
  }

  func cancelCoordination() {
    engine?.cancelCoordination()
  }

  func backgroundCycle() async -> Bool {
    if engine == nil { start() }
    if let retiring { await retiring.value }
    guard isEnabled, engine != nil, !Task.isCancelled else { return true }
    await runCycle()
    return phase == .updated
  }

  private func makeEngine(deviceId: String, entropy: Data, location: SyncLocation) -> SyncEngine? {
    do {
      let engine = try SyncEngine(directory: files.directory, deviceId: deviceId, entropy: entropy, location: location, locationGeneration: locationGeneration, chainSeen: meta.chainSeen, coordinationTimeout: coordinationTimeout, now: now)
      self.engine = engine
      return engine
    } catch {
      set(\.phase, .stalled(Self.stalledMessage))
      return nil
    }
  }

  private func startForegroundLoop() {
    guard foregroundLoop == nil else { return }
    foregroundLoop = Task { [weak self] in
      while !Task.isCancelled {
        try? await Task.sleep(for: Self.cycleInterval)
        guard !Task.isCancelled, let self else { return }
        await self.runCycle()
      }
    }
  }

  private func runCycle() async {
    guard engine != nil, isEnabled, !isDemo else { return }
    if running {
      again = true
      return
    }
    running = true
    defer {
      running = false
      let waiting = idle
      idle = []
      for continuation in waiting { continuation.resume() }
    }
    repeat {
      again = false
      guard let engine, isEnabled else { break }
      debounce?.cancel()
      debounce = nil
      let fetchedAt = now()
      let generation = visitGeneration
      let local = gatherLocal(at: fetchedAt)
      let dirty = localDirty
      localDirty = false
      let slow = Task { [weak self] in
        try? await Task.sleep(for: .seconds(1))
        guard !Task.isCancelled, let self, self.phase == .updated else { return }
        self.set(\.phase, .updating)
      }
      do {
        let outcome = try await engine.cycle(local)
        if local.visits != nil, outcome.status == .ok {
          if generation == visitGeneration { visitsDue = false }
          if !(outcome.snapshot ?? snapshot).profiles.isEmpty {
            meta.visitsSyncedThrough = fetchedAt
            saveMeta()
          }
        }
        if outcome.status == .ok, source != nil {
          dueVisits = outcome.visitsDue
          if !dueVisits.isEmpty, dueVisits != local.fetchedDue { again = true }
        }
        await apply(outcome, engine: engine)
      } catch SyncError.retired {
        localDirty = localDirty || dirty
      } catch SyncError.stateUnreadable {
        localDirty = localDirty || dirty
        await startOver(engine)
      } catch SyncError.stateUnavailable {
        localDirty = localDirty || dirty
        set(\.phase, .stalled(Self.unavailableMessage))
      } catch is CancellationError {
        localDirty = localDirty || dirty
      } catch {
        localDirty = localDirty || dirty
        set(\.phase, .stalled(Self.stalledMessage))
      }
      slow.cancel()
    } while again && isEnabled
  }

  private func apply(_ outcome: CycleOutcome, engine: SyncEngine) async {
    guard self.engine === engine, outcome.locationGeneration == locationGeneration else { return }
    if outcome.signInNeeded {
      await needSignIn(engine)
      return
    }
    if outcome.chainSeen, !meta.chainSeen {
      meta.chainSeen = true
      saveMeta()
    }
    switch outcome.status {
    case .unavailable:
      missingSince = nil
      set(\.phase, .offline)
    case .missing:
      guard foreground else {
        missingSince = nil
        set(\.phase, .offline)
        return
      }
      let seen = now()
      guard let since = missingSince, seen.timeIntervalSince(since) >= Self.resetConfirmation else {
        if missingSince == nil { missingSince = seen }
        set(\.phase, .offline)
        return
      }
      await resetFromElsewhere(engine)
    case .ok:
      missingSince = nil
      if let fresh = outcome.snapshot, !Self.same(fresh, snapshot) { snapshot = fresh }
      set(\.pendingDownloads, outcome.pending)
      set(\.phase, .updated)
      lastSynced = now()
      if !outcome.historyRemoved.isEmpty, let source {
        for removal in outcome.historyRemoved {
          source.removeVisits(urls: removal.urls, profileSyncId: removal.profileSyncId)
          if removal.includesUnassigned { source.removeVisits(urls: removal.urls, profileSyncId: nil) }
        }
        try? await engine.acknowledgeRemovals(outcome.historyRemoved)
      }
      if !outcome.received.isEmpty, let source, self.engine === engine {
        if source.receive(outcome.received) {
          try? await engine.acknowledge(outcome.received)
        }
      }
    }
  }

  private func startOver(_ broken: SyncEngine) async {
    guard self.engine === broken, let oldId = meta.deviceId, let entropy = keyStore.load(account: oldId),
          case .ready(let location, _) = resolver.resolve(meta)
    else {
      set(\.phase, .stalled(Self.stalledMessage))
      return
    }
    let deviceId = SyncKeys.newFileId()
    guard keyStore.save(entropy, account: deviceId) else {
      set(\.phase, .stalled(Self.stalledMessage))
      return
    }
    do {
      try SyncEngine.prepareFresh(directory: files.directory, deviceId: deviceId, ghosts: [oldId])
      meta.deviceId = deviceId
      meta.visitsSyncedThrough = nil
      try files.saveMeta(meta)
    } catch {
      meta.deviceId = oldId
      keyStore.delete(account: deviceId)
      set(\.phase, .stalled(Self.stalledMessage))
      return
    }
    await broken.retire()
    engine = nil
    keyStore.delete(account: oldId)
    visitsDue = true
    guard makeEngine(deviceId: deviceId, entropy: entropy, location: location) != nil else { return }
    again = true
  }

  private func resetFromElsewhere(_ engine: SyncEngine) async {
    meta.outOfSync = true
    saveMeta()
    await engine.setAside("reset")
    guard self.engine === engine else { return }
    self.engine = nil
    foregroundLoop?.cancel()
    foregroundLoop = nil
    missingSince = nil
    snapshot = .empty
    set(\.isEnabled, false)
    set(\.phase, .reset)
  }

  private func retirePending() async {
    defer { retiring = nil }
    await finishPendingRetire(giveUp: false)
  }

  private func retireAsGhost(_ oldId: String) async {
    guard let entropy = keyStore.load(account: oldId), case .ready(let location, _) = resolver.resolve(meta) else { return }
    let temporary = SyncKeys.newFileId()
    guard (try? SyncEngine.prepareFresh(directory: files.directory, deviceId: temporary, ghosts: [oldId])) != nil,
          let engine = try? SyncEngine(directory: files.directory, deviceId: temporary, entropy: entropy, location: location, coordinationTimeout: coordinationTimeout, now: now)
    else { return }
    let local = LocalBrowsing(deviceName: meta.deviceName, tabs: nil, visits: nil)
    for _ in 0..<2 {
      guard (try? await engine.cycle(local, retiring: true))?.status == .ok else { break }
    }
    await engine.forget()
  }

  @discardableResult
  private func finishPendingRetire(giveUp: Bool) async -> String? {
    guard let deviceId = meta.retiringDeviceId else { return nil }
    var landed = false
    if let entropy = keyStore.load(account: deviceId), case .ready(let location, _) = resolver.resolve(meta) {
      if let engine = try? SyncEngine(directory: files.directory, deviceId: deviceId, entropy: entropy, location: location, coordinationTimeout: coordinationTimeout, now: now) {
        do {
          landed = try await engine.stop(LocalBrowsing(deviceName: meta.deviceName, tabs: nil, visits: nil))
        } catch SyncError.stateUnreadable {
          await engine.forget()
          await retireAsGhost(deviceId)
          landed = true
        } catch {
          await engine.retire()
        }
      }
    } else {
      landed = keyStore.load(account: deviceId) == nil
    }
    guard landed || giveUp, meta.retiringDeviceId == deviceId else { return nil }
    keyStore.delete(account: deviceId)
    files.removeSyncData()
    meta.retiringDeviceId = nil
    if !meta.enabled { forgetNextcloud() }
    saveMeta()
    return landed ? nil : deviceId
  }

  private func gatherLocal(at time: Date) -> LocalBrowsing {
    guard let source else { return LocalBrowsing(deviceName: meta.deviceName, tabs: nil, visits: nil) }
    var visits: [LocalVisitRecord]?
    if visitsDue {
      let window = time.addingTimeInterval(-Self.historyWindow)
      let since = meta.visitsSyncedThrough.map { max(window, $0.addingTimeInterval(-Self.visitOverlap)) } ?? window
      visits = source.syncedVisits(since: since)
    }
    let due = dueVisits
    if !due.isEmpty { visits = (visits ?? []) + source.syncedVisits(urls: due) }
    return LocalBrowsing(deviceName: meta.deviceName, tabs: source.syncedTabs(), visits: visits, fetchedDue: due)
  }

  private func saveMeta() {
    guard !isDemo else { return }
    try? files.saveMeta(meta)
  }

  private func set<Value: Equatable>(_ keyPath: ReferenceWritableKeyPath<SyncService, Value>, _ value: Value) {
    if self[keyPath: keyPath] != value { self[keyPath: keyPath] = value }
  }

  private var waitingText: String {
    guard pendingDownloads > 0 else { return "" }
    return " · " + Self.waitingForDownloads(pendingDownloads)
  }

  static func same(_ a: SyncSnapshot, _ b: SyncSnapshot) -> Bool {
    var a = a
    a.syncedAt = b.syncedAt
    return a == b
  }

  private static let relative: RelativeDateTimeFormatter = {
    let formatter = RelativeDateTimeFormatter()
    formatter.unitsStyle = .full
    return formatter
  }()

  private enum Draft: Sendable {
    case folder(SyncFolderLocation)
    case nextcloud(NextcloudAccount, path: String)
  }

  private enum Preparation {
    case success(Prepared)
    case failure(ConnectResult)
  }

  private struct Prepared: Sendable {
    var location: SyncLocation
    var draft: Draft
    var check: FolderCheck
  }

  private func prepare(_ destination: SyncDestination, entropy: Data) async -> Preparation {
    let prepared: Prepared
    switch destination {
    case .folder(let folder):
      guard let ready = await Self.prepare(folder: folder, entropy: entropy) else { return .failure(.folderUnavailable) }
      prepared = ready
    case .nextcloud(let account, let path):
      let transport = resolver.transport
      do {
        let found = try await NextcloudLogin(transport: transport).locate(account, entropy: entropy, typedPath: path)
        prepared = Prepared(location: .nextcloud(NextcloudConnection(account: account, path: found.path, transport: transport)), draft: .nextcloud(account, path: found.path), check: found.check)
      } catch let problem as NextcloudProblem {
        return .failure(ConnectResult(problem))
      } catch {
        return .failure(.serverUnavailable)
      }
    }
    let remote = if case .nextcloud = destination { true } else { false }
    switch prepared.check {
    case .matches: return .success(prepared)
    case .mismatch: return .failure(.mismatch)
    case .noSyncData: return .failure(remote ? .noSyncDataInNextcloud : .noSyncData)
    case .unavailable: return .failure(remote ? .serverUnavailable : .folderUnavailable)
    }
  }

  @concurrent
  private static func prepare(folder: URL, entropy: Data) async -> Prepared? {
    guard let (grant, location) = try? SyncFolderAccess.grant(picked: folder) else { return nil }
    return Prepared(location: .folder(grant), draft: .folder(location), check: SyncEngine.check(entropy: entropy, folder: grant.folder))
  }

  private func commit(_ draft: Draft) -> SavedLocation? {
    switch draft {
    case .folder(let location): .folder(location)
    case .nextcloud(let account, let path): resolver.save(account, path: path).map { .nextcloud($0) }
    }
  }

  private func adopt(_ saved: SavedLocation) -> NextcloudLocation? {
    let previous = meta.nextcloud
    switch saved {
    case .folder(let location):
      meta.folder = location
      meta.nextcloud = nil
    case .nextcloud(let location):
      meta.nextcloud = location
      meta.folder = nil
    }
    refreshLocationName()
    guard let previous, previous != meta.nextcloud else { return nil }
    return previous
  }

  private func forget(_ location: NextcloudLocation, keeping live: NextcloudLocation? = nil) {
    if let revoking = resolver.forget(location, keeping: live) { revocations.append(revoking) }
  }

  private func forgetNextcloud() {
    guard let location = meta.nextcloud else { return }
    forget(location)
    meta.nextcloud = nil
    refreshLocationName()
  }

  public func release(_ account: NextcloudAccount) {
    guard !isDemo else { return }
    guard joining == 0 else {
      releaseAfterJoining.append(account)
      return
    }
    if let live = meta.nextcloud.flatMap(resolver.account), live.sharesCredential(with: account) { return }
    let login = NextcloudLogin(transport: resolver.transport)
    revocations.append(Task.detached { await login.revoke(account) })
  }

  private func finishJoining() {
    joining -= 1
    guard joining == 0, !releaseAfterJoining.isEmpty else { return }
    let waiting = releaseAfterJoining
    releaseAfterJoining = []
    for account in waiting { release(account) }
  }

  private func refreshLocationName() {
    folderName = meta.nextcloud?.path ?? meta.folder?.name
    nextcloudHost = meta.nextcloud?.host
  }

  private func needSignIn(_ engine: SyncEngine) async {
    let rejected = meta.nextcloud
    let generation = locationGeneration
    foregroundLoop?.cancel()
    foregroundLoop = nil
    debounce?.cancel()
    debounce = nil
    missingSince = nil
    if self.engine === engine { self.engine = nil }
    await engine.retire()
    guard locationGeneration == generation, meta.nextcloud == rejected else {
      if self.engine == nil, meta.enabled, !stopping { start() }
      if self.engine != nil, foreground { startForegroundLoop() }
      return
    }
    if let rejected { resolver.discard(.nextcloud(rejected)) }
    set(\.phase, .needsFolderAccess)
  }

  private static func opensState(_ files: SyncFiles, entropy: Data) -> Bool {
    files.readSealed(files.stateURL, keys: SyncKeys(entropy: entropy), fileId: SyncFiles.stateFile) != nil
  }
}

#if canImport(UIKit)
@MainActor
private final class BackgroundAssertion {
  private var identifier = UIBackgroundTaskIdentifier.invalid

  func begin(onExpiry: @escaping @MainActor () -> Void) {
    identifier = UIApplication.shared.beginBackgroundTask(withName: "Sync") { [weak self] in
      MainActor.assumeIsolated {
        onExpiry()
        self?.end()
      }
    }
  }

  func end() {
    guard identifier != .invalid else { return }
    UIApplication.shared.endBackgroundTask(identifier)
    identifier = .invalid
  }
}
#endif

#if os(iOS)
@MainActor
private final class BackgroundCompletion {
  private var task: BGTask?

  init(_ task: BGTask) {
    self.task = task
  }

  func finish(success: Bool) {
    task?.setTaskCompleted(success: success)
    task = nil
  }
}
#endif

private struct DemoKeyStore: SyncKeyStore {
  func load(account: String) -> Data? { nil }
  func save(_ secret: Data, account: String) -> Bool { true }
  func delete(account: String) {}
}

private struct PinnedPage: Hashable {
  var profile: String
  var url: String
}
