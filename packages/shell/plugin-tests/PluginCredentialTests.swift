import Darwin
import Foundation
import Testing

@testable import ArdiaPluginCore

@Suite("Credential providers in the official pin")
struct PluginCredentialPinTests {
  static func pin(_ plugins: [[String: Any]]) -> OfficialPin? {
    OfficialPin.parse(["version": 1, "plugins": plugins])
  }

  static func plugin(_ name: String, title: String? = nil, providers: [String]? = nil, programs: [String]? = nil, artifact: Bool = true) -> [String: Any] {
    var entry: [String: Any] = ["name": name, "version": "1.0.0", "release": "https://example.invalid/\(name)"]
    if let title { entry["title"] = title }
    if artifact { entry["artifacts"] = ["macos-arm64": ["file": "\(name).tar.gz", "sha256": String(repeating: "b", count: 64)]] }
    if let providers { entry["reservedProviders"] = providers }
    if let programs { entry["credentialPrograms"] = programs }
    return entry
  }

  @Test func `an official plugin runs its password manager only with the program the pin lists for it`() throws {
    let pin = try #require(Self.pin([Self.plugin("bitwarden", providers: ["bitwarden"], programs: ["bw"])]))
    #expect(pin.credentialRefusal(name: "bitwarden", official: true, program: "bw") == nil)
    #expect(pin.credentialRefusal(name: "bitwarden", official: true, program: "op") == "op isn't a program this plugin may run.")
  }

  @Test func `a plugin that isn't official can't take a reserved name, whatever it declares`() throws {
    let pin = try #require(Self.pin([Self.plugin("bitwarden", title: "Bitwarden", providers: ["bitwarden"], programs: ["bw"])]))
    #expect(pin.credentialRefusal(name: "bitwarden", official: false, program: nil) == "bitwarden is kept for Ardia's official Bitwarden plugin.")
    #expect(pin.credentialRefusal(name: "bitwarden", official: false, program: "bw") == "bitwarden is kept for Ardia's official Bitwarden plugin.")
    #expect(pin.providerTitles == ["bitwarden": "Bitwarden"])
  }

  @Test func `a plugin that isn't official can't be a password manager under any name`() throws {
    let pin = try #require(Self.pin([Self.plugin("bitwarden", providers: ["bitwarden"], programs: ["bw"])]))
    #expect(pin.credentialRefusal(name: "my-vault", official: false, program: "bw") == "Ardia runs password managers only from its official plugins.")
    #expect(pin.credentialRefusal(name: "my-vault", official: false, program: nil) == nil)
  }

  @Test func `an official plugin the pin doesn't reserve as a provider can't be one`() throws {
    let pin = try #require(Self.pin([Self.plugin("cli")]))
    #expect(pin.credentialRefusal(name: "cli", official: true, program: "bw") == "Ardia runs password managers only from its official plugins.")
  }

  @Test func `a reserved name holds even on a platform with no artifact for it`() throws {
    let pin = try #require(Self.pin([Self.plugin("protonpass", title: "Proton Pass", providers: ["protonpass"], programs: ["pass-cli"], artifact: false)]))
    #expect(pin.entry("protonpass") == nil)
    #expect(pin.credentialRefusal(name: "protonpass", official: false, program: nil) == "protonpass is kept for Ardia's official Proton Pass plugin.")
    #expect(Self.pin([Self.plugin("vault", providers: ["vault"])])?.credentialRefusal(name: "vault", official: false, program: nil) == "vault is kept for Ardia's official vault plugin.")
  }

