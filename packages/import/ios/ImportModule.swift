import AppKit
import ArdiaCore
import ExpoModulesCore

public class ImportModule: Module, ImportNative {
  private let importer: Importer = {
    let support = LaunchConfig.shared.instance("importSourceDir").map { URL(fileURLWithPath: $0, isDirectory: true) }
      ?? FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
    let icons = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0]
      .appendingPathComponent("\(Bundle.main.bundleIdentifier ?? "Ardia")/ImportIcons", isDirectory: true)
    return Importer(discovery: BrowserDiscovery(
      applicationSupport: support,
      diaApp: ImportModule.diaBundleId,
      locateApp: AppIcons.locate,
      iconFor: { app, id in AppIcons.png(for: app, id: id, directory: icons) }
    ))
  }()

  private static let safariHome: URL = {
    let config = LaunchConfig.shared
    if let home = config.instance("importSafariHome") { return URL(fileURLWithPath: home, isDirectory: true) }
    if let support = config.instance("importSourceDir") {
      return URL(fileURLWithPath: support, isDirectory: true).deletingLastPathComponent().deletingLastPathComponent()
    }
    return FileManager.default.homeDirectoryForCurrentUser
  }()

  private static let secret: Importer.SecretProvider = {
    if let fixed = LaunchConfig.shared.testValue("importSecret") {
      return { _, _ in Data(fixed.utf8) }
    }
    return SafeStorageKeychain.secret
  }()

  private static let diaBundleId = LaunchConfig.shared.testValue("importDiaBundleId") ?? DiaAutomation.bundleIdentifier

  private let jobs = ImportJobs()
  private let vault = ImportVault()
  private static let work = DispatchQueue(label: "ardia.import", qos: .userInitiated, attributes: .concurrent)

  func listBrowsers(_ promise: Promise) { self.run(promise) { try Self.json(self.importer.discovery.list()) } }

  func importData(_ jobId: String, _ browserId: String, _ profileId: String, _ kinds: [ImportKind], _ options: ImportRequestOptions, _ promise: Promise) {
    let cancellation = self.jobs.start(jobId)
    let observer = self.observer(jobId: jobId, options: options)
    self.run(promise, job: jobId) {
      var result = try self.importer.importData(browserId: browserId, profileId: profileId, kinds: kinds,
                                                options: options.importOptions, observer: observer, cancellation: cancellation)
      result.vaultToken = self.vault.keep(cookies: result.cookies, addresses: result.addresses, cards: result.cards)
      return try Self.json(result)
    }
  }

  func cancelImport(_ jobId: String) { self.jobs.cancel(jobId) }

  func unlockBrowser(_ browserId: String, _ primaryPassword: String?, _ promise: Promise) {
    self.run(promise) {
      try self.importer.unlock(browserId: browserId, primaryPassword: primaryPassword ?? "", secret: Self.secret)
      return nil
    }
  }

  func isBrowserUnlocked(_ browserId: String) -> Bool { self.importer.isUnlocked(browserId) }

  func forgetUnlockedKeys() {
    self.importer.forgetKeys()
    self.vault.discardAll()
  }

  func writeImported(_ token: String, _ profile: String, _ kinds: [ImportKind], _ promise: Promise) {
    guard let entry = self.vault.take(token) else { return promise.reject("notFound", "Nothing to write; import again") }
    Task { @MainActor in
      promise.resolve(await ImportWriter.write(entry, profile: profile, kinds: Set(kinds)))
    }
  }

  func discardImported(_ token: String) { self.vault.discard(token) }

  func listExtensions(_ browserId: String, _ profileId: String, _ promise: Promise) {
    self.run(promise) {
      guard let def = BrowserDefinition.find(browserId), def.isChromiumBased else { return "[]" }
      return try Self.json(ChromiumExtensions.list(profile: try self.importer.discovery.profileDirectory(def, profileId)))
    }
  }

  func importSafariExport(_ jobId: String, _ path: String, _ promise: Promise) {
    let cancellation = self.jobs.start(jobId)
    self.run(promise, job: jobId) {
      var data = try SafariExport.load(Self.fileURL(path), cancellation: cancellation)
      data.vaultToken = self.vault.keep(cookies: data.cookies, addresses: [], cards: data.cards)
      return try Self.json(data)
    }
  }

  static func safariHasFullDiskAccess() -> Bool { SafariDirect.hasAccess(home: Self.safariHome) }

  static func openFullDiskAccessSettings(_ promise: Promise) {
    let url = URL(string: "x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles")!
    NSWorkspace.shared.open(url)
    promise.resolve(nil)
  }

  func importSafariDirect(_ jobId: String, _ promise: Promise) {
    let cancellation = self.jobs.start(jobId)
    self.run(promise, job: jobId) {
      var data = try SafariDirect.load(home: Self.safariHome, cancellation: cancellation)
      data.vaultToken = self.vault.keep(cookies: data.cookies, addresses: [], cards: data.cards)
      return try Self.json(data)
    }
  }

  func readDiaTabs(_ promise: Promise) {
    self.run(promise) {
      let fixture = LaunchConfig.shared.testValue("importDiaWindows").map { URL(fileURLWithPath: $0) }
      let app = WorkspaceDiaApp(bundleIdentifier: Self.diaBundleId, consent: fixture.map { _ in { .granted } })
      let source: DiaScriptingSource = fixture.map(DiaFixtureWindows.init(url:)) ?? DiaAppleEvents(bundleIdentifier: Self.diaBundleId)
      var result = try DiaTabsFetch.read(app: app, source: source)
      result.favicons = self.importer.favicons(browserId: "dia", pages: result.profiles.flatMap { $0.pinned.map(\.url) + $0.tabs.map(\.url) })
      return try Self.json(result)
    }
  }

  func importBookmarksHTML(_ path: String, _ promise: Promise) { self.run(promise) { try Self.json(NetscapeBookmarks.load(Self.fileURL(path))) } }

  func importPasswordsCSV(_ path: String, _ promise: Promise) { self.run(promise) { try Self.json(PasswordsCSV.load(Self.fileURL(path))) } }

  static func chooseImportFile(_ kind: ImportFileKind, _ promise: Promise) {
    let panel = NSOpenPanel()
    panel.allowsMultipleSelection = false
    switch kind {
    case .safariExport:
      panel.canChooseDirectories = true
      panel.allowedContentTypes = [.zip]
    case .bookmarksHTML:
      panel.allowedContentTypes = [.html]
    case .passwordsCSV:
      panel.allowedContentTypes = [.commaSeparatedText]
    }
    panel.begin { response in promise.resolve(response == .OK ? panel.url?.path : nil) }
  }

  public func definition() -> ModuleDefinition {
    Name(Self.moduleName)
    Self.eventsDefinition

    OnCreate { Self.work.async { SQLiteSnapshot.removeLeftovers() } }

    listBrowsersFunction

    importDataFunction

    cancelImportFunction

    unlockBrowserFunction

    isBrowserUnlockedFunction
    forgetUnlockedKeysFunction

    writeImportedFunction

    discardImportedFunction

    listExtensionsFunction

    importSafariExportFunction

    Self.safariHasFullDiskAccessFunction

    Self.openFullDiskAccessSettingsFunction

    importSafariDirectFunction

    readDiaTabsFunction

    importBookmarksHTMLFunction

    importPasswordsCSVFunction

    Self.chooseImportFileFunction
  }

  private func run(_ promise: Promise, job: String? = nil, _ body: @escaping () throws -> String?) {
    Self.work.async { [jobs] in
      defer { if let job { jobs.finish(job) } }
      do {
        promise.resolve(try body())
      } catch let error as ImportError {
        promise.reject(error.code, error.description)
      } catch {
        promise.reject("unreadable", error.localizedDescription)
      }
    }
  }

  private func observer(jobId: String, options: ImportRequestOptions) -> ImportObserver {
    let stream = options.streamHistory
    let emit: @Sendable ([String: Any?]) -> Void = { [weak self] body in self?.sendEvent("onImportEvent", body) }
    let progress: @Sendable (ImportProgress) -> Void = { p in
      var body: [String: Any?] = ["jobId": jobId, "type": "progress", "kind": p.kind.rawValue,
                                  "phase": p.phase.rawValue, "processed": p.processed]
      if let total = p.total { body["total"] = total }
      emit(body)
    }
    var history: (@Sendable ([HistoryEntry]) -> Void)?
    if stream {
      history = { chunk in emit(["jobId": jobId, "type": "history", "entries": (try? Self.json(chunk)) ?? "[]"]) }
    }
    return ImportObserver(chunkSize: options.chunkSize ?? 1000, progress: progress, history: history)
  }

  static func fileURL(_ path: String) -> URL {
    if path.hasPrefix("file://"), let url = URL(string: path) { return url }
    return URL(fileURLWithPath: (path as NSString).expandingTildeInPath)
  }

  static func json<T: Encodable>(_ value: T) throws -> String {
    String(decoding: try JSONEncoder().encode(value), as: UTF8.self)
  }
}

final class ImportJobs: @unchecked Sendable {
  private let lock = NSLock()
  private var running: [String: Cancellation] = [:]

  func start(_ id: String) -> Cancellation {
    let c = Cancellation()
    lock.withLock { running[id] = c }
    return c
  }

  func cancel(_ id: String) { lock.withLock { running[id] }?.cancel() }
  func finish(_ id: String) { lock.withLock { running[id] = nil } }
}
