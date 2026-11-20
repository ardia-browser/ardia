import ArdiaBrowser
import ExpoModulesCore
import Foundation
import PhoneSync
import SQLite3
import SwiftData

enum LegacyPaths {
  static let migratedPrefixes = ["blocking.", "browsing.", "filters.", "library.", "reader.", "settings.", "tabs."]
  static let nativePrefixes = ["blocking.", "browsing.", "filters."]
  static let pagesSuite = "ardia.phone.pages"

  static var storeFolder: URL {
    if let group = FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: BrowserStore.appGroupIdentifier) {
      return group.appending(path: "Library/Application Support", directoryHint: .isDirectory)
    }
    return URL.applicationSupportDirectory.appending(path: "Ardia", directoryHint: .isDirectory)
  }

  static var store: URL { storeFolder.appending(path: "Browser.store") }

  static var syncFolder: URL { URL.applicationSupportDirectory.appending(path: "PhoneSync", directoryHint: .isDirectory) }

  static var settingsReceipt: URL { syncFolder.appending(path: "legacy-settings.json") }

  static var labUnusableFlag: URL { syncFolder.appending(path: "lab-legacy-unusable") }

  static var gate: LegacyImportGate {
    LegacyImportGate(legacyStores: [store], marker: syncFolder.appending(path: "legacy-imported.json"), hasLegacyPreferences: { !legacyPreferences().isEmpty })
  }

  static func legacyPreferences() -> [String: Any] {
    UserDefaults.standard.dictionaryRepresentation().filter { key, _ in migratedPrefixes.contains(where: key.hasPrefix) }
  }
}

enum LegacyFailure: Error, CustomStringConvertible {
  case locked
  case corrupt
  case schema
  case io
  case settings
  case receipt
  case labOnly

  var description: String {
    switch self {
    case .locked: "locked"
    case .corrupt: "corrupt"
    case .schema: "schema"
    case .io: "io"
    case .settings: "the old settings could not be applied"
    case .receipt: "the import receipt is not valid"
    case .labOnly: "making the old app's data unusable is a test-build switch"
    }
  }
}

enum LegacySettings {
  struct Receipt: Codable {
    var version: Int
    var keys: Int
  }

  static var applied: Bool {
    guard let data = try? Data(contentsOf: LegacyPaths.settingsReceipt), let receipt = try? JSONDecoder().decode(Receipt.self, from: data) else { return false }
    return receipt.version == 1 && receipt.keys >= 0
  }

  @discardableResult
  static func apply() throws -> Int {
    if applied { return 0 }
    guard let suite = UserDefaults(suiteName: LegacyPaths.pagesSuite) else { throw LegacyFailure.settings }
    let values = UserDefaults.standard.dictionaryRepresentation().filter { key, _ in LegacyPaths.nativePrefixes.contains(where: key.hasPrefix) }
    for (key, value) in values { suite.set(value, forKey: key) }
    for (key, value) in values {
      guard let stored = suite.object(forKey: key), (stored as AnyObject).isEqual(value) else { throw LegacyFailure.settings }
    }
    do {
      try FileManager.default.createDirectory(at: LegacyPaths.syncFolder, withIntermediateDirectories: true)
      try JSONEncoder().encode(Receipt(version: 1, keys: values.count)).write(to: LegacyPaths.settingsReceipt, options: .atomic)
    } catch {
      throw LegacyFailure.settings
    }
    guard applied else { throw LegacyFailure.settings }
    return values.count
  }

  static func applyAtLaunch() {
    let gate = LegacyPaths.gate
    guard !gate.released, gate.hasLegacyData, !applied else { return }
    do {
      try apply()
    } catch {
      NSLog("ARDIA_LEGACY settings not applied at launch: %@", String(describing: error))
    }
  }
}

final class LegacySnapshot: @unchecked Sendable {
  static let shared = LegacySnapshot()

  private let lock = NSLock()
  private var folder: URL?
  private var container: ModelContainer?

