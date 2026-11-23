import ArdiaCore
import Darwin
import Foundation

final class PluginProcess: PluginRun {
  static let channelFd: Int32 = 3
  static let memoryCheckInterval: TimeInterval = 10
  static let familySampleInterval: TimeInterval = 1

  let name: String
  let run: Int
  let pid: pid_t
  private let queue: DispatchQueue
  private let memoryLimit: UInt64
  private(set) var connection: ControlConnection?
  private var exitSource: DispatchSourceProcess?
  private var memoryTimer: DispatchSourceTimer?
  private var killTimer: DispatchWorkItem?
  private var stopWaiters: [() -> Void] = []
  private(set) var exited = false
  private var reaped = false
  private var overMemory = false
  let approved: String
  let hasPage: Bool
  let launch: Int
  var onPagePost: ((PluginProcess, PagePost) -> String?)?
  var credential: CredentialRunEndpoint?
  private(set) var sink: PluginRedactingSink?
  private(set) var refusedCredentialLines = 0
  private var stopRequested = false
  private var family: PluginFamily?
  private var log: Int32

  struct Spec {
    let name: String
    let run: [String]
    var memoryMB: Int
    let network: Bool
    let folderId: String
    let approved: String
    let hasPage: Bool
    let launch: Int
    var runtime = "process"
    var entry: String?
    var closedOutput = false

    var isScript: Bool { runtime == "js" }
    var sandboxNetwork: Bool { isScript ? false : network }
  }

  static func hostBinary() -> String? {
    let candidate = LaunchConfig.shared.testValue("pluginHost") ?? Bundle.main.bundleURL.appendingPathComponent("Contents/Helpers/ArdiaPluginHost").path
    guard let real = PluginSandbox.resolved(candidate) else { return nil }
    var info = stat()
    guard stat(real, &info) == 0, (info.st_mode & S_IFMT) == S_IFREG, access(real, X_OK) == 0 else { return nil }
    return real
  }

  static func launchPlan(_ spec: Spec, in folder: OpenedFolder) -> Result<(launched: String, program: String, arguments: [String]), Failure> {
    if spec.isScript {
      guard let given = spec.entry, let entry = PluginFiles.scriptEntry(given, in: folder) else {
        return .failure(.refused("its entry \(spec.entry ?? "(none)") wasn't found, or isn't a script file inside the plugin's folder"))
      }
      guard let host = hostBinary() else { return .failure(.refused("Ardia's plugin host is missing from the app")) }
      return .success((host, host, ["--entry", entry]))
    }
    guard let first = spec.run.first else { return .failure(.refused("it names no program")) }
    let isLocal = !first.hasPrefix("/") && first.contains("/")
    let launched = isLocal ? PluginFiles.localProgram(first, in: folder) : PluginSandbox.program(first, pluginFolder: folder.path)
    guard let launched else { return .failure(.refused("\(first) wasn't found, or isn't a program file inside the plugin's folder")) }
    let program = isLocal ? (folder.path as NSString).appendingPathComponent(first) : launched
    return .success((launched, program, Array(spec.run.dropFirst())))
  }

  enum Failure: Error {
    case refused(String)
    var reason: String {
      switch self {
      case .refused(let text): return text
      }
    }
  }

  private init(name: String, run: Int, pid: pid_t, queue: DispatchQueue, memoryLimit: UInt64, log: Int32, approved: String, hasPage: Bool, launch: Int) {
    self.approved = approved
    self.hasPage = hasPage
    self.launch = launch
    self.log = log
    self.name = name
    self.run = run
    self.pid = pid
    self.queue = queue
    self.memoryLimit = memoryLimit
  }

  static func errnoText(_ code: Int32 = errno) -> String { String(cString: strerror(code)) }

  static let certificateCache = PluginCertificateCache()

  static func prepareCertificates(for spec: Spec, deliverOn queue: DispatchQueue, then: @escaping (PluginSandbox.PreparedCertificates) -> Void) {
    guard spec.sandboxNetwork else { return then(.offline) }
    certificateCache.prepare(for: LaunchConfig.shared.environmentForChildProcesses, deliverOn: queue, then: then)
  }

