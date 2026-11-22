import CryptoKit
import Darwin
import Foundation

struct PluginProgram: Equatable {
  let name: String
  let path: String
}

struct ProgramPlaces {
  static let systemDirs = ["/usr/bin", "/bin", "/usr/sbin", "/sbin", "/opt/homebrew/bin", "/usr/local/bin"]

  let store: String
  let binDir: String
  var shadowable: [String] = ProgramPlaces.systemDirs

  func pluginStore(_ plugin: String) -> String { (store as NSString).appendingPathComponent(plugin) }
}

struct ProgramsLinked: Equatable {
  let version: String
  let fresh: Bool
  let linked: [String]
  let refused: [String: String]
  var adoption: LegacyAdoption = .none
  var kept: String? = nil

  var adopted: Bool { adoption == .adopted }
  var adoptBusy: Bool { adoption == .busy }
}

enum PluginPrograms {
  static let currentName = "current"
  static let previousName = "previous"
  static let leasesName = ".leases"
  static let afterUpdateMarker = ".after-update"
  static let afterUpdateClaim = ".after-update-claim"
  static let caches = "__pycache__"
  private static let reserved: Set<String> = [leasesName, afterUpdateMarker, afterUpdateClaim]
  private static let namePattern = try! NSRegularExpression(pattern: "^[a-z0-9][a-z0-9-]{0,39}$")
  private static let versionCharacters = CharacterSet(charactersIn: "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789.-")

  static func folded(_ name: String) -> String {
    name.decomposedStringWithCanonicalMapping.folding(options: .caseInsensitive, locale: nil)
  }

  static func isReserved(_ name: String) -> Bool {
    reserved.contains(folded(name))
  }

  static func isName(_ name: String) -> Bool {
    namePattern.firstMatch(in: name, range: NSRange(name.startIndex..., in: name)) != nil
  }

  static func versionFolderName(version: String?, approved: String) -> String {
    let kept = String(String.UnicodeScalarView((version ?? "").unicodeScalars.filter { versionCharacters.contains($0) }.prefix(48)))
    let trimmed = String(kept.drop(while: { $0 == "." || $0 == "-" }))
    let base = trimmed.isEmpty ? "0.0.0" : trimmed
    return "\(base)-\(approved.prefix(12))"
  }

