import Foundation
import Testing
import os

struct OriginTierRow: Sendable, CustomTestStringConvertible {
  let origin: String
  let saved: String
  let tier: String
  let mode: String?

  var testDescription: String { "\(saved) (\(mode ?? "domain")) on \(origin) is \(tier)" }

  static let tiers: [String: VaultMatchTier] = [
    "none": .none, "sibling": .sibling, "subdomain": .subdomain, "www": .www, "sameHost": .sameHost, "exact": .exact,
  ]

  static func shared() throws -> [OriginTierRow] {
    let url = URL(fileURLWithPath: #filePath).deletingLastPathComponent().appendingPathComponent("fixtures/vault-origin-tiers.json")
    let rows = try JSONDecoder().decode([[String]].self, from: Data(contentsOf: url))
    return rows.filter { $0.count >= 3 }.map { OriginTierRow(origin: $0[0], saved: $0[1], tier: $0[2], mode: $0.count > 3 ? $0[3] : nil) }
  }
}

@Suite("Origin matching")
struct VaultOriginMatchTests {
  @Test("A saved address matches a page at the shared table's tier", arguments: try OriginTierRow.shared())
  func sharedTier(row: OriginTierRow) throws {
    let wanted = try #require(OriginTierRow.tiers[row.tier])
    #expect(VaultOriginMatch.tier([row.saved], modes: row.mode.map { [$0] }, origin: row.origin) == wanted)
  }

  @Test func `the shared tier table has its cases`() throws {
    #expect(try OriginTierRow.shared().count > 60)
  }

  @Test("A saved port out of range never matches", arguments: ["https://bank.example:99999999999999999999", "https://bank.example:65536/login"])
  func portOutOfRange(saved: String) {
    #expect(VaultOriginMatch.tier(saved, origin: "https://bank.example") == .none)
  }

  @Test func `a sibling never fills without a choice`() {
    #expect(VaultOriginMatch.matches(["https://login.example.com"], origin: "https://app.example.com") == false)
  }

  @Test func `a choice never fills an insecure page`() {
    #expect(VaultOriginMatch.isSecure("http://example.com") == false)
  }

  @Test("Registrable domains follow the public suffix rules", arguments: [
    ("x.a.github.io", "a.github.io"),
    ("co.uk", ""),
    ("www.city.kawasaki.jp", "city.kawasaki.jp"),
    ("github.io", ""),
  ])
  func registrableDomain(host: String, site: String) {
    #expect(VaultOriginMatch.registrableDomain(host) == site)
  }

  @Test func `punycode encodes like the JS side`() {
    #expect(VaultPunycode.encode("bücher") == "bcher-kva")
  }
}

@Suite("Lane ordering")
struct VaultLaneTests {
  actor Order {
    var names: [String] = []
    func add(_ name: String) { names.append(name) }
  }

  actor Gate {
    private var open = false
    private var waiters: [CheckedContinuation<Void, Never>] = []
    private var arrivals = 0
    private var arrivalWaiters: [CheckedContinuation<Void, Never>] = []

    func wait() async {
      arrivals += 1
      arrivalWaiters.forEach { $0.resume() }
      arrivalWaiters = []
      guard !open else { return }
      await withCheckedContinuation { waiters.append($0) }
    }

    func reached() async {
      guard arrivals == 0 else { return }
      await withCheckedContinuation { arrivalWaiters.append($0) }
    }

    func release() {
      open = true
      waiters.forEach { $0.resume() }
      waiters = []
    }
  }

  static func queued(_ lane: VaultLane, _ count: Int) async {
    while await lane.waitingCount < count { await Task.yield() }
  }

  @Test func `a lock goes ahead of a fill, and a fill ahead of background work`() async {
    let lane = VaultLane()
    let order = Order()
    let gate = Gate()
    let holder = Task { await lane.run { await gate.wait(); await order.add("first") } }
    await gate.reached()
    let behind = Task { await lane.runBehindOthers { await order.add("background") } }
    await Self.queued(lane, 1)
    let fill = Task { await lane.run { await order.add("fill") } }
    await Self.queued(lane, 2)
    let lock = Task { await lane.runFirst { await order.add("lock") } }
    await Self.queued(lane, 3)
    await gate.release()
    _ = await (holder.value, behind.value, fill.value, lock.value)
    #expect(await order.names == ["first", "lock", "fill", "background"])
  }

