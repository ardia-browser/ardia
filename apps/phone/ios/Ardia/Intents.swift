import AppIntents
import ArdiaBrowser
import ArdiaDesign
internal import ArdiaPhoneNative
import CoreSpotlight
import Foundation
import SQLite3

struct SearchWithArdiaIntent: AppIntent {
  static let title: LocalizedStringResource = "Search with Ardia"
  static let description = IntentDescription("Searches the web in Ardia, or opens Ardia ready to type.")
  static let supportedModes: IntentModes = .foreground

  @Parameter(title: "Search", requestValueDialog: "What do you want to search for?")
  var query: String?

  static var parameterSummary: some ParameterSummary {
    Summary("Search the web for \(\.$query)")
  }

  @MainActor
  func perform() async throws -> some IntentResult {
    PhoneSystemLinks.shared.post(.search(query: query?.trimmingCharacters(in: .whitespacesAndNewlines)), source: "intent")
    return .result()
  }
}

struct VoiceSearchIntent: AppIntent {
  static let title: LocalizedStringResource = "Voice Search"
  static let description = IntentDescription("Opens Ardia and starts listening for your search.")
  static let supportedModes: IntentModes = .foreground

  @MainActor
  func perform() async throws -> some IntentResult {
    PhoneSystemLinks.shared.post(.voiceSearch, source: "intent")
    return .result()
  }
}

struct NewIncognitoTabIntent: AppIntent {
  static let title: LocalizedStringResource = "New Incognito Tab"
  static let description = IntentDescription("Opens a tab that isn’t saved to your history or synced.")
  static let supportedModes: IntentModes = .foreground

  @MainActor
  func perform() async throws -> some IntentResult {
    PhoneSystemLinks.shared.post(.incognito, source: "intent")
    return .result()
  }
}

struct OpenURLInArdiaIntent: AppIntent {
  static let title: LocalizedStringResource = "Open in Ardia"
  static let description = IntentDescription("Opens a web page in a new tab in Ardia.")
  static let supportedModes: IntentModes = .foreground

  @Parameter(title: "URL")
  var url: URL

  static var parameterSummary: some ParameterSummary {
    Summary("Open \(\.$url) in Ardia")
  }

  @MainActor
  func perform() async throws -> some IntentResult {
    guard let scheme = url.scheme?.lowercased(), scheme == "http" || scheme == "https" else {
      throw IntentFailure.notWebPage
    }
    PhoneSystemLinks.shared.post(.open(url), source: "intent")
    return .result()
  }
}

struct OpenMacTabsIntent: AppIntent {
  static let title: LocalizedStringResource = "Open Synced Tabs"
  static let description = IntentDescription("Shows the tabs, pinned tabs and Spaces synced from Ardia on your computer.")
  static let supportedModes: IntentModes = .foreground

  @MainActor
  func perform() async throws -> some IntentResult {
    PhoneSystemLinks.shared.post(.macTabs, source: "intent")
    return .result()
  }
}

struct SearchControlIntent: AppIntent {
  static let title: LocalizedStringResource = "Search"
  static let isDiscoverable = false
  static let supportedModes: IntentModes = .foreground

  @MainActor
  func perform() async throws -> some IntentResult {
    PhoneSystemLinks.shared.post(.search(query: nil), source: "shortcut")
    return .result()
  }
}

struct VoiceSearchControlIntent: AppIntent {
  static let title: LocalizedStringResource = "Voice Search"
  static let isDiscoverable = false
  static let supportedModes: IntentModes = .foreground

  @MainActor
  func perform() async throws -> some IntentResult {
    PhoneSystemLinks.shared.post(.voiceSearch, source: "shortcut")
    return .result()
  }
}

struct IncognitoControlIntent: AppIntent {
  static let title: LocalizedStringResource = "New Incognito Tab"
  static let isDiscoverable = false
  static let supportedModes: IntentModes = .foreground

  @MainActor
  func perform() async throws -> some IntentResult {
    PhoneSystemLinks.shared.post(.incognito, source: "shortcut")
    return .result()
  }
}

enum IntentFailure: Error, CustomLocalizedStringResourceConvertible {
  case notWebPage
  case tabGone

  var localizedStringResource: LocalizedStringResource {
    switch self {
    case .notWebPage: "Ardia opens web pages that start with http or https."
    case .tabGone: "That tab isn’t open anymore."
    }
  }
}

struct ArdiaShortcuts: AppShortcutsProvider {
  static let shortcutTileColor: ShortcutTileColor = .navy