  static func environment(name: String, data: OpenedFolder, network: Bool, certificates: PluginSandbox.PreparedCertificates) -> [String] {
    let built = PluginSandbox.helperEnvironment(
      name: name, data: data, channelFd: channelFd, network: network, given: LaunchConfig.shared.environmentForChildProcesses, certificates: certificates)
    if !built.droppedProxies.isEmpty {
      NSLog("[plugins] %@: %@ carries a user name or password, so its helper doesn't get it", name, built.droppedProxies.joined(separator: ", "))
    }
    return built.variables
  }

  static func spawn(
    _ spec: Spec, run: Int, folders: PluginFolders, queue: DispatchQueue, certificates: PluginSandbox.PreparedCertificates,
    onLine: @escaping (PluginProcess, String) -> Void, onExit: @escaping (PluginProcess, Int32?, Int32?, Bool) -> Void
  ) -> Result<PluginProcess, Failure> {
    let folder: OpenedFolder
    switch folders.approvedFolder(spec.name, folderId: spec.folderId, approved: spec.approved) {
    case .success(let opened): folder = opened
    case .failure(let refusal): return .failure(.refused(refusal.reason))
    }
    defer { folder.close() }
    let pluginFolder = folder.path
    guard let dataFolder = folders.dataFolder(spec.name) else { return .failure(.refused("its data folder couldn't be made")) }
    defer { dataFolder.close() }
    let data = dataFolder.path
    let launched: String
    let program: String
    let arguments: [String]
    switch launchPlan(spec, in: folder) {
    case .success(let plan): (launched, program, arguments) = plan
    case .failure(let failure): return .failure(failure)
    }
    let sandbox = PluginSandbox(
      home: PluginSandbox.resolved(NSHomeDirectory()) ?? NSHomeDirectory(), appData: folders.appData, configFolder: folders.config,
      pluginFolder: pluginFolder, pluginData: data, program: program, network: spec.sandboxNetwork)
    let sandboxArguments: [String]
    do {
      sandboxArguments = try sandbox.arguments()
    } catch PluginSandbox.Refusal.unsafe(let why) {
      return .failure(.refused(why))
    } catch {
      return .failure(.refused("its sandbox couldn't be set up"))
    }
    var pair: [Int32] = [-1, -1]
    guard socketpair(AF_UNIX, SOCK_STREAM, 0, &pair) == 0 else { return .failure(.refused("no channel (\(errnoText()))")) }
    for fd in pair { _ = fcntl(fd, F_SETFD, FD_CLOEXEC) }
    var noSigPipe: Int32 = 1
    setsockopt(pair[0], SOL_SOCKET, SO_NOSIGPIPE, &noSigPipe, socklen_t(MemoryLayout<Int32>.size))
    _ = fcntl(pair[0], F_SETFL, fcntl(pair[0], F_GETFL) | O_NONBLOCK)
    var sinkPipe: [Int32] = [-1, -1]
    if spec.closedOutput {
      guard pipe(&sinkPipe) == 0 else {
        Darwin.close(pair[0])
        Darwin.close(pair[1])
        return .failure(.refused("its output couldn't be set up (\(errnoText()))"))
      }
      for fd in sinkPipe { _ = fcntl(fd, F_SETFD, FD_CLOEXEC) }
    }
    let log = spec.closedOutput ? sinkPipe[1] : PluginFiles.openLog(in: dataFolder)
    defer {
      Darwin.close(pair[1])
      if spec.closedOutput { Darwin.close(sinkPipe[1]) }
    }
    guard log >= 0 else {
      Darwin.close(pair[0])
      return .failure(.refused("its log couldn't be opened (\(errnoText()))"))
    }
    var actions: posix_spawn_file_actions_t?
    var attributes: posix_spawnattr_t?
    let actionsMade = posix_spawn_file_actions_init(&actions)
    let attributesMade = posix_spawnattr_init(&attributes)
    defer {
      if actionsMade == 0 { posix_spawn_file_actions_destroy(&actions) }
      if attributesMade == 0 { posix_spawnattr_destroy(&attributes) }
    }
    guard actionsMade == 0, attributesMade == 0 else {
      Darwin.close(pair[0])
      Darwin.close(log)
      return .failure(.refused("it couldn't be set up to start (\(errnoText(actionsMade != 0 ? actionsMade : attributesMade)))"))
    }
    var none = sigset_t()
    var all = sigset_t()
    sigemptyset(&none)
    sigfillset(&all)
    let setup = [
      posix_spawn_file_actions_addopen(&actions, 0, "/dev/null", O_RDONLY, 0),
      posix_spawn_file_actions_adddup2(&actions, log, 1),
      posix_spawn_file_actions_adddup2(&actions, log, 2),
      posix_spawn_file_actions_adddup2(&actions, pair[1], channelFd),
      posix_spawn_file_actions_addfchdir_np(&actions, folder.fd),
      posix_spawnattr_setsigmask(&attributes, &none),
      posix_spawnattr_setsigdefault(&attributes, &all),
      posix_spawnattr_setpgroup(&attributes, 0),
      posix_spawnattr_setflags(&attributes, Int16(POSIX_SPAWN_SETPGROUP | POSIX_SPAWN_CLOEXEC_DEFAULT | POSIX_SPAWN_SETSIGMASK | POSIX_SPAWN_SETSIGDEF)),
    ]
    if let failed = setup.first(where: { $0 != 0 }) {
      Darwin.close(pair[0])
      Darwin.close(log)
      return .failure(.refused("it couldn't be set up to start (\(errnoText(failed)))"))
    }
    if !PluginProcessTree.disclaim(&attributes) {
      NSLog("[plugins] %@: macOS's responsibility calls aren't available, so its processes are tracked by group and descendants only", spec.name)
    }
    let argv = ["/usr/bin/sandbox-exec"] + sandboxArguments + [launched] + arguments
    let env = environment(name: spec.name, data: dataFolder, network: spec.sandboxNetwork, certificates: certificates)
    var pid: pid_t = 0
    let result = withCStrings(argv) { cArgv in withCStrings(env) { cEnv in posix_spawn(&pid, "/usr/bin/sandbox-exec", &actions, &attributes, cArgv, cEnv) } }
    guard result == 0 else {
      Darwin.close(pair[0])
      if spec.closedOutput { Darwin.close(sinkPipe[0]) } else { Darwin.close(log) }
      return .failure(.refused("it couldn't start (\(errnoText(result)))"))
    }
    let limit = UInt64(max(64, spec.memoryMB)) << 20
    let process = PluginProcess(
      name: spec.name, run: run, pid: pid, queue: queue, memoryLimit: limit, log: spec.closedOutput ? -1 : log, approved: spec.approved, hasPage: spec.hasPage,
      launch: spec.launch)
    if spec.closedOutput {
      let sink = PluginRedactingSink(fd: sinkPipe[0], queue: queue) { [weak process] text in process?.credential?.redact(text) ?? "[hidden]" }
      process.sink = sink
      sink.open()
    }
    process.watch(channel: pair[0], onLine: onLine, onExit: onExit)
    return .success(process)
  }