  @Test func `background work on an idle lane runs at once`() async {
    let ran = await VaultLane().runBehindOthers { 7 }
    #expect(ran == 7)
  }

  @Test func `interrupting a lane cancels the work holding it and frees the lane`() async {
    let busy = VaultLane()
    let stuck = Gate()
    let running = Task {
      await busy.run { () -> Bool in
        await stuck.wait()
        return Task.isCancelled
      }
    }
    await stuck.reached()
    busy.interrupt()
    await stuck.release()
    #expect(await running.value)
    let after = await busy.run { "free" }
    #expect(after == "free")
  }

  @Test func `cancelling the caller cancels its lane work`() async {
    let parent = VaultLane()
    let blocked = Gate()
    let cancelled = Task {
      await parent.run { () -> Bool in
        await blocked.wait()
        return Task.isCancelled
      }
    }
    await blocked.reached()
    cancelled.cancel()
    await blocked.release()
    #expect(await cancelled.value)
  }
}

@Suite("Lock epochs")
struct VaultLockEpochTests {
  let epochs = VaultLockEpochs()
  let sessions = OSAllocatedUnfairLock(initialState: [String: String]())

  var remember: @Sendable (VaultLockEpoch.Ticket) -> Bool {
    { [epochs, sessions] ticket in epochs.ifCurrent(ticket) { sessions.withLock { $0[ticket.provider] = "session" } } }
  }

  var lockAll: @Sendable () -> Void {
    { [epochs, sessions] in epochs.advanceAll { sessions.withLock { $0.removeAll() } } }
  }

  var nothingRemembered: Bool { sessions.withLock { $0.isEmpty } }

  @Test func `an unlock that finishes during Lock All can't settle, and Lock All forgets it`() {
    let unlocking = epochs.ticket("bitwarden")
    #expect(remember(unlocking))
    lockAll()
    #expect(epochs.isCurrent(unlocking) == false)
    #expect(nothingRemembered)
  }

  @Test func `a session the tool hands back after Lock All is dropped`() {
    let late = epochs.ticket("bitwarden")
    lockAll()
    #expect(remember(late) == false)
    #expect(nothingRemembered)
  }

  @Test func `an unlock that starts after the lock works`() {
    lockAll()
    let fresh = epochs.ticket("bitwarden")
    #expect(remember(fresh))
    #expect(epochs.isCurrent(fresh))
  }

  @Test func `locking one manager drops only its own in-flight unlock`() {
    let bitwarden = epochs.ticket("bitwarden")
    let proton = epochs.ticket("protonpass")
    epochs.advance("bitwarden")
    #expect(epochs.isCurrent(bitwarden) == false)
    #expect(epochs.isCurrent(proton))
  }

  @Test func `a remember racing Lock All never survives it`() {
    let remember = remember
    let lockAll = lockAll
    var survivors = 0
    for _ in 0..<200 {
      let racing = epochs.ticket("bitwarden")
      DispatchQueue.concurrentPerform(iterations: 8) { lane in
        if lane == 0 {
          usleep(20)
          lockAll()
        } else {
          _ = remember(racing)
        }
      }
      if nothingRemembered == false {
        survivors += 1
        sessions.withLock { $0.removeAll() }
      }
    }
    #expect(survivors == 0)
  }
}

@Suite("Cloud account")
struct VaultCloudAccountTests {
  struct Case: Sendable, CustomTestStringConvertible {
    let state: VaultState
    let account: String?
    let server: String?
    let saved: String?
    let accepted: String?
    let testDescription: String
  }

