import CommonCrypto
import CryptoKit
import Foundation

public struct DiaSidebar: Equatable {
  public var spaces: [SpaceSuggestion] = []
  public var primarySpaceId: String?

  static let fileName = "tabs.db"
  static let kinds: [ImportKind] = [.tabs, .pinnedTabs, .favorites]
  static let splitRole = "split"

  public static func exists(profile: URL) -> Bool {
    FileManager.default.fileExists(atPath: profile.appendingPathComponent(fileName).path)
  }

  public static func load(profile dir: URL, folder: String, rootKey: Data) throws -> DiaSidebar {
    let file = dir.appendingPathComponent(fileName)
    guard FileManager.default.fileExists(atPath: file.path) else { throw ImportError.notFound("Dia keeps no sidebar file in this profile") }
    let key = DiaDatabase.key(rootKey: rootKey, label: DiaDatabase.label(profile: folder, name: "tabs"))
    let snapshot = try SQLiteSnapshot(memory: try DiaDatabase.decrypt(file, key: key), name: fileName)
    return try read(snapshot, profileId: folder)
  }

  struct Node {
    var id: Int64
    var kind: String
    var space: String
  }

  struct Pane {
    var url: String
    var title: String
    var customTitle: String?
  }

  struct Group {
    var title: String
    var icon: String?
    var color: String?
  }

  static func read(_ db: SQLiteSnapshot, profileId: String) throws -> DiaSidebar {
    guard db.tableExists("nodes") else { throw ImportError.unreadable("Dia's sidebar file has no tabs") }
    var children: [Int64: [Node]] = [:]
    var roots: [Node] = []
    var nodeOfEntity: [String: Int64] = [:]
    var seen = Set<Int64>()
    try db.query("SELECT id, kind, entity_id, parent_id, space_id FROM nodes WHERE deleted_at IS NULL ORDER BY \"order\", id") { row in
      guard let id = row.int("id"), let kind = row.text("kind"), seen.insert(id).inserted else { return true }
      let node = Node(id: id, kind: kind, space: row.text("space_id") ?? "")
      if let entity = row.text("entity_id") { nodeOfEntity["\(kind):\(entity)"] = id }
      if let parent = row.int("parent_id") { children[parent, default: []].append(node) } else { roots.append(node) }
      return true
    }

    var groups: [Int64: Group] = [:]
    if db.tableExists("tab_groups") {
      try db.query("SELECT * FROM tab_groups") { row in
        guard let node = row.int("node_id") ?? row.text("id").flatMap({ nodeOfEntity["group:\($0)"] }) else { return true }
        groups[node] = Group(title: row.text("title") ?? "", icon: emoji(row.text("icon")), color: groupColor(row.text("theme")))
        return true
      }
    }

    var panes: [Int64: Pane] = [:]
    if db.tableExists("content_panes"), db.tableExists("web_contents") {
      try db.query("""
        SELECT p.*, w.url AS page_url, w.title AS page_title FROM content_panes p
        JOIN web_contents w ON w.content_pane_id = p.id ORDER BY w.id
        """) { row in
        guard let node = row.int("node_id") ?? row.text("id").flatMap({ nodeOfEntity["content_pane:\($0)"] }),
              let url = row.text("page_url")?.trimmingCharacters(in: .whitespacesAndNewlines), URL.isWebURL(url) else { return true }
        let custom = row.text("custom_title").flatMap { $0.isEmpty ? nil : $0 }
        panes[node] = Pane(url: url, title: row.text("page_title") ?? "", customTitle: custom)
        return true
      }
    }

    var spaceOrder: [String] = []
    var spaceRows: [String: (title: String, theme: String?)] = [:]
    if db.tableExists("spaces") {
      try db.query("SELECT * FROM spaces ORDER BY creation_date, id") { row in
        guard let id = row.text("id") else { return true }
        spaceOrder.append(id)
        spaceRows[id] = (row.text("title") ?? "", row.text("theme"))
        return true
      }
    }
    for node in roots where !spaceOrder.contains(node.space) { spaceOrder.append(node.space) }

    let tree = Tree(children: children, groups: groups, panes: panes)
    var looseOf: [String: [ImportedTab]] = [:]
    var openGroupsOf: [String: [BookmarkNode]] = [:]
    var windowsOf: [String: Int] = [:]
    for window in roots where window.kind == "window" {
      let index = windowsOf[window.space, default: 0]
      windowsOf[window.space] = index + 1
      for child in tree.children[window.id] ?? [] {
        let space = child.space.isEmpty ? window.space : child.space
        switch child.kind {
        case "tab":
          let found = tree.panes(of: child.id)
          for pane in found {
            looseOf[space, default: []].append(ImportedTab(url: pane.url, title: pane.title, customTitle: pane.customTitle,
                                                           splitId: found.count >= 2 ? "dia-\(child.id)" : nil, windowIndex: index))
          }
        case "group":
          if let folder = tree.folder(child.id) { openGroupsOf[space, default: []].append(folder) }
        default:
          continue
        }
        if !spaceOrder.contains(space) { spaceOrder.append(space) }
      }
    }

    var out = DiaSidebar()
    out.primarySpaceId = spaceOrder.first.map { $0.isEmpty ? "dia-\(profileId)" : $0 }
    var untitled = 0
    for spaceId in spaceOrder {
      let containers = roots.filter { $0.space == spaceId }
      let favorites = containers.filter { $0.kind == "favorites" }.flatMap { tree.flatTabs($0.id, pinned: true) }
      let pinned = containers.filter { $0.kind == "pinned_container" }.flatMap { tree.bookmarks($0.id) }
      let loose = looseOf[spaceId] ?? []
      let openGroups = openGroupsOf[spaceId] ?? []
      guard !(favorites.isEmpty && pinned.isEmpty && loose.isEmpty && openGroups.isEmpty) else { continue }
      let row = spaceRows[spaceId]
      let name: String
      if let title = row?.title, !title.isEmpty {
        name = title
      } else {
        untitled += 1
        name = "Space \(untitled)"
      }
      out.spaces.append(SpaceSuggestion(
        id: spaceId.isEmpty ? "dia-\(profileId)" : spaceId,
        name: name,
        color: spaceColor(row?.theme),
        colors: nil,
        emoji: nil,
        icon: nil,
        profileId: profileId,
        pinned: pinned,
        tabs: loose,
        openGroups: openGroups,
        favorites: favorites
      ))
    }
    return out
  }

