import AppKit
import ArdiaCore
import Foundation

enum PluginProgramLinks {
  private static let queue = DispatchQueue(label: "ardia.plugin-programs", qos: .utility)
  private static let afterUpdateQueue = DispatchQueue(label: "ardia.plugin-programs.after-update", qos: .utility)
  private static let afterUpdateDeadline: TimeInterval = 300
  private static let afterUpdateGrace: TimeInterval = 3
  private static let pathMarker = ".path-line"

  private static let lock = NSLock()
  private static var generations: [String: Int] = [:]

  private static func request(_ name: String) -> Int {
    lock.lock()
    defer { lock.unlock() }
    let next = (generations[name] ?? 0) + 1
    generations[name] = next
    return next
  }

  private static func isCurrent(_ name: String, _ generation: Int) -> Bool {
    lock.lock()
    defer { lock.unlock() }
    return generations[name] == generation
  }

  static func link(_ spec: [String: Any], done: @escaping ([String: Any]) -> Void) {
    let name = spec["name"] as? String ?? ""
    let generation = request(name)
    queue.async {
      guard isCurrent(name, generation) else { return done(["ok": false, "stale": true]) }
      done(linkNow(spec, generation: generation))
    }
  }

  static func unlink(_ name: String, programs: [String], remove: Bool, done: @escaping ([String: Any]) -> Void) {
    let generation = request(name)
    queue.async {
      guard isCurrent(name, generation) else { return done(["ok": false, "stale": true]) }
      guard let folders = PluginFolders.current(), case .success(let places) = folders.programPlaces() else { return done(["ok": true]) }
      if remove {
        done(["ok": PluginPrograms.remove(plugin: name, programs: programs, places: places)])
      } else {
        PluginPrograms.withdraw(plugin: name, programs: programs, places: places, keepCopy: PluginFolders.officialPin()?.entry(name) != nil)
        done(["ok": true])
      }
    }
  }

  static func legacyInstalled(done: @escaping ([String]) -> Void) {
    queue.async {
      guard let folders = PluginFolders.current() else { return done([]) }
      let registry = folders.programRegistry()
      done(registry.failClosed ? [] : registry.legacy.filter(PluginPrograms.legacyInstalled).map(\.owner))
    }
  }

  static func registry(done: @escaping ([String: Any]) -> Void) {
    queue.async { done((PluginFolders.current()?.programRegistry() ?? .empty).jsonValue) }
  }

  static func sweep(keeping active: [String], done: @escaping () -> Void) {
    queue.async {
      if let folders = PluginFolders.current(), case .success(let places) = folders.programPlaces() {
        PluginPrograms.withdrawAllBut(Set(active), places: places, keepingCopies: Set(PluginFolders.officialPin()?.entries.map(\.name) ?? []))
      }
      done()
    }
  }

