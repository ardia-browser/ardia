import Darwin
import Foundation

struct LinkRefusal: Error, Equatable {
  enum Cause: String, Error {
    case name
    case binFolder = "bin_folder"
    case binShared = "bin_shared"
    case shadowed
    case taken
    case otherPlugin = "other_plugin"
    case busy
    case io
  }

  let reason: String
  let cause: Cause
}

extension PluginPrograms {
  static func openBin(_ places: ProgramPlaces, creating: Bool = false) -> Result<BinFolder, LinkRefusal> {
    BinFolder.open(places.binDir, creating: creating)
  }

  static func storeBase(_ store: String) -> [UInt8] {
    Array(store.utf8) + (store.utf8.last == 0x2F ? [] : [0x2F])
  }

  static func launcherOwner(_ bytes: [UInt8], in store: String) -> String? {
    let base = storeBase(store)
    guard bytes.starts(with: base), !bytes.contains(0), String(bytes: bytes, encoding: .utf8) != nil else { return nil }
    let parts = bytes.dropFirst(base.count).split(separator: 0x2F, omittingEmptySubsequences: false).map(Array.init)
    guard parts.count >= 3, !parts.contains(where: { $0.isEmpty || $0 == [0x2E] || $0 == [0x2E, 0x2E] }), parts[1] == Array(currentName.utf8) else { return nil }
    let owner = String(decoding: parts[0], as: UTF8.self)
    return isName(owner) && Array(owner.utf8) == parts[0] ? owner : nil
  }

  static func isLauncherPath(_ bytes: [UInt8], in store: String, plugin: String? = nil) -> Bool {
    guard let owner = launcherOwner(bytes, in: store) else { return false }
    return plugin.map { $0 == owner } ?? true
  }

  static func isLauncherPath(_ path: String, in store: String, plugin: String? = nil) -> Bool {
    isLauncherPath(Array(path.utf8), in: store, plugin: plugin)
  }

  static func isArdiaLink(_ name: String, existing: [UInt8], target: String, in bin: BinFolder, places: ProgramPlaces, deadLegacyLauncher: String?) -> Bool {
    if bin.leadsNowhere(name) {
      if let deadLegacyLauncher, existing == Array(deadLegacyLauncher.utf8) { return true }
      if isLauncherPath(existing, in: places.store) { return true }
    }
    return bin.isSameFile(name, as: target)
  }

  static func linkProblem(
    _ program: PluginProgram, plugin: String, places: ProgramPlaces, bin opened: Result<BinFolder, LinkRefusal>, adoptTarget: String? = nil, deadLegacyLauncher: String? = nil
  ) -> LinkRefusal? {
    guard isName(program.name) else { return LinkRefusal(reason: "\(program.name) isn't a program name", cause: .name) }
    let bin: BinFolder
    switch opened {
    case .failure(let refusal): return refusal
    case .success(let found): bin = found
    }
    if let hidden = places.shadowable.map({ ($0 as NSString).appendingPathComponent(program.name) }).first(where: { FileManager.default.isExecutableFile(atPath: $0) }) {
      return LinkRefusal(reason: "\(program.name) would hide \(hidden), so it isn't put on PATH", cause: .shadowed)
    }
    let path = (places.binDir as NSString).appendingPathComponent(program.name)
    let target = linkTargetPath(program, plugin: plugin, places: places)
    guard let present = bin.exists(program.name) else { return LinkRefusal(reason: "\(path) couldn't be checked", cause: .io) }
    guard present else { return nil }
    let taken = LinkRefusal(reason: "\(path) is someone else's; remove it to use this one", cause: .taken)
    guard let existing = bin.targetBytes(program.name) else { return taken }
    if existing == Array(target.utf8) || isLauncherPath(existing, in: places.store, plugin: plugin) || adoptTarget.map({ existing == Array($0.utf8) }) == true { return nil }
    if isArdiaLink(program.name, existing: existing, target: target, in: bin, places: places, deadLegacyLauncher: deadLegacyLauncher) { return nil }
    if let other = launcherOwner(existing, in: places.store) {
      return LinkRefusal(reason: "\(program.name) comes from the \(other) plugin; turn that one off to use this one", cause: .otherPlugin)
    }
    return taken
  }