  private static func withCStrings<T>(_ strings: [String], _ body: ([UnsafeMutablePointer<CChar>?]) -> T) -> T {
    let pointers = strings.map { strdup($0) } + [nil]
    defer { pointers.forEach { free($0) } }
    return body(pointers)
  }

  private func watch(channel: Int32, onLine: @escaping (PluginProcess, String) -> Void, onExit: @escaping (PluginProcess, Int32?, Int32?, Bool) -> Void) {
    let connection = ControlConnection(
      id: run, fd: channel, queue: queue,
      onLine: { [weak self] connection, line in
        guard let self else { return }
        if let credential = self.credential {
          connection.release()
          return credential.receive(line)
        }
        guard !self.answeredPageLine(line), !self.answeredCredentialLine(line) else { return }
        onLine(self, line)
      },
      onClose: { _ in }, onWritten: { _ in })
    self.connection = connection
    connection.open()
    let source = DispatchSource.makeProcessSource(identifier: pid, eventMask: .exit, queue: queue)
    source.setEventHandler { [weak self] in self?.reap(onExit) }
    exitSource = source
    source.activate()
    let timer = DispatchSource.makeTimerSource(queue: queue)
    timer.schedule(deadline: .now() + Self.memoryCheckInterval, repeating: Self.memoryCheckInterval)
    timer.setEventHandler { [weak self] in self?.checkMemory() }
    memoryTimer = timer
    timer.activate()
    let family = PluginFamily(root: pid, queue: queue, interval: Self.familySampleInterval)
    family.start()
    self.family = family
    queue.async { [weak self] in self?.reapIfGone(onExit) }
  }