  @Test("The cloud copy is adopted only for a known account", arguments: [
    Case(state: .locked, account: nil, server: nil, saved: nil, accepted: nil,
         testDescription: "with no account known, the cloud copy is never adopted"),
    Case(state: .locked, account: "", server: "vault.example", saved: "@vault.example", accepted: nil,
         testDescription: "a saved snapshot without an account doesn't count as knowing it"),
    Case(state: .unlocked, account: "me@example.com", server: nil, saved: "other@example.com@", accepted: "me@example.com@",
         testDescription: "the live account wins over the saved one"),
    Case(state: .locked, account: nil, server: nil, saved: "me@example.com@", accepted: "me@example.com@",
         testDescription: "a locked manager falls back to the account its snapshot was saved for"),
    Case(state: .signedOut, account: "me@example.com", server: nil, saved: "me@example.com@", accepted: nil,
         testDescription: "a signed-out manager takes nothing from the cloud"),
  ])
  func accepted(row: Case) {
    #expect(VaultCloudAccount.accepted(state: row.state, account: row.account, server: row.server, saved: row.saved) == row.accepted)
  }
}

@Suite("Commands and scale", .serialized)
struct VaultCommandRunTests {
  let environment = ["PATH": "/usr/bin:/bin"]

  static let killedWithin: Duration = .seconds(20)

  static func elapsed(_ start: ContinuousClock.Instant) -> Duration { ContinuousClock.now - start }

  @Test func `the site index hands a page a small slice and finds what a full scan finds`() {
    var urls: [String] = []
    for site in 0..<3000 {
      let base = "site\(site)\(site % 7 == 0 ? ".co.uk" : ".com")"
      urls.append("https://\(base)/login")
      for sub in 0..<(site % 5 == 0 ? 12 : 2) { urls.append("https://s\(sub).\(base)") }
    }
    while urls.count < 10_000 { urls.append("https://extra\(urls.count).example.org") }
    _ = urls.map { VaultOriginMatch.tier($0, origin: "https://s1.site15.com") }
    let built = ContinuousClock.now
    let index = VaultSiteIndex(urls.map { [$0] })
    let buildTime = Self.elapsed(built)
    let start = ContinuousClock.now
    let rounds = 200
    var found = 0
    for round in 0..<rounds {
      let origin = "https://s1.site\(round * 5).com"
      found += index.entries(near: origin).filter { VaultOriginMatch.matches(urls[$0], origin: origin) }.count
    }
    let perPage = Self.elapsed(start) / rounds
    print("native match over \(urls.count) saved addresses: index built in \(buildTime), \(perPage) per page")
    #expect(found >= rounds)
    let widest = (0..<rounds).map { index.entries(near: "https://s1.site\($0 * 5).com").count }.max() ?? urls.count
    #expect(widest * 50 < urls.count)
    let brute = urls.indices.filter { VaultOriginMatch.matches(urls[$0], origin: "https://s3.site40.com") }
    let indexed = index.entries(near: "https://s3.site40.com").filter { VaultOriginMatch.matches(urls[$0], origin: "https://s3.site40.com") }
    #expect(brute == indexed)
  }

  @Test func `a command past its deadline is stopped within the kill delay`() async {
    let start = ContinuousClock.now
    let result = await VaultCommand(executable: "/bin/sleep", arguments: ["30"], environment: environment, input: nil, timeout: 0.5).run()
    #expect(result.timedOut)
    #expect(result.succeeded == false)
    #expect(Self.elapsed(start) < Self.killedWithin)
  }

  @Test func `a blocked stdin write does not hold the deadline`() async {
    let start = ContinuousClock.now
    let big = Data(repeating: 0x61, count: 4 * 1024 * 1024)
    let result = await VaultCommand(executable: "/bin/sleep", arguments: ["30"], environment: environment, input: big, timeout: 0.5).run()
    #expect(result.timedOut)
    #expect(Self.elapsed(start) < Self.killedWithin)
  }

  @Test func `cancelling the calling task stops the command promptly`() async {
    let start = ContinuousClock.now
    let environment = environment
    let running = Task { await VaultCommand(executable: "/bin/sleep", arguments: ["30"], environment: environment, input: nil, timeout: 30).run() }
    while VaultCommand.running == 0 { await Task.yield() }
    running.cancel()
    let result = await running.value
    #expect(result.cancelled)
    #expect(result.succeeded == false)
    #expect(Self.elapsed(start) < Self.killedWithin)
  }

  @Test func `a task cancelled before launch never starts the command`() async {
    let start = ContinuousClock.now
    let environment = environment
    let early = Task {
      withUnsafeCurrentTask { $0?.cancel() }
      return await VaultCommand(executable: "/bin/sleep", arguments: ["30"], environment: environment, input: nil, timeout: 30).run()
    }
    let result = await early.value
    #expect(result.cancelled)
    #expect(result.launched == false)
    #expect(Self.elapsed(start) < Self.killedWithin)
  }