  struct Tree {
    var children: [Int64: [Node]]
    var groups: [Int64: Group]
    var paneData: [Int64: Pane]

    init(children: [Int64: [Node]], groups: [Int64: Group], panes: [Int64: Pane]) {
      self.children = children
      self.groups = groups
      paneData = panes
    }

    func panes(of tab: Int64) -> [Pane] {
      (children[tab] ?? []).filter { $0.kind == "content_pane" }.compactMap { paneData[$0.id] }
    }

    static func link(_ pane: Pane) -> BookmarkNode {
      var link = BookmarkNode.link(pane.customTitle ?? pane.title, pane.url)
      if pane.customTitle != nil { link.pageTitle = pane.title }
      return link
    }

    func bookmarks(_ parent: Int64, depth: Int = 0) -> [BookmarkNode] {
      guard depth < 64 else { return [] }
      return (children[parent] ?? []).flatMap { child -> [BookmarkNode] in
        switch child.kind {
        case "tab":
          let found = panes(of: child.id)
          if found.count >= 2 { return [.folder("", found.map(Self.link), role: DiaSidebar.splitRole)] }
          return found.map(Self.link)
        case "group":
          return folder(child.id, depth: depth).map { [$0] } ?? []
        default:
          return []
        }
      }
    }

    func folder(_ id: Int64, depth: Int = 0) -> BookmarkNode? {
      let kids = bookmarks(id, depth: depth + 1)
      guard !kids.isEmpty else { return nil }
      let group = groups[id]
      var folder = BookmarkNode.folder(group.map { $0.title.isEmpty ? "Group" : $0.title } ?? "Group", kids)
      folder.icon = group?.icon
      folder.color = group?.color
      return folder
    }

