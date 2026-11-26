import Foundation

struct StoreExpectation: Equatable {
  let key: String
  let id: String
  let version: String?
  let sha256: String?
}

enum PluginInstaller {
  struct Failure: Error, Equatable {
    let code: String
    let reason: String
    var cause: FailureCause = .other
  }

  struct Published: Equatable {
    let copy: StoreCopy
    let manifest: String
    let version: String
  }

  static let officialScope = "ardia"

  static func manifestFields(_ text: String) -> (manifest: Int?, id: String?, version: String?) {
    guard let doc = (try? JSONSerialization.jsonObject(with: Data(text.utf8))) as? [String: Any] else { return (nil, nil, nil) }
    return ((doc["manifest"] as? NSNumber)?.intValue, doc["id"] as? String, doc["version"] as? String)
  }

  static func refusal(manifest text: String, expected: StoreExpectation) -> String? {
    let fields = manifestFields(text)
    guard fields.manifest == 3 else { return "its plugin.json isn't manifest 3" }
    guard fields.id == expected.id else { return "its plugin.json is \(fields.id ?? "another plugin"), not \(expected.id)" }
    guard let version = fields.version, PluginStore.entryName(version: version, sha: String(repeating: "0", count: 64)) != nil else { return "its plugin.json has no usable version" }
    if let wanted = expected.version, version != wanted { return "its plugin.json is version \(version), not \(wanted)" }
    return nil
  }