  private static func linkNow(_ spec: [String: Any], generation: Int) -> [String: Any] {
    let name = spec["name"] as? String ?? ""
    guard PluginFolders.isName(name), let folderId = spec["folderId"] as? String, let approved = spec["approved"] as? String,
      let raw = spec["programs"] as? [[String: Any]]
    else { return ["ok": false, "reason": "linkPrograms needs name, folderId, approved and programs"] }
    let programs = raw.compactMap { entry -> PluginProgram? in
      guard let program = entry["name"] as? String, let path = entry["path"] as? String else { return nil }
      return PluginProgram(name: program, path: path)
    }
    guard let folders = PluginFolders.current() else { return ["ok": false, "reason": "Ardia has no data folder"] }
    let pin = PluginFolders.officialPin()
    let legacy = folderId == PluginFolders.legacyId
    let copy = legacy ? nil : folders.officialCopy(name, folderId: folderId, pin: pin, fresh: true)
    if legacy && folders.legacyFolder(name, pin: pin) == nil { return ["ok": false, "reason": "its earlier copy is gone"] }
    let unverified = { (reason: String) -> [String: Any] in
      if case .success(let places) = folders.programPlaces(),
        PluginPrograms.dropCurrentUnlessTrusted(plugin: name, programs: programs, places: places, trusted: [], bundledDigests: pin?.entry(name)?.bundledDigests ?? []) == .stuck
      {
        return ["ok": false, "reason": "\(reason), and the programs it left on PATH couldn't be taken off"]
      }
      return ["ok": false, "reason": reason]
    }
    if OfficialPin.sha(ofFolderId: folderId) != nil && copy == nil { return unverified("its downloaded copy is gone") }
    let builtIn = legacy || copy != nil
    let registry = folders.programRegistry(pin: pin)
    if let refusal = programs.lazy.compactMap({ registry.refusal(program: $0.name, plugin: name, builtIn: builtIn) }).first {
      return ["ok": false, "reason": refusal]
    }
    let afterUpdate = copy != nil ? raw.compactMap { entry -> (String, [[String]])? in
      guard let program = entry["path"] as? String, let commands = entry["afterUpdate"] as? [[String]], !commands.isEmpty else { return nil }
      return (program, commands)
    } : []
    let places: ProgramPlaces
    switch folders.programPlaces() {
    case .failure(let refusal): return ["ok": false, "reason": refusal.reason]
    case .success(let found): places = found
    }
    let folder: OpenedFolder
    switch folders.approvedFolder(name, folderId: folderId, approved: approved) {
    case .failure(let refusal): return copy != nil ? unverified(refusal.reason) : ["ok": false, "reason": refusal.reason]
    case .success(let opened): folder = opened
    }
    defer { folder.close() }
    let result: Result<ProgramsLinked, FolderRefusal>
    if legacy {
      result = PluginPrograms.keepLegacy(plugin: name, programs: programs, places: places)
    } else {
      let adoption = registry.adoption(for: name, programs: programs.map(\.name), builtIn: builtIn)
      result = PluginPrograms.install(
        plugin: name, from: folder, approved: approved, version: spec["version"] as? String, programs: programs, places: places,
        expectedDigest: copy?.payloadDigest, adoption: adoption)
    }
    let clean: Bool
    switch result {
    case .failure: clean = false
    case .success(let linked): clean = linked.refused.isEmpty
    }
    var check = CurrentCheck.trusted
    if !clean, let copy {
      let source = TrustedProgramCopy(version: spec["version"] as? String, approved: approved, digest: copy.payloadDigest)
      check = PluginPrograms.dropCurrentUnlessTrusted(plugin: name, programs: programs, places: places, trusted: [source], bundledDigests: pin?.entry(name)?.bundledDigests ?? [])
      if check == .stuck { return ["ok": false, "reason": "its programs on PATH don't match the copy Ardia checked, and couldn't be taken off PATH"] }
    }
    switch result {
    case .failure(let refusal):
      return ["ok": false, "reason": refusal.reason]
    case .success(let linked):
      if !linked.linked.isEmpty { addToLoginPath(places) }
      if !afterUpdate.isEmpty, PluginPrograms.shouldRunAfterUpdate(linked, plugin: name, places: places) {
        runAfterUpdate(name, version: linked.version, commands: afterUpdate, programs: programs, places: places, generation: generation, digest: copy?.payloadDigest)
      }
      var reply: [String: Any] = ["ok": true, "linked": linked.linked, "refused": linked.refused, "binDir": places.binDir, "adopted": linked.adopted, "adoptBusy": linked.adoptBusy, "adoption": linked.adoption.rawValue]
      if let kept = linked.kept, check == .trusted { reply["kept"] = kept }
      return reply
    }
  }

  private static let runs = AfterUpdateRuns.shared
  private static let quitStopsFile = "after-update-quit-stops.json"
  private static var quitObserver: NSObjectProtocol?
  private static var quitCancelObserver: NSObjectProtocol?
  private static let quitObserverLock = NSLock()
  private static let quitStopsLock = NSLock()
  private static let quitStopsConsentLock = NSLock()
  private static var quitStopsConsent = ""

  static var afterUpdatesRunning: Bool { !runs.running.isEmpty }

  private static let quitStopsQueue = DispatchQueue(label: "ardia.plugin-programs.quit-stops", qos: .userInitiated)
  private static let quitStopsWriteLimit: TimeInterval = 0.25
  private static let quitHoldLimit = AfterUpdateRuns.quitGrace + AfterUpdateRuns.quitReapLimit + quitStopsWriteLimit + 0.75
  static let quitCancelledNotification = Notification.Name("ArdiaHostQuitCancelled")