  static func linkTargetPath(_ program: PluginProgram, plugin: String, places: ProgramPlaces) -> String {
    ((places.pluginStore(plugin) as NSString).appendingPathComponent(currentName) as NSString).appendingPathComponent(program.path)
  }

  static func link(
    _ program: PluginProgram, plugin: String, places: ProgramPlaces, bin opened: Result<BinFolder, LinkRefusal>, adoptTarget: String? = nil, deadLegacyLauncher: String? = nil
  ) -> LinkRefusal? {
    if let problem = linkProblem(program, plugin: plugin, places: places, bin: opened, adoptTarget: adoptTarget, deadLegacyLauncher: deadLegacyLauncher) { return problem }
    guard case .success(let bin) = opened else { return nil }
    let path = (places.binDir as NSString).appendingPathComponent(program.name)
    let target = linkTargetPath(program, plugin: plugin, places: places)
    let failed = LinkRefusal(reason: "\(path) couldn't be linked", cause: .io)
    guard let present = bin.exists(program.name) else { return failed }
    if !present { return bin.create(program.name, to: target) ? nil : failed }
    if bin.targetBytes(program.name) == Array(target.utf8) { return nil }
    return bin.swap(program.name, to: target) ? nil : failed
  }

  static func keepLegacy(plugin: String, programs: [PluginProgram], places: ProgramPlaces) -> Result<ProgramsLinked, FolderRefusal> {
    guard let lock = lock(plugin, places) else { return .failure(FolderRefusal(reason: "its program folder couldn't be locked")) }
    defer { close(lock) }
    let pluginStore = places.pluginStore(plugin)
    guard isRealFolder(pluginStore), let version = linkTarget((pluginStore as NSString).appendingPathComponent(currentName)), !version.contains("/"),
      let folder = PluginFiles.openFolder((pluginStore as NSString).appendingPathComponent(version))
    else { return .failure(FolderRefusal(reason: "its earlier copy is gone")) }
    guard hasPrivateAncestry(pluginStore) else {
      folder.close()
      return .failure(FolderRefusal(reason: "its program folder (\(pluginStore)) is inside a folder other users can change"))
    }
    defer { folder.close() }
    guard checkTree(folder.fd) == nil else { return .failure(FolderRefusal(reason: "its earlier copy isn't as Ardia made it")) }
    for program in programs where PluginFiles.localProgram(program.path, in: folder) == nil {
      return .failure(FolderRefusal(reason: "its earlier copy has no \(program.path)"))
    }
    var linked: [String] = []
    var refusals: [String: LinkRefusal] = [:]
    guard let binHeld = binLock(places) else {
      for program in programs { refusals[program.name] = LinkRefusal(reason: "\(places.binDir) couldn't be locked", cause: .busy) }
      return .success(ProgramsLinked(version: version, fresh: false, linked: [], refusals: refusals))
    }
    defer { close(binHeld) }
    let bin = openBin(places, creating: true)
    for program in programs {
      if let problem = link(program, plugin: plugin, places: places, bin: bin) { refusals[program.name] = problem } else { linked.append(program.name) }
    }
    return .success(ProgramsLinked(version: version, fresh: false, linked: linked, refusals: refusals, kept: version))
  }

  static func legacyCopy(plugin: String, places: ProgramPlaces) -> String? {
    let pluginStore = places.pluginStore(plugin)
    guard isRealFolder(pluginStore), let version = linkTarget((pluginStore as NSString).appendingPathComponent(currentName)), !version.contains("/"),
      ProgramRegistry.isComponent(version)
    else { return nil }
    let folder = (pluginStore as NSString).appendingPathComponent(version)
    guard isRealFolder(folder), let opened = PluginFiles.openFolder(folder) else { return nil }
    defer { opened.close() }
    guard case .text(let text) = PluginFiles.readManifest(in: opened) else { return nil }
    let base = versionFolderName(version: OfficialPin.manifestVersion(text), approved: PluginFiles.approvalHash(text: text, folderId: OfficialPin.legacyFolderId))
    return version == base || version.hasPrefix(base + "-r") ? folder : nil
  }

