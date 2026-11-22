import XCTest

@testable import ArdiaPluginCore

final class PluginSandboxEscapeTests: XCTestCase {
  static let lsregister = "/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister"
  static let probeSource = """
    #include <IOKit/IOKitLib.h>
    #include <errno.h>
    #include <fcntl.h>
    #include <netdb.h>
    #include <netinet/in.h>
    #include <notify.h>
    #include <sys/mman.h>
    #include <sys/sysctl.h>
    #include <sys/attr.h>
    #include <sys/xattr.h>
    #include <dirent.h>
    #include <libproc.h>
    #include <servers/bootstrap.h>
    #include <signal.h>
    #include <stdio.h>
    #include <stdlib.h>
    #include <string.h>
    #include <sys/socket.h>
    #include <sys/un.h>
    #include <unistd.h>
    extern int sandbox_check(pid_t pid, const char *operation, int type, ...);
    static int failed(void) { int code = errno; printf("errno %d\\n", code); return code ? code : 99; }
    int main(int argc, char **argv) {
      if (argc < 3) return 98;
      const char *mode = argv[1];
      if (!strcmp(mode, "pidpath")) {
        char path[PROC_PIDPATHINFO_MAXSIZE];
        if (proc_pidpath(atoi(argv[2]), path, sizeof path) <= 0) return failed();
        printf("%s\\n", path);
        return 0;
      }
      if (!strcmp(mode, "pidinfo")) {
        struct proc_bsdinfo info;
        if (proc_pidinfo(atoi(argv[2]), PROC_PIDTBSDINFO, 0, &info, sizeof info) != sizeof info) return failed();
        printf("%s\\n", info.pbi_comm);
        return 0;
      }
      if (!strcmp(mode, "signal")) {
        if (kill(atoi(argv[2]), 0) != 0) return failed();
        printf("signalled\\n");
        return 0;
      }
      if (!strcmp(mode, "lookup")) {
        mach_port_t port = MACH_PORT_NULL;
        kern_return_t result = bootstrap_look_up(bootstrap_port, argv[2], &port);
        printf("%s %d\\n", result == KERN_SUCCESS ? "reachable" : "refused", result);
        return result == KERN_SUCCESS ? 0 : 97;
      }
      if (!strcmp(mode, "notify")) {
        uint32_t status = notify_post(argv[2]);
        printf("notify %u\\n", status);
        return status == NOTIFY_STATUS_OK ? 0 : 96;
      }
      if (!strcmp(mode, "watch")) {
        int token = 0, changed = 0;
        if (notify_register_check(argv[2], &token) != NOTIFY_STATUS_OK) return 96;
        notify_check(token, &changed);
        printf("ready\\n");
        fflush(stdout);
        for (int i = 0; i < 40; i++) {
          usleep(50000);
          notify_check(token, &changed);
          if (changed) { printf("arrived\\n"); return 0; }
        }
        printf("silent\\n");
        return 92;
      }
      if (!strcmp(mode, "shm")) {
        int fd = shm_open(argv[2], O_CREAT | O_RDWR, 0600);
        if (fd < 0) return failed();
        close(fd);
        shm_unlink(argv[2]);
        printf("created\\n");
        return 0;
      }
      if (!strcmp(mode, "iokit")) {
        io_service_t service = IOServiceGetMatchingService(kIOMainPortDefault, IOServiceMatching(argv[2]));
        if (!service) { printf("no service\\n"); return 95; }
        io_connect_t connection = 0;
        kern_return_t result = IOServiceOpen(service, mach_task_self(), 0, &connection);
        IOObjectRelease(service);
        printf("%s %d\\n", result == KERN_SUCCESS ? "opened" : "refused", result);
        if (result == KERN_SUCCESS) IOServiceClose(connection);
        return result == KERN_SUCCESS ? 0 : 94;
      }
      if (!strcmp(mode, "resolve")) {
        struct addrinfo *found = NULL;
        int result = getaddrinfo(argv[2], "443", NULL, &found);
        printf("resolve %d\\n", result);
        if (found) freeaddrinfo(found);
        return result == 0 ? 0 : 93;
      }
      if (!strcmp(mode, "tcp")) {
        int fd = socket(AF_INET, SOCK_STREAM, 0);
        struct sockaddr_in address = {0};
        address.sin_family = AF_INET;
        address.sin_port = htons(atoi(argv[2]));
        address.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
        if (connect(fd, (struct sockaddr *)&address, sizeof address) != 0) return failed();
        printf("connected\\n");
        return 0;
      }
      if (!strcmp(mode, "bind")) {
        int fd = socket(AF_INET, SOCK_STREAM, 0);
        struct sockaddr_in address = {0};
        address.sin_family = AF_INET;
        address.sin_port = 0;
        address.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
        if (bind(fd, (struct sockaddr *)&address, sizeof address) != 0) return failed();
        if (listen(fd, 1) != 0) return failed();
        printf("listening\\n");
        return 0;
      }
      if (!strcmp(mode, "sysctlread")) {
        int value = 0;
        size_t size = sizeof value;
        if (sysctlbyname(argv[2], &value, &size, NULL, 0) != 0) return failed();
        printf("read %d\\n", value);
        return 0;
      }
      if (!strcmp(mode, "xattr")) {
        char value[256];
        ssize_t size = getxattr(argv[2], argv[3], value, sizeof value, 0, 0);
        if (size < 0) return failed();
        printf("xattr %.*s\\n", (int)size, value);
        return 0;
      }
      if (!strcmp(mode, "finderinfo")) {
        struct attrlist list = {0};
        list.bitmapcount = ATTR_BIT_MAP_COUNT;
        list.commonattr = ATTR_CMN_FNDRINFO;
        struct { uint32_t length; char info[32]; } __attribute__((packed)) answer;
        if (getattrlist(argv[2], &list, &answer, sizeof answer, 0) != 0) return failed();
        printf("finderinfo\\n");
        return 0;
      }
      if (!strcmp(mode, "listdir")) {
        DIR *dir = opendir(argv[2]);
        if (!dir) return failed();
        int count = 0;
        while (readdir(dir)) count++;
        closedir(dir);
        printf("listed %d\\n", count);
        return 0;
      }
      if (!strcmp(mode, "decision")) {
        int denied = sandbox_check(getpid(), argv[2], 0);
        printf("%s\\n", denied ? "denied" : "allowed");
        return denied ? 91 : 0;
      }
      if (!strcmp(mode, "ubind")) {
        int fd = socket(AF_UNIX, SOCK_STREAM, 0);
        struct sockaddr_un address = {0};
        address.sun_family = AF_UNIX;
        strlcpy(address.sun_path, argv[2], sizeof address.sun_path);
        if (bind(fd, (struct sockaddr *)&address, sizeof address) != 0) return failed();
        printf("bound\\n");
        unlink(argv[2]);
        return 0;
      }
      if (!strcmp(mode, "fd3")) {
        if (write(3, "hello\\n", 6) != 6) return failed();
        printf("wrote\\n");
        return 0;
      }
      if (!strcmp(mode, "sysctlwrite")) {
        int value = 0;
        size_t size = sizeof value;
        if (sysctlbyname(argv[2], &value, &size, NULL, 0) != 0) return failed();
        if (sysctlbyname(argv[2], NULL, NULL, &value, sizeof value) != 0) return failed();
        printf("wrote\\n");
        return 0;
      }
      if (!strcmp(mode, "connect")) {
        int fd = socket(AF_UNIX, SOCK_STREAM, 0);
        struct sockaddr_un address = {0};
        address.sun_family = AF_UNIX;
        strlcpy(address.sun_path, argv[2], sizeof address.sun_path);
        if (connect(fd, (struct sockaddr *)&address, sizeof address) != 0) return failed();
        printf("connected\\n");
        return 0;
      }
      return 98;
    }
    """

  struct Outcome {
    let status: Int32
    let output: String
  }

  var root = ""
  var home = ""
  var data = ""
  var config = ""
  var plugin = ""
  var pluginData = ""
  var outside = ""
  var token = ""
  var tokenFile = ""
  var probe = ""
  var started: [Process] = []
  var listeners: [Int32] = []
  var scratch: [String] = []
  var preferenceDomains: [String] = []
  var jobs: [String] = []

  override func setUpWithError() throws {
    let made = URL(fileURLWithPath: NSTemporaryDirectory()).appendingPathComponent("pe-\(Self.short())", isDirectory: true)
    try FileManager.default.createDirectory(at: made, withIntermediateDirectories: true)
    root = PluginSandbox.resolved(made.path)!
    home = "\(root)/home"
    data = "\(root)/data"
    config = "\(data)/config"
    plugin = "\(config)/plugins/example"
    pluginData = "\(data)/PluginData/example"
    outside = "\(root)/o"
    for folder in [home, plugin, "\(pluginData)/home", "\(pluginData)/tmp", "\(data)/Chromium", outside] {
      try FileManager.default.createDirectory(atPath: folder, withIntermediateDirectories: true)
    }
    token = "fake-control-token-\(UUID().uuidString)"
    tokenFile = "\(data)/Chromium/ArdiaControl.json"
    try "{\"token\":\"\(token)\"}".write(toFile: tokenFile, atomically: true, encoding: .utf8)
    try Self.probeSource.write(toFile: "\(root)/probe.c", atomically: true, encoding: .utf8)
    probe = "\(plugin)/probe"
    let built = try Self.run("/usr/bin/xcrun", ["clang", "-O", "-framework", "IOKit", "-o", probe, "\(root)/probe.c"])
    XCTAssertEqual(built.status, 0, built.output)
  }