  static var appShortcuts: [AppShortcut] {
    AppShortcut(
      intent: SearchWithArdiaIntent(),
      phrases: [
        "Search with \(.applicationName)",
        "Start a Search with \(.applicationName)",
        "Search the web with \(.applicationName)",
      ],
      shortTitle: "Search",
      systemImageName: "magnifyingglass"
    )
    AppShortcut(
      intent: VoiceSearchIntent(),
      phrases: [
        "Voice Search with \(.applicationName)",
        "Start a Voice Search with \(.applicationName)",
      ],
      shortTitle: "Voice Search",
      systemImageName: "waveform.badge.magnifyingglass"
    )
    AppShortcut(
      intent: OpenMacTabsIntent(),
      phrases: [
        "Show my synced tabs in \(.applicationName)",
        "Open my synced tabs in \(.applicationName)",
      ],
      shortTitle: "Synced Tabs",
      systemImageName: "laptopcomputer"
    )
    AppShortcut(
      intent: OpenTabIntent(),
      phrases: [
        "Open \(\.$target) in \(.applicationName)",
        "Switch to \(\.$target) in \(.applicationName)",
      ],
      shortTitle: "Open Tab",
      systemImageName: "square.on.square"
    )
    AppShortcut(
      intent: NewIncognitoTabIntent(),
      phrases: [
        "Open an Incognito tab in \(.applicationName)",
        "New Incognito tab in \(.applicationName)",
      ],
      shortTitle: "Incognito Tab",
      systemImageName: "eyes"
    )
  }
}

struct StoredTab: Sendable {
  let id: String
  let title: String
  let url: String
  let lastActive: Date
  let archivedAt: Date?
}

enum TabRecords {
  static var database: URL { URL.documentsDirectory.appending(path: "SQLite/browser.db") }
  static let columns = "id, title, url, lastActive, archivedAt"

  static func openTabs() -> [StoredTab] {
    read("SELECT \(columns) FROM tabs WHERE archivedAt IS NULL ORDER BY lastActive DESC", [])
  }

  static func archivedTabs(limit: Int) -> [StoredTab] {
    read("SELECT \(columns) FROM tabs WHERE archivedAt IS NOT NULL ORDER BY archivedAt DESC LIMIT \(max(limit, 0))", [])
  }

  static func tabs(_ ids: [String]) -> [StoredTab] {
    guard !ids.isEmpty else { return [] }
    let marks = Array(repeating: "?", count: ids.count).joined(separator: ", ")
    return read("SELECT \(columns) FROM tabs WHERE id IN (\(marks))", ids.map { $0.lowercased() })
  }

  private static func read(_ sql: String, _ values: [String]) -> [StoredTab] {
    var db: OpaquePointer?
    guard sqlite3_open_v2(database.path(percentEncoded: false), &db, SQLITE_OPEN_READONLY, nil) == SQLITE_OK, let db else {
      if let db { sqlite3_close_v2(db) }
      return []
    }
    defer { sqlite3_close_v2(db) }
    sqlite3_busy_timeout(db, 1_000)
    var statement: OpaquePointer?
    guard sqlite3_prepare_v2(db, sql, -1, &statement, nil) == SQLITE_OK, let statement else { return [] }
    defer { sqlite3_finalize(statement) }
    let transient = unsafeBitCast(-1, to: sqlite3_destructor_type.self)
    for (index, value) in values.enumerated() {
      sqlite3_bind_text(statement, Int32(index + 1), value, -1, transient)
    }
    var rows: [StoredTab] = []
    while sqlite3_step(statement) == SQLITE_ROW {
      func text(_ column: Int32) -> String {
        sqlite3_column_text(statement, column).map { String(cString: $0) } ?? ""
      }
      func date(_ column: Int32) -> Date? {
        sqlite3_column_type(statement, column) == SQLITE_NULL ? nil : Date(timeIntervalSince1970: sqlite3_column_double(statement, column) / 1000)
      }
      rows.append(StoredTab(id: text(0), title: text(1), url: text(2), lastActive: date(3) ?? .distantPast, archivedAt: date(4)))
    }
    return rows
  }
}

@AppEntity(schema: .browser.tab)
struct TabEntity: IndexedEntity {
  static let defaultQuery = TabEntityQuery()

  let id: String

  @Property(title: "Title")
  var name: String

  @Property(title: "URL")
  var url: URL?

  @Property(title: "Archived")
  var isArchived: Bool

  @Property(title: "Private")
  var isPrivate: Bool

  var lastActive: Date

  init(id: String, title: String, url: URL?, isArchived: Bool, lastActive: Date) {
    self.id = id
    self.lastActive = lastActive
    self.name = title
    self.url = url
    self.isArchived = isArchived
    self.isPrivate = false
  }

  init(_ tab: StoredTab) {
    self.init(id: tab.id, title: tab.title, url: URL(string: tab.url), isArchived: tab.archivedAt != nil, lastActive: tab.lastActive)
  }

  var host: String? {
    url.flatMap { BrowserURL.host(of: $0.absoluteString) }
  }

  var displayTitle: String {
    let trimmed = name.trimmingCharacters(in: .whitespacesAndNewlines)
    return trimmed.isEmpty ? (host ?? String(localized: "Untitled")) : trimmed
  }

  var subtitle: String {
    let place = host ?? ""
    guard isArchived else { return place }
    return place.isEmpty ? String(localized: "Archived") : String(localized: "Archived · \(place)")
  }

