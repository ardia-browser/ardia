import Foundation

@main
enum WebUIShellHostTest {
  static var failures = 0
  static let fileManager = FileManager.default

  static func check(_ ok: Bool, _ what: String) {
    if !ok {
      print("FAIL \(what)")
      failures += 1
    }
  }

  static func makeApp(_ path: String, identifier: String = WebUIShellHost.devHostBundleIdentifier, executable: String = "host") {
    try! fileManager.createDirectory(atPath: path + "/Contents/MacOS", withIntermediateDirectories: true)
    let info: NSDictionary = ["CFBundleExecutable": executable, "CFBundleIdentifier": identifier]
    info.write(toFile: path + "/Contents/Info.plist", atomically: true)
  }

  static func makeExecutable(_ path: String) {
    fileManager.createFile(atPath: path, contents: Data("#!/bin/sh\n".utf8), attributes: [.posixPermissions: 0o755])
  }

  static func request(hostApp: String? = nil, handedOff: Bool = false) -> WebUIShellHost.Request {
    WebUIShellHost.Request(dataDirectory: "/tmp/dev", dataDirectoryDefaulted: true, hostApp: hostApp, handedOff: handedOff)
  }

  static func main() {
    let root = WebUIShellHost.canonicalPath(NSTemporaryDirectory())! + "/webui-host-\(getpid())"
    defer { try? fileManager.removeItem(atPath: root) }
    let apps = root + "/Applications"
    let app = URL(fileURLWithPath: apps + "/Ardia Dev.app", isDirectory: true)
    makeApp(app.path, identifier: "com.ardia.browser", executable: "Ardia")
    makeExecutable(app.path + "/Contents/MacOS/Ardia")
    let sibling = apps + "/Ardia WebUI Dev.app"
    let named = root + "/built/Ardia WebUI.app"
    let route = { (request: WebUIShellHost.Request) in WebUIShellHost.route(request, runningBundle: app) }

    if case .stay(let reason) = route(request()) {
      check(reason.contains(sibling) && reason.contains("ARDIA_WEBUI_APP") && reason.contains("React Native"), "no host says where it looked and how to build one")
    } else {
      check(false, "with no host built the app stays on the React Native shell")
    }

    makeApp(sibling)
    makeExecutable(sibling + "/Contents/MacOS/host")
    check(route(request()) == .handOff(executable: sibling + "/Contents/MacOS/host"), "the dev host beside the app")

    makeApp(named, identifier: "anything.built.locally")
    makeExecutable(named + "/Contents/MacOS/host")
    check(route(request(hostApp: named)) == .handOff(executable: named + "/Contents/MacOS/host"), "ARDIA_WEBUI_APP comes first, whatever its identifier")
    check(route(request(hostApp: root + "/built/Missing.app")) == .handOff(executable: sibling + "/Contents/MacOS/host"), "a missing ARDIA_WEBUI_APP falls back to the dev host beside the app")
    check(route(request(hostApp: app.path)) == .handOff(executable: sibling + "/Contents/MacOS/host"), "never hands off to itself")
    let appLink = root + "/AppLink.app"
    try! fileManager.createSymbolicLink(atPath: appLink, withDestinationPath: app.path)
    check(route(request(hostApp: appLink)) == .handOff(executable: sibling + "/Contents/MacOS/host"), "never hands off to itself through a symlink")
    let firmlinked = "/System/Volumes/Data" + app.path
    if fileManager.fileExists(atPath: firmlinked) {
      check(WebUIShellHost.sameFile(firmlinked, app.path), "the Data volume path is the same bundle")
      check(route(request(hostApp: firmlinked)) == .handOff(executable: sibling + "/Contents/MacOS/host"), "never hands off to itself through the Data volume's path")
    } else {
      check(false, "the Data volume path of a temporary folder exists on macOS")
    }
    let hardFolder = root + "/hard"
    try! fileManager.createDirectory(atPath: hardFolder, withIntermediateDirectories: true)
    check(!WebUIShellHost.sameFile(hardFolder, app.path), "another folder is not the running bundle")
    if case .handOff = route(request(handedOff: true)) { check(false, "a host that handed back doesn't loop") }

    let outside = root + "/outside"
    try! fileManager.createDirectory(atPath: outside, withIntermediateDirectories: true)
    makeExecutable(outside + "/evil")
    let escaping = root + "/Escaping.app"
    makeApp(escaping)
    try! fileManager.createSymbolicLink(atPath: escaping + "/Contents/MacOS/host", withDestinationPath: outside + "/evil")
    check(WebUIShellHost.hostExecutable(bundle: escaping, requiredIdentifier: nil) == nil, "an executable symlinked out of the bundle is refused")
    check(route(request(hostApp: escaping)) == .handOff(executable: sibling + "/Contents/MacOS/host"), "an escaping ARDIA_WEBUI_APP falls back")

    let linkedMacOS = root + "/LinkedMacOS.app"
    try! fileManager.createDirectory(atPath: linkedMacOS + "/Contents", withIntermediateDirectories: true)
    (["CFBundleExecutable": "evil"] as NSDictionary).write(toFile: linkedMacOS + "/Contents/Info.plist", atomically: true)
    try! fileManager.createSymbolicLink(atPath: linkedMacOS + "/Contents/MacOS", withDestinationPath: outside)
    check(WebUIShellHost.hostExecutable(bundle: linkedMacOS, requiredIdentifier: nil) == nil, "a Contents/MacOS symlinked out of the bundle is refused")

    let climbing = root + "/Climbing.app"
    makeApp(climbing, executable: "../../../outside/evil")
    check(WebUIShellHost.hostExecutable(bundle: climbing, requiredIdentifier: nil) == nil, "a CFBundleExecutable that climbs out is refused")

    let directoryHost = root + "/DirectoryHost.app"
    makeApp(directoryHost)
    try! fileManager.createDirectory(atPath: directoryHost + "/Contents/MacOS/host", withIntermediateDirectories: true)
    check(WebUIShellHost.hostExecutable(bundle: directoryHost, requiredIdentifier: nil) == nil, "a directory is not an executable")

    let plainFile = root + "/NotExecutable.app"
    makeApp(plainFile)
    fileManager.createFile(atPath: plainFile + "/Contents/MacOS/host", contents: Data(), attributes: [.posixPermissions: 0o644])
    check(WebUIShellHost.hostExecutable(bundle: plainFile, requiredIdentifier: nil) == nil, "a file without the execute bit is refused")

    let linkedBundle = root + "/LinkedHost.app"
    try! fileManager.createSymbolicLink(atPath: linkedBundle, withDestinationPath: named)
    check(WebUIShellHost.hostExecutable(bundle: linkedBundle, requiredIdentifier: nil) == named + "/Contents/MacOS/host", "a symlinked bundle resolves to its real executable")

    try! fileManager.removeItem(atPath: sibling)
    makeApp(sibling, identifier: "com.someone.else")
    makeExecutable(sibling + "/Contents/MacOS/host")
    if case .handOff = route(request()) { check(false, "a sibling with another bundle identifier is never run") }

    check(WebUIShellHost.handOffArguments(["--x"]) == ["--x", "--ardia-shell=webui"], "the host is told it runs as the WebUI shell")
    check(WebUIShellHost.handOffArguments(["--ARDIA-SHELL=webui"]) == ["--ARDIA-SHELL=webui"], "once")
    print("webui host: \(failures) failures")
    exit(failures == 0 ? 0 : 1)
  }
}