  override func tearDownWithError() throws {
    for process in started where process.isRunning { process.terminate() }
    for fd in listeners { close(fd) }
    for job in jobs { _ = try? Self.run("/bin/launchctl", ["remove", job]) }
    let bundles = (try? FileManager.default.contentsOfDirectory(atPath: pluginData))?.filter { $0.hasSuffix(".app") } ?? []
    for bundle in bundles { _ = try? Self.run(Self.lsregister, ["-u", "\(pluginData)/\(bundle)"]) }
    for domain in preferenceDomains {
      _ = try? Self.run("/usr/bin/defaults", ["delete", domain])
      try? FileManager.default.removeItem(atPath: "\(NSHomeDirectory())/Library/Preferences/\(domain).plist")
    }
    for path in scratch { try? FileManager.default.removeItem(atPath: path) }
    try? FileManager.default.removeItem(atPath: root)
  }

  static func short() -> String { String(UUID().uuidString.prefix(8)).lowercased() }

  static func run(_ program: String, _ arguments: [String], in folder: String? = nil) throws -> Outcome {
    let process = Process()
    process.executableURL = URL(fileURLWithPath: program)
    process.arguments = arguments
    if let folder { process.currentDirectoryURL = URL(fileURLWithPath: folder) }
    let pipe = Pipe()
    process.standardInput = FileHandle.nullDevice
    process.standardError = pipe
    process.standardOutput = pipe
    try process.run()
    let output = pipe.fileHandleForReading.readDataToEndOfFile()
    process.waitUntilExit()
    return Outcome(status: process.terminationStatus, output: String(decoding: output, as: UTF8.self))
  }

  func sandboxed(_ program: String, _ arguments: [String], network: Bool = true, realHome: Bool = false) throws -> Outcome {
    let box = PluginSandbox(home: realHome ? PluginSandbox.resolved(NSHomeDirectory())! : home, appData: data, configFolder: config, pluginFolder: plugin, pluginData: pluginData, program: program, network: network)
    return try Self.run("/usr/bin/sandbox-exec", try box.arguments() + [program] + arguments, in: plugin)
  }

  func shell(_ script: String) throws -> Outcome { try sandboxed("/bin/sh", ["-c", script]) }

  func leaked(_ file: String, waiting seconds: Double) -> Bool {
    let deadline = Date().addingTimeInterval(seconds)
    repeat {
      if let text = try? String(contentsOfFile: file, encoding: .utf8), text.contains(token) { return true }
      Thread.sleep(forTimeInterval: 0.1)
    } while Date() < deadline
    return false
  }