  static func holdAfterUpdates() {
    watchQuit()
    runs.beginQuit()
  }

  static func resumeAfterUpdates() { runs.resume() }

  static func stopAfterUpdates(done: @escaping () -> Void) {
    var answered = false
    let answer = {
      guard !answered else { return }
      answered = true
      done()
    }
    DispatchQueue.main.asyncAfter(deadline: .now() + quitHoldLimit, execute: answer)
    runs.stopForQuit(limit: quitHoldLimit) { stops in
      recordWithinLimit(stops)
      DispatchQueue.main.async(execute: answer)
    }
  }

  private static func finishAfterUpdates() {
    guard let stops = runs.finishQuit() else { return }
    recordWithinLimit(stops)
  }

  private static func recordWithinLimit(_ stops: AfterUpdateQuitStops) {
    guard !stops.isEmpty else { return }
    let consent = currentQuitStopsConsent()
    let written = DispatchSemaphore(value: 0)
    quitStopsQueue.async {
      recordQuitStops(stops, consent: consent)
      written.signal()
    }
    _ = written.wait(timeout: .now() + quitStopsWriteLimit)
  }

  private static func runAfterUpdate(
    _ name: String, version: String, commands: [(String, [[String]])], programs: [PluginProgram], places: ProgramPlaces, generation: Int, digest: String?
  ) {
    let steps = commands.flatMap { program, runList in runList.map { (program, $0) } }
    watchQuit()
    runAfterUpdateSteps(name, version: version, steps: steps, from: 0, succeeded: true, programs: programs, places: places, generation: generation, digest: digest)
  }

  private static func runAfterUpdateSteps(
    _ name: String, version: String, steps: [(String, [String])], from first: Int, succeeded earlier: Bool, programs: [PluginProgram], places: ProgramPlaces,
    generation: Int, digest: String?
  ) {
    afterUpdateQueue.async {
      let retry = { (step: Int, succeeded: Bool) in
        runs.whenOpen {
          runAfterUpdateSteps(name, version: version, steps: steps, from: step, succeeded: succeeded, programs: programs, places: places, generation: generation, digest: digest)
        }
      }
      guard !runs.isQuitting else { return retry(first, earlier) }
      guard PluginPrograms.claimAfterUpdate(plugin: name, version: version, places: places) else { return }
      defer { PluginPrograms.releaseAfterUpdate(plugin: name, version: version, places: places) }
      let leased = PluginPrograms.lease(plugin: name, version: version, places: places)
      defer { if let leased { Darwin.unlink(leased) } }
      let folder = (places.pluginStore(name) as NSString).appendingPathComponent(version)
      let environment = childEnvironment(places)
      var succeeded = earlier
      for step in steps.indices where step >= first {
        let (program, arguments) = steps[step]
        guard isCurrent(name, generation) else { return }
        var damaged = false
        let started = PluginPrograms.whileCurrent(plugin: name, version: version, places: places) { () -> AfterUpdateSpawn in
          if let digest, !PluginPrograms.isSealed(folder, keepingRootWritable: true) || PluginPrograms.payloadDigest(folder, keepingCaches: true) != digest {
            damaged = true
            return .failed
          }
          return runs.spawn((folder as NSString).appendingPathComponent(program), arguments, environment: environment)
        }
        if damaged {
          _ = PluginPrograms.dropCurrentUnlessTrusted(plugin: name, programs: programs, places: places, trusted: [], onlyVersion: version)
          return
        }
        switch started {
        case nil: return
        case .quitting?: return retry(step, succeeded)
        case .failed?: succeeded = false
        case .started(let group)?:
          let code = runs.wait(group: group, deadline: afterUpdateDeadline, grace: afterUpdateGrace)
          if code == AfterUpdateRuns.interrupted { return retry(step, succeeded) }
          if code != 0 { succeeded = false }
        }
      }
      if succeeded, isCurrent(name, generation) { PluginPrograms.markAfterUpdate(plugin: name, version: version, places: places) }
    }
  }