  var displayRepresentation: DisplayRepresentation {
    DisplayRepresentation(
      title: "\(displayTitle)",
      subtitle: "\(subtitle)",
      image: DisplayRepresentation.Image(systemName: isArchived ? "archivebox" : "globe")
    )
  }

  var attributeSet: CSSearchableItemAttributeSet {
    let attributes = defaultAttributeSet
    attributes.title = displayTitle
    attributes.contentDescription = subtitle
    if let url {
      attributes.url = url
      attributes.contentURL = url
    }
    if let host { attributes.keywords = [host] }
    attributes.lastUsedDate = lastActive
    return attributes
  }
}

struct TabEntityQuery: EntityStringQuery {
  static let archiveSearchLimit = 30
  static let archiveScan = 500

  func entities(for identifiers: [TabEntity.ID]) async throws -> [TabEntity] {
    TabRecords.tabs(identifiers).map(TabEntity.init)
  }

  func suggestedEntities() async throws -> [TabEntity] {
    TabRecords.openTabs().map(TabEntity.init)
  }

  func entities(matching string: String) async throws -> [TabEntity] {
    let needle = string.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !needle.isEmpty else { return try await suggestedEntities() }
    let matches = { (tab: StoredTab) in tab.title.localizedStandardContains(needle) || tab.url.localizedStandardContains(needle) }
    let open = TabRecords.openTabs().filter(matches)
    let openIDs = Set(open.map(\.id))
    let archived = TabRecords.archivedTabs(limit: Self.archiveScan).filter { !openIDs.contains($0.id) && matches($0) }.prefix(Self.archiveSearchLimit)
    return (open + archived).map(TabEntity.init)
  }
}

struct OpenTabIntent: OpenIntent {
  static let title: LocalizedStringResource = "Open Tab"
  static let description = IntentDescription("Switches to one of your tabs in Ardia, or brings an archived tab back.")
  static let supportedModes: IntentModes = .foreground

  @Parameter(title: "Tab")
  var target: TabEntity

  @MainActor
  func perform() async throws -> some IntentResult {
    guard !TabRecords.tabs([target.id]).isEmpty else { throw IntentFailure.tabGone }
    PhoneSystemLinks.shared.openTab(target.id, source: "intent")
    return .result()
  }
}

@MainActor
final class SpotlightIndexer {
  static let shared = SpotlightIndexer()
  static let fingerprintsKey = "system.spotlight.tabs"
  static let archiveLimit = 500
  static let debounce: Duration = .seconds(1.5)

  private var pending: Task<Void, Never>?

  func update() {
    guard !PhoneTestBuild.isDemo, CSSearchableIndex.isIndexingAvailable() else { return }
    pending?.cancel()
    pending = Task { [weak self] in
      try? await Task.sleep(for: Self.debounce)
      guard !Task.isCancelled, let self else { return }
      let entities = await Task.detached(priority: .utility) { Self.entities() }.value
      await self.reindex(entities)
    }
  }

  nonisolated static func entities() -> [TabEntity] {
    let open = TabRecords.openTabs()
    let openIDs = Set(open.map(\.id))
    let archived = TabRecords.archivedTabs(limit: archiveLimit).filter { !openIDs.contains($0.id) }
    return (open + archived).filter { BrowserURL.isSyncable($0.url) }.map(TabEntity.init)
  }

  private func reindex(_ entities: [TabEntity]) async {
    let defaults = UserDefaults.standard
    let previous = defaults.dictionary(forKey: Self.fingerprintsKey) as? [String: String]
    var current: [String: String] = [:]
    for entity in entities { current[entity.id] = Self.fingerprint(entity) }
    let changed = entities.filter { previous?[$0.id] != current[$0.id] }
    let removed = (previous ?? [:]).keys.filter { current[$0] == nil }
    do {
      if previous == nil {
        try await CSSearchableIndex.default().deleteAppEntities(ofType: TabEntity.self)
      } else if !removed.isEmpty {
        try await CSSearchableIndex.default().deleteAppEntities(identifiedBy: Array(removed), ofType: TabEntity.self)
      }
      if !changed.isEmpty {
        try await CSSearchableIndex.default().indexAppEntities(changed)
      }
    } catch {
      return
    }
    defaults.set(current, forKey: Self.fingerprintsKey)
    if !changed.isEmpty || !removed.isEmpty {
      ArdiaShortcuts.updateAppShortcutParameters()
    }
  }

  static func fingerprint(_ entity: TabEntity) -> String {
    var hash: UInt64 = 0xCBF2_9CE4_8422_2325
    let text = [entity.name, entity.url?.absoluteString ?? "", entity.isArchived ? "1" : "0"].joined(separator: "\u{1}")
    for byte in text.utf8 {
      hash ^= UInt64(byte)
      hash = hash &* 0x0000_0100_0000_01B3
    }
    return String(hash, radix: 16)
  }
}