  func backgroundApp(_ name: String, writingTo leak: String) throws -> String {
    let bundle = "\(pluginData)/\(name).app"
    try FileManager.default.createDirectory(atPath: "\(bundle)/Contents/MacOS", withIntermediateDirectories: true)
    let info: [String: Any] = [
      "CFBundleExecutable": "run", "CFBundleIdentifier": "dev.ardia.plugin-escape.\(Self.short())", "CFBundlePackageType": "APPL", "LSBackgroundOnly": true,
    ]
    try PropertyListSerialization.data(fromPropertyList: info, format: .xml, options: 0).write(to: URL(fileURLWithPath: "\(bundle)/Contents/Info.plist"))
    let run = "\(bundle)/Contents/MacOS/run"
    try "#!/bin/sh\ncat '\(tokenFile)' > '\(leak)'\n".write(toFile: run, atomically: true, encoding: .utf8)
    try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: run)
    return bundle
  }

  struct SocketPathTooLong: Error {
    let path: String
  }

  func listen(at path: String) throws {
    var address = sockaddr_un()
    address.sun_family = sa_family_t(AF_UNIX)
    let bytes = Array(path.utf8CString)
    guard bytes.count <= MemoryLayout.size(ofValue: address.sun_path) else { throw SocketPathTooLong(path: path) }
    let fd = socket(AF_UNIX, SOCK_STREAM, 0)
    XCTAssertGreaterThanOrEqual(fd, 0)
    withUnsafeMutableBytes(of: &address.sun_path) { raw in bytes.withUnsafeBytes { raw.copyMemory(from: $0) } }
    let bound = withUnsafePointer(to: &address) { $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { Darwin.bind(fd, $0, socklen_t(MemoryLayout<sockaddr_un>.size)) } }
    XCTAssertEqual(bound, 0, "bind \(path): \(String(cString: strerror(errno)))")
    XCTAssertEqual(Darwin.listen(fd, 8), 0)
    listeners.append(fd)
  }

  func testTheControlTokenIsUnreadableFromInside() throws {
    XCTAssertEqual(try Self.run("/bin/cat", [tokenFile]).output.contains(token), true, "control: the token is readable outside")
    let inside = try sandboxed("/bin/cat", [tokenFile])
    XCTAssertNotEqual(inside.status, 0)
    XCTAssertFalse(inside.output.contains(token))
  }

  func testAnAppItWritesCannotBeLaunchedOutsideTheSandbox() throws {
    let controlLeak = "\(outside)/control-opened"
    let control = try Self.run("/usr/bin/open", ["-g", "-j", try backgroundApp("Control", writingTo: controlLeak)])
    try XCTSkipUnless(control.status == 0 && leaked(controlLeak, waiting: 10), "LaunchServices can't launch apps here: \(control.output)")
    let leak = "\(outside)/opened"
    let inside = try sandboxed("/usr/bin/open", ["-g", "-j", try backgroundApp("Escape", writingTo: leak)])
    XCTAssertNotEqual(inside.status, 0, "open reports success inside: \(inside.output)")
    XCTAssertFalse(leaked(leak, waiting: 3), "the app ran outside the sandbox and read the control token")
  }

  func testNSWorkspaceCannotLaunchItEither() throws {
    func script(_ bundle: String) -> String {
      "ObjC.import('AppKit'); $.NSWorkspace.sharedWorkspace.openURL($.NSURL.fileURLWithPath('\(bundle)')) ? 'opened' : 'refused'"
    }
    let controlLeak = "\(outside)/control-workspace"
    let control = try Self.run("/usr/bin/osascript", ["-l", "JavaScript", "-e", script(try backgroundApp("WorkspaceControl", writingTo: controlLeak))])
    try XCTSkipUnless(control.output.contains("opened") && leaked(controlLeak, waiting: 10), "NSWorkspace can't launch apps here: \(control.output)")
    let leak = "\(outside)/workspace"
    let inside = try sandboxed("/usr/bin/osascript", ["-l", "JavaScript", "-e", script(try backgroundApp("Workspace", writingTo: leak))])
    XCTAssertTrue(inside.output.contains("refused"), "openURL didn't report a refusal: \(inside.output)")
    XCTAssertFalse(leaked(leak, waiting: 3), "NSWorkspace launched the app outside the sandbox")
  }

  func testProcessesOutsideItCanNotBeSignalledOrInspected() throws {
    let sibling = Process()
    sibling.executableURL = URL(fileURLWithPath: "/bin/sleep")
    sibling.arguments = ["30"]
    try sibling.run()
    started.append(sibling)
    let pid = String(sibling.processIdentifier)
    let expected = ["pidpath": "/bin/sleep", "pidinfo": "sleep", "signal": "signalled"]
    for (mode, answer) in expected {
      let control = try Self.run(probe, [mode, pid])
      XCTAssertEqual(control.status, 0, "control \(mode): \(control.output)")
      XCTAssertTrue(control.output.contains(answer), "control \(mode): \(control.output)")
      let inside = try sandboxed(probe, [mode, pid])
      XCTAssertEqual(inside.status, EPERM, "\(mode) of a process outside: \(inside.output)")
      XCTAssertFalse(inside.output.contains(answer))
    }
    XCTAssertTrue(sibling.isRunning)
    let family = try shell("'\(probe)' pidinfo $$ || exit 1; /bin/sleep 30 & child=$!; /bin/sleep 0.3; '\(probe)' pidpath $child && '\(probe)' signal $child && kill $child")
    XCTAssertEqual(family.status, 0, "it still inspects and signals itself and its children: \(family.output)")
    XCTAssertTrue(family.output.contains("/bin/sleep"))
  }

  func testUnixSocketsOutsideItsFolderAreUnreachable() throws {
    let id = Self.short()
    let launchdLayout = "/private/tmp/com.apple.launchd.ardia\(id)"
    let tempAgent = "/private/tmp/ardia-agent-\(id)"
    scratch += [launchdLayout, tempAgent]
    for folder in [launchdLayout, tempAgent] { try FileManager.default.createDirectory(atPath: folder, withIntermediateDirectories: true) }
    let refused = ["\(launchdLayout)/Listeners", "\(tempAgent)/agent.sock", "\(outside)/a"]
    let ownFolder = "\(pluginData)/s"
    for path in refused + [ownFolder] { try listen(at: path) }
    for path in refused {
      let spellings = [path, path.replacingOccurrences(of: "/private/", with: "/", options: .anchored)]
      for spelling in spellings {
        let control = try Self.run(probe, ["connect", spelling])
        XCTAssertEqual(control.status, 0, "control: \(spelling) accepts outside: \(control.output)")
        let inside = try sandboxed(probe, ["connect", spelling])
        XCTAssertEqual(inside.status, EPERM, "\(spelling) is reachable from inside: \(inside.output)")
      }
    }
    XCTAssertEqual(try Self.run(probe, ["connect", ownFolder]).status, 0, "control: its own folder's socket accepts outside")
    XCTAssertEqual(try sandboxed(probe, ["connect", ownFolder]).status, EPERM, "a pathname socket in its own folder is refused too; fd 3 is its only channel")
  }

  func testMachServicesOffTheAllowlistAreRefused() throws {
    let denied = [
      "com.apple.lsd.open", "com.apple.lsd.modifydb", "com.apple.coreservices.launchservicesd", "com.apple.xpc.smd", "com.apple.backgroundtaskmanagement",
      "com.apple.tccd", "com.apple.pasteboard.1", "com.apple.SecurityServer", "com.apple.diagnosticd",
    ]
    for name in denied {
      let control = try Self.run(probe, ["lookup", name])
      XCTAssertEqual(control.status, 0, "control: \(name) is reachable outside: \(control.output)")
      let inside = try sandboxed(probe, ["lookup", name])
      XCTAssertEqual(inside.status, 97, "\(name) is reachable from inside: \(inside.output)")
      XCTAssertTrue(inside.output.hasPrefix("refused"), inside.output)
    }
    for name in ["com.apple.trustd.agent", "com.apple.cfprefsd.agent", "com.apple.SystemConfiguration.DNSConfiguration"] {
      XCTAssertEqual(try sandboxed(probe, ["lookup", name]).status, 0, "\(name) is on the allowlist")
    }
  }

  func testAppleEventsAreRefusedWeakControlFinderRunning() throws {
    try XCTSkipUnless(try Self.run("/usr/bin/pgrep", ["-x", "Finder"]).status == 0, "Finder isn't running, so a refusal proves nothing")
    let disk = try XCTUnwrap(try URL(fileURLWithPath: "/").resourceValues(forKeys: [.volumeNameKey]).volumeName)
    let inside = try sandboxed("/usr/bin/osascript", ["-e", "tell application \"Finder\" to get name of startup disk"])
    XCTAssertNotEqual(inside.status, 0)
    XCTAssertTrue(inside.output.contains("execution error"), inside.output)
    XCTAssertFalse(inside.output.contains("\n\(disk)\n") || inside.output.hasPrefix(disk), "Finder answered from inside: \(inside.output)")
  }

  func testLaunchdJobsCannotBeSubmitted() throws {
    let controlJob = "dev.ardia.plugin-escape.control.\(Self.short())"
    let controlLeak = "\(outside)/control-job"
    jobs.append(controlJob)
    let control = try Self.run("/bin/launchctl", ["submit", "-l", controlJob, "--", "/bin/sh", "-c", "cat '\(tokenFile)' > '\(controlLeak)'"])
    try XCTSkipUnless(control.status == 0 && leaked(controlLeak, waiting: 10), "launchd won't run a submitted job here: \(control.output)")
    let job = "dev.ardia.plugin-escape.\(Self.short())"
    let leak = "\(outside)/job"
    jobs.append(job)
    let inside = try sandboxed("/bin/launchctl", ["submit", "-l", job, "--", "/bin/sh", "-c", "cat '\(tokenFile)' > '\(leak)'"])
    XCTAssertNotEqual(inside.status, 0)
    XCTAssertNotEqual(try Self.run("/bin/launchctl", ["list", job]).status, 0, "the job was registered")
    XCTAssertFalse(leaked(leak, waiting: 2))
  }

  func testItCannotWriteOtherAppsPreferences() throws {
    let controlDomain = "dev.ardia.plugin-escape.control.\(Self.short())"
    let domain = "dev.ardia.plugin-escape.\(Self.short())"
    preferenceDomains += [controlDomain, domain]
    XCTAssertEqual(try Self.run("/usr/bin/defaults", ["write", controlDomain, "key", "value"]).status, 0)
    XCTAssertEqual(try Self.run("/usr/bin/defaults", ["read", controlDomain, "key"]).output.trimmingCharacters(in: .whitespacesAndNewlines), "value", "control")
    _ = try sandboxed("/usr/bin/defaults", ["write", domain, "key", "value"], realHome: true)
    Thread.sleep(forTimeInterval: 0.5)
    XCTAssertNotEqual(try Self.run("/usr/bin/defaults", ["read", domain, "key"]).status, 0, "the write landed")
  }

  func testItCannotReadOtherAppsPreferencesInEitherHostScope() throws {
    for scope in [[], ["-currentHost"]] {
      let controlDomain = "dev.ardia.plugin-escape.secret.\(Self.short())"
      preferenceDomains.append(controlDomain)
      XCTAssertEqual(try Self.run("/usr/bin/defaults", scope + ["write", controlDomain, "token", "secret-value"]).status, 0)
      XCTAssertEqual(try Self.run("/usr/bin/defaults", scope + ["read", controlDomain, "token"]).output.trimmingCharacters(in: .whitespacesAndNewlines), "secret-value", "control \(scope)")
      let inside = try sandboxed("/usr/bin/defaults", scope + ["read", controlDomain, "token"], realHome: true)
      XCTAssertNotEqual(inside.status, 0, "\(scope)")
      XCTAssertFalse(inside.output.contains("secret-value"), "another app's preferences are readable \(scope): \(inside.output)")
      _ = try? Self.run("/usr/bin/defaults", scope + ["delete", controlDomain])
    }
  }

  func testItReadsTheGlobalDomainLikeOutside() throws {
    let locale = try Self.run("/usr/bin/defaults", ["read", "-g", "AppleLocale"])
    try XCTSkipUnless(locale.status == 0, "no AppleLocale to compare")
    XCTAssertEqual(try sandboxed("/usr/bin/defaults", ["read", "-g", "AppleLocale"], realHome: true).output, locale.output, "the global domain stays readable")
  }

  func watch(_ name: String, while posting: () throws -> Void) throws -> Bool {
    let watcher = Process()
    watcher.executableURL = URL(fileURLWithPath: probe)
    watcher.arguments = ["watch", name]
    let pipe = Pipe()
    watcher.standardOutput = pipe
    try watcher.run()
    started.append(watcher)
    let lock = NSLock()
    var heard = ""
    let ready = DispatchSemaphore(value: 0)
    let finished = DispatchSemaphore(value: 0)
    pipe.fileHandleForReading.readabilityHandler = { handle in
      let data = handle.availableData
      lock.lock()
      heard += String(decoding: data, as: UTF8.self)
      let text = heard
      lock.unlock()
      if text.contains("ready") { ready.signal() }
      if data.isEmpty {
        handle.readabilityHandler = nil
        finished.signal()
      }
    }
    XCTAssertEqual(ready.wait(timeout: .now() + 5), .success, "the watcher never registered")
    try posting()
    XCTAssertEqual(finished.wait(timeout: .now() + 10), .success, "the watcher never finished")
    lock.lock()
    defer { lock.unlock() }
    return heard.contains("arrived")
  }

  func testDarwinNotificationsCannotBePosted() throws {
    let controlName = "dev.ardia.plugin-escape.control.\(Self.short())"
    XCTAssertTrue(try watch(controlName) { _ = try Self.run(probe, ["notify", controlName]) }, "control: a post from outside arrives")
    let name = "dev.ardia.plugin-escape.\(Self.short())"
    XCTAssertFalse(try watch(name) { _ = try sandboxed(probe, ["notify", name]) }, "a post from inside arrived")
  }

  func testSharedMemoryCannotBeCreated() throws {
    let name = "/ardia.\(Self.short())"
    XCTAssertEqual(try Self.run(probe, ["shm", name]).status, 0, "control: shm_open works outside")
    let inside = try sandboxed(probe, ["shm", name])
    XCTAssertEqual(inside.status, EPERM, inside.output)
  }

  func testIOKitUserClientsCannotBeOpened() throws {
    let control = try Self.run(probe, ["iokit", "IOPMrootDomain"])
    try XCTSkipUnless(control.status == 0, "IOPMrootDomain doesn't open outside: \(control.output)")
    let inside = try sandboxed(probe, ["iokit", "IOPMrootDomain"])
    XCTAssertNotEqual(inside.status, 0, inside.output)
    XCTAssertFalse(inside.output.hasPrefix("opened"), inside.output)
  }

  func testWithoutNetworkThereIsNoResolver() throws {
    let control = try Self.run(probe, ["resolve", "apple.com"])
    try XCTSkipUnless(control.status == 0, "no DNS here: \(control.output)")
    XCTAssertEqual(try sandboxed(probe, ["resolve", "apple.com"], network: true).status, 0, "with network the resolver works")
    let resolved = try sandboxed(probe, ["resolve", "apple.com"], network: false)
    XCTAssertEqual(resolved.status, 93, "without network a name resolves: \(resolved.output)")
  }

  func testWithoutNetworkThereIsNoLoopback() throws {
    let listener = socket(AF_INET, SOCK_STREAM, 0)
    var address = sockaddr_in()
    address.sin_family = sa_family_t(AF_INET)
    address.sin_addr.s_addr = inet_addr("127.0.0.1")
    address.sin_port = 0
    let bound = withUnsafePointer(to: &address) { $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { Darwin.bind(listener, $0, socklen_t(MemoryLayout<sockaddr_in>.size)) } }
    XCTAssertEqual(bound, 0)
    XCTAssertEqual(Darwin.listen(listener, 8), 0)
    listeners.append(listener)
    var length = socklen_t(MemoryLayout<sockaddr_in>.size)
    _ = withUnsafeMutablePointer(to: &address) { $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { getsockname(listener, $0, &length) } }
    let port = String(UInt16(bigEndian: address.sin_port))
    XCTAssertEqual(try Self.run(probe, ["tcp", port]).status, 0, "control: loopback accepts outside")
    XCTAssertEqual(try sandboxed(probe, ["tcp", port], network: true).status, 0, "with network loopback works")
    XCTAssertEqual(try sandboxed(probe, ["tcp", port], network: false).status, EPERM, "without network loopback is reachable")
  }

  static let sampleCertificate = """
    -----BEGIN CERTIFICATE-----
    MIICFDCCAboCCQCGzc4KH/YOFDAKBggqhkjOPQQDAjAYMRYwFAYDVQQDDA1BcmRp
    YSBUZXN0IENBMB4XDTI2MTExOTIxMTQwMVoXDTM2MTExNjIxMTQwMVowGDEWMBQG
    A1UEAwwNQXJkaWEgVGVzdCBDQTCCAUswggEDBgcqhkjOPQIBMIH3AgEBMCwGByqG
    SM49AQECIQD/////AAAAAQAAAAAAAAAAAAAAAP///////////////zBbBCD/////
    AAAAAQAAAAAAAAAAAAAAAP///////////////AQgWsY12Ko6k+ez671VdpiGvGUd
    BrDMU7D2O848PifSYEsDFQDEnTYIhucEk2pmeOETnSa3gZ9+kARBBGsX0fLhLEJH
    +Lzm5WOkQPJ3A32BLeszoPShOUXYmMKWT+NC4v4af5uO5+tKfA+eFivOM1drMV7O
    y7ZAaDe/UfUCIQD/////AAAAAP//////////vOb6racXnoTzucrC/GMlUQIBAQNC
    AAQCdPnUV0joYs5KtwyoUoI3FEjwSVJLfuiYWvZ6gCoqvSsBpKL0tzcrBKV2wI3A
    FoEmSE3kOgehsuGLLxDvb9npMAoGCCqGSM49BAMCA0gAMEUCIFUmsE9O5AIUpNi0
    u1HfwwIuvvExdEDiU2oA1IrAx2AUAiEA0Z4Gj3ZZHgOAReutq88nidJ4BZjoFNfN
    tKQASN2/l4c=
    -----END CERTIFICATE-----
    """

  func makeCertificate(_ name: String) throws -> (pem: String, keyDER: String) {
    let folder = "\(root)/cert-\(name)"
    try FileManager.default.createDirectory(atPath: folder, withIntermediateDirectories: true)
    let made = try Self.run("/usr/bin/openssl", ["req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1", "-nodes", "-keyout", "\(folder)/key.pem", "-out", "\(folder)/cert.pem", "-days", "2", "-subj", "/CN=\(name)"])
    XCTAssertEqual(made.status, 0, made.output)
    let der = try Self.run("/usr/bin/openssl", ["pkey", "-in", "\(folder)/key.pem", "-outform", "DER", "-out", "\(folder)/key.der"])
    XCTAssertEqual(der.status, 0, der.output)
    return (try String(contentsOfFile: "\(folder)/cert.pem", encoding: .utf8), try Data(contentsOf: URL(fileURLWithPath: "\(folder)/key.der")).base64EncodedString())
  }

  static func body(_ pem: String) -> String {
    pem.components(separatedBy: "\n").filter { !$0.hasPrefix("-----") }.joined()
  }

  func testHelpersGetProxySettingsButNoSecrets() {
    let given = [
      "HTTPS_PROXY": "http://proxy.example:3128", "no_proxy": "localhost", "HTTP_PROXY": "http://user:pass@proxy.example:3128",
      "all_proxy": "socks5://alice@proxy.example:1080", "ANTHROPIC_AUTH_TOKEN": "secret", "OPENAI_API_KEY": "secret",
      "https_proxy": "http://proxy.example:8080/?token=secret", "ALL_PROXY": "proxy.example:1080#secret",
    ]
    XCTAssertEqual(PluginSandbox.networkEnvironment(from: given, network: false), PluginSandbox.NetworkEnvironment(), "without network a helper gets none of it")
    let carried = PluginSandbox.networkEnvironment(from: given, network: true)
    XCTAssertEqual(Set(carried.variables), ["HTTPS_PROXY=http://proxy.example:3128", "no_proxy=localhost"])
    XCTAssertEqual(Set(carried.droppedProxies), ["HTTP_PROXY", "all_proxy", "https_proxy", "ALL_PROXY"], "proxies with a user name, a password, a query or a fragment are dropped")
    XCTAssertFalse(carried.variables.contains { $0.contains("secret") })
  }

  func testCertificatesKeepOnlyWholeX509BlocksAndExtrasStaySeparate() throws {
    let a = try makeCertificate("Ardia Test A")
    let b = try makeCertificate("Ardia Test B")
    let c = try makeCertificate("Ardia Test C")
    let system = "\(root)/system.pem"
    let corporate = "\(home)/corp.pem"
    try a.pem.write(toFile: system, atomically: true, encoding: .utf8)
    let trailing = Data(base64Encoded: Self.body(a.pem))! + Data([0x00, 0x01])
    let mixed = [
      "comment line", b.pem,
      "-----BEGIN PRIVATE KEY-----\n\(b.keyDER)\n-----END PRIVATE KEY-----",
      "-----BEGIN CERTIFICATE-----\n\(b.keyDER)\n-----END CERTIFICATE-----",
      "-----BEGIN CERTIFICATE-----\n\(trailing.base64EncodedString())\n-----END CERTIFICATE-----",
      "-----BEGIN CERTIFICATE-----\nnot base64 !!",
      c.pem,
      a.pem,
    ].joined(separator: "\n")
    try mixed.write(toFile: corporate, atomically: true, encoding: .utf8)
    let kept = PluginSandbox.certificates(from: ["NODE_EXTRA_CA_CERTS": corporate], system: system)
    let names = { (bundle: String) in PluginSandbox.certificateBlocks(in: bundle).map { block -> String in
      let der = Data(base64Encoded: Self.body(block))!
      let certificate = SecCertificateCreateWithData(nil, der as CFData)!
      return SecCertificateCopySubjectSummary(certificate) as String? ?? "?"
    } }
    XCTAssertEqual(names(kept.replacement), ["Ardia Test A", "Ardia Test B", "Ardia Test C"], "the system roots, then each distinct extra, nothing else")
    XCTAssertEqual(names(kept.extra), ["Ardia Test B", "Ardia Test C", "Ardia Test A"], "the additive bundle holds every distinct supplied root, even one the system bundle has, since node doesn't read the system bundle")
    XCTAssertFalse(kept.replacement.contains(b.keyDER), "a key, even labelled CERTIFICATE, is never kept")
    XCTAssertEqual(PluginSandbox.certificateVariables(dataFolder: pluginData, staged: kept), [
      "SSL_CERT_FILE=\(pluginData)/certificates.pem", "GIT_SSL_CAINFO=\(pluginData)/certificates.pem", "NODE_EXTRA_CA_CERTS=\(pluginData)/extra-certificates.pem",
    ])
    XCTAssertEqual(PluginSandbox.certificateVariables(dataFolder: pluginData, staged: nil), ["SSL_CERT_FILE=/etc/ssl/cert.pem", "GIT_SSL_CAINFO=/etc/ssl/cert.pem"], "until a bundle is staged, the system roots")
    let huge = "\(root)/huge.pem"
    try String(repeating: c.pem, count: (PluginSandbox.certificateSourceLimit / c.pem.utf8.count) + 2).write(toFile: huge, atomically: true, encoding: .utf8)
    XCTAssertEqual(names(PluginSandbox.certificates(from: ["SSL_CERT_FILE": huge], system: system).replacement), ["Ardia Test A"], "a file past the size limit isn't read")
  }

  func testCertificateSourcesNeverBlockAndAreReadOffTheCaller() throws {
    let fifo = "\(root)/roots.fifo"
    XCTAssertEqual(mkfifo(fifo, 0o600), 0)
    let started = Date()
    let kept = PluginSandbox.certificates(from: ["SSL_CERT_FILE": fifo], system: "\(root)/none.pem")
    XCTAssertLessThan(Date().timeIntervalSince(started), 1, "a FIFO is refused without waiting for a writer")
    XCTAssertEqual(kept, PluginSandbox.Certificates(replacement: "", extra: ""))
    let a = try makeCertificate("Ardia Cache")
    let system = "\(root)/cache.pem"
    try a.pem.write(toFile: system, atomically: true, encoding: .utf8)
    let lifecycle = DispatchQueue(label: "test.lifecycle")
    let cache = PluginCertificateCache(system: system)
    var answered: PluginSandbox.PreparedCertificates?
    let preparing = Date()
    lifecycle.sync {
      cache.prepare(for: ["NODE_EXTRA_CA_CERTS": fifo], deliverOn: lifecycle) { answered = $0 }
      XCTAssertNil(answered, "preparing returns at once and answers later on the lifecycle queue")
    }
    guard case .ready(let ready) = prepared(cache, ["NODE_EXTRA_CA_CERTS": fifo], on: lifecycle) else { return XCTFail("a FIFO source still lets preparation answer") }
    XCTAssertEqual(names(ready.replacement), ["Ardia Cache"])
    XCTAssertEqual(ready.extra, "")
    XCTAssertLessThan(Date().timeIntervalSince(preparing), 2)
  }

  func prepared(_ cache: PluginCertificateCache, _ given: [String: String], on queue: DispatchQueue = DispatchQueue(label: "test.prepare"), within limit: TimeInterval = PluginCertificateCache.preparationLimit) -> PluginSandbox.PreparedCertificates {
    let done = DispatchSemaphore(value: 0)
    var answer = PluginSandbox.PreparedCertificates.timedOut
    cache.prepare(for: given, within: limit, deliverOn: queue) {
      answer = $0
      done.signal()
    }
    XCTAssertEqual(done.wait(timeout: .now() + 10), .success)
    return answer
  }

  func names(_ bundle: String) -> [String] {
    PluginSandbox.certificateBlocks(in: bundle).map { block -> String in
      let certificate = SecCertificateCreateWithData(nil, Data(base64Encoded: Self.body(block))! as CFData)!
      return SecCertificateCopySubjectSummary(certificate) as String? ?? "?"
    }
  }

  func testPreparationsForTheSameSettingsShareOneLoadAndATimedOutStartLeavesIt() throws {
    let a = try makeCertificate("Ardia Share A")
    let b = try makeCertificate("Ardia Share B")
    let system = "\(root)/system.pem"
    try a.pem.write(toFile: system, atomically: true, encoding: .utf8)
    let corporate = "\(root)/corp.pem"
    try b.pem.write(toFile: corporate, atomically: true, encoding: .utf8)
    let given = ["NODE_EXTRA_CA_CERTS": corporate]
    let cache = PluginCertificateCache(system: system)
    let started = DispatchSemaphore(value: 0)
    let release = DispatchSemaphore(value: 0)
    cache.willLoad = {
      started.signal()
      release.wait()
    }
    let target = DispatchQueue(label: "test.share")
    let all = DispatchGroup()
    let answers = NSMutableArray()
    for _ in 0..<5 {
      all.enter()
      cache.prepare(for: given, within: 20, deliverOn: target) {
        answers.add($0 == .timedOut ? "timedOut" : "ready")
        all.leave()
      }
    }
    XCTAssertEqual(started.wait(timeout: .now() + 10), .success, "the first load started")
    XCTAssertEqual(cache.loadsStarted, 1, "five starts waiting together share one load")
    XCTAssertEqual(cache.waiting(for: given), 5)
    let late = DispatchSemaphore(value: 0)
    var lateAnswer: PluginSandbox.PreparedCertificates?
    cache.prepare(for: given, within: 0.2, deliverOn: target) {
      lateAnswer = $0
      late.signal()
    }
    XCTAssertEqual(late.wait(timeout: .now() + 10), .success)
    XCTAssertEqual(lateAnswer, .timedOut)
    XCTAssertEqual(target.sync { cache.waiting(for: given) }, 5, "a start that timed out leaves the shared load and the others' waits alone")
    XCTAssertEqual(cache.loadsStarted, 1)
    release.signal()
    XCTAssertEqual(all.wait(timeout: .now() + 10), .success)
    XCTAssertEqual(target.sync { answers as? [String] }, Array(repeating: "ready", count: 5))
    XCTAssertEqual(cache.waiting(for: given), 0)
    cache.willLoad = nil
    guard case .ready(let after) = prepared(cache, given) else { return XCTFail("not ready") }
    XCTAssertEqual(names(after.extra), ["Ardia Share B"])
    XCTAssertEqual(cache.loadsStarted, 2, "a start after the shared load finished starts its own")
  }

  func testTheCertificateCacheRereadsChangedSourcesForgetsRemovedRootsAndNeverCachesAFailure() throws {
    let a = try makeCertificate("Ardia Root A")
    let b = try makeCertificate("Ardia Root B")
    let c = try makeCertificate("Ardia Root C")
    let system = "\(root)/system.pem"
    try a.pem.write(toFile: system, atomically: true, encoding: .utf8)
    let corporate = "\(root)/corp.pem"
    let given = ["NODE_EXTRA_CA_CERTS": corporate]
    let cache = PluginCertificateCache(system: system)
    let folder = open(pluginData, O_RDONLY | O_DIRECTORY)
    XCTAssertGreaterThanOrEqual(folder, 0)
    defer { close(folder) }
    func extras() -> [String] {
      guard case .ready(let ready) = prepared(cache, given) else { XCTFail("not ready"); return [] }
      _ = PluginSandbox.stage(.ready(ready), in: folder)
      return names(ready.extra)
    }
    let extraBundle = "\(pluginData)/extra-certificates.pem"
    XCTAssertEqual(extras(), [], "a source that can't be read yet adds nothing")
    try b.pem.write(toFile: corporate, atomically: true, encoding: .utf8)
    XCTAssertEqual(extras(), ["Ardia Root B"], "a failed read isn't cached: the file is read once it exists")
    XCTAssertEqual(names(try String(contentsOfFile: extraBundle, encoding: .utf8)), ["Ardia Root B"])
    try c.pem.write(toFile: corporate, atomically: true, encoding: .utf8)
    XCTAssertEqual(extras(), ["Ardia Root C"], "a file replaced at the same path is read again, and the old root is gone")
    let handle = try FileHandle(forWritingTo: URL(fileURLWithPath: corporate))
    try handle.truncate(atOffset: 0)
    try handle.write(contentsOf: Data(b.pem.utf8))
    try handle.close()
    XCTAssertEqual(extras(), ["Ardia Root B"], "a file rewritten in place is read again")
    let width = max(b.pem.utf8.count, c.pem.utf8.count)
    let padded = { (pem: String) in pem + String(repeating: " ", count: width - pem.utf8.count) }
    try padded(b.pem).write(toFile: corporate, atomically: false, encoding: .utf8)
    XCTAssertEqual(extras(), ["Ardia Root B"])
    var kept = stat()
    XCTAssertEqual(stat(corporate, &kept), 0)
    Thread.sleep(forTimeInterval: 0.05)
    let rewrite = try FileHandle(forWritingTo: URL(fileURLWithPath: corporate))
    try rewrite.write(contentsOf: Data(padded(c.pem).utf8))
    try rewrite.close()
    var times = [timespec(tv_sec: kept.st_atimespec.tv_sec, tv_nsec: kept.st_atimespec.tv_nsec), timespec(tv_sec: kept.st_mtimespec.tv_sec, tv_nsec: kept.st_mtimespec.tv_nsec)]
    XCTAssertEqual(utimensat(AT_FDCWD, corporate, &times, 0), 0)
    var after = stat()
    XCTAssertEqual(stat(corporate, &after), 0)
    XCTAssertEqual(after.st_size, kept.st_size)
    XCTAssertEqual(after.st_mtimespec.tv_nsec, kept.st_mtimespec.tv_nsec, "same inode, size and modification time")
    XCTAssertEqual(extras(), ["Ardia Root C"], "a rewrite that restores the modification time is still seen through the status-change time")
    try FileManager.default.removeItem(atPath: corporate)
    XCTAssertEqual(extras(), [], "a deleted file's roots disappear")
    XCTAssertFalse(FileManager.default.fileExists(atPath: extraBundle), "and so does the staged bundle that held them")
    XCTAssertEqual(names(try String(contentsOfFile: "\(pluginData)/certificates.pem", encoding: .utf8)), ["Ardia Root A"])
    try FileManager.default.removeItem(atPath: system)
    try b.pem.write(toFile: corporate, atomically: true, encoding: .utf8)
    guard case .ready(let systemless) = prepared(cache, given) else { return XCTFail("not ready") }
    XCTAssertEqual(systemless.replacement, "", "without usable system roots there is no replacement bundle, never an extras-only one")
    XCTAssertEqual(names(systemless.extra), ["Ardia Root B"])
    let staged = PluginSandbox.stage(.ready(systemless), in: folder)
    XCTAssertFalse(FileManager.default.fileExists(atPath: "\(pluginData)/certificates.pem"))
    XCTAssertEqual(PluginSandbox.certificateVariables(dataFolder: pluginData, staged: staged), [
      "SSL_CERT_FILE=/etc/ssl/cert.pem", "GIT_SSL_CAINFO=/etc/ssl/cert.pem", "NODE_EXTRA_CA_CERTS=\(pluginData)/extra-certificates.pem",
    ], "replacing tools keep the system path; node still gets the extra roots")
    XCTAssertEqual(prepared(cache, [:]), .notConfigured)
    _ = PluginSandbox.stage(.notConfigured, in: folder)
    XCTAssertFalse(FileManager.default.fileExists(atPath: "\(pluginData)/certificates.pem"), "with no extra roots configured, nothing staged is left")
  }

  func testAColdOnlineLaunchWaitsForTheCorporateRootsAndAnOfflineOneDoesNot() throws {
    let a = try makeCertificate("Ardia Cold A")
    let b = try makeCertificate("Ardia Cold B")
    let system = "\(root)/system.pem"
    try a.pem.write(toFile: system, atomically: true, encoding: .utf8)
    let corporate = "\(root)/corp.pem"
    try b.pem.write(toFile: corporate, atomically: true, encoding: .utf8)
    let given = ["NODE_EXTRA_CA_CERTS": corporate, "PATH": "/usr/bin:/bin"]
    let lifecycle = DispatchQueue(label: "test.lifecycle")
    let folder = open(pluginData, O_RDONLY | O_DIRECTORY)
    XCTAssertGreaterThanOrEqual(folder, 0)
    defer { close(folder) }
    let opened = OpenedFolder(fd: folder, path: pluginData, id: "test")
    func launch(network: Bool, cache: PluginCertificateCache, limit: TimeInterval = PluginCertificateCache.preparationLimit) throws -> (prepared: PluginSandbox.PreparedCertificates, output: String) {
      let done = DispatchSemaphore(value: 0)
      var environment: [String] = []
      var answer = PluginSandbox.PreparedCertificates.timedOut
      lifecycle.async {
        let deliver = { (certificates: PluginSandbox.PreparedCertificates) in
          dispatchPrecondition(condition: .onQueue(lifecycle))
          answer = certificates
          environment = PluginSandbox.helperEnvironment(name: "example", data: opened, channelFd: 3, network: network, given: given, certificates: certificates).variables
          done.signal()
        }
        if network { cache.prepare(for: given, within: limit, deliverOn: lifecycle, then: deliver) } else { deliver(.offline) }
      }
      XCTAssertEqual(done.wait(timeout: .now() + 10), .success)
      let box = PluginSandbox(home: home, appData: data, configFolder: config, pluginFolder: plugin, pluginData: pluginData, program: "/bin/sh", network: network)
      let process = Process()
      process.executableURL = URL(fileURLWithPath: "/usr/bin/sandbox-exec")
      process.arguments = try box.arguments() + ["/bin/sh", "-c", "echo \"roots=$NODE_EXTRA_CA_CERTS\"; [ -n \"$NODE_EXTRA_CA_CERTS\" ] && /bin/cat \"$NODE_EXTRA_CA_CERTS\"; echo \"replace=$SSL_CERT_FILE\""]
      process.environment = Dictionary(uniqueKeysWithValues: environment.map { line -> (String, String) in
        let parts = line.split(separator: "=", maxSplits: 1)
        return (String(parts[0]), parts.count > 1 ? String(parts[1]) : "")
      })
      process.currentDirectoryURL = URL(fileURLWithPath: plugin)
      let pipe = Pipe()
      process.standardOutput = pipe
      process.standardError = pipe
      try process.run()
      let output = String(decoding: pipe.fileHandleForReading.readDataToEndOfFile(), as: UTF8.self)
      process.waitUntilExit()
      return (answer, output)
    }
    let cold = try launch(network: true, cache: PluginCertificateCache(system: system))
    guard case .ready = cold.prepared else { return XCTFail("a cold cache still answers before the deadline: \(cold.prepared)") }
    XCTAssertTrue(cold.output.contains("roots=\(pluginData)/extra-certificates.pem"), cold.output)
    XCTAssertEqual(names(cold.output), ["Ardia Cold B"], "the first online helper already has the corporate root: \(cold.output)")
    XCTAssertTrue(cold.output.contains("replace=\(pluginData)/certificates.pem"), cold.output)
    let late = try launch(network: true, cache: PluginCertificateCache(system: system), limit: 0)
    XCTAssertEqual(late.prepared, .timedOut)
    XCTAssertTrue(late.output.contains("replace=/etc/ssl/cert.pem"), "past the deadline it starts with the system roots: \(late.output)")
    let offline = try launch(network: false, cache: PluginCertificateCache(system: system))
    XCTAssertEqual(offline.prepared, .offline)
    XCTAssertTrue(offline.output.contains("roots=\n"), offline.output)
  }

  func testThePEMScanIsLinearHandlesCRLFAndKeepsOnlyCertificateBlocks() throws {
    let a = try makeCertificate("Ardia PEM A")
    let b = try makeCertificate("Ardia PEM B")
    let crlf = a.pem.replacingOccurrences(of: "\n", with: "\r\n")
    XCTAssertEqual(names(PluginSandbox.certificateBlocks(in: crlf).joined()), ["Ardia PEM A"], "CRLF line ends")
    let trusted = b.pem.replacingOccurrences(of: "BEGIN CERTIFICATE", with: "BEGIN TRUSTED CERTIFICATE").replacingOccurrences(of: "END CERTIFICATE", with: "END TRUSTED CERTIFICATE")
    XCTAssertEqual(names(PluginSandbox.certificateBlocks(in: trusted + a.pem).joined()), ["Ardia PEM A"], "TRUSTED CERTIFICATE blocks are skipped")
    let unended = String(repeating: "-----BEGIN CERTIFICATE-----\nAAAA\n", count: 200_000)
    var visited = 0
    let input = unended + b.pem
    XCTAssertEqual(names(PluginSandbox.certificateBlocks(in: input, visited: &visited).joined()), ["Ardia PEM B"])
    XCTAssertEqual(visited, input.split(omittingEmptySubsequences: false, whereSeparator: { $0 == "\n" || $0 == "\r\n" }).count, "unmatched BEGIN lines are scanned once")
    let malformed = ["-----END CERTIFICATE-----", "-----BEGIN CERTIFICATE-----", "-----END PRIVATE KEY-----", Self.body(a.pem), "-----END CERTIFICATE-----", "-----BEGIN CERTIFICATE-----", "@@@", "-----END CERTIFICATE-----", b.pem].joined(separator: "\n")
    XCTAssertEqual(names(PluginSandbox.certificateBlocks(in: malformed).joined()), ["Ardia PEM B"], "a stray END, a foreign END inside a block and a bad body each drop only their block")
  }

  func testTheCertificateBundleIsWrittenAtomicallyInsideTheDataFolder() throws {
    let outsideFile = "\(outside)/target.pem"
    try "outside".write(toFile: outsideFile, atomically: true, encoding: .utf8)
    try FileManager.default.createSymbolicLink(atPath: "\(pluginData)/certificates.pem", withDestinationPath: outsideFile)
    let fd = open(pluginData, O_RDONLY | O_DIRECTORY)
    XCTAssertGreaterThanOrEqual(fd, 0)
    defer { close(fd) }
    XCTAssertTrue(PluginSandbox.writeAtomically(in: fd, name: "certificates.pem", contents: Self.sampleCertificate))
    XCTAssertEqual(try String(contentsOfFile: outsideFile, encoding: .utf8), "outside", "a link left in its place isn't followed")
    XCTAssertEqual(try String(contentsOfFile: "\(pluginData)/certificates.pem", encoding: .utf8), Self.sampleCertificate)
    XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: pluginData).filter { $0.hasPrefix(".certificates.pem.") }, [], "no temporary file is left")
  }

  func testAProgramOnAMountedDiskRunsButReadsNothingBesideItself() throws {
    let image = "\(root)/tools.dmg"
    let volume = "ArdiaTools\(Self.short())"
    XCTAssertEqual(try Self.run("/usr/bin/hdiutil", ["create", "-size", "4m", "-fs", "HFS+", "-volname", volume, "-ov", image]).status, 0)
    XCTAssertEqual(try Self.run("/usr/bin/hdiutil", ["attach", "-nobrowse", "-noverify", image]).status, 0)
    let mount = "/Volumes/\(volume)"
    defer { _ = try? Self.run("/usr/bin/hdiutil", ["detach", mount, "-force"]) }
    try FileManager.default.createDirectory(atPath: "\(mount)/bin", withIntermediateDirectories: true)
    try "#!/bin/sh\nexec /bin/cat \"$@\"\n".write(toFile: "\(mount)/bin/tool", atomically: true, encoding: .utf8)
    try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: "\(mount)/bin/tool")
    try "beside-secret".write(toFile: "\(mount)/secret", atomically: true, encoding: .utf8)
    XCTAssertEqual(try Self.run("\(mount)/bin/tool", ["\(mount)/secret"]).output, "beside-secret", "control")
    let runs = try sandboxed("\(mount)/bin/tool", ["/dev/null"])
    XCTAssertEqual(runs.status, 0, "the program itself runs: \(runs.output)")
    let beside = try sandboxed("\(mount)/bin/tool", ["\(mount)/secret"])
    XCTAssertNotEqual(beside.status, 0)
    XCTAssertFalse(beside.output.contains("beside-secret"))
  }

  func testAProgramOnAnotherDiskOrInAnotherHomeReadsOnlyItself() {
    for program in ["/Volumes/Work/bin/tool", "/Users/Shared/tools/bin/tool", "/Users/someone/bin/tool"] {
      let box = PluginSandbox(home: home, appData: data, configFolder: config, pluginFolder: plugin, pluginData: pluginData, program: program, network: true)
      XCTAssertEqual(box.installFolder(), program, program)
    }
    XCTAssertEqual(PluginSandbox(home: home, appData: data, configFolder: config, pluginFolder: plugin, pluginData: pluginData, program: "/opt/homebrew/opt/node/bin/node", network: true).installFolder(), "/opt/homebrew/opt/node")
  }

  func testPathnameSocketsCannotBeBoundButTheChannelOnDescriptorThreeWorks() throws {
    let path = "\(pluginData)/own.sock"
    XCTAssertEqual(try Self.run(probe, ["ubind", path]).status, 0, "control: binding works outside")
    for network in [true, false] {
      XCTAssertEqual(try sandboxed(probe, ["ubind", path], network: network).status, EPERM, "a pathname socket can't be bound (network \(network))")
    }
    let box = PluginSandbox(home: home, appData: data, configFolder: config, pluginFolder: plugin, pluginData: pluginData, program: probe, network: false)
    let launcher = """
      import os, socket, subprocess, sys
      reserved = os.open("/dev/null", os.O_RDONLY)
      ours, theirs = socket.socketpair()
      os.dup2(theirs.fileno(), 3)
      os.set_inheritable(3, True)
      done = subprocess.run(["/usr/bin/sandbox-exec"] + sys.argv[1:], pass_fds=(3,), capture_output=True, timeout=20)
      ours.settimeout(5)
      print(done.returncode, ours.recv(64).decode().strip())
      """
    let through = try Self.run("/usr/bin/python3", ["-I", "-c", launcher] + (try box.arguments()) + [probe, "fd3", "x"], in: plugin)
    XCTAssertEqual(through.output.trimmingCharacters(in: .whitespacesAndNewlines), "0 hello", "the inherited channel still works: \(through.output)")
  }

  func testWithoutNetworkItCannotListenWithItCanOnLoopback() throws {
    XCTAssertEqual(try Self.run(probe, ["bind", "0"]).status, 0, "control: binding loopback works outside")
    XCTAssertEqual(try sandboxed(probe, ["bind", "0"], network: true).status, 0, "with network a local server can listen")
    XCTAssertEqual(try sandboxed(probe, ["bind", "0"], network: false).status, EPERM, "without network it can't listen")
  }

  func testTrustServicesAreReachableOnlyWithNetwork() throws {
    for name in PluginSandbox.machAllowedOnline {
      XCTAssertEqual(try Self.run(probe, ["lookup", name]).status, 0, "control: \(name) outside")
      XCTAssertEqual(try sandboxed(probe, ["lookup", name], network: true).status, 0, "\(name) with network")
      XCTAssertEqual(try sandboxed(probe, ["lookup", name], network: false).status, 97, "\(name) without network")
    }
  }

  func testOtherUsersFilesAndMountedDisksAreUnreadable() throws {
    let shared = "/Users/Shared/ardia-plugin-escape-\(Self.short())"
    scratch.append(shared)
    try "shared-secret".write(toFile: shared, atomically: true, encoding: .utf8)
    XCTAssertEqual(try Self.run("/bin/cat", [shared]).output, "shared-secret", "control")
    let inside = try sandboxed("/bin/cat", [shared])
    XCTAssertNotEqual(inside.status, 0)
    XCTAssertFalse(inside.output.contains("shared-secret"))
    let image = "\(root)/disk.dmg"
    let volume = "ArdiaEscape\(Self.short())"
    let made = try Self.run("/usr/bin/hdiutil", ["create", "-size", "1m", "-fs", "HFS+", "-volname", volume, "-ov", image])
    try XCTSkipUnless(made.status == 0, "hdiutil can't make an image here: \(made.output)")
    let attached = try Self.run("/usr/bin/hdiutil", ["attach", "-nobrowse", "-noverify", image])
    try XCTSkipUnless(attached.status == 0, "hdiutil can't attach here: \(attached.output)")
    let mount = "/Volumes/\(volume)"
    defer { _ = try? Self.run("/usr/bin/hdiutil", ["detach", mount, "-force"]) }
    try "disk-secret".write(toFile: "\(mount)/secret.txt", atomically: true, encoding: .utf8)
    XCTAssertEqual(try Self.run("/bin/cat", ["\(mount)/secret.txt"]).output, "disk-secret", "control")
    let onDisk = try sandboxed("/bin/cat", ["\(mount)/secret.txt"])
    XCTAssertNotEqual(onDisk.status, 0)
    XCTAssertFalse(onDisk.output.contains("disk-secret"))
  }

  func testSysctlReadsWorkAndWritesAreRefused() throws {
    let control = try Self.run(probe, ["sysctlread", "hw.pagesize"])
    XCTAssertEqual(control.status, 0, control.output)
    XCTAssertEqual(try sandboxed(probe, ["sysctlread", "hw.pagesize"]).output, control.output, "a required read works inside")
    XCTAssertEqual(try Self.run(probe, ["decision", "sysctl-write"]).output, "allowed\n", "control: outside a sandbox the write isn't refused by policy")
    XCTAssertEqual(try sandboxed(probe, ["decision", "sysctl-write"]).output, "denied\n", "the sandbox's own decision refuses sysctl writes")
  }

  func testDataUnderTheRealLibraryWorksAndItsSiblingsStayDenied() throws {
    let realHome = PluginSandbox.resolved(NSHomeDirectory())!
    let base = "\(realHome)/Library/Caches/ardia plugin-escape é'\(Self.short())"
    scratch.append(base)
    let libraryData = "\(base)/data"
    let libraryConfig = "\(libraryData)/config"
    let libraryPlugin = "\(libraryConfig)/plugins/example"
    let libraryPluginData = "\(libraryData)/PluginData/example"
    let sibling = "\(base)/sibling"
    for folder in [libraryPlugin, libraryPluginData, sibling] { try FileManager.default.createDirectory(atPath: folder, withIntermediateDirectories: true) }
    try "plugin file".write(toFile: "\(libraryPlugin)/readme", atomically: true, encoding: .utf8)
    try "sibling-secret".write(toFile: "\(sibling)/secret", atomically: true, encoding: .utf8)
    try FileManager.default.createSymbolicLink(atPath: "\(libraryPluginData)/link", withDestinationPath: "\(sibling)/secret")
    XCTAssertEqual(setxattr(base, "dev.ardia.escape", "named", 5, 0, 0), 0)
    let box = PluginSandbox(home: realHome, appData: libraryData, configFolder: libraryConfig, pluginFolder: libraryPlugin, pluginData: libraryPluginData, program: probe, network: false)
    func inside(_ arguments: [String]) throws -> Outcome { try Self.run("/usr/bin/sandbox-exec", try box.arguments() + [probe] + arguments, in: libraryPlugin) }
    let shell = PluginSandbox(home: realHome, appData: libraryData, configFolder: libraryConfig, pluginFolder: libraryPlugin, pluginData: libraryPluginData, program: "/bin/sh", network: false)
    let worked = try Self.run("/usr/bin/sandbox-exec", try shell.arguments() + ["/bin/sh", "-c", "echo written > \"$1/note\" && cat \"$1/note\" \"$2/readme\"", "sh", libraryPluginData, libraryPlugin], in: libraryPlugin)
    XCTAssertEqual(worked.output, "written\nplugin file", "its own data and folder work under the real Library, odd characters and all: \(worked.output)")
    for ancestor in PluginSandbox.ancestors(of: libraryPluginData, below: realHome) {
      let stat = try Self.run("/usr/bin/sandbox-exec", try shell.arguments() + ["/usr/bin/stat", "-f", "%N", ancestor], in: libraryPlugin)
      XCTAssertEqual(stat.status, 0, "metadata on the named ancestor \(ancestor): \(stat.output)")
    }
    XCTAssertEqual(try Self.run(probe, ["listdir", base]).status, 0, "control: the ancestor lists outside")
    XCTAssertEqual(try inside(["listdir", base]).status, EPERM, "an ancestor can't be listed")
    XCTAssertEqual(try Self.run(probe, ["xattr", base, "dev.ardia.escape"]).output, "xattr named\n", "control")
    XCTAssertEqual(try inside(["xattr", base, "dev.ardia.escape"]).status, EPERM, "an ancestor's extended attributes can't be read")
    XCTAssertEqual(try Self.run(probe, ["finderinfo", sibling]).status, 0, "control")
    XCTAssertEqual(try inside(["finderinfo", base]).status, 0, "Finder info is metadata, so a named ancestor answers it")
    XCTAssertEqual(try inside(["finderinfo", sibling]).status, EPERM, "a folder that isn't a named ancestor doesn't")
    XCTAssertEqual(try Self.run("/bin/cat", ["\(sibling)/secret"]).output, "sibling-secret", "control")
    for path in ["\(sibling)/secret", "\(libraryPluginData)/link", "/System/Volumes/Data\(sibling)/secret"] {
      XCTAssertEqual(try Self.run("/bin/cat", [path]).output, "sibling-secret", "control: \(path) reads outside")
      let read = try Self.run("/usr/bin/sandbox-exec", try shell.arguments() + ["/bin/cat", path], in: libraryPlugin)
      XCTAssertNotEqual(read.status, 0, path)
      XCTAssertTrue(read.output.contains("Operation not permitted"), "\(path): \(read.output)")
    }
  }

  static let fileEventsSource = #"""