  @Test func `a pin entry carries the catalogue words and look the Add Password Manager list shows`() throws {
    var entry = Self.plugin("bitwarden", title: "Bitwarden", providers: ["bitwarden"], programs: ["bw"])
    entry["blurb"] = "Logins from your Bitwarden vault."
    entry["symbol"] = "shield.lefthalf.filled"
    entry["accent"] = "#175DDC"
    var damaged = Self.plugin("onepassword", title: "1Password\n", programs: ["op"])
    damaged["accent"] = "blue"
    let pin = try #require(Self.pin([entry, damaged]))
    let bitwarden = try #require(pin.entry("bitwarden"))
    #expect([bitwarden.title, bitwarden.blurb, bitwarden.symbol, bitwarden.accent] == ["Bitwarden", "Logins from your Bitwarden vault.", "shield.lefthalf.filled", "#175DDC"])
    let other = try #require(pin.entry("onepassword"))
    #expect([other.title, other.accent] == ["", ""])
  }

  @Test func `removing a reserved password manager wipes its data even after it was turned off`() throws {
    let pin = try #require(Self.pin([Self.plugin("bitwarden", title: "Bitwarden", providers: ["bitwarden"], programs: ["bw"]), Self.plugin("cli")]))
    #expect(OfficialPin.forgetsOnRemove("bitwarden", known: false, pin: pin))
    #expect(!OfficialPin.forgetsOnRemove("cli", known: false, pin: pin))
    #expect(OfficialPin.forgetsOnRemove("cli", known: true, pin: nil))
  }

  @Test func `two official plugins can't reserve the same provider name`() {
    #expect(Self.pin([Self.plugin("a", providers: ["vault"]), Self.plugin("b", providers: ["vault"])]) == nil)
    #expect(Self.pin([Self.plugin("a", providers: ["Not A Name"])]) == nil)
    #expect(Self.pin([Self.plugin("a", programs: ["bw", "op", "node", "pass-cli", "extra"])]) == nil)
  }
}

@Suite("Programs password managers run")
struct PluginPasswordManagerProgramTests {
  @Test("No plugin, official or not, puts a password manager's program on PATH", arguments: ["op", "bw", "pass-cli", "node"])
  func claimed(_ program: String) {
    let registry = ProgramRegistry(claims: [program: "cli"], legacy: [], failClosed: false)
    #expect(registry.refusal(program: program, plugin: "cli", builtIn: true) == "\(program) belongs to Ardia's password managers, so no plugin puts it on PATH")
    #expect(ProgramRegistry.empty.refusal(program: program, plugin: "anything", builtIn: false) != nil)
  }

  @Test func `other programs keep their own rules`() {
    #expect(ProgramRegistry.empty.refusal(program: "ardia", plugin: "cli", builtIn: true) == nil)
  }
}

@Suite("Credential lines from plugins that aren't password managers")
struct PluginCredentialGateTests {
  @Test("A credentials request from any other plugin is answered natively with a refusal", arguments: [
    #"{"id":3,"method":"credentials.verb","params":{"call":"v1","verb":"status"}}"#,
    #"{"id":"x","method":"credentials.session.takeStored","params":{"call":"v1"}}"#,
    #"{"id": 9, "method": "credentials"}"#,
    #"{"id":10,"method":"\u0063redentials.verb","params":{"call":"v1"}}"#,
  ])
  func refused(_ line: String) throws {
    guard case .reply(let reply) = PluginCredentialGate.screen(line) else {
      Issue.record("\(line) wasn't refused")
      return
    }
    let object = try #require(try JSONSerialization.jsonObject(with: Data(reply.utf8)) as? [String: Any])
    #expect((object["error"] as? [String: Any])?["code"] as? String == "refused")
    #expect(object["id"] != nil)
  }

  @Test func `a result for a call id only native mints is dropped, never forwarded`() {
    #expect(PluginCredentialGate.screen(#"{"id":4,"method":"result","params":{"call":"v12","result":{"password":"x"}}}"#) == .drop)
    #expect(PluginCredentialGate.screen(#"{"id":4,"method":"result","params":{"\u0063all":"v12","result":{"password":"x"}}}"#) == .drop)
  }