  @Test func `output past the cap stops the command and hands back nothing`() async {
    let result = await VaultCommand(executable: "/usr/bin/yes", arguments: [], environment: environment, input: nil, timeout: 20).run()
    #expect(result.overflowed)
    #expect(result.succeeded == false)
    #expect(result.stdout.isEmpty)
    #expect(result.timedOut == false)
  }

  @Test func `output past the cap fails the command even when it exits before the output is read`() async {
    let result = await VaultCommand(executable: "/bin/sh", arguments: ["-c", "printf AB"], environment: environment, input: nil, timeout: 60,
                                    outputLimit: 1).run()
    #expect(result.overflowed)
    #expect(result.succeeded == false)
    #expect(result.stdout.isEmpty)
  }

  @Test func `output still open when the drain deadline passes fails the command`() async {
    let script = "echo head; (sleep 20; echo tail) & exit 0"
    let result = await VaultCommand(executable: "/bin/sh", arguments: ["-c", script], environment: environment, input: nil, timeout: 10).run()
    #expect(result.status == 0)
    #expect(result.incomplete)
    #expect(result.succeeded == false)
  }

  @Test func `a stopped command's group is killed even after its leader exits and closes its output`() async throws {
    let script = "(trap '' TERM; exec /bin/sleep 30) </dev/null >/dev/null 2>&1 & echo $!; wait"
    let result = await VaultCommand(executable: "/bin/sh", arguments: ["-c", script], environment: environment, input: nil, timeout: 0.5).run()
    #expect(result.timedOut)
    let survivor = try #require(pid_t(result.trimmedOutput))
    let deadline = ContinuousClock.now + Self.killedWithin
    while kill(survivor, 0) == 0, ContinuousClock.now < deadline { try await Task.sleep(for: .milliseconds(50)) }
    #expect(kill(survivor, 0) != 0)
  }

  @Test func `stdin reaches the command and stdout comes back`() async {
    let text = "fixture-" + "stdin-1"
    let result = await VaultCommand(executable: "/bin/cat", arguments: [], environment: environment, input: Data(text.utf8), timeout: 60).run()
    #expect(result.succeeded)
    #expect(result.output == text)
  }

  @Test func `a missing executable reports that it never launched`() async {
    let result = await VaultCommand(executable: "/nonexistent/tool", arguments: [], environment: environment, input: nil, timeout: 5).run()
    #expect(result.launched == false)
    #expect(result.succeeded == false)
  }

  @Test func `a command sees only the environment it was given`() async {
    let result = await VaultCommand(executable: "/usr/bin/env", arguments: [], environment: environment, input: nil, timeout: 60).run()
    #expect(result.succeeded)
    #expect(result.output.trimmingCharacters(in: .whitespacesAndNewlines) == "PATH=/usr/bin:/bin")
  }
}

@Suite("Store gate")
struct VaultStoreGateTests {
  @Test func `signing in to one manager after Lock All leaves every other saved store closed`() {
    var gate = VaultStoreGate()
    gate.lockAll()
    let opened = gate.settled(.signIn, provider: "protonpass")
    #expect(opened == false)
    #expect(gate.admits("bitwarden") == false)
    #expect(gate.admits("protonpass") == false)
  }

  @Test func `unlocking an existing account opens the store for managers not locked on their own`() {
    var gate = VaultStoreGate()
    let opened = gate.settled(.unlock, provider: "bitwarden")
    #expect(opened)
    gate.lock("onepassword")
    #expect(gate.admits("bitwarden"))
    #expect(gate.admits("protonpass"))
    #expect(gate.admits("onepassword") == false)
    let reopened = gate.settled(.unlock, provider: "onepassword")
    #expect(reopened == false)
    #expect(gate.admits("onepassword"))
  }

  @Test func `a sign-in while the store is open admits that manager again`() {
    var gate = VaultStoreGate()
    _ = gate.settled(.unlock, provider: "bitwarden")
    gate.lock("protonpass")
    let opened = gate.settled(.signIn, provider: "protonpass")
    #expect(opened == false)
    #expect(gate.admits("protonpass"))
  }
}