  private func answeredCredentialLine(_ line: String) -> Bool {
    switch PluginCredentialGate.screen(line) {
    case .forward: return false
    case .drop:
      refusedCredentialLines += 1
      connection?.release()
      return true
    case .reply(let reply):
      refusedCredentialLines += 1
      connection?.reply(Data((reply + "\n").utf8), ticket: 0)
      return true
    }
  }

  private func answeredPageLine(_ line: String) -> Bool {
    guard let reply = PluginPageMessages.answer(line, hasPage: hasPage, post: { [weak self] post in self.flatMap { $0.onPagePost?($0, post) } }) else { return false }
    connection?.reply(reply, ticket: 0)
    return true
  }


  private func reapIfGone(_ onExit: @escaping (PluginProcess, Int32?, Int32?, Bool) -> Void) {
    reap(onExit)
  }

  private func hasExited() -> Bool? { reaped ? nil : PluginProcessTree.ownership(pid) }

  private func reap(_ onExit: @escaping (PluginProcess, Int32?, Int32?, Bool) -> Void) {
    guard !reaped else { return }
    switch hasExited() {
    case .some(false): return
    case .none:
      exited = true
      reaped = true
      signalFamily(SIGKILL)
      cleanUp()
      return onExit(self, nil, nil, overMemory)
    case .some(true): break
    }
    exited = true
    signalFamily(SIGKILL)
    var status: Int32 = 0
    while waitpid(pid, &status, 0) < 0 && errno == EINTR {}
    reaped = true
    cleanUp()
    let signaled = (status & 0x7f) != 0 && (status & 0x7f) != 0x7f
    onExit(self, signaled ? nil : (status >> 8) & 0xff, signaled ? status & 0x7f : nil, overMemory)
  }

  private func signalFamily(_ signal: Int32) {
    family?.signal(signal, group: hasExited() != nil)
  }

  private func cleanUp() {
    exitSource?.cancel()
    exitSource = nil
    memoryTimer?.cancel()
    memoryTimer = nil
    family?.cancel()
    killTimer?.cancel()
    killTimer = nil
    connection?.close()
    connection = nil
    sink?.close()
    credential?.ended(crashed: !stopRequested || overMemory)
    if log >= 0 {
      Darwin.close(log)
      log = -1
    }
    let waiters = stopWaiters
    stopWaiters = []
    waiters.forEach { $0() }
  }

  private func capLog() {
    var info = stat()
    if log >= 0, fstat(log, &info) == 0, info.st_size > PluginFiles.logLimit * 2 { ftruncate(log, 0) }
  }

  private func checkMemory() {
    guard !exited else { return }
    capLog()
    var info = rusage_info_v4()
    let got = withUnsafeMutablePointer(to: &info) { pointer in
      pointer.withMemoryRebound(to: rusage_info_t?.self, capacity: 1) { proc_pid_rusage(pid, RUSAGE_INFO_V4, $0) }
    }
    guard got == 0, info.ri_phys_footprint > memoryLimit else { return }
    overMemory = true
    signalFamily(SIGKILL)
  }

  func stop(graceMs: Int, done: @escaping () -> Void) {
    stopRequested = true
    guard !exited else { return done() }
    stopWaiters.append(done)
    family?.sample()
    connection?.close()
    signalFamily(SIGTERM)
    guard killTimer == nil else { return }
    let item = DispatchWorkItem { [weak self] in
      guard let self, !self.exited else { return }
      self.signalFamily(SIGKILL)
    }
    killTimer = item
    queue.asyncAfter(deadline: .now() + .milliseconds(max(0, graceMs)), execute: item)
  }

  func killNow() {
    stopRequested = true
    guard !exited else { return }
    signalFamily(SIGKILL)
  }

  func terminateForQuit(within seconds: TimeInterval) {
    stopRequested = true
    credential?.ended(crashed: false)
    guard !exited else { return }
    family?.sample()
    connection?.close()
    signalFamily(SIGTERM)
    let deadline = Date().addingTimeInterval(seconds)
    while Date() < deadline {
      if hasExited() != false {
        exited = true
        signalFamily(SIGKILL)
        var status: Int32 = 0
        _ = waitpid(pid, &status, WNOHANG)
        reaped = true
        return
      }
      usleep(20_000)
    }
    signalFamily(SIGKILL)
  }
}