  static func install(
    plugin: String, from folder: OpenedFolder, approved: String, version: String?, programs: [PluginProgram], places: ProgramPlaces,
    expectedDigest: String? = nil, adoption: LegacyInstall? = nil
  ) -> Result<ProgramsLinked, FolderRefusal> {
    guard let lock = lock(plugin, places) else { return .failure(FolderRefusal(reason: "its program folder couldn't be locked")) }
    defer { close(lock) }
    guard let pluginStore = realFolder(places.pluginStore(plugin), creating: true) else {
      return .failure(FolderRefusal(reason: "its program folder (\(places.pluginStore(plugin))) isn't a folder you own"))
    }
    guard hasPrivateAncestry(pluginStore) else {
      return .failure(FolderRefusal(reason: "its program folder (\(pluginStore)) is inside a folder other users can change"))
    }
    let base = versionFolderName(version: version, approved: approved)
    var name = base
    var fresh = false
    let reusable = [base] + ((try? FileManager.default.contentsOfDirectory(atPath: pluginStore)) ?? []).filter { $0.hasPrefix(base + "-r") }.sorted()
    if let found = reusable.first(where: { holdsApproved((pluginStore as NSString).appendingPathComponent($0), folderId: folder.id, approved: approved, programs: programs, expectedDigest: expectedDigest) }) {
      name = found
    } else {
      var info = stat()
      if lstat((pluginStore as NSString).appendingPathComponent(base), &info) == 0 { name = "\(base)-r\(String(UInt32.random(in: 0...UInt32.max), radix: 36))" }
      let target = (pluginStore as NSString).appendingPathComponent(name)
      switch stage(folder, into: pluginStore, approved: approved, programs: programs, expectedDigest: expectedDigest) {
      case .failure(let refusal): return .failure(refusal)
      case .success(let staged):
        guard renamex_np(staged, target, UInt32(RENAME_EXCL)) == 0 else {
          discard(staged)
          return .failure(FolderRefusal(reason: "its programs couldn't be put in place (\(String(cString: strerror(errno))))"))
        }
        fresh = true
      }
    }
    let legacy = adoption.map { lockLegacy($0, plugin: plugin, places: places) }
    defer { legacy?.release() }
    if legacy?.outcome == .busy {
      return .success(ProgramsLinked(version: name, fresh: fresh, linked: [], refused: [:], adoption: .busy))
    }
    let before = linkTarget((pluginStore as NSString).appendingPathComponent(currentName))
    let replacing = before.map { $0 != name && isRealFolder((pluginStore as NSString).appendingPathComponent($0)) } ?? false
    let adoptTarget = { (program: PluginProgram) -> String? in
      adoption?.program == program.name && legacy?.held == true ? adoption.map(legacyLauncherPath) : nil
    }
    guard let bin = binLock(places) else {
      var refused: [String: String] = [:]
      for program in programs { refused[program.name] = "\(places.binDir) couldn't be locked" }
      return .success(ProgramsLinked(version: name, fresh: fresh, linked: [], refused: refused, kept: replacing ? before : nil))
    }
    defer { close(bin) }
    if replacing {
      var held: [String: String] = [:]
      for program in programs {
        if let problem = linkProblem(program, plugin: plugin, places: places, adoptTarget: adoptTarget(program)) { held[program.name] = problem }
      }
      if !held.isEmpty { return .success(ProgramsLinked(version: name, fresh: fresh, linked: [], refused: held, kept: before)) }
    }
    let snapshot = Dictionary(uniqueKeysWithValues: programs.map { ($0.name, linkTarget((places.binDir as NSString).appendingPathComponent($0.name))) })
    guard swapLink(in: pluginStore, named: currentName, to: name) else {
      return .failure(FolderRefusal(reason: "its programs couldn't be switched to the new version"))
    }
    var linked: [String] = []
    var refused: [String: String] = [:]
    var outcome: LegacyAdoption = legacy?.outcome == .failed ? .failed : .none
    for program in programs {
      if let problem = link(program, plugin: plugin, places: places, adoptTarget: adoptTarget(program)) { refused[program.name] = problem } else { linked.append(program.name) }
    }
    if replacing, !refused.isEmpty, let before {
      var restored = swapLink(in: pluginStore, named: currentName, to: before)
      for name in linked {
        let path = (places.binDir as NSString).appendingPathComponent(name)
        if let target = snapshot[name] ?? nil {
          if linkTarget(path) != target && !swapLink(in: places.binDir, named: name, to: target) { restored = false }
        } else if unlink(path) != 0 && errno != ENOENT {
          restored = false
        }
      }
      guard restored else {
        return .failure(FolderRefusal(reason: "\(refused.values.first ?? "a program was refused"), and the earlier version couldn't be put back on PATH"))
      }
      return .success(ProgramsLinked(version: name, fresh: fresh, linked: [], refused: refused, kept: before))
    }
    if let before, before != name { _ = swapLink(in: pluginStore, named: previousName, to: before) }
    unlinkOthers(plugin: plugin, keeping: Set(programs.map(\.name)), places: places)
    sweepLocked(plugin: plugin, places: places, keepCurrent: true)
    if let legacy, let entry = adoption, legacy.held, linked.contains(entry.program) { outcome = adoptLegacyLocked(legacy, plugin: plugin, places: places, entry: entry) }
    return .success(ProgramsLinked(version: name, fresh: fresh, linked: linked, refused: refused, adoption: outcome))
  }

  static func withdraw(plugin: String, programs: [String], places: ProgramPlaces, keepCopy: Bool = false) {
    guard let lock = lock(plugin, places) else { return }
    defer { close(lock) }
    if keepCopy {
      if let bin = binLock(places) {
        unlinkOthers(plugin: plugin, keeping: [], places: places)
        close(bin)
      }
      return
    }
    withdrawLocked(plugin: plugin, programs: programs, places: places)
  }

  private static func withdrawLocked(plugin: String, programs: [String], places: ProgramPlaces) {
    if let bin = binLock(places) {
      unlinkOthers(plugin: plugin, keeping: [], places: places)
      close(bin)
    }
    let pluginStore = places.pluginStore(plugin)
    guard isRealFolder(pluginStore) else { return }
    for link in [currentName, previousName] {
      let path = (pluginStore as NSString).appendingPathComponent(link)
      if linkTarget(path) != nil { unlink(path) }
    }
    sweepLocked(plugin: plugin, places: places, keepCurrent: false)
  }

