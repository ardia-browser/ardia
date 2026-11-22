import XCTest

@testable import ArdiaPluginCore

final class PluginProgramRegistryTests: XCTestCase {
  let home = "/Users/someone"
  let signed: [String: Any] = [
    "version": 1, "claims": ["ardia": "cli"],
    "legacyInstalls": [["owner": "cli", "program": "ardia", "root": "Library/Application Support/Ardia/CLI", "current": "current"]],
  ]

  func testASignedRegistryReservesItsNamesWhateverIsListedOrOn() {
    let registry = resolve(info: signed)
    XCTAssertFalse(registry.failClosed)
    XCTAssertNil(registry.refusal(program: "ardia", plugin: "cli", builtIn: true))
    XCTAssertEqual(registry.refusal(program: "ardia", plugin: "cli", builtIn: false), "ardia belongs to Ardia's official cli plugin")
    XCTAssertEqual(registry.refusal(program: "ardia", plugin: "copycat", builtIn: true), "ardia belongs to Ardia's official cli plugin")
    XCTAssertNil(registry.refusal(program: "other", plugin: "copycat", builtIn: false))
    XCTAssertEqual(registry.adoption(for: "cli", programs: ["ardia"], builtIn: true)?.folder, "/Users/someone/Library/Application Support/Ardia/CLI")
    XCTAssertNil(registry.adoption(for: "cli", programs: ["ardia"], builtIn: false))
    XCTAssertNil(registry.adoption(for: "copycat", programs: ["ardia"], builtIn: true))
  }

  let pin = OfficialPin.parse([
    "version": 1,
    "plugins": [[
      "name": "cli", "version": "0.6.0", "release": "https://github.com/ardia-browser/plugins/releases/download/cli-v0.6.0", "reservedPrograms": ["ardia"],
      "legacyInstall": ["program": "ardia", "root": "Library/Application Support/Ardia/CLI", "current": "current"],
      "artifacts": ["macos-arm64": ["file": "cli-plugin-0.6.0-macos-arm64.tar.gz", "sha256": String(repeating: "a", count: 64)]],
    ]],
  ])!

  func testAMissingOrDamagedRegistryFailsClosed() {
    let missing = resolve(info: nil, pin: pin)
    XCTAssertTrue(missing.failClosed)
    XCTAssertNotNil(missing.refusal(program: "ardia", plugin: "cli", builtIn: true), "no signed list, so not even its owner links it")
    XCTAssertNotNil(missing.refusal(program: "anything-else", plugin: "mine", builtIn: false), "a distributed build without valid metadata links no program at all")
    XCTAssertNil(missing.adoption(for: "cli", programs: ["ardia"], builtIn: true))
    XCTAssertTrue(resolve(info: nil, usePin: false).failClosed, "a distributed build fails closed even with no official plugin installed or pinned")
    XCTAssertTrue(resolve(info: ["version": 1, "claims": "ardia"], pin: pin).failClosed)
    XCTAssertTrue(resolve(info: ["version": 1, "claims": ["ardia": "other"]], pin: pin).failClosed, "a signed list the pin disagrees with is inconsistent")
    XCTAssertTrue(resolve(info: signed, usePin: false).failClosed, "a signed list with no pin to agree with it fails closed")
    XCTAssertTrue(resolve(info: nil, pin: pin, isolated: true).failClosed, "a signed smoke instance isn't a test instance, so it gets no fixture")
    XCTAssertFalse(resolve(info: signed, pin: pin).failClosed)
  }

  func testLegacyEntriesNameOnlyKnownRootsAndOneComponent() {
    var entry = (signed["legacyInstalls"] as! [[String: Any]])[0]
    for (key, bad) in [("root", "/etc"), ("root", "Library/../../etc"), ("root", "Library/Application Support/Other"), ("current", "../x"), ("current", "a/b"), ("owner", "copycat")] {
      entry[key] = bad
      XCTAssertNil(ProgramRegistry.parse(["version": 1, "claims": ["ardia": "cli"], "legacyInstalls": [entry]], home: home), "\(key)=\(bad)")
      entry = (signed["legacyInstalls"] as! [[String: Any]])[0]
    }
  }

  func resolve(info: Any?, pin given: OfficialPin? = nil, usePin: Bool = true, fixture: Any? = nil, isolated: Bool = false, testInstance: Bool = false, scratch: String? = nil) -> ProgramRegistry {
    ProgramRegistry.resolve(info: info, pin: usePin ? (given ?? pin) : nil, fixture: fixture, home: home, isolated: isolated, testInstance: testInstance, scratchLegacyBase: scratch)
  }

