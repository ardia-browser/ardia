import Foundation

enum ArdiaHost {
  nonisolated(unsafe) static var dataDirectory = ""
  static func baseProfile(of profile: String) -> String { profile }
}

struct ArdiaConsentStamp {
  static func begin() -> ArdiaConsentStamp { ArdiaConsentStamp() }
  func onto(_ data: [String: Any]) -> [String: Any] { data }
}

enum ArdiaServices {
  static func profileDirectory(_ profile: String) -> String { profile }
}

enum WebKitExtensionShared {
  enum Feature { case grants }
  enum Answer {
    case ok([String: Any])
    case missing
    case failed(String)
  }

  static func has(_ feature: Feature) -> Bool { false }
  static func call(_ name: String, profile: String, args: [String: Any], done: @escaping (Answer) -> Void) { done(.missing) }
  static func count(_ name: String) {}
}

enum ArdiaEvents {
  static func emit(_ name: String, data: [String: Any]) {}
}

@main
@MainActor
struct WebKitNativeHostTests {
  static var failures = 0

  static func expect(_ ok: Bool, _ name: String) {
    if ok { return }
    failures += 1
    print("FAIL \(name)")
  }

  static func spin(until done: () -> Bool, seconds: TimeInterval) {
    let end = Date().addingTimeInterval(seconds)
    while !done(), Date() < end { RunLoop.main.run(until: Date().addingTimeInterval(0.02)) }
  }

  static func alive(_ pid: pid_t) -> Bool { kill(pid, 0) == 0 }

