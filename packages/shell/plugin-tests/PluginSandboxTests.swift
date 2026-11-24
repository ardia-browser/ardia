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

  func sandbox(plugin: String? = nil, program: String = "/bin/sh", network: Bool = false, officialCopy: String? = nil) -> PluginSandbox {
    PluginSandbox(
      home: home, appData: data, configFolder: config, pluginFolder: plugin ?? self.plugin, pluginData: pluginData, program: program, network: network,
      officialCopy: officialCopy)
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

  func testAnOfficialCopyInTheStoreIsAPluginFolderAndNothingAroundItIs() throws {
    let copy = "\(data)/OfficialPlugins/example/\(String(repeating: "a", count: 64))"
    XCTAssertNil(refusal(sandbox(plugin: copy, officialCopy: copy)), "the verified copy starts")
    XCTAssertNotNil(refusal(sandbox(plugin: copy)), "the same folder reached any other way, a linked local plugin say, doesn't")
    XCTAssertNotNil(refusal(sandbox(plugin: copy, officialCopy: "\(data)/OfficialPlugins/example/\(String(repeating: "c", count: 64))")), "nor when another copy is the verified one")
    XCTAssertNotNil(refusal(sandbox(plugin: "\(data)/OfficialPlugins", officialCopy: "\(data)/OfficialPlugins")))
    XCTAssertNotNil(refusal(sandbox(plugin: "\(data)/OfficialPlugins/example", officialCopy: "\(data)/OfficialPlugins/example")))
    XCTAssertNotNil(refusal(sandbox(plugin: "\(copy)/bin", officialCopy: "\(copy)/bin")))
    XCTAssertNotNil(refusal(sandbox(plugin: "\(data)/OfficialPluginsX/example/copy", officialCopy: "\(data)/OfficialPluginsX/example/copy")))
    try FileManager.default.createDirectory(atPath: copy, withIntermediateDirectories: true)
    try "{}".write(toFile: "\(copy)/plugin.json", atomically: true, encoding: .utf8)
    let other = "\(data)/OfficialPlugins/other/\(String(repeating: "b", count: 64))"
    try FileManager.default.createDirectory(atPath: other, withIntermediateDirectories: true)
    try "secret".write(toFile: "\(other)/plugin.json", atomically: true, encoding: .utf8)
    let box = sandbox(plugin: copy, officialCopy: copy)
    XCTAssertEqual(try run(box, "cat '\(copy)/plugin.json'"), 0, "it reads its own copy")
    XCTAssertNotEqual(try run(box, "cat '\(other)/plugin.json'"), 0, "not another official plugin's")
    XCTAssertNotEqual(try run(box, "ls '\(data)/OfficialPlugins'"), 0, "nor list the store")
    XCTAssertNotEqual(try run(box, "echo x > '\(copy)/written'"), 0, "and its copy stays read-only")
  }

  func testAProgramInArdiasDataIsRefusedUnlessItIsThePluginsOwn() {
    XCTAssertNotNil(refusal(sandbox(program: "\(data)/Chromium/Default/Cookies")))
    XCTAssertNil(refusal(sandbox(program: "\(plugin)/helper")))
  }

  func testAnInstallFolderNeverWidensToRootOrHome() {
    XCTAssertEqual(sandbox(program: "/bin/sh").installFolder(), "/bin/sh")
    XCTAssertEqual(sandbox(program: "\(home)/bin/tool").installFolder(), "\(home)/bin/tool")
    XCTAssertEqual(sandbox(program: "/opt/homebrew/opt/node/bin/node").installFolder(), "/opt/homebrew/opt/node")
    for direct in ["/opt/homebrew/bin/brew", "/usr/local/bin/tool", "/usr/bin/python3", "/opt/bin/tool"] {
      XCTAssertEqual(sandbox(program: direct).installFolder(), direct, "a program straight in a prefix's bin doesn't take the whole prefix")
    }
    XCTAssertEqual(sandbox(program: "/opt/homebrew/opt/node/bin/node").installFolder(), "/opt/homebrew/opt/node", "a package's own folder still does")
    XCTAssertEqual(sandbox(program: "/private/tmp/shared/bin/tool").installFolder(), "/private/tmp/shared/bin/tool", "a shared temp folder isn't granted for the program in it")
    XCTAssertEqual(sandbox(program: "/private/var/folders/x/T/tool").installFolder(), "/private/var/folders/x/T/tool")
    XCTAssertEqual(sandbox(program: "\(plugin)/bin/tool").installFolder(), "\(plugin)/bin/tool", "its own folder is read through PLUGIN, not INSTALL")
  }

  func testPathsGoInAsParametersNeverIntoTheProfile() throws {
    let quoted = "\(root)/we\"ird"
    try FileManager.default.createDirectory(atPath: "\(config)/plugins/x", withIntermediateDirectories: true)
    let arguments = try sandbox(program: "\(quoted)/bin/tool").arguments()
    XCTAssertEqual(arguments[0], "-p")
    XCTAssertFalse(arguments[1].contains(root))
    XCTAssertTrue(arguments.contains("PROGRAM=\(quoted)/bin/tool"))
  }

  func testTheProfileStartsFromDenyAndOnlyProgramsMayStartOthers() throws {
    let program = try sandbox().arguments()[1]
    let script = try PluginSandbox(home: home, appData: data, configFolder: config, pluginFolder: plugin, pluginData: pluginData, program: "/bin/sh", network: true, kind: .script).arguments()[1]
    for profile in [program, script] {
      XCTAssertTrue(profile.contains("(deny default)"))
      XCTAssertFalse(profile.contains("(allow default)"))
    }
    XCTAssertTrue(program.contains("(allow process-fork)"))
    XCTAssertFalse(script.contains("process-fork"))
    XCTAssertFalse(script.contains("/opt/homebrew"))
    XCTAssertFalse(script.contains("DEVELOPER"))
    XCTAssertFalse(program.contains("(subpath \"/usr/local\")") || program.contains("(subpath \"/opt/homebrew\")"), "package prefixes are granted folder by folder")
    XCTAssertTrue(program.contains("(subpath \"/opt/homebrew/Cellar\")"))
    XCTAssertEqual(PluginSandbox(home: home, appData: data, configFolder: config, pluginFolder: plugin, pluginData: pluginData, program: "/opt/homebrew/opt/node/bin/node", network: false, kind: .script).installFolder(), "/opt/homebrew/opt/node/bin/node")
  }

  func testTheDeveloperFolderIsTheSelectedXcodeOrNothingUnderTheUsersFolders() throws {
    let xcode = "\(root)/Xcode.app/Contents/Developer"
    try FileManager.default.createDirectory(atPath: xcode, withIntermediateDirectories: true)
    try FileManager.default.createSymbolicLink(atPath: "\(root)/xcode-link", withDestinationPath: xcode)
    XCTAssertEqual(PluginSandbox.developerFolder(link: "\(root)/xcode-link"), "\(root)/Xcode.app")
    try FileManager.default.createSymbolicLink(atPath: "\(root)/tools-link", withDestinationPath: "\(root)")
    XCTAssertEqual(PluginSandbox.developerFolder(link: "\(root)/tools-link"), root)
    XCTAssertNil(PluginSandbox.developerFolder(link: "\(root)/missing"))
    try FileManager.default.createSymbolicLink(atPath: "\(root)/root-link", withDestinationPath: "/")
    XCTAssertNil(PluginSandbox.developerFolder(link: "\(root)/root-link"))
    try FileManager.default.createSymbolicLink(atPath: "\(root)/users-link", withDestinationPath: "/Users")
    XCTAssertNil(PluginSandbox.developerFolder(link: "\(root)/users-link"))
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