#include <CoreServices/CoreServices.h>
#include <stdio.h>
#include <string.h>

static const char *needle;
static int leaked = 0;
static int events = 0;

static void callback(ConstFSEventStreamRef stream, void *info, size_t count, void *paths, const FSEventStreamEventFlags flags[], const FSEventStreamEventId ids[]) {
  char **list = paths;
  for (size_t i = 0; i < count; i++) {
    events++;
    if (needle && strstr(list[i], needle)) {
      leaked = 1;
      printf("leak %s\n", list[i]);
    }
  }
}

int main(int argc, char **argv) {
  if (argc < 8) return 98;
  const char *root = argv[1];
  needle = argv[2];
  FSEventStreamEventId since = strcmp(argv[3], "now") == 0 ? kFSEventStreamEventIdSinceNow : strtoull(argv[3], NULL, 10);
  double seconds = atof(argv[4]);
  int perDevice = strcmp(argv[5], "device") == 0;
  dev_t device = (dev_t)strtol(argv[6], NULL, 10);
  const char *watched = perDevice ? argv[7] : root;
  printf("currentEventId %llu\n", (unsigned long long)FSEventsGetCurrentEventId());
  CFUUIDRef uuid = FSEventsCopyUUIDForDevice(device);
  printf("uuid %s\n", uuid ? "returned" : "refused");
  if (uuid) CFRelease(uuid);
  printf("lastBeforeTime %llu\n", (unsigned long long)FSEventsGetLastEventIdForDeviceBeforeTime(device, CFAbsoluteTimeGetCurrent() - 1));
  fflush(stdout);
  CFStringRef path = CFStringCreateWithCString(NULL, watched, kCFStringEncodingUTF8);
  CFArrayRef paths = CFArrayCreate(NULL, (const void **)&path, 1, &kCFTypeArrayCallBacks);
  FSEventStreamCreateFlags flags = kFSEventStreamCreateFlagFileEvents | kFSEventStreamCreateFlagNoDefer;
  FSEventStreamRef stream = perDevice ? FSEventStreamCreateRelativeToDevice(NULL, callback, NULL, device, paths, since, 0.1, flags) : FSEventStreamCreate(NULL, callback, NULL, paths, since, 0.1, flags);
  if (!stream) {
    printf("stream refused\n");
    return 90;
  }
  dispatch_queue_t queue = dispatch_queue_create("fse", NULL);
  FSEventStreamSetDispatchQueue(stream, queue);
  if (!FSEventStreamStart(stream)) {
    printf("stream start refused\n");
    return 89;
  }
  printf("started\n");
  fflush(stdout);
  CFRunLoopRunInMode(kCFRunLoopDefaultMode, seconds, false);
  FSEventStreamStop(stream);
  FSEventStreamInvalidate(stream);
  printf("events %d leaked %d\n", events, leaked);
  return 0;
}
"""#

  func testFileEventsAreRefusedSoNothingOutsideLeaks() throws {
    try Self.fileEventsSource.write(toFile: "\(root)/fse.c", atomically: true, encoding: .utf8)
    let watcher = "\(plugin)/fse"
    let built = try Self.run("/usr/bin/xcrun", ["clang", "-O", "-framework", "CoreServices", "-o", watcher, "\(root)/fse.c"])
    XCTAssertEqual(built.status, 0, built.output)
    let realHome = PluginSandbox.resolved(NSHomeDirectory())!
    func eventId(_ output: String, _ label: String) -> UInt64? {
      output.split(separator: "\n").first { $0.hasPrefix("\(label) ") }.flatMap { UInt64($0.dropFirst(label.count + 1)) }
    }
    var info = stat()
    XCTAssertEqual(stat(realHome, &info), 0)
    var volume = statfs()
    XCTAssertEqual(statfs(realHome, &volume), 0)
    let mountPoint = withUnsafeBytes(of: volume.f_mntonname) { String(decoding: $0.prefix { $0 != 0 }, as: UTF8.self) }
    let relative = (realHome.hasPrefix(mountPoint) ? String(realHome.dropFirst(mountPoint.count)) : realHome).trimmingCharacters(in: CharacterSet(charactersIn: "/"))
    func watch(inside: Bool, network: Bool = true, mode: String, since: String, writing marker: String?, looking needle: String) throws -> Outcome {
      let finished = DispatchSemaphore(value: 0)
      if let marker {
        Thread {
          for _ in 0..<8 {
            Thread.sleep(forTimeInterval: 0.25)
            try? "x".write(toFile: "\(realHome)/\(marker)", atomically: false, encoding: .utf8)
            try? FileManager.default.removeItem(atPath: "\(realHome)/\(marker)")
          }
          finished.signal()
        }.start()
      } else {
        finished.signal()
      }
      let arguments = [realHome, needle, since, "4", mode, String(info.st_dev), relative]
      let outcome = inside ? try sandboxed(watcher, arguments, network: network) : try Self.run(watcher, arguments, in: plugin)
      XCTAssertEqual(finished.wait(timeout: .now() + 10), .success, "the writer finished")
      return outcome
    }
    var control = Outcome(status: -1, output: "")
    var marker = ""
    for _ in 0..<3 where !control.output.contains("leak ") {
      marker = "fse-secret-\(Self.short())"
      control = try watch(inside: false, mode: "device", since: "now", writing: marker, looking: marker)
    }
    XCTAssertEqual(control.status, 0, control.output)
    XCTAssertTrue(control.output.contains("started"), "control: a stream must start outside, or this test proves nothing: \(control.output)")
    XCTAssertTrue(control.output.contains("uuid returned"), "control: outside, the device's UUID is returned: \(control.output)")
    XCTAssertGreaterThan(eventId(control.output, "currentEventId") ?? 0, 0, "control: outside, the current event id is real")
    XCTAssertTrue(control.output.contains("leak "), "control: outside, a stream on the home folder's device shows the write: \(control.output)")
    let since = String(eventId(control.output, "currentEventId") ?? 0)
    for mode in ["path", "device"] {
      let replay = try watch(inside: false, mode: mode, since: since, writing: nil, looking: marker)
      XCTAssertTrue(replay.output.contains("leak "), "control: outside, replay from an earlier event id shows the write (\(mode)): \(replay.output)")
    }
    for network in [true, false] {
      for mode in ["path", "device"] {
        for start in ["now", since] {
          let probe = start == "now" ? "fse-secret-\(Self.short())" : nil
          let inside = try watch(inside: true, network: network, mode: mode, since: start, writing: probe, looking: probe ?? marker)
          let label = "network \(network), \(mode), since \(start)"
          XCTAssertTrue([89, 90].contains(inside.status), "the stream is refused, not run (\(label)): status \(inside.status) \(inside.output)")
          XCTAssertTrue(inside.output.contains("uuid refused"), "the device's event UUID is refused (\(label)): \(inside.output)")
          XCTAssertEqual(eventId(inside.output, "currentEventId"), 0, "no current event id (\(label))")
          XCTAssertEqual(eventId(inside.output, "lastBeforeTime"), 0, "no per-device event id (\(label))")
          XCTAssertFalse(inside.output.contains("leak "), "nothing leaks (\(label))")
          XCTAssertFalse(inside.output.contains(marker), "the control's write doesn't replay (\(label))")
        }
      }
    }
  }
}