  static func dropCurrentUnlessTrusted(
    plugin: String, programs: [PluginProgram], places: ProgramPlaces, trusted: [TrustedProgramCopy], bundledDigests: Set<String> = [], onlyVersion: String? = nil
  ) -> CurrentCheck {
    guard let lock = lock(plugin, places) else { return .stuck }
    defer { close(lock) }
    let pluginStore = places.pluginStore(plugin)
    let currentPath = (pluginStore as NSString).appendingPathComponent(currentName)
    if let onlyVersion, linkTarget(currentPath) != onlyVersion { return .trusted }
    var info = stat()
    if lstat(currentPath, &info) != 0 && errno == ENOENT { return .trusted }
    if let version = linkTarget(currentPath), currentIsTrusted(version, plugin: plugin, programs: programs, places: places, trusted: trusted, bundledDigests: bundledDigests) {
      return .trusted
    }
    var offPath = false
    if let binHeld = binLock(places) {
      if case .success(let bin) = openBin(places) {
        unlinkOthers(plugin: plugin, keeping: [], places: places, in: bin)
        for program in programs where launchesFrom(program.name, plugin: plugin, places: places, in: bin) { bin.remove(program.name) }
        let reachesStore = { (name: String) in touchesPluginStore(name, pluginStore: pluginStore, in: bin) }
        offPath = (bin.names().map { !$0.contains(where: reachesStore) } ?? false) && !programs.contains { reachesStore($0.name) }
      }
      close(binHeld)
    }
    if linkTarget(currentPath) != nil { unlink(currentPath) } else { discard(currentPath) }
    let severed = lstat(currentPath, &info) != 0 && errno == ENOENT
    return offPath || severed ? .dropped : .stuck
  }

  private static func launchesFrom(_ name: String, plugin: String, places: ProgramPlaces, in bin: BinFolder) -> Bool {
    bin.targetBytes(name).map { isLauncherPath($0, in: places.store, plugin: plugin) } ?? false
  }

  private static func touchesPluginStore(_ name: String, pluginStore: String, in bin: BinFolder) -> Bool {
    guard let present = bin.exists(name) else { return true }
    guard present else { return false }
    return bin.targetBytes(name).map { $0.starts(with: storeBase(pluginStore)) } ?? false
  }

  static func currentIsTrusted(
    _ version: String, plugin: String, programs: [PluginProgram], places: ProgramPlaces, trusted: [TrustedProgramCopy], bundledDigests: Set<String> = []
  ) -> Bool {
    guard !version.contains("/") else { return false }
    let folder = (places.pluginStore(plugin) as NSString).appendingPathComponent(version)
    if legacyCopy(plugin: plugin, places: places) == folder {
      return hasPrivateAncestry(places.pluginStore(plugin)) && legacyHolds(folder, programs: programs) && OfficialTrust.bundledCopyHolds(folder, digests: bundledDigests)
    }
    let sources = trusted.filter { source in
      let base = versionFolderName(version: source.version, approved: source.approved)
      return version == base || version.hasPrefix(base + "-r")
    }
    guard !sources.isEmpty, isRealFolder(folder), isSealed(folder, keepingRootWritable: true), let digest = payloadDigest(folder, keepingCaches: true) else { return false }
    return sources.contains { $0.digest == digest }
  }

  private static func legacyHolds(_ folder: String, programs: [PluginProgram]) -> Bool {
    guard isRealFolder(folder), let opened = PluginFiles.openFolder(folder) else { return false }
    defer { opened.close() }
    return checkTree(opened.fd) == nil && programs.allSatisfy { PluginFiles.localProgram($0.path, in: opened) != nil }
  }
}

struct TrustedProgramCopy: Equatable {
  let version: String?
  let approved: String
  let digest: String
}

enum CurrentCheck: Equatable {
  case trusted
  case dropped
  case stuck
}
