import Foundation

enum OfficialInstaller {
  struct Failure: Error, Equatable {
    let code: String
    let reason: String
    var cause: FailureCause = .other
  }

  static func verifyAndPublish(
    _ entry: OfficialPinEntry, archive: String, scratch: String, store: OfficialStore, registry: ProgramRegistry
  ) -> Result<(copy: OfficialCopy, manifest: String), Failure> {
    guard let held = OfficialArchive.snapshot(archive, in: scratch) else { return .failure(Failure(code: "failed", reason: "the download couldn't be read", cause: .io)) }
    defer { held.close() }
    guard held.sha == entry.sha256 else {
      return .failure(Failure(code: "verify", reason: "the download doesn't match the copy this Ardia pins (SHA-256 \(held.sha.prefix(12))…, not \(entry.sha256.prefix(12))…)", cause: .mismatch))
    }
    guard let stage = store.makeScratch(entry.name, prefix: ".stage-") else { return .failure(Failure(code: "failed", reason: "its folder couldn't be made", cause: .folder)) }
    func refuse(_ failure: Failure) -> Result<(copy: OfficialCopy, manifest: String), Failure> {
      PluginPrograms.discard(stage)
      return .failure(failure)
    }
    let stageFolder = open(stage, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
    guard stageFolder >= 0 else { return refuse(Failure(code: "failed", reason: "its folder couldn't be opened", cause: .folder)) }
    let unpacked = OfficialArchive.unpack(held.fd, top: entry.name, into: stageFolder, scratch: scratch)
    close(stageFolder)
    if let problem = unpacked { return refuse(Failure(code: "verify", reason: problem, cause: .unpack)) }
    guard let opened = PluginFiles.openFolder(stage) else { return refuse(Failure(code: "verify", reason: "its folder can't be read", cause: .unpack)) }
    let read = PluginFiles.readManifest(in: opened)
    opened.close()
    guard case .text(let text) = read else { return refuse(Failure(code: "verify", reason: "its plugin.json can't be read", cause: .unpack)) }
    if let problem = OfficialPin(entries: [entry]).refusal(manifest: text, of: entry) { return refuse(Failure(code: "verify", reason: problem, cause: .unpack)) }
    if registry.failClosed { return refuse(Failure(code: "verify", reason: "Ardia's list of official program names is missing or damaged")) }
    for program in ProgramRegistry.claimedPrograms(manifest: Data(text.utf8)) where registry.claims[program] != entry.name {
      return refuse(Failure(code: "verify", reason: "it claims \(program), which Ardia's signed list doesn't give it"))
    }
    guard OfficialStore.stripQuarantine(tree: stage) else { return refuse(Failure(code: "failed", reason: "its files couldn't be cleared for use", cause: .permission)) }
    switch store.publish(entry.name, staged: stage, archive: held, sha: entry.sha256) {
    case .failure(let refusal): return .failure(Failure(code: "failed", reason: refusal.reason, cause: refusal.cause))
    case .success(let copy): return .success((copy, text))
    }
  }

  static func promote(_ name: String, folderId: String, approved: String, store: OfficialStore, pin: OfficialPin) -> String? {
    guard let entry = pin.entry(name), let sha = OfficialPin.sha(ofFolderId: folderId) else { return "It isn't an official plugin this Ardia pins." }
    guard store.active(name)?.sha == sha || sha == entry.sha256, let copy = store.copy(name, sha: sha, fresh: true) else { return "Its download is gone or changed. Try again." }
    guard let opened = PluginFiles.openFolder(copy.path) else { return "Its download is gone. Try again." }
    let read = PluginFiles.readManifest(in: opened)
    opened.close()
    guard case .text(let text) = read, PluginFiles.approvalHash(text: text, folderId: folderId) == approved else { return "It changed since you approved it. Try again." }
    return store.activate(name, sha: sha) ? nil : "It couldn't be switched to the new copy."
  }
}