  static func remove(plugin: String, programs: [String], places: ProgramPlaces) -> Bool {
    guard let lock = lock(plugin, places) else { return false }
    defer { close(lock) }
    withdrawLocked(plugin: plugin, programs: programs, places: places)
    let pluginStore = places.pluginStore(plugin)
    guard isRealFolder(pluginStore) else { return true }
    let left = (try? FileManager.default.contentsOfDirectory(atPath: pluginStore)) ?? []
    guard left.allSatisfy({ $0.hasPrefix(".") }) else { return false }
    discard(pluginStore)
    return true
  }

  static func sweep(plugin: String, places: ProgramPlaces, keepCurrent: Bool) {
    guard let lock = lock(plugin, places) else { return }
    defer { close(lock) }
    sweepLocked(plugin: plugin, places: places, keepCurrent: keepCurrent)
  }

  static func isCurrent(plugin: String, version: String, places: ProgramPlaces) -> Bool {
    linkTarget((places.pluginStore(plugin) as NSString).appendingPathComponent(currentName)) == version
  }

  static func shouldRunAfterUpdate(_ linked: ProgramsLinked, plugin: String, places: ProgramPlaces) -> Bool {
    !linked.adoptBusy && needsAfterUpdate(plugin: plugin, version: linked.version, places: places)
  }

  static func needsAfterUpdate(plugin: String, version: String, places: ProgramPlaces) -> Bool {
    let folder = (places.pluginStore(plugin) as NSString).appendingPathComponent(version)
    var info = stat()
    return isRealFolder(folder) && lstat((folder as NSString).appendingPathComponent(afterUpdateMarker), &info) != 0
  }

  static func whileCurrent<T>(plugin: String, version: String, places: ProgramPlaces, _ body: () -> T) -> T? {
    guard let held = lock(plugin, places) else { return nil }
    defer { close(held) }
    return isCurrent(plugin: plugin, version: version, places: places) ? body() : nil
  }

  static func claimAfterUpdate(plugin: String, version: String, places: ProgramPlaces) -> Bool {
    let folder = (places.pluginStore(plugin) as NSString).appendingPathComponent(version)
    let claim = (folder as NSString).appendingPathComponent(afterUpdateClaim)
    for _ in 0..<2 {
      let fd = open(claim, O_WRONLY | O_CREAT | O_EXCL | O_CLOEXEC | O_NOFOLLOW, 0o600)
      if fd >= 0 {
        let text = Data("\(getpid())\n".utf8)
        _ = text.withUnsafeBytes { write(fd, $0.baseAddress, $0.count) }
        close(fd)
        return true
      }
      guard errno == EEXIST, !claimIsLive(claim) else { return false }
      unlink(claim)
    }
    return false
  }

  static func releaseAfterUpdate(plugin: String, version: String, places: ProgramPlaces) {
    unlink(((places.pluginStore(plugin) as NSString).appendingPathComponent(version) as NSString).appendingPathComponent(afterUpdateClaim))
  }

  private static func claimIsLive(_ claim: String) -> Bool {
    var info = stat()
    guard lstat(claim, &info) == 0, (info.st_mode & S_IFMT) == S_IFREG,
      let text = try? String(contentsOfFile: claim, encoding: .utf8), let pid = pid_t(text.trimmingCharacters(in: .whitespacesAndNewlines)), pid > 0,
      let started = PluginProcessTree.entry(pid)?.started
    else { return false }
    return started / 1_000_000 <= UInt64(max(0, info.st_mtimespec.tv_sec))
  }

  static func lease(plugin: String, version: String, places: ProgramPlaces) -> String? {
    let leases = (((places.pluginStore(plugin) as NSString).appendingPathComponent(version)) as NSString).appendingPathComponent(leasesName)
    let path = (leases as NSString).appendingPathComponent("\(getpid())")
    let fd = open(path, O_WRONLY | O_CREAT | O_CLOEXEC | O_NOFOLLOW, 0o600)
    guard fd >= 0 else { return nil }
    close(fd)
    return path
  }

