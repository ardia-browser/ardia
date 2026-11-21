import AppKit
import ArdiaCore
import Foundation

enum PluginProgramLinks {
  private static let queue = DispatchQueue(label: "ardia.plugin-programs", qos: .utility)
  private static let afterUpdateQueue = DispatchQueue(label: "ardia.plugin-programs.after-update", qos: .utility)
  private static let afterUpdateDeadline: TimeInterval = 300
  private static let pathMarker = ".path-line"
  static let builtInDigestsKey = "ArdiaBuiltInPlugins"

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
        PluginPrograms.withdraw(plugin: name, programs: programs, places: places)
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
        PluginPrograms.withdrawAllBut(Set(active), places: places)
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
    let builtIn = folderId == PluginFolders.bundledId
    guard let folders = PluginFolders.current() else { return ["ok": false, "reason": "Ardia has no data folder"] }
    let registry = folders.programRegistry()
    if let refusal = programs.lazy.compactMap({ registry.refusal(program: $0.name, plugin: name, builtIn: builtIn) }).first {
      return ["ok": false, "reason": refusal]
    }
    let afterUpdate = builtIn ? raw.compactMap { entry -> (String, [[String]])? in
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
    case .failure(let refusal): return ["ok": false, "reason": refusal.reason]
    case .success(let opened): folder = opened
    }
    defer { folder.close() }
    var expected: String?
    if builtIn {
      let signed = (Bundle.main.infoDictionary?[builtInDigestsKey] as? [String: String])?[name]
      if signed == nil && !LaunchConfig.shared.isolated { return ["ok": false, "reason": "it isn't in the list of built-in plugins this Ardia was signed with"] }
      expected = signed
    }
    let adoption = registry.adoption(for: name, programs: programs.map(\.name), builtIn: builtIn)
    let result = PluginPrograms.install(
      plugin: name, from: folder, approved: approved, version: spec["version"] as? String, programs: programs, places: places, expectedDigest: expected,
      adoption: adoption)
    switch result {
    case .failure(let refusal):
      return ["ok": false, "reason": refusal.reason]
    case .success(let linked):
      if !linked.linked.isEmpty { addToLoginPath(places) }
      if !afterUpdate.isEmpty, PluginPrograms.shouldRunAfterUpdate(linked, plugin: name, places: places) {
        runAfterUpdate(name, version: linked.version, commands: afterUpdate, places: places, generation: generation)
      }
      return ["ok": true, "linked": linked.linked, "refused": linked.refused, "binDir": places.binDir, "adopted": linked.adopted, "adoptBusy": linked.adoptBusy, "adoption": linked.adoption.rawValue]
    }
  }

  private static let runningLock = NSLock()
  private static var runningGroups: Set<pid_t> = []
  private static var quitObserver: NSObjectProtocol?

  private static func runAfterUpdate(_ name: String, version: String, commands: [(String, [[String]])], places: ProgramPlaces, generation: Int) {
    let folder = (places.pluginStore(name) as NSString).appendingPathComponent(version)
    let environment = childEnvironment(places)
    watchQuit()
    afterUpdateQueue.async {
      guard PluginPrograms.claimAfterUpdate(plugin: name, version: version, places: places) else { return }
      defer { PluginPrograms.releaseAfterUpdate(plugin: name, version: version, places: places) }
      let leased = PluginPrograms.lease(plugin: name, version: version, places: places)
      defer { if let leased { Darwin.unlink(leased) } }
      var succeeded = true
      for (program, runs) in commands {
        for arguments in runs {
          guard isCurrent(name, generation) else { return }
          let started = PluginPrograms.whileCurrent(plugin: name, version: version, places: places) {
            spawnGroup((folder as NSString).appendingPathComponent(program), arguments, environment: environment)
          }
          guard let started else { return }
          guard let group = started else {
            succeeded = false
            continue
          }
          if wait(group: group) != 0 { succeeded = false }
        }
      }
      if succeeded, isCurrent(name, generation) { PluginPrograms.markAfterUpdate(plugin: name, version: version, places: places) }
    }
  }

  private static func spawnGroup(_ program: String, _ arguments: [String], environment: [String: String]) -> pid_t? {
    var attributes: posix_spawnattr_t?
    var actions: posix_spawn_file_actions_t?
    guard posix_spawnattr_init(&attributes) == 0 else { return nil }
    defer { posix_spawnattr_destroy(&attributes) }
    guard posix_spawn_file_actions_init(&actions) == 0 else { return nil }
    defer { posix_spawn_file_actions_destroy(&actions) }
    guard posix_spawnattr_setflags(&attributes, Int16(POSIX_SPAWN_SETPGROUP | POSIX_SPAWN_CLOEXEC_DEFAULT)) == 0, posix_spawnattr_setpgroup(&attributes, 0) == 0 else { return nil }
    for fd: Int32 in [0, 1, 2] {
      guard posix_spawn_file_actions_addopen(&actions, fd, "/dev/null", fd == 0 ? O_RDONLY : O_WRONLY, 0) == 0 else { return nil }
    }
    guard posix_spawn_file_actions_addchdir_np(&actions, NSTemporaryDirectory()) == 0 else { return nil }
    let argv = ([program] + arguments).map { strdup($0) } + [nil]
    let envp = environment.map { strdup("\($0.key)=\($0.value)") } + [nil]
    defer { (argv + envp).forEach { free($0) } }
    var pid: pid_t = 0
    guard posix_spawn(&pid, program, &actions, &attributes, argv, envp) == 0 else { return nil }
    runningLock.lock()
    runningGroups.insert(pid)
    runningLock.unlock()
    return pid
  }

  private static func wait(group: pid_t) -> Int32 {
    let deadline = Date().addingTimeInterval(afterUpdateDeadline)
    var exited = false
    while Date() < deadline {
      var info = siginfo_t()
      if waitid(P_PID, id_t(group), &info, WEXITED | WNOHANG | WNOWAIT) == 0, info.si_pid == group {
        exited = true
        break
      }
      usleep(100_000)
    }
    kill(-group, SIGTERM)
    if !exited {
      usleep(3_000_000)
      kill(-group, SIGKILL)
    }
    var status: Int32 = 0
    while waitpid(group, &status, 0) < 0 && errno == EINTR {}
    runningLock.lock()
    runningGroups.remove(group)
    runningLock.unlock()
    return exited && (status & 0x7f) == 0 ? (status >> 8) & 0xff : -1
  }

  private static func watchQuit() {
    runningLock.lock()
    defer { runningLock.unlock() }
    guard quitObserver == nil else { return }
    quitObserver = NotificationCenter.default.addObserver(forName: NSApplication.willTerminateNotification, object: nil, queue: nil) { _ in
      runningLock.lock()
      let groups = runningGroups
      runningLock.unlock()
      for group in groups { kill(-group, SIGKILL) }
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
