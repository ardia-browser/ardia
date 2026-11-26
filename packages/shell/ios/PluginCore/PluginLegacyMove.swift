import Darwin
import Foundation

enum ReservedPrograms {
  static let owners: [String: String] = ["ardia": "ardia__cli"]

  static func refusal(program: String, plugin: String, official: Bool) -> String? {
    if !official, PluginStore.parts(plugin)?.scope == PluginInstaller.officialScope {
      return "\(PluginStore.id(plugin) ?? plugin) isn't Ardia's verified download, so none of its programs go on PATH"
    }
    guard let owner = owners[PluginPrograms.folded(program)] else { return nil }
    return official && owner == plugin ? nil : "\(program) belongs to Ardia's official \(PluginStore.id(owner) ?? owner) plugin"
  }
}

enum PluginLegacyMove {
  static let legacyStoreFolder = "OfficialPlugins"
  static var swapLink: (BinFolder, String, [UInt8]) -> Bool = { bin, name, target in bin.swap(name, toBytes: target) }
  static var beforeReverse: () -> Void = {}

  static func adopt(from: String, to: String, appData: String, places: ProgramPlaces, replaced: Bool) -> [String: Any] {
    guard PluginPrograms.isName(from), PluginPrograms.isKey(to), from != to else { return ["ok": false, "found": false, "moved": [], "leftover": false, "reason": "those aren't plugin names"] }
    var moved: [String] = []
    var found = false
    var problems: [String] = []
    let oldPrograms = places.pluginStore(from)
    let newPrograms = places.pluginStore(to)
    if PluginPrograms.isRealFolder(oldPrograms) {
      found = true
      switch movePrograms(from: from, to: to, places: places) {
      case .some(let problem): problems.append(problem)
      case .none: moved.append("programs")
      }
    } else if PluginPrograms.isRealFolder(newPrograms), let problem = retarget(from: oldPrograms, to: newPrograms, places: places) {
      problems.append(problem)
    }
    let data = (appData as NSString).appendingPathComponent("PluginData")
    let oldData = (data as NSString).appendingPathComponent(from)
    let newData = (data as NSString).appendingPathComponent(to)
    var info = stat()
    if PluginPrograms.isRealFolder(oldData) {
      found = true
      if lstat(newData, &info) == 0 {
        problems.append("its data folder is already there")
      } else if rename(oldData, newData) == 0 {
        moved.append("data")
      } else {
        problems.append("its data couldn't be moved (\(String(cString: strerror(errno))))")
      }
    }
    let oldStore = ((appData as NSString).appendingPathComponent(legacyStoreFolder) as NSString).appendingPathComponent(from)
    var leftover = false
    if lstat(oldStore, &info) == 0, !replaced || !problems.isEmpty {
      found = true
      leftover = true
    } else if lstat(oldStore, &info) == 0 {
      found = true
      PluginPrograms.unseal(oldStore)
      PluginPrograms.discard(oldStore)
      moved.append("download")
      let root = (appData as NSString).appendingPathComponent(legacyStoreFolder)
      if ((try? FileManager.default.contentsOfDirectory(atPath: root)) ?? ["?"]).allSatisfy({ $0.hasPrefix(".") }) {
        PluginPrograms.unseal(root)
        PluginPrograms.discard(root)
      }
    }
    if leftover == false, lstat(oldStore, &info) == 0 { leftover = true }
    var reply: [String: Any] = ["ok": problems.isEmpty, "found": found, "moved": moved, "leftover": leftover]
    if let problem = problems.first { reply["reason"] = problem }
    return reply
  }

  private static func movePrograms(from: String, to: String, places: ProgramPlaces) -> String? {
    guard let first = PluginPrograms.lock(from, places) else { return "its programs folder couldn't be locked" }
    defer { close(first) }
    guard let second = PluginPrograms.lock(to, places) else { return "its new programs folder couldn't be locked" }
    defer { close(second) }
    let oldPrograms = places.pluginStore(from)
    let newPrograms = places.pluginStore(to)
    var info = stat()
    if lstat(newPrograms, &info) == 0 { return "its new programs folder is already there" }
    let staging = ((newPrograms as NSString).deletingLastPathComponent as NSString).appendingPathComponent(".adopt-\(getpid())-\(UInt32.random(in: 0...UInt32.max))")
    do {
      try FileManager.default.copyItem(atPath: oldPrograms, toPath: staging)
    } catch {
      PluginPrograms.discard(staging)
      return "its programs couldn't be copied (\(error.localizedDescription))"
    }
    guard renamex_np(staging, newPrograms, UInt32(RENAME_EXCL)) == 0 else {
      let failed = errno
      PluginPrograms.discard(staging)
      return "its programs couldn't be put in place (\(String(cString: strerror(failed))))"
    }
    guard let held = PluginPrograms.binLock(places) else {
      PluginPrograms.discard(newPrograms)
      return "its programs on PATH couldn't be locked"
    }
    defer { close(held) }
    let forward = retargetHeld(from: oldPrograms, to: newPrograms, places: places)
    guard let problem = forward.problem else {
      PluginPrograms.discard(oldPrograms)
      return nil
    }
    beforeReverse()
    let back = retargetHeld(from: newPrograms, to: oldPrograms, places: places, only: Set(forward.moved))
    if back.problem == nil, !linksInto(newPrograms, places: places) { PluginPrograms.discard(newPrograms) }
    return problem
  }

  static func retarget(from oldPrograms: String, to newPrograms: String, places: ProgramPlaces) -> String? {
    guard let held = PluginPrograms.binLock(places) else { return "its programs on PATH couldn't be locked" }
    defer { close(held) }
    return retargetHeld(from: oldPrograms, to: newPrograms, places: places).problem
  }

  static func retargetHeld(from oldPrograms: String, to newPrograms: String, places: ProgramPlaces, only: Set<String>? = nil) -> (moved: [String], problem: String?) {
    let bin: BinFolder
    switch PluginPrograms.openBin(places) {
    case .success(let opened): bin = opened
    case .failure(let refusal):
      var info = stat()
      return ([], lstat(places.binDir, &info) != 0 && errno == ENOENT ? nil : "its programs on PATH couldn't be read (\(refusal.reason))")
    }
    guard let names = bin.names() else { return ([], "its programs on PATH couldn't be listed") }
    let oldBase = PluginPrograms.storeBase(oldPrograms)
    let newBase = PluginPrograms.storeBase(newPrograms)
    var moved: [String] = []
    var stuck: [String] = []
    for name in names where only?.contains(name) ?? true {
      guard let target = bin.targetBytes(name), target.starts(with: oldBase) else { continue }
      if swapLink(bin, name, newBase + target.dropFirst(oldBase.count)) { moved.append(name) } else { stuck.append(name) }
    }
    if let only { stuck.append(contentsOf: only.filter { !names.contains($0) }) }
    return (moved, stuck.isEmpty ? nil : "\(stuck.sorted().joined(separator: ", ")) on PATH couldn't be pointed at its new folder")
  }

  static func linksInto(_ folder: String, places: ProgramPlaces) -> Bool {
    guard case .success(let bin) = PluginPrograms.openBin(places) else { return true }
    guard let names = bin.names() else { return true }
    let base = PluginPrograms.storeBase(folder)
    return names.contains { bin.targetBytes($0)?.starts(with: base) == true }
  }
}
