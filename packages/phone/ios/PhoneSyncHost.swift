import ArdiaBrowser
import ArdiaDesign
import ArdiaSync
import Foundation
import Observation
import PhoneSync

@MainActor
public final class PhoneSyncHost {
  public static let shared = PhoneSyncHost()

  static var folder: URL { URL.applicationSupportDirectory.appending(path: "PhoneSync", directoryHint: .isDirectory) }
  static var database: URL { URL.documentsDirectory.appending(path: "SQLite/browser.db") }

  public static var legacyGate: LegacyImportGate { LegacyPaths.gate }

  enum Change {
    case status
    case view
    case incoming
    case inbox(Int)
  }

  let inbox: PhoneInbox
  private let source: PhoneBrowsingSource
  private(set) var service: SyncService
  private(set) var isDemo = false
  private var launched = false
  private var replacing: Task<Void, Never>?
  private var generation = 0
  private var announced = Set<String>()
  private(set) var incoming: [ReceivedTab] = []
  private let exporter = WidgetExporter()
  private var sharesInFlight = Set<UUID>()
  static let shareSyncWait: Duration = .seconds(20)

  var widgetColorChoice: String? {
    didSet { if widgetColorChoice != oldValue { exportWidget() } }
  }

  private(set) var listener: ((Change) -> Void)?
  private weak var listenerOwner: AnyObject?

  func listen(_ owner: AnyObject, _ handler: @escaping (Change) -> Void) {
    listenerOwner = owner
    listener = handler
  }

  func stopListening(_ owner: AnyObject) {
    guard listenerOwner === owner else { return }
    listenerOwner = nil
    listener = nil
  }

  private init() {
    try? FileManager.default.createDirectory(at: Self.folder, withIntermediateDirectories: true)
    var folder = Self.folder
    var values = URLResourceValues()
    values.isExcludedFromBackup = true
    try? folder.setResourceValues(values)
    inbox = PhoneInbox(file: Self.folder.appending(path: "inbox.json"))
    source = PhoneBrowsingSource(database: Self.database, inbox: inbox, engine: .expoSQLite, isReady: { !PhoneSyncHost.legacyGate.holdsSync })
    service = SyncService()
    service.source = source
    source.onReceived = { [weak self] tabs in self?.announce(tabs) }
    inbox.onChange = { [weak self] count in
      Task { @MainActor in self?.listener?(.inbox(count)) }
    }
    inbox.onProblem = { [weak self] _ in
      Task { @MainActor in self?.listener?(.status) }
    }
  }

  public func launch() {
    guard !launched else { return }
    launched = true
    LegacySettings.applyAtLaunch()
    SyncService.registerBackgroundRefresh()
    inbox.load()
    service.start()
    track()
  }

  public func sceneBecameActive() {
    service.appBecameActive()
  }

  public func sceneWillResignActive() {
    service.appWillResignActive()
  }

  func ready() async -> SyncService {
    if let replacing { await replacing.value }
    return service
  }

  func useDemoIfAsked() async {
    guard PhoneTestBuild.isDemo else { return }
    await useDemo(overConnection: true)
  }

  func useDemo(overConnection: Bool = false) async {
    if let replacing { return await replacing.value }
    guard PhoneTestBuild.isOn, !isDemo else { return }
    guard overConnection || (!service.isEnabled && service.folderName == nil) else { return }
    let old = service
    let task = Task { @MainActor in
      await old.close()
      let demo = SyncService.demo
      self.service = demo
      self.isDemo = true
      self.announced = []
      self.incoming = []
      self.track()
      self.listener?(.status)
      self.listener?(.view)
      if PhoneTestBuild.flag("ArdiaVaultDemo") {
        Task { @MainActor in
          try? await Task.sleep(for: .seconds(3))
          demo.demoAskToSignIn()
        }
      }
    }
    replacing = task
    await task.value
    replacing = nil
  }

  func legacyImportFinished() {
    guard !PhoneSyncHost.legacyGate.holdsSync else { return }
    service.localDidChange()
    Task { await service.syncNow() }
  }

  func stopSyncing() async {
    await ready().stopSyncing()
    announced = []
    incoming = []
    listener?(.incoming)
  }

  func clearIncoming() {
    incoming = []
  }

  private func announce(_ tabs: [ReceivedTab]) {
    let fresh = tabs.filter { announced.insert($0.key).inserted }
    guard !fresh.isEmpty else { return }
    incoming = fresh
    listener?(.incoming)
  }

  private func track() {
    generation += 1
    let current = generation
    trackStatus(current)
    trackView(current)
  }

  private func trackStatus(_ current: Int) {
    let service = service
    withObservationTracking {
      _ = (service.phase, service.isEnabled, service.pendingDownloads, service.lastSynced, service.folderName, service.deviceName, service.selectedProfileId)
    } onChange: { [weak self] in
      Task { @MainActor [weak self] in
        guard let self, self.generation == current else { return }
        self.listener?(.status)
        self.trackStatus(current)
      }
    }
  }

  private func trackView(_ current: Int) {
    let service = service
    let widget = withObservationTracking {
      _ = (service.snapshot, service.selectedProfileId, service.isEnabled)
      return WidgetExporter.snapshot(sync: service, colorChoice: widgetColorChoice)
    } onChange: { [weak self] in
      Task { @MainActor [weak self] in
        guard let self, self.generation == current else { return }
        self.listener?(.view)
        self.trackView(current)
      }
    }
    if !isDemo, let store = SystemStore.shared { exporter.export(widget, into: store) }
  }

  private func exportWidget() {
    guard !isDemo, let store = SystemStore.shared else { return }
    exporter.export(WidgetExporter.snapshot(sync: service, colorChoice: widgetColorChoice), into: store)
  }

  func sendFromShareSheet(_ item: SystemInboxItem, to target: SystemDevice, store: SystemStore) {
    guard !isDemo, !sharesInFlight.contains(item.id) else { return }
    guard let url = item.url.flatMap(URL.init(string:)) else { return store.removeFromInbox(item.id) }
    sharesInFlight.insert(item.id)
    Task { @MainActor in
      defer { sharesInFlight.remove(item.id) }
      let deadline = ContinuousClock.now + Self.shareSyncWait
      while !canAnswerShare(for: target), ContinuousClock.now < deadline {
        try? await Task.sleep(for: .milliseconds(250))
      }
      guard canAnswerShare(for: target) else { return }
      guard service.isEnabled, let device = service.snapshot.devices.first(where: { $0.id == target.id }) else {
        return store.removeFromInbox(item.id)
      }
      if await service.send(url: url, title: item.title, to: device, key: item.id) { store.removeFromInbox(item.id) }
    }
  }

  private func canAnswerShare(for target: SystemDevice) -> Bool {
    !service.isEnabled || service.phase == .updated || service.snapshot.devices.contains { $0.id == target.id }
  }
}