  static func markAfterUpdate(plugin: String, version: String, places: ProgramPlaces) {
    let marker = ((places.pluginStore(plugin) as NSString).appendingPathComponent(version) as NSString).appendingPathComponent(afterUpdateMarker)
    let fd = open(marker, O_WRONLY | O_CREAT | O_EXCL | O_CLOEXEC | O_NOFOLLOW, 0o600)
    if fd >= 0 { close(fd) }
  }

  static func binLock(_ places: ProgramPlaces) -> Int32? {
    guard realFolder(places.store, creating: true) != nil else { return nil }
    let fd = open((places.store as NSString).appendingPathComponent(".bin.lock"), O_RDWR | O_CREAT | O_CLOEXEC | O_NOFOLLOW, 0o600)
    guard fd >= 0 else { return nil }
    guard flock(fd, LOCK_EX) == 0 else {
      close(fd)
      return nil
    }
    return fd
  }

  static func unlinkOthers(plugin: String, keeping: Set<String>, places: ProgramPlaces) {
    for (name, target) in linksIntoStore(places) where !keeping.contains(name) && isInside(target, places.pluginStore(plugin)) {
      unlink((places.binDir as NSString).appendingPathComponent(name))
    }
  }

  static func linksIntoStore(_ places: ProgramPlaces) -> [(String, String)] {
    let names = (try? FileManager.default.contentsOfDirectory(atPath: places.binDir)) ?? []
    return names.compactMap { name in
      guard isName(name), let target = linkTarget((places.binDir as NSString).appendingPathComponent(name)), isInside(target, places.store) else { return nil }
      return (name, target)
    }
  }

  static func withdrawAllBut(_ active: Set<String>, places: ProgramPlaces, keepingCopies: Set<String> = []) {
    if let bin = binLock(places) {
      for (name, target) in linksIntoStore(places) {
        guard let owner = owner(of: target, store: places.store), !active.contains(owner) else { continue }
        unlink((places.binDir as NSString).appendingPathComponent(name))
      }
      close(bin)
    }
    let stores = (try? FileManager.default.contentsOfDirectory(atPath: places.store)) ?? []
    for plugin in stores where isName(plugin) && !active.contains(plugin) && isRealFolder(places.pluginStore(plugin)) {
      withdraw(plugin: plugin, programs: [], places: places, keepCopy: keepingCopies.contains(plugin))
    }
  }

  static func lock(_ plugin: String, _ places: ProgramPlaces) -> Int32? {
    guard isName(plugin), realFolder(places.store, creating: true) != nil else { return nil }
    let fd = open((places.store as NSString).appendingPathComponent(".\(plugin).lock"), O_RDWR | O_CREAT | O_CLOEXEC | O_NOFOLLOW, 0o600)
    guard fd >= 0 else { return nil }
    guard flock(fd, LOCK_EX) == 0 else {
      close(fd)
      return nil
    }
    return fd
  }

  private static func sweepLocked(plugin: String, places: ProgramPlaces, keepCurrent: Bool) {
    let pluginStore = places.pluginStore(plugin)
    guard isRealFolder(pluginStore), let entries = try? FileManager.default.contentsOfDirectory(atPath: pluginStore) else { return }
    var keep: Set<String> = []
    if keepCurrent {
      for link in [currentName, previousName] {
        if let target = linkTarget((pluginStore as NSString).appendingPathComponent(link)) { keep.insert(target) }
      }
    }
    for entry in entries where entry != currentName && entry != previousName && !keep.contains(entry) {
      let path = (pluginStore as NSString).appendingPathComponent(entry)
      if entry.hasPrefix(".stage-") || entry.hasPrefix(".trash-") {
        if entry.hasPrefix(".trash-") || olderThan(path, seconds: 3600) { discard(path) }
        continue
      }
      guard isRealFolder(path), !isLeased(path) else { continue }
      discard(path)
    }
  }