  static func verifyAndPublish(_ expected: StoreExpectation, archive: String, scratch: String, store: PluginStore) -> Result<Published, Failure> {
    guard let parts = PluginStore.parts(expected.key), PluginStore.id(expected.key) == expected.id else { return .failure(Failure(code: "verify", reason: "\(expected.id) isn't a scoped plugin id")) }
    guard let held = PluginArchive.snapshot(archive, in: scratch) else { return .failure(Failure(code: "failed", reason: "the download couldn't be read", cause: .io)) }
    defer { held.close() }
    if let sha = expected.sha256, held.sha != sha {
      return .failure(Failure(code: "verify", reason: "the download doesn't match the registry's copy (SHA-256 \(held.sha.prefix(12))…, not \(sha.prefix(12))…)", cause: .mismatch))
    }
    guard let stage = store.makeScratch(expected.key, prefix: ".stage-") else { return .failure(Failure(code: "failed", reason: "its folder couldn't be made", cause: .folder)) }
    func refuse(_ failure: Failure) -> Result<Published, Failure> {
      PluginPrograms.discard(stage)
      return .failure(failure)
    }
    let stageFolder = open(stage, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
    guard stageFolder >= 0 else { return refuse(Failure(code: "failed", reason: "its folder couldn't be opened", cause: .folder)) }
    let unpacked = PluginArchive.unpack(held.fd, top: parts.name, into: stageFolder, scratch: scratch)
    close(stageFolder)
    if let problem = unpacked { return refuse(Failure(code: "verify", reason: problem, cause: .unpack)) }
    guard let opened = PluginFiles.openFolder(stage) else { return refuse(Failure(code: "verify", reason: "its folder can't be read", cause: .unpack)) }
    let read = PluginFiles.readManifest(in: opened)
    opened.close()
    guard case .text(let text) = read else { return refuse(Failure(code: "verify", reason: "its plugin.json can't be read", cause: .unpack)) }
    if let problem = refusal(manifest: text, expected: expected) { return refuse(Failure(code: "verify", reason: problem, cause: .unpack)) }
    guard let version = manifestFields(text).version else { return refuse(Failure(code: "verify", reason: "its plugin.json has no version", cause: .unpack)) }
    guard PluginStore.stripQuarantine(tree: stage) else { return refuse(Failure(code: "failed", reason: "its files couldn't be cleared for use", cause: .permission)) }
    switch store.publish(expected.key, version: version, staged: stage, archive: held, sha: held.sha) {
    case .failure(let refusal): return .failure(Failure(code: "failed", reason: refusal.reason, cause: refusal.cause))
    case .success(let copy): return .success(Published(copy: copy, manifest: text, version: version))
    }
  }

  static func localArchive(_ path: String, scratch: String, store: PluginStore) -> Result<Published, Failure> {
    guard let held = PluginArchive.snapshot(path, in: scratch) else { return .failure(Failure(code: "failed", reason: "the archive couldn't be read, or it's over 512 MB", cause: .io)) }
    let top = PluginArchive.topFolder(held.fd, scratch: scratch)
    held.close()
    guard let top else { return .failure(Failure(code: "verify", reason: "the archive's files aren't all in one folder named after the plugin", cause: .unpack)) }
    let probe = (scratch as NSString).appendingPathComponent("probe")
    guard mkdir(probe, 0o700) == 0, let again = PluginArchive.snapshot(path, in: scratch) else { return .failure(Failure(code: "failed", reason: "the archive couldn't be read", cause: .io)) }
    defer {
      again.close()
      PluginPrograms.discard(probe)
    }
    let probeFolder = open(probe, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
    guard probeFolder >= 0 else { return .failure(Failure(code: "failed", reason: "the archive couldn't be unpacked", cause: .folder)) }
    let problem = PluginArchive.unpack(again.fd, top: top, into: probeFolder, scratch: scratch)
    close(probeFolder)
    if let problem { return .failure(Failure(code: "verify", reason: problem, cause: .unpack)) }
    guard let opened = PluginFiles.openFolder(probe) else { return .failure(Failure(code: "verify", reason: "the archive's folder can't be read", cause: .unpack)) }
    let read = PluginFiles.readManifest(in: opened)
    opened.close()
    guard case .text(let text) = read, let id = manifestFields(text).id, let key = keyOf(id), PluginStore.parts(key)?.name == top else {
      return .failure(Failure(code: "verify", reason: "the archive has no manifest 3 plugin.json with an id like @you/\(top)", cause: .unpack))
    }
    guard PluginStore.parts(key)?.scope != officialScope else { return .failure(Failure(code: "verify", reason: "@ardia plugins come only from Ardia's registry", cause: .mismatch)) }
    return verifyAndPublish(StoreExpectation(key: key, id: id, version: nil, sha256: again.sha), archive: path, scratch: scratch, store: store)
  }

  static func keyOf(_ id: String) -> String? {
    guard id.hasPrefix("@"), let slash = id.firstIndex(of: "/") else { return nil }
    let key = "\(id[id.index(after: id.startIndex)..<slash])__\(id[id.index(after: slash)...])"
    return PluginStore.id(key) == id ? key : nil
  }

  static func reachesOutsideSandbox(_ text: String) -> Bool {
    guard let doc = (try? JSONSerialization.jsonObject(with: Data(text.utf8))) as? [String: Any] else { return true }
    let sidecar = doc["sidecar"].map { !($0 is NSNull) } ?? false
    let programs = ((doc["contributes"] as? [String: Any])?["programs"] as? [Any])?.isEmpty == false
    let control = (doc["permissions"] as? [String: Any])?["control"] as? Bool == true
    return sidecar || programs || control
  }

  static func activate(_ key: String, folderId: String, approved: String, store: PluginStore, officialKeys: [String]) -> String? {
    guard let sha = PluginStore.sha(ofFolderId: folderId), let copy = store.copy(key, sha: sha, fresh: true) else { return "Its download is gone or changed. Try again." }
    guard let opened = PluginFiles.openFolder(copy.path) else { return "Its download is gone. Try again." }
    let read = PluginFiles.readManifest(in: opened)
    opened.close()
    guard case .text(let text) = read, PluginFiles.approvalHash(text: text, folderId: folderId) == approved else { return "It changed since you approved it. Try again." }
    if PluginStore.parts(key)?.scope == officialScope, reachesOutsideSandbox(text), !store.isOfficial(copy, keys: officialKeys) {
      return "It reaches outside Ardia's sandbox but isn't signed by Ardia's release key, so it wasn't switched to."
    }
    return store.activate(key, sha: sha) ? nil : "It couldn't be switched to the new copy."
  }
}