  static func install(_ name: String, script: String, in folder: URL) throws {
    let path = folder.appendingPathComponent("\(name).py")
    try ("#!/usr/bin/python3\nimport json, os, signal, struct, sys, time\nopen(sys.argv[0] + '.pid', 'w').write(str(os.getpid()))\n" + script)
      .write(to: path, atomically: true, encoding: .utf8)
    try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: path.path)
    let manifest: [String: Any] = ["name": name, "path": path.path, "type": "stdio", "allowed_origins": ["chrome-extension://abc/"]]
    try JSONSerialization.data(withJSONObject: manifest).write(to: folder.appendingPathComponent("NativeMessagingHosts/\(name).json"))
  }

  static func pid(_ name: String, in folder: URL) -> pid_t? {
    (try? String(contentsOf: folder.appendingPathComponent("\(name).py.pid"), encoding: .utf8)).flatMap { pid_t($0) }
  }

  static func checkExtensionAccess() {
    for method in ["getAll", "get", "setEnabled", "uninstall"] {
      expect(!WebKitExtensionAccess.mayCall("management", method, permissions: ["storage"]), "management.\(method) needs the management permission")
      expect(WebKitExtensionAccess.mayCall("management", method, permissions: ["management"]), "management.\(method) works with the management permission")
    }
    for method in ["getSelf", "uninstallSelf", "getPermissionWarningsByManifest"] {
      expect(WebKitExtensionAccess.mayCall("management", method, permissions: []), "management.\(method) needs no permission, as in Chrome")
    }
    expect(WebKitExtensionAccess.mayCall("history", "search", permissions: []), "other namespaces are gated by their own permission elsewhere")

    expect(WebKitExtensionAccess.acceptsExternal(from: "a", manifest: [:]), "without externally_connectable every extension may connect")
    expect(!WebKitExtensionAccess.acceptsExternal(from: "a", manifest: ["externally_connectable": ["matches": ["https://x.test/*"]]]),
           "externally_connectable without ids refuses other extensions")
    expect(WebKitExtensionAccess.acceptsExternal(from: "a", manifest: ["externally_connectable": ["ids": ["b", "a"]]]), "a listed id may connect")
    expect(!WebKitExtensionAccess.acceptsExternal(from: "c", manifest: ["externally_connectable": ["ids": ["b"]]]), "an unlisted id may not connect")
    expect(WebKitExtensionAccess.acceptsExternal(from: "c", manifest: ["externally_connectable": ["ids": ["*"]]]), "a wildcard id lets any extension connect")

    expect(WebKitExtensionAccess.ownsNewChannel("abc:1:x", extensionId: "abc", open: []), "an extension opens a channel under its own id")
    expect(!WebKitExtensionAccess.ownsNewChannel("other:1:x", extensionId: "abc", open: []), "an extension can't open a channel under another id")
    expect(!WebKitExtensionAccess.ownsNewChannel("abcd:1", extensionId: "abc", open: []), "an id that only starts with the extension's id isn't its own")
    expect(!WebKitExtensionAccess.ownsNewChannel("abc:1:x", extensionId: "abc", open: ["abc:1:x"]), "an open channel can't be taken over")
    expect(!WebKitExtensionAccess.ownsNewChannel("abc:", extensionId: "abc", open: []), "a channel needs a name after the id")

    for name in ["Origin", "cookie", "Referer", "Host", "Sec-Fetch-Site", "Proxy-Authorization"] {
      expect(WebKitExtensionAccess.isForbiddenHeader(name), "\(name) can't be set on a download")
    }
    for name in ["Content-Type", "X-Requested-With", "Authorization"] {
      expect(!WebKitExtensionAccess.isForbiddenHeader(name), "\(name) can be set on a download")
    }

    expect(!WebKitExtensionAccess.mayListen("management", permissions: ["storage"]), "management events need the management permission")
    expect(WebKitExtensionAccess.mayListen("management", permissions: ["management"]), "management events reach an extension with the permission")
    expect(WebKitExtensionAccess.mayListen("storage", permissions: []), "other namespaces' events are gated by staging")
    expect(WebKitExtensionAccess.hearsAlarm(isPrivate: false, regularHasExtension: true), "the regular window's copy hears its alarm")
    expect(!WebKitExtensionAccess.hearsAlarm(isPrivate: true, regularHasExtension: true), "a private window's copy doesn't hear it a second time")
    expect(WebKitExtensionAccess.hearsAlarm(isPrivate: true, regularHasExtension: false), "a private-only copy still hears its alarm")

    expect(WebKitExtensionAccess.ownPage(URL(string: "webkit-extension://abc/options.html")!) == "abc", "an extension page names its extension")
    expect(WebKitExtensionAccess.ownPage(URL(string: "https://abc/options.html")!) == nil, "a web page isn't an extension page")
    let clicked = Date(timeIntervalSince1970: 1000)
    expect(WebKitExtensionAccess.isFresh(clicked, lifetime: 5, now: clicked.addingTimeInterval(4.9)), "a click counts for five seconds")
    expect(!WebKitExtensionAccess.isFresh(clicked, lifetime: 5, now: clicked.addingTimeInterval(5.1)), "a click stops counting after five seconds")
    expect(!WebKitExtensionAccess.isFresh(nil, lifetime: 5, now: clicked), "no click, no gesture")

    expect(!WebKitExtensionAccess.mayNavigate(to: URL(fileURLWithPath: "/etc/hosts")), "an extension can't open a file URL")
    expect(!WebKitExtensionAccess.mayNavigate(to: URL(string: "javascript:alert(1)")!), "an extension can't run script in a tab through its URL")
    expect(!WebKitExtensionAccess.mayNavigate(to: URL(string: "JavaScript:alert(1)")!), "the javascript scheme is refused in any case")
    expect(WebKitExtensionAccess.mayNavigate(to: URL(string: "https://example.com/")!), "an extension can open a web URL")
  }

  static func checkFallbackGrants(in root: URL) throws {
    let file = root.appendingPathComponent("Secure Preferences")
    let settings: [String: Any] = [
      "withheld": [
        "withholding_permissions": true,
        "granted_permissions": ["api": ["storage"], "explicit_host": ["<all_urls>"], "scriptable_host": ["https://all.example/*"]],
        "runtime_granted_permissions": ["explicit_host": ["https://picked.example/*"]],
      ],
      "withheldNothingPicked": [
        "withholding_permissions": true,
        "granted_permissions": ["api": ["tabs"], "explicit_host": ["<all_urls>"]],
      ],
      "open": [
        "granted_permissions": ["api": ["storage", "history"], "explicit_host": ["https://open.example/*"]],
      ],
    ]
    try JSONSerialization.data(withJSONObject: ["extensions": ["settings": settings]]).write(to: file)
    let grants = WebKitExtensionGrants.parse(file)
    expect(grants["withheld"]?.hosts == ["https://picked.example/*"], "a user who limited site access keeps only the sites they picked")
    expect(grants["withheld"]?.apis == ["storage"], "withholding sites keeps the extension's API permissions")
    expect(grants["withheldNothingPicked"]?.hosts.isEmpty == true, "a user who limited site access and picked nothing grants no site")
    expect(grants["open"]?.hosts == ["https://open.example/*"] && grants["open"]?.apis == ["storage", "history"], "without withholding every granted permission counts")
  }

  static func main() throws {
    expect(WebKitExtensionNativeHost.isValidName("com.example.host_1"), "a dotted lowercase name is valid")
    for name in ["com.example.host\n", "Com.example", ".host", "host.", "a..b", "a-b", ""] {
      expect(!WebKitExtensionNativeHost.isValidName(name), "\(name.debugDescription) is not a valid name")
    }
    let home = FileManager.default.homeDirectoryForCurrentUser.path
    expect(WebKitExtensionNativeHost.folders().contains { $0.path == home + "/Library/Application Support/Chromium/NativeMessagingHosts" },
           "the user's Chromium folder is searched")

    var buffer = WebKitExtensionNativeHost.frame(["a": [1, 2]])! + WebKitExtensionNativeHost.frame("hi")!
    let messages = try WebKitExtensionNativeHost.unframe(&buffer)
    expect(messages.count == 2 && (messages[1] as? String) == "hi" && buffer.isEmpty, "two framed messages read back in order")

    let whole = WebKitExtensionNativeHost.frame(["k": "v"])!
    expect(whole.prefix(4) == Data([UInt8(whole.count - 4), 0, 0, 0]), "the length prefix is little-endian, as Chrome's native order on a Mac")
    var pieces = Data()
    var heard: [Any] = []
    for byte in whole + whole.prefix(3) {
      pieces.append(byte)
      heard += try WebKitExtensionNativeHost.unframe(&pieces)
    }
    expect(heard.count == 1 && pieces.count == 3, "a message split at every byte reads once whole and leaves the next partial header waiting")

    expect(WebKitExtensionNativeHost.frame(String(repeating: "z", count: WebKitExtensionNativeHost.maxOutgoing)) == nil,
           "a message over 64 MB to a host is refused, as Chrome does")
    expect(WebKitExtensionNativeHost.frame(String(repeating: "z", count: 1_000_000)) != nil, "a large message under the limit is framed")

    expect(WebKitExtensionNativeHost.frame(Double.nan) == nil && WebKitExtensionNativeHost.frame(["n": Double.infinity]) == nil,
           "a number JSON can't hold is refused instead of raising")

    func rejects(_ bytes: [UInt8]) -> Bool {
      var data = Data(bytes)
      return (try? WebKitExtensionNativeHost.unframe(&data)) == nil
    }
    let limit = UInt32(WebKitExtensionNativeHost.maxIncoming)
    let over = withUnsafeBytes(of: (limit + 1).littleEndian, Array.init)
    expect(rejects(over), "a length over 1 MB is refused from its header alone")
    let atLimit = withUnsafeBytes(of: limit.littleEndian, Array.init)
    expect(!rejects(atLimit), "a 1 MB length waits for its body")
    expect(rejects([0, 0, 0, 0]), "a zero-length message is refused")
    expect(rejects([2, 0, 0, 0, 0x7B, 0x7B]), "a body that isn't JSON is refused")

    let root = URL(fileURLWithPath: NSTemporaryDirectory()).appendingPathComponent("nh-test-\(getpid())", isDirectory: true)
    defer { try? FileManager.default.removeItem(at: root) }
    try FileManager.default.createDirectory(at: root.appendingPathComponent("NativeMessagingHosts"), withIntermediateDirectories: true)
    ArdiaHost.dataDirectory = root.path
    try install("test.stubborn", script: "signal.signal(signal.SIGTERM, signal.SIG_IGN)\ntime.sleep(30)\n", in: root)
    try install("test.echo", script: """
      while True:
          raw = sys.stdin.buffer.read(4)
          if len(raw) < 4: break
          body = sys.stdin.buffer.read(struct.unpack('<I', raw)[0])
          out = json.dumps({'size': len(body)}).encode()
          sys.stdout.buffer.write(struct.pack('<I', len(out)) + out)
          sys.stdout.buffer.flush()

      """, in: root)

    var exits: [NSError?] = []
    let stubborn = try WebKitExtensionNativeHost.launch("test.stubborn", extensionId: "abc", onMessage: { _ in }, onExit: { exits.append($0) })
    spin(until: { pid("test.stubborn", in: root) != nil }, seconds: 5)
    let started = Date()
    expect(stubborn.send(String(repeating: "x", count: 300_000)), "a large message to a host that never reads is queued")
    expect(Date().timeIntervalSince(started) < 0.5, "sending to a host that never reads doesn't block the caller")
    let stubbornPid = pid("test.stubborn", in: root) ?? 0
    stubborn.close()
    spin(until: { !alive(stubbornPid) }, seconds: 1)
    expect(alive(stubbornPid), "a host that ignores SIGTERM gets the grace period")
    spin(until: { !alive(stubbornPid) }, seconds: 4)
    expect(!alive(stubbornPid), "a host that ignores SIGTERM is killed after the grace period")
    expect(exits.isEmpty, "closing a host doesn't report an exit")

    var replies: [Any] = []
    let echo = try WebKitExtensionNativeHost.launch("test.echo", extensionId: "abc", onMessage: { replies.append($0) }, onExit: { exits.append($0) })
    expect(echo.extensionId == "abc", "a host knows which extension launched it")
    expect(echo.send(String(repeating: "y", count: 200_000)) && echo.send(["n": 1]), "messages to a reading host are queued")
    spin(until: { replies.count == 2 }, seconds: 10)
    let sizes = replies.compactMap { ($0 as? [String: Any])?["size"] as? Int }
    expect(sizes == [200_002, 7], "a reading host gets every message whole and in order (\(sizes))")
    let echoPid = pid("test.echo", in: root) ?? 0
    echo.finish(WebKitExtensionNativeHost.exited)
    expect(exits.count == 1 && exits[0] === WebKitExtensionNativeHost.exited, "finishing a host reports its exit once")
    spin(until: { !alive(echoPid) }, seconds: 3)
    expect(!alive(echoPid), "a host that reads stdin exits when it closes")

    expect((try? WebKitExtensionNativeHost.launch("test.echo", extensionId: "other", onMessage: { _ in }, onExit: { _ in })) == nil,
           "an extension the manifest doesn't allow can't launch the host")

    checkExtensionAccess()
    try checkFallbackGrants(in: root)

    if failures > 0 { exit(1) }
    print("ok")
  }
}