  static func isLeased(_ versionFolder: String) -> Bool {
    let leases = (versionFolder as NSString).appendingPathComponent(leasesName)
    guard isRealFolder(leases), let names = try? FileManager.default.contentsOfDirectory(atPath: leases) else { return false }
    var live = false
    for name in names {
      let path = (leases as NSString).appendingPathComponent(name)
      guard let pid = pid_t(name), pid > 0 else { continue }
      var info = stat()
      guard lstat(path, &info) == 0, (info.st_mode & S_IFMT) == S_IFREG else { continue }
      if let started = PluginProcessTree.entry(pid)?.started, started / 1_000_000 <= UInt64(max(0, info.st_mtimespec.tv_sec)) {
        live = true
      } else {
        unlink(path)
      }
    }
    return live
  }

  static func owner(of target: String, store: String) -> String? {
    let rest = String(target.dropFirst(store.count)).split(separator: "/").first.map(String.init)
    return rest.flatMap { isName($0) ? $0 : nil }
  }

  private static func stage(
    _ folder: OpenedFolder, into pluginStore: String, approved: String, programs: [PluginProgram], expectedDigest: String?
  ) -> Result<String, FolderRefusal> {
    let staged = (pluginStore as NSString).appendingPathComponent(".stage-\(getpid())-\(UInt32.random(in: 0...UInt32.max))")
    guard mkdir(staged, 0o755) == 0 else { return .failure(FolderRefusal(reason: "its programs couldn't be staged")) }
    let destination = open(staged, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
    guard destination >= 0 else {
      discard(staged)
      return .failure(FolderRefusal(reason: "its programs couldn't be staged"))
    }
    let copied = copyTree(from: folder.fd, to: destination, relative: "")
    close(destination)
    if let problem = copied {
      discard(staged)
      return .failure(FolderRefusal(reason: problem))
    }
    if let expectedDigest, payloadDigest(staged, keepingCaches: true) != expectedDigest {
      discard(staged)
      return .failure(FolderRefusal(reason: "its files don't match the ones Ardia downloaded and checked"))
    }
    if let problem = checkCopy(staged, folderId: folder.id, approved: approved, programs: programs) {
      discard(staged)
      return .failure(FolderRefusal(reason: problem))
    }
    guard seal(staged, keepingRootWritable: true) else {
      discard(staged)
      return .failure(FolderRefusal(reason: "its programs couldn't be made read-only"))
    }
    guard mkdir((staged as NSString).appendingPathComponent(leasesName), 0o700) == 0 || errno == EEXIST else {
      discard(staged)
      return .failure(FolderRefusal(reason: "its programs' lease folder couldn't be made"))
    }
    return .success(staged)
  }

  static func copyTree(from source: Int32, to destination: Int32, relative: String) -> String? {
    let listing = dup(source)
    guard listing >= 0, let directory = fdopendir(listing) else {
      if listing >= 0 { close(listing) }
      return "\(relative.isEmpty ? "its folder" : relative) couldn't be read"
    }
    defer { closedir(directory) }
    rewinddir(directory)
    var names: [String] = []
    while let entry = readdir(directory) {
      let name = withUnsafeBytes(of: entry.pointee.d_name) { String(decoding: $0.prefix(Int(entry.pointee.d_namlen)), as: UTF8.self) }
      if name != "." && name != ".." { names.append(name) }
    }
    for name in names.sorted() {
      let shown = relative.isEmpty ? name : "\(relative)/\(name)"
      if name.unicodeScalars.contains(where: { $0.value < 0x20 || $0.value == 0x7f }) { return "a name in \(relative.isEmpty ? "its folder" : relative) has control characters" }
      if relative.isEmpty && isReserved(name) { return "\(shown) is reserved for Ardia" }
      var info = stat()
      guard fstatat(source, name, &info, AT_SYMLINK_NOFOLLOW) == 0 else { return "\(shown) couldn't be read" }
      if name == caches && (info.st_mode & S_IFMT) == S_IFDIR { continue }
      switch info.st_mode & S_IFMT {
      case S_IFDIR:
        let child = openat(source, name, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
        guard child >= 0 else { return "\(shown) couldn't be read" }
        defer { close(child) }
        guard mkdirat(destination, name, 0o755) == 0 else { return "\(shown) couldn't be copied (\(String(cString: strerror(errno))))" }
        let made = openat(destination, name, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
        guard made >= 0 else { return "\(shown) couldn't be copied (\(String(cString: strerror(errno))))" }
        defer { close(made) }
        if let problem = copyTree(from: child, to: made, relative: shown) { return problem }
      case S_IFREG:
        let file = openat(source, name, O_RDONLY | O_NOFOLLOW | O_NONBLOCK | O_CLOEXEC)
        guard file >= 0 else { return "\(shown) couldn't be read" }
        defer { close(file) }
        var opened = stat()
        guard fstat(file, &opened) == 0, (opened.st_mode & S_IFMT) == S_IFREG, opened.st_ino == info.st_ino, opened.st_dev == info.st_dev else { return "\(shown) changed while it was copied" }
        guard opened.st_nlink == 1 else { return "\(shown) is a hard link; a plugin's programs may not contain links" }
        let mode = mode_t(opened.st_mode & 0o755)
        if fclonefileat(file, destination, name, UInt32(CLONE_NOOWNERCOPY)) != 0 {
          let out = openat(destination, name, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, mode)
          guard out >= 0 else { return "\(shown) couldn't be copied (\(String(cString: strerror(errno))))" }
          defer { close(out) }
          guard fcopyfile(file, out, nil, copyfile_flags_t(COPYFILE_DATA)) == 0 else { return "\(shown) couldn't be copied (\(String(cString: strerror(errno))))" }
        }
        guard fchmodat(destination, name, mode, AT_SYMLINK_NOFOLLOW) == 0 else { return "\(shown) couldn't be copied (\(String(cString: strerror(errno))))" }
      case S_IFLNK:
        return "\(shown) is a link; a plugin's programs may not contain links"
      default:
        return "\(shown) isn't a file or a folder"
      }
    }
    return nil
  }

  static func checkTree(_ folder: Int32, relative: String = "") -> String? {
    let listing = dup(folder)
    guard listing >= 0, let directory = fdopendir(listing) else {
      if listing >= 0 { close(listing) }
      return "\(relative.isEmpty ? "its copy" : relative) couldn't be read"
    }
    defer { closedir(directory) }
    rewinddir(directory)
    var names: [String] = []
    while let entry = readdir(directory) {
      let name = withUnsafeBytes(of: entry.pointee.d_name) { String(decoding: $0.prefix(Int(entry.pointee.d_namlen)), as: UTF8.self) }
      if name != "." && name != ".." { names.append(name) }
    }
    for name in names {
      let shown = relative.isEmpty ? name : "\(relative)/\(name)"
      if relative.isEmpty && reserved.contains(name) { continue }
      var info = stat()
      guard fstatat(folder, name, &info, AT_SYMLINK_NOFOLLOW) == 0 else { return "\(shown) couldn't be read" }
      switch info.st_mode & S_IFMT {
      case S_IFDIR:
        let child = openat(folder, name, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
        guard child >= 0 else { return "\(shown) couldn't be read" }
        defer { close(child) }
        if let problem = checkTree(child, relative: shown) { return problem }
      case S_IFREG:
        if info.st_nlink != 1 || info.st_mode & 0o7022 != 0 { return "\(shown) isn't as Ardia copied it" }
      default:
        return "\(shown) isn't a file or a folder"
      }
    }
    return nil
  }

  private static func checkCopy(_ staged: String, folderId: String, approved: String, programs: [PluginProgram]) -> String? {
    guard let copy = PluginFiles.openFolder(staged) else { return "its copy couldn't be opened" }
    defer { copy.close() }
    guard case .text(let text) = PluginFiles.readManifest(in: copy), PluginFiles.approvalHash(text: text, folderId: folderId) == approved else {
      return "its plugin.json changed since you approved it"
    }
    for program in programs where PluginFiles.localProgram(program.path, in: copy) == nil {
      return "its program \(program.path) isn't an executable file in its folder"
    }
    return nil
  }

  static func payloadDigest(_ root: String, keepingCaches: Bool = false, skippingReserved: Bool = true) -> String? {
    guard let walker = FileManager.default.enumerator(atPath: root) else { return nil }
    var entries: [String] = []
    while let relative = walker.nextObject() as? String {
      if (skippingReserved && reserved.contains(relative)) || (!keepingCaches && (relative as NSString).lastPathComponent == caches) {
        walker.skipDescendants()
        continue
      }
      entries.append(relative)
    }
    var listing = Data()
    for relative in entries.sorted(by: { Array($0.utf8).lexicographicallyPrecedes(Array($1.utf8)) }) {
      let path = (root as NSString).appendingPathComponent(relative)
      var info = stat()
      guard lstat(path, &info) == 0 else { return nil }
      switch info.st_mode & S_IFMT {
      case S_IFDIR: listing.append(Data("d \(relative)\n".utf8))
      case S_IFREG:
        guard let digest = OfficialArchive.sha256(file: path) else { return nil }
        listing.append(Data("f \(info.st_mode & 0o111 != 0 ? "755" : "644") \(digest) \(relative)\n".utf8))
      default: return nil
      }
    }
    return SHA256.hash(data: listing).map { String(format: "%02x", $0) }.joined()
  }

  static func holdsApproved(_ folder: String, folderId: String, approved: String, programs: [PluginProgram] = [], expectedDigest: String? = nil) -> Bool {
    guard isRealFolder(folder), let opened = PluginFiles.openFolder(folder) else { return false }
    defer { opened.close() }
    guard case .text(let text) = PluginFiles.readManifest(in: opened), PluginFiles.approvalHash(text: text, folderId: folderId) == approved else { return false }
    guard checkTree(opened.fd) == nil, programs.allSatisfy({ PluginFiles.localProgram($0.path, in: opened) != nil }) else { return false }
    guard let expectedDigest else { return true }
    return isSealed(folder, keepingRootWritable: true) && payloadDigest(folder, keepingCaches: true) == expectedDigest
  }

  static func linkTarget(_ path: String) -> String? {
    var info = stat()
    guard lstat(path, &info) == 0, (info.st_mode & S_IFMT) == S_IFLNK else { return nil }
    return try? FileManager.default.destinationOfSymbolicLink(atPath: path)
  }

  static func swapLink(in folder: String, named name: String, to target: String) -> Bool {
    let path = (folder as NSString).appendingPathComponent(name)
    var info = stat()
    if lstat(path, &info) == 0 && (info.st_mode & S_IFMT) != S_IFLNK { return false }
    let temporary = (folder as NSString).appendingPathComponent(".\(name).\(getpid())-\(UInt32.random(in: 0...UInt32.max))")
    guard symlink(target, temporary) == 0 else { return false }
    guard rename(temporary, path) == 0 else {
      unlink(temporary)
      return false
    }
    return true
  }

  static func isInside(_ path: String, _ folder: String) -> Bool {
    let base = folder.hasSuffix("/") ? folder : folder + "/"
    return path.hasPrefix(base)
  }

  static func isRealFolder(_ path: String) -> Bool {
    var info = stat()
    return lstat(path, &info) == 0 && (info.st_mode & S_IFMT) == S_IFDIR && info.st_uid == geteuid()
  }

  static func realFolder(_ path: String, creating: Bool) -> String? {
    if creating && !isRealFolder(path) {
      try? FileManager.default.createDirectory(atPath: path, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o755])
    }
    return isRealFolder(path) ? path : nil
  }

  private static func olderThan(_ path: String, seconds: Int) -> Bool {
    var info = stat()
    guard lstat(path, &info) == 0 else { return false }
    return Int(Date().timeIntervalSince1970) - info.st_mtimespec.tv_sec > seconds
  }

  static func unseal(_ root: String) {
    var info = stat()
    guard lstat(root, &info) == 0, (info.st_mode & S_IFMT) == S_IFDIR, info.st_uid == geteuid() else { return }
    chmod(root, 0o700)
    guard let walker = FileManager.default.enumerator(atPath: root) else { return }
    while let relative = walker.nextObject() as? String {
      let path = (root as NSString).appendingPathComponent(relative)
      if lstat(path, &info) == 0, (info.st_mode & S_IFMT) == S_IFDIR { chmod(path, 0o700) }
    }
  }

  static func discard(_ path: String) {
    var info = stat()
    guard lstat(path, &info) == 0 else { return }
    unseal(path)
    let parent = (path as NSString).deletingLastPathComponent
    let trash = (parent as NSString).appendingPathComponent(".trash-\(getpid())-\(UInt32.random(in: 0...UInt32.max))")
    let doomed = rename(path, trash) == 0 ? trash : path
    try? FileManager.default.removeItem(atPath: doomed)
  }
}
