import ArdiaCore
import Foundation

struct PluginCredentialPlan {
  let manifest: Data
  let memoryMB: Int

  static func make(for spec: PluginProcess.Spec, folders: PluginFolders) -> Result<PluginCredentialPlan?, FolderRefusal> {
    let pin = PluginFolders.officialPin()
    let official = folders.isOfficial(spec.name, folderId: spec.folderId)
    if !official, let refusal = pin?.credentialRefusal(name: spec.name, official: false, program: nil) { return .failure(FolderRefusal(reason: refusal)) }
    guard case .success(let folder) = folders.approvedFolder(spec.name, folderId: spec.folderId, approved: spec.approved) else {
      guard PluginCredentialProviders.saved()[spec.name] != nil else { return .success(nil) }
      return .failure(FolderRefusal(reason: "This copy of \(spec.name) is damaged. Reinstall it."))
    }
    defer { folder.close() }
    guard case .text(let text) = PluginFiles.readManifest(in: folder), PluginFiles.approvalHash(text: text, folderId: folder.id) == spec.approved else {
      return .success(nil)
    }
    let manifest = Data(text.utf8)
    let check = CredentialPluginHost.check(manifest: manifest)
    guard check.declaresProvider else { return .success(nil) }
    guard official, let pin else { return .failure(FolderRefusal(reason: "Ardia runs password managers only from its official plugins.")) }
    guard check.accepted, spec.isScript else {
      return .failure(FolderRefusal(reason: check.refusals.first.map { "its plugin.json: \($0)" } ?? "a password manager plugin runs in main"))
    }
    if let refusal = pin.credentialRefusal(name: spec.name, official: true, program: check.program ?? "") { return .failure(FolderRefusal(reason: refusal)) }
    return .success(PluginCredentialPlan(manifest: manifest, memoryMB: check.memoryMB))
  }

  static func officialManifest(_ name: String, approved: String, folders: PluginFolders) -> Data? {
    guard let pin = PluginFolders.officialPin(), let entry = pin.entry(name), pin.reservedProviders[name] == name,
      let active = OfficialTrust.trustedActive(folders.officialStore(), entry), let folder = PluginFiles.openFolder(active.path)
    else { return nil }
    defer { folder.close() }
    guard case .text(let text) = PluginFiles.readManifest(in: folder), PluginFiles.approvalHash(text: text, folderId: active.folderId) == approved else { return nil }
    let manifest = Data(text.utf8)
    let check = CredentialPluginHost.check(manifest: manifest)
    guard check.accepted, let program = check.program, entry.credentialPrograms.contains(program) else { return nil }
    return manifest
  }

  static func refusedProgramRoots(_ folders: PluginFolders) -> [String] {
    var roots = [folders.pluginsLexical, folders.dataRoot(), folders.officialStore().root, (folders.appData as NSString).appendingPathComponent("Programs")]
    if case .success(let places) = folders.programPlaces() { roots.append(places.store) }
    return roots
  }
}

enum PluginCredentialProviders {
  private static let lock = NSLock()

  static func saved() -> [String: String] {
    lock.withLock {
      guard let text = DocumentStore.read(PluginHost.credentialProvidersFile),
        let table = (try? JSONSerialization.jsonObject(with: Data(text.utf8))) as? [String: String]
      else { return [:] }
      return table.filter { PluginFolders.isName($0.key) && OfficialPin.isSha($0.value) }
    }
  }

  static func save(_ name: String, approved: String?) {
    lock.withLock {
      var table = (DocumentStore.read(PluginHost.credentialProvidersFile).flatMap { try? JSONSerialization.jsonObject(with: Data($0.utf8)) } as? [String: String]) ?? [:]
      guard table[name] != approved else { return }
      table[name] = approved
      guard let data = try? JSONSerialization.data(withJSONObject: table, options: [.sortedKeys]) else { return }
      try? DocumentStore.write(PluginHost.credentialProvidersFile, String(decoding: data, as: UTF8.self))
    }
  }
}
