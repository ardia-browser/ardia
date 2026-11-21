import XCTest

@testable import ArdiaPluginCore

final class PluginSandboxTests: XCTestCase {
  var root = ""
  var home = ""
  var data = ""
  var config = ""
  var plugin = ""
  var pluginData = ""

  override func setUpWithError() throws {
    let made = FileManager.default.temporaryDirectory.appendingPathComponent("plugin-sandbox-\(UUID().uuidString)", isDirectory: true)
    try FileManager.default.createDirectory(at: made, withIntermediateDirectories: true)
    root = PluginSandbox.resolved(made.path)!
    home = "\(root)/home"
    data = "\(root)/data"
    config = "\(data)/config"
    plugin = "\(config)/plugins/example"
    pluginData = "\(data)/PluginData/example"
    for folder in [home, plugin, "\(pluginData)/home", "\(pluginData)/tmp"] {
      try FileManager.default.createDirectory(atPath: folder, withIntermediateDirectories: true)
    }
    try "secret".write(toFile: "\(home)/notes.txt", atomically: true, encoding: .utf8)
    try "{}".write(toFile: "\(data)/plugins.json", atomically: true, encoding: .utf8)
    try "{}".write(toFile: "\(config)/config.json", atomically: true, encoding: .utf8)
    try "{\"name\": \"example\"}".write(toFile: "\(plugin)/plugin.json", atomically: true, encoding: .utf8)
  }

  override func tearDownWithError() throws {
    try? FileManager.default.removeItem(atPath: root)
  }

  func sandbox(plugin: String? = nil, program: String = "/bin/sh", network: Bool = false) -> PluginSandbox {
    PluginSandbox(home: home, appData: data, configFolder: config, pluginFolder: plugin ?? self.plugin, pluginData: pluginData, program: program, network: network)
  }

  func refusal(_ box: PluginSandbox) -> String? {
    do {
      try box.checked()
      return nil
    } catch PluginSandbox.Refusal.unsafe(let why) {
      return why
    } catch {
      return "\(error)"
    }
  }

  func testAScratchInstancesPluginFolderInsideItsDataFolderIsAllowed() {
    XCTAssertNil(refusal(sandbox()))
  }

  func testFoldersThatTakeInArdiasDataOrConfigAreRefused() {
    XCTAssertNotNil(refusal(sandbox(plugin: data)))
    XCTAssertNotNil(refusal(sandbox(plugin: config)))
    XCTAssertNotNil(refusal(sandbox(plugin: "\(config)/plugins")))
    XCTAssertNotNil(refusal(sandbox(plugin: "\(data)/Chromium")))
    XCTAssertNotNil(refusal(sandbox(plugin: root)))
    XCTAssertNotNil(refusal(sandbox(plugin: "/")))
  }

  func testAProgramInArdiasDataIsRefusedUnlessItIsThePluginsOwn() {
    XCTAssertNotNil(refusal(sandbox(program: "\(data)/Chromium/Default/Cookies")))
    XCTAssertNil(refusal(sandbox(program: "\(plugin)/helper")))
  }

  func testAnInstallFolderNeverWidensToRootOrHome() {
    XCTAssertEqual(sandbox(program: "/bin/sh").installFolder(), "/bin/sh")
    XCTAssertEqual(sandbox(program: "\(home)/bin/tool").installFolder(), "\(home)/bin/tool")
    XCTAssertEqual(sandbox(program: "/opt/homebrew/opt/node/bin/node").installFolder(), "/opt/homebrew/opt/node")
  }

  func testPathsGoInAsParametersNeverIntoTheProfile() throws {
    let quoted = "\(root)/we\"ird"
    try FileManager.default.createDirectory(atPath: "\(config)/plugins/x", withIntermediateDirectories: true)
    let arguments = try sandbox(program: "\(quoted)/bin/tool").arguments()
    XCTAssertEqual(arguments[0], "-p")
    XCTAssertFalse(arguments[1].contains(root))
    XCTAssertTrue(arguments.contains("PROGRAM=\(quoted)/bin/tool"))
  }

  func run(_ box: PluginSandbox, _ script: String) throws -> Int32 {
    let process = Process()
    process.executableURL = URL(fileURLWithPath: "/usr/bin/sandbox-exec")
    process.arguments = try box.arguments() + ["/bin/sh", "-c", script]
    process.standardError = FileHandle.nullDevice
    process.standardOutput = FileHandle.nullDevice
    try process.run()
    process.waitUntilExit()
    return process.terminationStatus
  }

  func testTheProfileHoldsOnAScratchInstance() throws {
    let box = sandbox()
    XCTAssertEqual(try run(box, "cat '\(plugin)/plugin.json'"), 0, "reads its own folder")
    XCTAssertEqual(try run(box, "echo hi > '\(pluginData)/home/x'"), 0, "writes its data folder")
    XCTAssertNotEqual(try run(box, "cat '\(data)/plugins.json'"), 0, "Ardia's data stays unreadable")
    XCTAssertNotEqual(try run(box, "cat '\(config)/config.json'"), 0, "Ardia's config stays unreadable")
    XCTAssertNotEqual(try run(box, "cat '\(home)/notes.txt'"), 0, "home stays unreadable")
    XCTAssertNotEqual(try run(box, "echo hi > '\(plugin)/written'"), 0, "its own folder is read-only")
    XCTAssertNotEqual(try run(box, "echo hi > '\(root)/escape'"), 0, "nothing else is writable")
  }
}