    func flatTabs(_ parent: Int64, pinned: Bool, depth: Int = 0) -> [ImportedTab] {
      guard depth < 64 else { return [] }
      return (children[parent] ?? []).flatMap { child -> [ImportedTab] in
        switch child.kind {
        case "tab":
          return panes(of: child.id).map { ImportedTab(url: $0.url, title: $0.title, pinned: pinned, customTitle: $0.customTitle) }
        case "group":
          return flatTabs(child.id, pinned: pinned, depth: depth + 1)
        default:
          return []
        }
      }
    }
  }

  static func emoji(_ json: String?) -> String? {
    guard let data = json?.data(using: .utf8),
          let icon = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
          let emoji = icon["emoji"] as? String, !emoji.isEmpty, emoji.count <= 4 else { return nil }
    return emoji
  }

  static let groupColors: [String: String] = [
    "red": "red", "orange": "orange", "yellow": "yellow", "green": "green", "mint": "green", "teal": "cyan",
    "cyan": "cyan", "blue": "blue", "indigo": "purple", "purple": "purple", "pink": "pink", "gray": "grey", "grey": "grey",
  ]

  static func groupColor(_ theme: String?) -> String? {
    theme.flatMap { groupColors[$0.lowercased()] }
  }

  static let spaceColors: [String: String] = [
    "red": "#E5534B", "orange": "#EE8434", "yellow": "#E3B341", "green": "#3FB06C", "blue": "#4C8DF6",
    "purple": "#9B6CF0", "pink": "#DB61A2",
  ]

  static func spaceColor(_ theme: String?) -> String? {
    theme.flatMap { spaceColors[$0.lowercased()] }
  }
}

enum DiaDatabase {
  static let saltKey = Data(base64Encoded: "iOe1Ue/XtonbieE/5m1nAgewvWQlePHRcKnoU10EyOM=")!
  static let pageSize = 4096
  static let reserved = 80
  static let ivSize = 16
  static let hmacSize = 64
  static let saltSize = 16
  static let hmacSaltMask: UInt8 = 0x3A
  static let hmacKeyRounds: UInt32 = 2
  static let maximumBytes = 256 * 1024 * 1024
  static let snapshotAttempts = 3
  static let sqliteMagic = Array("SQLite format 3\0".utf8)

  static func label(profile: String, name: String) -> String { "profile/\(profile)/\(name)" }

  static func key(rootKey: Data, label: String) -> Data {
    let info = Data(label.utf8)
    let salt = Data(HMAC<SHA256>.authenticationCode(for: info, using: SymmetricKey(data: saltKey)))
    let key = HKDF<SHA256>.deriveKey(inputKeyMaterial: SymmetricKey(data: rootKey), salt: salt, info: info, outputByteCount: 32)
    return key.withUnsafeBytes { Data($0) }
  }

  static func hmacKey(key: Data, salt: ArraySlice<UInt8>) -> SymmetricKey? {
    let masked = salt.map { $0 ^ hmacSaltMask }
    var out = [UInt8](repeating: 0, count: key.count)
    let status = key.withUnsafeBytes { password in
      CCKeyDerivationPBKDF(CCPBKDFAlgorithm(kCCPBKDF2), password.bindMemory(to: Int8.self).baseAddress, password.count,
                           masked, masked.count, CCPseudoRandomAlgorithm(kCCPRFHmacAlgSHA512), hmacKeyRounds, &out, out.count)
    }
    return status == kCCSuccess && !out.isEmpty ? SymmetricKey(data: out) : nil
  }

  struct FileState: Equatable {
    var device: Int64
    var inode: UInt64
    var size: Int64
    var modified: [Int]
    var changed: [Int]

    init(_ info: stat) {
      device = Int64(info.st_dev)
      inode = UInt64(info.st_ino)
      size = Int64(info.st_size)
      modified = [info.st_mtimespec.tv_sec, info.st_mtimespec.tv_nsec]
      changed = [info.st_ctimespec.tv_sec, info.st_ctimespec.tv_nsec]
    }
  }

  struct FileRead {
    var bytes: [UInt8]
    var state: FileState
  }