  func open() throws -> ModelContainer {
    try lock.withLock {
      if let container { return container }
      Self.removeLeftoverCopies()
      let copy = URL.temporaryDirectory.appending(path: "\(Self.copyPrefix)\(UUID().uuidString)", directoryHint: .isDirectory)
      do {
        try FileManager.default.createDirectory(at: copy, withIntermediateDirectories: true)
        try Self.backup(from: LegacyPaths.store, to: copy.appending(path: "Browser.store"))
        let support = LegacyPaths.storeFolder.appending(path: ".Browser_SUPPORT", directoryHint: .isDirectory)
        if FileManager.default.fileExists(atPath: support.path(percentEncoded: false)) {
          try FileManager.default.copyItem(at: support, to: copy.appending(path: ".Browser_SUPPORT", directoryHint: .isDirectory))
        }
        let made = try BrowserStore.makeContainer(.directory(copy))
        folder = copy
        container = made
        return made
      } catch let failure as LegacyFailure {
        try? FileManager.default.removeItem(at: copy)
        throw failure
      } catch {
        try? FileManager.default.removeItem(at: copy)
        throw LegacyFailure.schema
      }
    }
  }

  static let copyPrefix = "LegacyBrowserStore-"

  static func removeLeftoverCopies() {
    let manager = FileManager.default
    guard let names = try? manager.contentsOfDirectory(atPath: URL.temporaryDirectory.path(percentEncoded: false)) else { return }
    for name in names where name.hasPrefix(copyPrefix) {
      try? manager.removeItem(at: URL.temporaryDirectory.appending(path: name, directoryHint: .isDirectory))
    }
  }

  func close() {
    lock.withLock {
      container = nil
      if let folder { try? FileManager.default.removeItem(at: folder) }
      folder = nil
    }
  }

  static func backup(from source: URL, to destination: URL) throws {
    var input: OpaquePointer?
    let uri = "file:\(source.path(percentEncoded: true))?mode=ro"
    guard sqlite3_open_v2(uri, &input, SQLITE_OPEN_READONLY | SQLITE_OPEN_URI, nil) == SQLITE_OK, let input else {
      if let input { sqlite3_close_v2(input) }
      throw LegacyFailure.io
    }
    defer { sqlite3_close_v2(input) }
    sqlite3_busy_timeout(input, 5_000)
    var output: OpaquePointer?
    guard sqlite3_open_v2(destination.path(percentEncoded: false), &output, SQLITE_OPEN_READWRITE | SQLITE_OPEN_CREATE, nil) == SQLITE_OK, let output else {
      if let output { sqlite3_close_v2(output) }
      throw LegacyFailure.io
    }
    defer { sqlite3_close_v2(output) }
    guard let backup = sqlite3_backup_init(output, "main", input, "main") else { throw LegacyFailure.io }
    let deadline = Date.now.addingTimeInterval(10)
    var result = SQLITE_OK
    repeat {
      result = sqlite3_backup_step(backup, -1)
      if result == SQLITE_BUSY || result == SQLITE_LOCKED { usleep(100_000) }
    } while (result == SQLITE_BUSY || result == SQLITE_LOCKED) && Date.now < deadline
    sqlite3_backup_finish(backup)
    switch result {
    case SQLITE_DONE: break
    case SQLITE_BUSY, SQLITE_LOCKED: throw LegacyFailure.locked
    case SQLITE_CORRUPT, SQLITE_NOTADB: throw LegacyFailure.corrupt
    default: throw LegacyFailure.io
    }
    var check: OpaquePointer?
    defer { sqlite3_finalize(check) }
    guard sqlite3_prepare_v2(output, "PRAGMA quick_check", -1, &check, nil) == SQLITE_OK, sqlite3_step(check) == SQLITE_ROW,
          let text = sqlite3_column_text(check, 0), String(cString: text) == "ok"
    else { throw LegacyFailure.corrupt }
  }
}

enum LegacyReader {
  static func source() -> [String: Any] {
    let gate = LegacyPaths.gate
    switch gate.outcome {
    case .imported: return ["kind": "done", "outcome": "imported"]
    case .startedFresh: return ["kind": "done", "outcome": "startedFresh"]
    case nil: break
    }
    if PhoneTestBuild.isOn, FileManager.default.fileExists(atPath: LegacyPaths.labUnusableFlag.path(percentEncoded: false)) {
      return ["kind": "unusable", "reason": "io"]
    }
    let store = gate.storePresence
    if store == .unreadable { return ["kind": "unusable", "reason": "io"] }
    if store == .absent {
      return LegacyPaths.legacyPreferences().isEmpty ? ["kind": "none"] : ["kind": "pending", "counts": ["tabs": 0, "archive": 0, "visits": 0]]
    }
    do {
      let context = ModelContext(try LegacySnapshot.shared.open())
      let tabs = try context.fetch(FetchDescriptor<BrowserTab>())
      let visits = try context.fetchCount(FetchDescriptor<Visit>())
      return ["kind": "pending", "counts": ["tabs": tabs.filter { !$0.isArchived }.count, "archive": tabs.filter(\.isArchived).count, "visits": visits]]
    } catch let failure as LegacyFailure {
      return ["kind": "unusable", "reason": failure.description]
    } catch {
      return ["kind": "unusable", "reason": "corrupt"]
    }
  }

