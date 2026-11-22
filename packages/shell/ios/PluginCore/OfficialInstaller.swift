import Foundation

enum OfficialInstaller {
  struct Failure: Error, Equatable {
    let code: String
    let reason: String
  }

  static func verifyAndPublish(
    _ entry: OfficialPinEntry, archive: String, scratch: String, store: OfficialStore, registry: ProgramRegistry
  ) -> Result<(copy: OfficialCopy, manifest: String), Failure> {
    guard let got = OfficialArchive.sha256(file: archive) else { return .failure(Failure(code: "failed", reason: "the download couldn't be read")) }
    guard got == entry.sha256 else {
      return .failure(Failure(code: "verify", reason: "the download doesn't match the copy this Ardia pins (SHA-256 \(got.prefix(12))…, not \(entry.sha256.prefix(12))…)"))
    }
    guard let stage = store.makeScratch(entry.name, prefix: ".stage-") else { return .failure(Failure(code: "failed", reason: "its folder couldn't be made")) }
    func refuse(_ failure: Failure) -> Result<(copy: OfficialCopy, manifest: String), Failure> {
      PluginPrograms.discard(stage)
      return .failure(failure)
    }
    if let problem = OfficialArchive.unpack(archive, top: entry.name, into: stage, scratch: scratch) { return refuse(Failure(code: "verify", reason: problem)) }
    guard let opened = PluginFiles.openFolder(stage) else { return refuse(Failure(code: "verify", reason: "its folder can't be read")) }
    let read = PluginFiles.readManifest(in: opened)
    opened.close()
    guard case .text(let text) = read else { return refuse(Failure(code: "verify", reason: "its plugin.json can't be read")) }
    if let problem = OfficialPin(entries: [entry]).refusal(manifest: text, of: entry) { return refuse(Failure(code: "verify", reason: problem)) }
    if registry.failClosed { return refuse(Failure(code: "verify", reason: "Ardia's list of official program names is missing or damaged")) }
    for program in ProgramRegistry.claimedPrograms(manifest: Data(text.utf8)) where registry.claims[program] != entry.name {
      return refuse(Failure(code: "verify", reason: "it claims \(program), which Ardia's signed list doesn't give it"))
    }
    guard OfficialStore.stripQuarantine(tree: stage) else { return refuse(Failure(code: "failed", reason: "its files couldn't be cleared for use")) }
    switch store.publish(entry.name, staged: stage, archive: archive, sha: entry.sha256) {
    case .failure(let refusal): return .failure(Failure(code: "failed", reason: refusal.reason))
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