  static func read(_ url: URL, limit: Int) throws -> FileRead? {
    let fd = open(url.path, O_RDONLY | O_CLOEXEC)
    guard fd >= 0 else {
      let error = errno
      if error == ENOENT { return nil }
      throw ImportError.unreadable("Couldn't read \(url.lastPathComponent): \(String(cString: strerror(error)))")
    }
    let handle = FileHandle(fileDescriptor: fd, closeOnDealloc: true)
    var info = stat()
    guard fstat(fd, &info) == 0 else { throw ImportError.unreadable("Couldn't read \(url.lastPathComponent)") }
    var bytes = [UInt8]()
    do {
      while bytes.count <= limit, let chunk = try handle.read(upToCount: min(1 << 20, limit + 1 - bytes.count)), !chunk.isEmpty {
        bytes += chunk
      }
    } catch {
      throw ImportError.unreadable("Couldn't read \(url.lastPathComponent): \(error.localizedDescription)")
    }
    guard bytes.count <= limit else { throw ImportError.unreadable("\(url.lastPathComponent) is too large") }
    return FileRead(bytes: bytes, state: FileState(info))
  }

  static func unchanged(_ url: URL, since read: FileRead) -> Bool {
    guard let handle = FileHandle(forReadingAtPath: url.path) else { return false }
    defer { try? handle.close() }
    var info = stat()
    guard fstat(handle.fileDescriptor, &info) == 0, FileState(info) == read.state,
          let first = try? handle.read(upToCount: pageSize) else { return false }
    return [UInt8](first) == Array(read.bytes.prefix(pageSize))
  }

  static func snapshot(_ file: URL, limit: Int, betweenReads: () throws -> Void) throws -> (main: [UInt8], wal: [UInt8]?) {
    let walFile = URL(fileURLWithPath: file.path + "-wal")
    for _ in 0..<snapshotAttempts {
      guard let main = try read(file, limit: limit) else { throw ImportError.notFound("Dia keeps no sidebar file in this profile") }
      let wal = try read(walFile, limit: limit)
      try betweenReads()
      if unchanged(file, since: main) { return (main.bytes, wal?.bytes) }
    }
    throw ImportError.unreadable("\(file.lastPathComponent) kept changing while it was read")
  }

  static func decrypt(_ file: URL, key: Data, limit: Int = maximumBytes, betweenReads: () throws -> Void = {}) throws -> Data {
    let (main, wal) = try snapshot(file, limit: limit, betweenReads: betweenReads)
    guard main.count >= pageSize, main.count % pageSize == 0 else {
      throw ImportError.unreadable("\(file.lastPathComponent) isn't a database")
    }
    var pages: [Int: ArraySlice<UInt8>] = [:]
    var count = main.count / pageSize
    for n in 1...count { pages[n] = main[(n - 1) * pageSize..<n * pageSize] }
    if let wal { count = fold(wal, into: &pages, count: count) }
    guard count <= limit / pageSize else { throw ImportError.unreadable("\(file.lastPathComponent) is too large") }
    guard count >= 1, (1...count).allSatisfy({ pages[$0] != nil }) else {
      throw ImportError.unreadable("\(file.lastPathComponent) is missing pages")
    }
    guard let hmacKey = hmacKey(key: key, salt: main[0..<saltSize]), let first = pages[1],
          let header = decryptPage(first, number: 1, key: key, hmacKey: hmacKey), isSQLiteHeader(header) else {
      throw ImportError.unreadable("\(file.lastPathComponent) didn't open with Dia's key")
    }
    var out = [UInt8]()
    out.reserveCapacity(count * pageSize)
    out += header
    for n in stride(from: 2, through: count, by: 1) {
      guard let page = pages[n], let plain = decryptPage(page, number: n, key: key, hmacKey: hmacKey) else {
        throw ImportError.unreadable("\(file.lastPathComponent) has a page that doesn't verify")
      }
      out += plain
    }
    out[18] = 1
    out[19] = 1
    return Data(out)
  }

  static func isSQLiteHeader(_ page: [UInt8]) -> Bool {
    page.count >= 100 && Array(page[0..<16]) == sqliteMagic && page[16] == 0x10 && page[17] == 0
      && page[20] == UInt8(reserved) && page[21] == 64 && page[22] == 32 && page[23] == 32
  }