  static func read() throws -> [String: Any] {
    var result: [String: Any] = ["preferences": preferenceStrings(), "tabs": [Any](), "archive": [Any](), "selectedTabId": NSNull()]
    switch LegacyPaths.gate.storePresence {
    case .absent: return result
    case .unreadable: throw LegacyFailure.io
    case .present: break
    }
    let context = ModelContext(try LegacySnapshot.shared.open())
    let tabs = try context.fetch(FetchDescriptor<BrowserTab>())
    let open = tabs.filter { !$0.isArchived }.sorted { $0.position < $1.position }
    let archived = tabs.filter(\.isArchived).sorted { ($0.archivedAt ?? .distantPast) > ($1.archivedAt ?? .distantPast) }
    result["tabs"] = open.map(tab)
    result["archive"] = archived.map(tab)
    result["selectedTabId"] = open.max { $0.lastActive < $1.lastActive }?.id.uuidString.lowercased() ?? NSNull()
    return result
  }

  static func visits(after: Int, limit: Int) throws -> [String: Any] {
    let size = max(1, min(limit, 5_000))
    let start = max(0, after)
    guard LegacyPaths.gate.storePresence == .present else { return ["visits": [Any](), "next": NSNull()] }
    let context = ModelContext(try LegacySnapshot.shared.open())
    var descriptor = FetchDescriptor<Visit>(sortBy: [SortDescriptor(\.visitedAt), SortDescriptor(\.url), SortDescriptor(\.title)])
    descriptor.fetchOffset = start
    descriptor.fetchLimit = size + 1
    let page = try context.fetch(descriptor)
    let kept = page.prefix(size).enumerated().map { index, item -> [String: Any] in
      var fields = visit(item)
      fields["id"] = start + index + 1
      return fields
    }
    return ["visits": kept, "next": page.count > size ? start + size : NSNull()]
  }

  static let jsonPreferenceKeys: Set<String> = ["library.hiddenHistory"]

  static func preferenceStrings() -> [String: String] {
    var strings: [String: String] = [:]
    for (key, value) in LegacyPaths.legacyPreferences() {
      switch value {
      case let text as String: strings[key] = text
      case let number as NSNumber:
        strings[key] = CFGetTypeID(number) == CFBooleanGetTypeID() ? (number.boolValue ? "true" : "false") : number.stringValue
      case let dictionary as [String: Any] where jsonPreferenceKeys.contains(key):
        if JSONSerialization.isValidJSONObject(dictionary), let data = try? JSONSerialization.data(withJSONObject: dictionary, options: [.sortedKeys]) {
          strings[key] = String(decoding: data, as: UTF8.self)
        }
      default: continue
      }
    }
    return strings
  }

  private static func tab(_ tab: BrowserTab) -> [String: Any] {
    var fields: [String: Any] = [
      "id": tab.id.uuidString,
      "url": tab.url,
      "title": tab.title,
      "created": milliseconds(tab.created),
      "lastActive": milliseconds(tab.lastActive),
      "position": tab.position,
      "origin": tab.originRawValue,
    ]
    if let archivedAt = tab.archivedAt { fields["archivedAt"] = milliseconds(archivedAt) }
    if let profile = tab.profileSyncId { fields["profileSyncId"] = profile }
    if let state = tab.interactionState { fields["savedState"] = state.base64EncodedString() }
    if let favicon = tab.faviconURL { fields["faviconUrl"] = favicon }
    if let theme = tab.themeColorHex { fields["themeColor"] = theme }
    if let name = tab.snapshotFileName, let path = ownThumbnail(named: name, tabID: tab.id) { fields["snapshotPath"] = path }
    if let key = tab.receivedKey { fields["receivedKey"] = key }
    if let device = tab.receivedFromDevice { fields["receivedFromDevice"] = device }
    return fields
  }