  @Test("Ordinary lines pass on to the app", arguments: [
    #"{"id":1,"method":"hello","params":{}}"#, #"{"id":2,"method":"result","params":{"call":"c4","result":1}}"#, #"{"id":5,"method":"storage.get","params":{"key":"credentials"}}"#,
    "not json at all",
  ])
  func forwarded(_ line: String) {
    #expect(PluginCredentialGate.screen(line) == .forward)
  }

  @Test func `a credentials request without an id is dropped instead of reaching the app`() {
    #expect(PluginCredentialGate.screen(#"{"method":"credentials.verb","params":{}}"#) == .drop)
  }
}

@Suite("The redacting sink a password manager's output goes to")
struct PluginRedactingSinkTests {
  @Test func `lines are redacted, capped and kept only in memory`() {
    let sink = PluginRedactingSink(fd: -1, queue: .main) { $0.replacingOccurrences(of: "hunter2", with: "[hidden]") }
    sink.take(Data("password hunter2 leaked\nsecond".utf8))
    sink.take(Data(" half\n".utf8))
    sink.take(Data(String(repeating: "x", count: PluginRedactingSink.longestLine + 10).utf8))
    #expect(sink.recent.prefix(2) == ["password [hidden] leaked", "second half"])
    #expect(sink.recent.last?.utf8.count == PluginRedactingSink.longestLine)
  }

  @Test func `it keeps only the most recent lines`() {
    let sink = PluginRedactingSink(fd: -1, queue: .main) { $0 }
    for index in 0..<(PluginRedactingSink.keptLines + 50) { sink.take(Data("line \(index)\n".utf8)) }
    #expect(sink.recent.count == PluginRedactingSink.keptLines)
    #expect(sink.recent.first == "line 50")
    #expect(sink.seenLines == PluginRedactingSink.keptLines + 50)
  }

  @Test func `it reads what a process writes to its pipe`() async throws {
    var ends: [Int32] = [-1, -1]
    #expect(pipe(&ends) == 0)
    let queue = DispatchQueue(label: "sink-test")
    let sink = PluginRedactingSink(fd: ends[0], queue: queue) { $0.uppercased() }
    sink.open()
    let text = "from the plugin\n"
    _ = text.withCString { write(ends[1], $0, strlen($0)) }
    close(ends[1])
    let deadline = Date().addingTimeInterval(5)
    while Date() < deadline, queue.sync(execute: { sink.recent.isEmpty }) { try await Task.sleep(for: .milliseconds(10)) }
    #expect(queue.sync { sink.recent } == ["FROM THE PLUGIN"])
  }
}

@Suite("How a plugin's exit is reported")
struct PluginExitReportTests {
  @Test func `a run the host ended, as a lock ends a password manager's run, is reported as requested and no crash`() {
    let killed = PluginExitReport.payload(name: "bitwarden", run: 3, status: nil, signal: SIGKILL, overMemory: false, stopRequested: true)
    #expect(killed["requested"] as? Bool == true)
    #expect(killed["signal"] as? Int == Int(SIGKILL))
    #expect(!PluginExitReport.crashed(stopRequested: true, overMemory: false))
  }

  @Test func `a run that died on its own or went over its memory is a crash`() {
    #expect(PluginExitReport.payload(name: "bitwarden", run: 3, status: 1, signal: nil, overMemory: false, stopRequested: false)["requested"] as? Bool == false)
    #expect(PluginExitReport.crashed(stopRequested: true, overMemory: true))
    #expect(PluginExitReport.crashed(stopRequested: false, overMemory: false))
  }
}

@Suite("What a password manager's run may keep waiting to send")
struct PluginPendingBudgetTests {
  @Test func `a batch past the budget is refused whole, and sent lines free their room`() {
    var budget = PluginPendingBudget(limit: 100)
    let first = budget.admit(60)
    let over = budget.admit(41)
    #expect(first && !over && budget.bytes == 60)
    budget.release(30)
    let after = budget.admit(70)
    #expect(after && budget.bytes == 100)
  }
}