  private static func watchQuit() {
    quitObserverLock.lock()
    defer { quitObserverLock.unlock() }
    guard quitObserver == nil else { return }
    quitObserver = NotificationCenter.default.addObserver(forName: NSApplication.willTerminateNotification, object: nil, queue: nil) { _ in
      finishAfterUpdates()
    }
    quitCancelObserver = NotificationCenter.default.addObserver(forName: quitCancelledNotification, object: nil, queue: nil) { _ in
      runs.resume()
    }
  }

  static func setQuitStopsConsent(_ consent: String) {
    quitStopsConsentLock.lock()
    quitStopsConsent = consent
    quitStopsConsentLock.unlock()
  }

  private static func currentQuitStopsConsent() -> String {
    quitStopsConsentLock.lock()
    defer { quitStopsConsentLock.unlock() }
    return quitStopsConsent
  }

  private static func recordQuitStops(_ stops: AfterUpdateQuitStops, consent: String) {
    quitStopsLock.lock()
    defer { quitStopsLock.unlock() }
    guard !consent.isEmpty, consent == currentQuitStopsConsent(), let url = try? DocumentStore.url(quitStopsFile) else { return }
    let saved = readQuitStops(url)
    let total = (saved.consent == consent ? saved.stops : AfterUpdateQuitStops()) + stops
    let doc: [String: Any] = ["consent": consent, "exitedOnTerm": total.exitedOnTerm, "killed": total.killed]
    guard let data = try? JSONSerialization.data(withJSONObject: doc) else { return }
    try? data.write(to: url, options: .atomic)
  }

  private static func readQuitStops(_ url: URL) -> (consent: String, stops: AfterUpdateQuitStops) {
    guard let data = try? Data(contentsOf: url), let saved = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any], let consent = saved["consent"] as? String else {
      return ("", AfterUpdateQuitStops())
    }
    return (consent, AfterUpdateQuitStops(exitedOnTerm: max(0, saved["exitedOnTerm"] as? Int ?? 0), killed: max(0, saved["killed"] as? Int ?? 0)))
  }

  static func takeQuitStops(done: @escaping ([String: Any]) -> Void) {
    queue.async {
      guard let url = try? DocumentStore.url(quitStopsFile) else { return done(["consent": "", "exitedOnTerm": 0, "killed": 0]) }
      quitStopsLock.lock()
      let saved = readQuitStops(url)
      try? FileManager.default.removeItem(at: url)
      quitStopsLock.unlock()
      done(["consent": saved.consent, "exitedOnTerm": saved.stops.exitedOnTerm, "killed": saved.stops.killed])
    }
  }

  private static func childEnvironment(_ places: ProgramPlaces) -> [String: String] {
    var environment = LaunchConfig.shared.environmentForChildProcesses.filter { !$0.key.hasPrefix("ARDIA_") }
    guard LaunchConfig.shared.isolated else { return environment }
    let home = ((places.store as NSString).deletingLastPathComponent as NSString).appendingPathComponent("ProgramsHome")
    try? FileManager.default.createDirectory(atPath: home, withIntermediateDirectories: true)
    environment["HOME"] = home
    if let data = LaunchConfig.shared.dataDirectory { environment["ARDIA_DATA_DIR"] = data }
    if let legacy = LaunchConfig.shared.instance(PluginFolders.isolatedLegacyKey) { environment["ARDIA_CLI_HOME"] = legacy }
    return environment
  }

  private static func addToLoginPath(_ places: ProgramPlaces) {
    guard !LaunchConfig.shared.isolated else { return }
    let home = FileManager.default.homeDirectoryForCurrentUser.path
    guard places.binDir == (home as NSString).appendingPathComponent(".local/bin") else { return }
    let configHome = LaunchConfig.shared.environmentForChildProcesses["XDG_CONFIG_HOME"].flatMap { $0.hasPrefix("/") ? $0 : nil } ?? (home as NSString).appendingPathComponent(".config")
    _ = PluginLoginPath.ensure(shellPath: loginShell(), home: home, configHome: configHome, marker: (places.store as NSString).appendingPathComponent(pathMarker))
  }

  private static func loginShell() -> String {
    if let entry = getpwuid(getuid()), let shell = entry.pointee.pw_shell {
      let path = String(cString: shell)
      if FileManager.default.isExecutableFile(atPath: path) { return path }
    }
    return "/bin/zsh"
  }
}