  func testATestInstanceDerivesTheRegistryFromThePinAndAdoptsOnlyFromItsScratchHome() {
    let derived = resolve(info: nil, isolated: true, testInstance: true, scratch: "/tmp/old-home")
    XCTAssertFalse(derived.failClosed)
    XCTAssertEqual(derived.claims, ["ardia": "cli"])
    XCTAssertEqual(derived.adoption(for: "cli", programs: ["ardia"], builtIn: true)?.folder, "/tmp/old-home")
    let fixture = resolve(info: nil, fixture: signed, isolated: true, testInstance: true, scratch: nil)
    XCTAssertEqual(fixture.claims, ["ardia": "cli"])
    XCTAssertNil(fixture.adoption(for: "cli", programs: ["ardia"], builtIn: true), "no scratch cliHome, no adoption")
    XCTAssertTrue(resolve(info: nil, fixture: ["version": 1, "claims": ["ardia": "other"]], isolated: true, testInstance: true).failClosed, "a fixture that disagrees with the pin is refused")
    XCTAssertEqual(resolve(info: nil, usePin: false, isolated: true, testInstance: true), .empty, "a dev build with no pin has nothing to reserve")
  }

  func testASignedScratchInstanceKeepsTheClaimsButNeverTouchesTheRealHome() {
    let smoke = resolve(info: signed, isolated: true, scratch: nil)
    XCTAssertEqual(smoke.claims, ["ardia": "cli"])
    XCTAssertTrue(smoke.legacy.isEmpty, "no scratch cliHome, so the owner's real old install is left alone")
    let scratch = resolve(info: signed, isolated: true, scratch: "/tmp/scratch-cli")
    XCTAssertEqual(scratch.adoption(for: "cli", programs: ["ardia"], builtIn: true)?.folder, "/tmp/scratch-cli", "adoption happens only in the scratch home")
    XCTAssertEqual(resolve(info: signed).adoption(for: "cli", programs: ["ardia"], builtIn: true)?.folder, "/Users/someone/Library/Application Support/Ardia/CLI")
  }

  func testClaimsAreReadFromV1AndV2Manifests() {
    XCTAssertEqual(ProgramRegistry.claimedPrograms(manifest: Data(#"{"manifest":2,"contributes":{"programs":[{"name":"ardia","path":"bin/ardia","claim":true},{"name":"x","path":"bin/x"}]}}"#.utf8)), ["ardia"])
    XCTAssertEqual(ProgramRegistry.claimedPrograms(manifest: Data(#"{"programs":[{"name":"ardia","path":"bin/ardia"}]}"#.utf8)), [])
  }

  func testLegacyDetectionWalksWithoutFollowingLinks() throws {
    let made = FileManager.default.temporaryDirectory.appendingPathComponent("registry-\(UUID().uuidString)", isDirectory: true)
    try FileManager.default.createDirectory(at: made, withIntermediateDirectories: true)
    let root = PluginSandbox.resolved(made.path)!
    defer { try? FileManager.default.removeItem(atPath: root) }
    let entry = LegacyInstall(owner: "cli", program: "ardia", base: root, relative: "Library/Application Support/Ardia/CLI", current: "current")
    try FileManager.default.createDirectory(atPath: "\(entry.folder)/0.2.41/bin", withIntermediateDirectories: true)
    XCTAssertFalse(PluginPrograms.legacyInstalled(entry), "no current link yet")
    XCTAssertEqual(symlink("0.2.41", "\(entry.folder)/current"), 0)
    XCTAssertFalse(PluginPrograms.legacyInstalled(entry), "no launcher yet")
    try "#!/bin/sh\n".write(toFile: "\(entry.folder)/0.2.41/bin/ardia", atomically: true, encoding: .utf8)
    XCTAssertTrue(PluginPrograms.legacyInstalled(entry))
    unlink("\(entry.folder)/current")
    XCTAssertEqual(symlink("/etc", "\(entry.folder)/current"), 0)
    XCTAssertFalse(PluginPrograms.legacyInstalled(entry), "a current pointing outside the home isn't a legacy install")
    unlink("\(entry.folder)/current")
    XCTAssertEqual(symlink("0.2.41", "\(entry.folder)/current"), 0)
    try FileManager.default.moveItem(atPath: "\(root)/Library/Application Support/Ardia", toPath: "\(root)/elsewhere")
    XCTAssertEqual(symlink("\(root)/elsewhere", "\(root)/Library/Application Support/Ardia"), 0)
    XCTAssertFalse(PluginPrograms.legacyInstalled(entry), "a symlinked folder on the way in isn't followed")
  }
}