  static func pageTag(_ page: ArraySlice<UInt8>, number: Int, hmacKey: SymmetricKey) -> HMAC<SHA512>.MAC {
    let start = page.startIndex + (number == 1 ? saltSize : 0)
    let end = page.startIndex + pageSize - reserved + ivSize
    var mac = HMAC<SHA512>(key: hmacKey)
    mac.update(data: page[start..<end])
    mac.update(data: withUnsafeBytes(of: UInt32(truncatingIfNeeded: number).littleEndian) { Array($0) })
    return mac.finalize()
  }

  static func decryptPage(_ page: ArraySlice<UInt8>, number: Int, key: Data, hmacKey: SymmetricKey) -> [UInt8]? {
    guard page.count == pageSize else { return nil }
    let base = page.startIndex
    let start = base + (number == 1 ? saltSize : 0)
    let end = base + pageSize - reserved
    let tag = end + ivSize
    guard pageTag(page, number: number, hmacKey: hmacKey) == page[tag..<tag + hmacSize] else { return nil }
    let iv = Data(page[end..<end + ivSize])
    guard let plain = AES.cbc(.decrypt, Data(page[start..<end]), key: key, iv: iv, padding: false), plain.count == end - start else {
      return nil
    }
    return (number == 1 ? sqliteMagic : []) + [UInt8](plain) + [UInt8](repeating: 0, count: reserved)
  }

  static func fold(_ wal: [UInt8], into pages: inout [Int: ArraySlice<UInt8>], count: Int) -> Int {
    let headerSize = 32
    let frameHeader = 24
    guard wal.count >= headerSize else { return count }
    let magic = word(wal, 0, bigEndian: true)
    guard magic == 0x377F_0682 || magic == 0x377F_0683, Int(word(wal, 8, bigEndian: true)) == pageSize else { return count }
    let bigEndian = magic & 1 == 1
    var sum = checksum(wal, 0..<24, bigEndian: bigEndian, from: (0, 0))
    guard sum == (word(wal, 24, bigEndian: true), word(wal, 28, bigEndian: true)) else { return count }
    let salt = wal[16..<24]
    var pending: [Int: ArraySlice<UInt8>] = [:]
    var count = count
    var at = headerSize
    while at + frameHeader + pageSize <= wal.count, wal[at + 8..<at + 16] == salt {
      sum = checksum(wal, at..<at + 8, bigEndian: bigEndian, from: sum)
      sum = checksum(wal, at + frameHeader..<at + frameHeader + pageSize, bigEndian: bigEndian, from: sum)
      guard sum == (word(wal, at + 16, bigEndian: true), word(wal, at + 20, bigEndian: true)) else { break }
      let number = Int(word(wal, at, bigEndian: true))
      guard number > 0 else { break }
      pending[number] = wal[at + frameHeader..<at + frameHeader + pageSize]
      let commit = Int(word(wal, at + 4, bigEndian: true))
      if commit > 0 {
        pages.merge(pending) { $1 }
        pending = [:]
        count = commit
      }
      at += frameHeader + pageSize
    }
    return count
  }

  static func word(_ b: [UInt8], _ i: Int, bigEndian: Bool) -> UInt32 {
    let bytes = (UInt32(b[i]), UInt32(b[i + 1]), UInt32(b[i + 2]), UInt32(b[i + 3]))
    return bigEndian
      ? bytes.0 << 24 | bytes.1 << 16 | bytes.2 << 8 | bytes.3
      : bytes.3 << 24 | bytes.2 << 16 | bytes.1 << 8 | bytes.0
  }

  static func checksum(_ b: [UInt8], _ range: Range<Int>, bigEndian: Bool, from start: (UInt32, UInt32)) -> (UInt32, UInt32) {
    var (s0, s1) = start
    var i = range.lowerBound
    while i + 8 <= range.upperBound {
      s0 = s0 &+ word(b, i, bigEndian: bigEndian) &+ s1
      s1 = s1 &+ word(b, i + 4, bigEndian: bigEndian) &+ s0
      i += 8
    }
    return (s0, s1)
  }
}
