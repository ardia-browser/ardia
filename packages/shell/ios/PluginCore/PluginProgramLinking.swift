import Darwin
import Foundation

extension PluginPrograms {
  static func linkProblem(_ program: PluginProgram, plugin: String, places: ProgramPlaces, adoptTarget: String? = nil) -> String? {
    guard isName(program.name) else { return "\(program.name) isn't a program name" }
    var folder = stat()
    if lstat(places.binDir, &folder) == 0 && !isRealFolder(places.binDir) { return "\(places.binDir) isn't a folder you own" }
    if let hidden = places.shadowable.map({ ($0 as NSString).appendingPathComponent(program.name) }).first(where: { FileManager.default.isExecutableFile(atPath: $0) }) {
      return "\(program.name) would hide \(hidden), so it isn't put on PATH"
    }
    let path = (places.binDir as NSString).appendingPathComponent(program.name)
    let target = linkTargetPath(program, plugin: plugin, places: places)
    var info = stat()
    guard lstat(path, &info) == 0 else { return errno == ENOENT ? nil : "\(path) couldn't be checked" }
    guard (info.st_mode & S_IFMT) == S_IFLNK, let existing = linkTarget(path) else { return "\(path) is someone else's; remove it to use this one" }
    if existing == target || isInside(existing, places.pluginStore(plugin)) || (adoptTarget != nil && existing == adoptTarget) { return nil }
    if isInside(existing, places.store), let other = owner(of: existing, store: places.store) {
      return "\(program.name) comes from the \(other) plugin; turn that one off to use this one"
    }
    return "\(path) is someone else's; remove it to use this one"
  }

  static func linkTargetPath(_ program: PluginProgram, plugin: String, places: ProgramPlaces) -> String {
    ((places.pluginStore(plugin) as NSString).appendingPathComponent(currentName) as NSString).appendingPathComponent(program.path)
  }

  static func link(_ program: PluginProgram, plugin: String, places: ProgramPlaces, adoptTarget: String? = nil) -> String? {
    guard isName(program.name) else { return "\(program.name) isn't a program name" }
    guard realFolder(places.binDir, creating: true) != nil else { return "\(places.binDir) isn't a folder you own" }
    guard hasPrivateAncestry(places.binDir, followingLinks: true) else { return "\(places.binDir) is inside a folder other users can change" }
    if let problem = linkProblem(program, plugin: plugin, places: places, adoptTarget: adoptTarget) { return problem }
    let path = (places.binDir as NSString).appendingPathComponent(program.name)
    let target = linkTargetPath(program, plugin: plugin, places: places)
    var info = stat()
    if lstat(path, &info) != 0 {
      return symlink(target, path) == 0 ? nil : "\(path) couldn't be linked"
    }
    if linkTarget(path) == target { return nil }
    let temporary = (places.binDir as NSString).appendingPathComponent(".\(program.name).ardia-\(getpid())-\(UInt32.random(in: 0...UInt32.max))")
    guard symlink(target, temporary) == 0 else { return "\(path) couldn't be linked" }
    guard rename(temporary, path) == 0 else {
      unlink(temporary)
      return "\(path) couldn't be linked"
    }
    return nil
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
    var refused: [String: String] = [:]
    guard let bin = binLock(places) else {
      for program in programs { refused[program.name] = "\(places.binDir) couldn't be locked" }
      return .success(ProgramsLinked(version: version, fresh: false, linked: [], refused: refused))
    }
    defer { close(bin) }
    for program in programs {
      if let problem = link(program, plugin: plugin, places: places) { refused[program.name] = problem } else { linked.append(program.name) }
    }
    return .success(ProgramsLinked(version: version, fresh: false, linked: linked, refused: refused, kept: version))
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
    if let bin = binLock(places) {
      unlinkOthers(plugin: plugin, keeping: [], places: places)
      for program in programs where linksIntoPlugin(program.name, pluginStore: pluginStore, places: places) {
        unlink((places.binDir as NSString).appendingPathComponent(program.name))
      }
      let listed = (try? FileManager.default.contentsOfDirectory(atPath: places.binDir)) != nil
      offPath = listed && !linksIntoStore(places).contains { isInside($0.1, pluginStore) }
        && !programs.contains { linksIntoPlugin($0.name, pluginStore: pluginStore, places: places) }
      close(bin)
    }
    if linkTarget(currentPath) != nil { unlink(currentPath) } else { discard(currentPath) }
    let severed = lstat(currentPath, &info) != 0 && errno == ENOENT
    return offPath || severed ? .dropped : .stuck
  }

  private static func linksIntoPlugin(_ name: String, pluginStore: String, places: ProgramPlaces) -> Bool {
    let path = (places.binDir as NSString).appendingPathComponent(name)
    var info = stat()
    if lstat(path, &info) != 0 { return errno != ENOENT }
    return linkTarget(path).map { isInside($0, pluginStore) } ?? false
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