  static func ownThumbnail(named name: String, tabID: UUID) -> String? {
    guard !name.isEmpty, !name.contains("/"), !name.hasPrefix("."), !name.hasPrefix("memory") else { return nil }
    let folder = URL.cachesDirectory.appending(path: "TabSnapshots", directoryHint: .isDirectory).standardizedFileURL
    let source = folder.appending(path: name).standardizedFileURL
    guard source.deletingLastPathComponent() == folder,
          (try? source.resourceValues(forKeys: [.isRegularFileKey]))?.isRegularFile == true
    else { return nil }
    let target = PageSnapshots.saved.appending(path: "\(PageSnapshots.fileStem(tabID.uuidString.lowercased()))-legacy.jpg")
    let manager = FileManager.default
    if !manager.fileExists(atPath: target.path(percentEncoded: false)) {
      do {
        try manager.createDirectory(at: PageSnapshots.saved, withIntermediateDirectories: true)
        try manager.copyItem(at: source, to: target)
      } catch {
        return nil
      }
    }
    return target.path(percentEncoded: false)
  }

  private static func visit(_ visit: Visit) -> [String: Any] {
    var fields: [String: Any] = [
      "url": visit.url,
      "title": visit.title,
      "visitedAt": milliseconds(visit.visitedAt),
      "transition": visit.transitionRawValue,
    ]
    if let profile = visit.profileSyncId { fields["profileSyncId"] = profile }
    return fields
  }

  private static func milliseconds(_ date: Date) -> Double { (date.timeIntervalSince1970 * 1000).rounded() }

  static func receipt(_ value: [String: Any]?) throws -> LegacyImportGate.Receipt? {
    guard let value else { return nil }
    guard (value["version"] as? NSNumber)?.intValue == 1,
          let tabs = (value["tabs"] as? NSNumber)?.intValue, let archive = (value["archive"] as? NSNumber)?.intValue,
          let visits = (value["visits"] as? NSNumber)?.intValue, let preferences = (value["preferences"] as? NSNumber)?.intValue,
          [tabs, archive, visits, preferences].allSatisfy({ $0 >= 0 })
    else { throw LegacyFailure.receipt }
    return LegacyImportGate.Receipt(tabs: tabs, archive: archive, visits: visits, preferences: preferences)
  }

  static func markImported(_ receipt: LegacyImportGate.Receipt?) throws {
    try LegacySettings.apply()
    try LegacyPaths.gate.markImported(receipt: receipt, settingsApplied: LegacySettings.applied)
    LegacySnapshot.shared.close()
  }

  static func setLabUnusable(_ on: Bool) throws {
    guard PhoneTestBuild.isOn else { throw LegacyFailure.labOnly }
    if on {
      try FileManager.default.createDirectory(at: LegacyPaths.syncFolder, withIntermediateDirectories: true)
      try Data("io".utf8).write(to: LegacyPaths.labUnusableFlag, options: .atomic)
    } else if FileManager.default.fileExists(atPath: LegacyPaths.labUnusableFlag.path(percentEncoded: false)) {
      try FileManager.default.removeItem(at: LegacyPaths.labUnusableFlag)
    }
  }

  static func startFresh() throws {
    try LegacyPaths.gate.startFresh()
    LegacySnapshot.shared.close()
  }
}

public final class LegacyModule: Module {
  static func releaseSync() {
    DispatchQueue.main.async { MainActor.assumeIsolated { PhoneSyncHost.shared.legacyImportFinished() } }
  }

  public func definition() -> ModuleDefinition {
    Name("ArdiaPhoneLegacy")

    AsyncFunction("source") { () -> [String: Any] in
      LegacyReader.source()
    }

    AsyncFunction("readLegacy") { () throws -> [String: Any] in
      try LegacyReader.read()
    }

    AsyncFunction("readVisits") { (afterId: Int, limit: Int) throws -> [String: Any] in
      try LegacyReader.visits(after: afterId, limit: limit)
    }

    AsyncFunction("applyNativeSettings") { () throws in
      try LegacySettings.apply()
    }

    AsyncFunction("markImportedWith") { (receipt: [String: Any]) throws in
      try LegacyReader.markImported(try LegacyReader.receipt(receipt))
      Self.releaseSync()
    }

    AsyncFunction("startFresh") { () throws in
      try LegacyReader.startFresh()
      Self.releaseSync()
    }

    Function("labSetUnusable") { (on: Bool) throws in
      try LegacyReader.setLabUnusable(on)
    }
  }
}
