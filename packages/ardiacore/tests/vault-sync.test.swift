import CryptoKit
import Foundation
import Testing

enum SyncFixture {
  static let totpSecret = String(repeating: "AB", count: 16)
  static let shortTotpSecret = String(repeating: "AB", count: 8)

  static func key(_ profile: String, _ origin: String, _ username: String) -> String {
    ArdiaLoginKey.make(ArdiaVaultLogin(profile: profile, origin: origin, username: username))
  }

  static func merged(_ first: VaultLedger, _ second: VaultLedger) -> VaultLedger {
    var result = first
    result.merge(second)
    return result
  }

  static func sealedInOldFormat(_ plain: Data, with key: SymmetricKey) throws -> Data {
    let header = Data("ARV1".utf8) + VaultSealed.keyId(key)
    return header + (try #require(try AES.GCM.seal(plain, using: key, authenticating: header).combined))
  }

  static func item(_ id: String, _ updatedAt: Double) -> VaultCacheSnapshot.Entry {
    VaultCacheSnapshot.Entry(item: VaultItem(provider: "bitwarden", id: id, title: id, username: "u", urls: [], updatedAt: updatedAt), totpPeriod: nil)
  }

  static func password(_ value: String, _ updatedAt: Double) -> VaultCacheSnapshot.Password {
    VaultCacheSnapshot.Password(value: value, itemUpdatedAt: updatedAt)
  }

  static func code(_ label: String, website: String? = nil, secret: String = totpSecret) -> ArdiaStandaloneCode {
    ArdiaStandaloneCode(uri: "otpauth://totp/\(label)?secret=\(secret)", label: label, issuer: nil, website: website, createdAt: 1)
  }

  static func snapshot(account: String, savedAt: Double) -> VaultCacheSnapshot {
    VaultCacheSnapshot(account: account, savedAt: savedAt, entries: [], passwords: [:], totps: nil)
  }
}

@Suite("Sealed vault files")
struct VaultSealingTests {
  let current = SymmetricKey(size: .bits256)
  let retired = SymmetricKey(size: .bits256)
  let stranger = SymmetricKey(size: .bits256)
  let plain = Data("{\"version\":3}".utf8)
  let context = "store/bitwarden"

  @Test func `a file sealed with a missing key reads as unknownKey, not corrupt`() throws {
    let sealed = try #require(VaultSealed.seal(plain, with: retired, context: context))
    #expect(VaultSealed.open(sealed, keys: [stranger], context: context) == .unknownKey)
    #expect(VaultSealed.open(sealed, keys: [], context: context) == .unknownKey)
  }

  @Test func `a retired key opens a file and asks for a reseal, the current key does not`() throws {
    let sealed = try #require(VaultSealed.seal(plain, with: retired, context: context))
    #expect(VaultSealed.open(sealed, keys: [current, retired], context: context) == .opened(plain, current: false))
    let fresh = try #require(VaultSealed.seal(plain, with: current, context: context))
    #expect(VaultSealed.open(fresh, keys: [current, retired], context: context) == .opened(plain, current: true))
  }

  @Test func `damaged files read as corrupt`() throws {
    let sealed = try #require(VaultSealed.seal(plain, with: retired, context: context))
    var flipped = sealed
    flipped[flipped.count - 1] ^= 0x01
    #expect(VaultSealed.open(flipped, keys: [retired], context: context) == .corrupt)
    #expect(VaultSealed.open(sealed.prefix(14), keys: [retired], context: context) == .corrupt)
    #expect(VaultSealed.open(Data(), keys: [retired], context: context) == .corrupt)
    #expect(VaultSealed.open(Data(repeating: 7, count: 200), keys: [current], context: context) == .corrupt)
  }

  @Test func `the key id is authenticated, so swapping it never opens`() throws {
    var relabelled = try #require(VaultSealed.seal(plain, with: retired, context: context))
    relabelled.replaceSubrange(4..<12, with: VaultSealed.keyId(current))
    #expect(VaultSealed.open(relabelled, keys: [current, retired], context: context).plain == nil)
  }

  @Test func `only the migration reads legacy blobs, and only with the key that sealed them`() throws {
    let sealed = try #require(VaultSealed.seal(plain, with: retired, context: context))
    let legacy = try #require(try AES.GCM.seal(plain, using: retired).combined)
    #expect(VaultSealed.open(legacy, keys: [current, retired], context: context) == .corrupt)
    #expect(VaultSealed.openLegacy(legacy, keys: [current, retired]) == plain)
    #expect(VaultSealed.openLegacy(legacy, keys: [stranger]) == nil)
    #expect(VaultSealed.openLegacy(try SyncFixture.sealedInOldFormat(plain, with: retired), keys: [retired]) == plain)
    #expect(VaultSealed.openLegacy(sealed, keys: [retired]) == nil)
  }

  @Test func `every seal uses a fresh nonce`() throws {
    let first = try #require(VaultSealed.seal(plain, with: current, context: "store/ardia"))
    let second = try #require(VaultSealed.seal(plain, with: current, context: "store/ardia"))
    #expect(first != second)
  }

  @Test("A sealed file opens only under its own name", arguments: [
    ("store/bitwarden", true), ("store/1password", false), ("marker/deleted", false),
  ])
  func opensUnderItsOwnName(name: String, opens: Bool) throws {
    let bitwarden = try #require(VaultSealed.seal(Data("{}".utf8), with: current, context: "store/bitwarden"))
    #expect((VaultSealed.open(bitwarden, keys: [current], context: name).plain != nil) == opens)
  }

  @Test func `an ARV1 file can't pose as a bound file under any name`() throws {
    let old = try SyncFixture.sealedInOldFormat(Data("{}".utf8), with: current)
    #expect(VaultSealed.open(old, keys: [current], context: "store/bitwarden") == .corrupt)
  }

  @Test func `only sealed files have a well-formed header`() throws {
    let bitwarden = try #require(VaultSealed.seal(Data("{}".utf8), with: current, context: "store/bitwarden"))
    #expect(VaultSealed.isWellFormed(bitwarden))
    #expect(VaultSealed.isWellFormed(try SyncFixture.sealedInOldFormat(Data("{}".utf8), with: current)))
    #expect(VaultSealed.isWellFormed(Data("ARV2".utf8) + Data(repeating: 1, count: 8)) == false)
    #expect(VaultSealed.isWellFormed(Data(repeating: 9, count: 100)) == false)
  }

  @Test func `a quit marker verifies only when signed here and unedited`() throws {
    let marker = try #require(VaultQuitMarker.signed(["boot": "B", "providers": ["bitwarden"]], key: current))
    #expect(VaultQuitMarker.verified(marker, key: current)?["boot"] as? String == "B")
    #expect(VaultQuitMarker.verified(marker, key: stranger) == nil)
    let planted = try #require(String(data: try JSONSerialization.data(withJSONObject: ["boot": "B", "providers": ["bitwarden"]]), encoding: .utf8))
    #expect(VaultQuitMarker.verified(planted, key: current) == nil)
    let swappedBody = try JSONSerialization.data(withJSONObject: ["boot": "B", "providers": ["protonpass"]], options: [.sortedKeys]).base64EncodedString()
    let tampered = swappedBody + "." + marker.split(separator: ".")[1]
    #expect(VaultQuitMarker.verified(tampered, key: current) == nil)
  }

  @Test("An account is its email and server, ignoring case", arguments: [
    ("me@self.example", "me@vault.bitwarden.com", false), ("Me@Vault.Bitwarden.com", "me@vault.bitwarden.com", true),
  ])
  func sameAccount(first: String, second: String, same: Bool) {
    #expect(SyncFixture.snapshot(account: first, savedAt: 1).sameAccount(SyncFixture.snapshot(account: second, savedAt: 1)) == same)
  }
}

@Suite("Sync ledger")
struct VaultLedgerTests {
  @Test func `removing something never known writes no tombstone`() {
    var ledger = VaultLedger()
    let wrote = ledger.set("k", nil, at: 1, device: "a")
    #expect(wrote == false)
  }

  @Test func `concurrent edits merge to the same result and the later one wins`() {
    var macA = VaultLedger()
    var macB = VaultLedger()
    macA.set("k", "one", at: 100, device: "a")
    macB.merge(macA)
    #expect(macB.value("k") == "one")
    macA.set("k", "two", at: 200, device: "a")
    macB.set("k", "three", at: 150, device: "b")
    let ab = SyncFixture.merged(macA, macB)
    #expect(ab == SyncFixture.merged(macB, macA))
    #expect(ab.value("k") == "two")
  }

  @Test func `an edit made after seeing a future-stamped one still wins despite a slow clock`() {
    var skewed = VaultLedger()
    skewed.set("k", "future", at: 5_000_000_000, device: "fast")
    var slow = VaultLedger()
    slow.merge(skewed)
    slow.set("k", "after seeing it", at: 100, device: "slow")
    #expect(SyncFixture.merged(skewed, slow).value("k") == "after seeing it")
  }

  @Test func `tombstones remove entries everywhere until a later add`() {
    var base = VaultLedger()
    base.set("k", "two", at: 200, device: "a")
    var deleter = base
    deleter.set("k", nil, at: 300, device: "a")
    var stale = base
    stale.merge(deleter)
    #expect(stale.isRemoved("k"))
    #expect(stale.value("k") == nil)
    stale.merge(base)
    #expect(stale.isRemoved("k"))
    var readd = stale
    readd.set("k", "back", at: 400, device: "b")
    #expect(SyncFixture.merged(deleter, readd).value("k") == "back")
  }

  @Test func `merge is idempotent and an empty ledger removes nothing`() {
    var ledger = VaultLedger()
    ledger.set("x", "1", at: 1, device: "a")
    ledger.set("y", "2", at: 1, device: "a")
    var twice = ledger
    let changed = twice.merge(ledger)
    #expect(changed == false)
    #expect(twice == ledger)
    var target = ledger
    target.merge(VaultLedger())
    #expect(target == ledger)
  }

  @Test func `a maximal stamp from a damaged copy doesn't overflow`() {
    var maxed = VaultLedger(entries: ["k": VaultLedgerEntry(value: "v", stamp: Int64.max, device: "a")])
    maxed.set("k", "w", at: 1, device: "a")
    #expect(maxed.value("k") == "w")
    #expect(maxed.entries["k"]?.stamp == Int64.max)
  }

  @Test("Odd clocks clamp to zero", arguments: [Double.nan, -5])
  func oddClocks(time: Double) {
    #expect(VaultLedger.stamp(at: time, after: nil) == 0)
  }

  @Test func `a full tie picks the same winner both ways`() {
    let tie1 = VaultLedgerEntry(value: "a", stamp: 1, device: "same")
    let tie2 = VaultLedgerEntry(value: nil, stamp: 1, device: "same")
    #expect(tie1.beats(tie2))
    #expect(tie2.beats(tie1) == false)
  }
}

@Suite("Cache snapshots")
struct VaultSnapshotTests {
  let older = VaultCacheSnapshot(
    account: "me@vault.bitwarden.com", savedAt: 100,
    entries: [SyncFixture.item("a", 1), SyncFixture.item("b", 1), SyncFixture.item("gone", 1)],
    passwords: ["a": SyncFixture.password("pa", 1), "b": SyncFixture.password("pb-old", 1), "gone": SyncFixture.password("pg", 1)],
    totps: ["a": SyncFixture.password("otpauth://a", 1)])
  let newer = VaultCacheSnapshot(
    account: "ME@vault.bitwarden.com", savedAt: 200,
    entries: [SyncFixture.item("a", 1), SyncFixture.item("b", 2), SyncFixture.item("c", 1)],
    passwords: ["c": SyncFixture.password("pc", 1)], totps: nil)

  @Test func `a snapshot merge keeps secrets only for unchanged items and the newest item list`() {
    let merged = VaultCacheSnapshot.merged(older, newer)
    #expect(merged == VaultCacheSnapshot.merged(newer, older))
    #expect(merged.entries.map(\.item.id) == ["a", "b", "c"])
    #expect(merged.passwords["a"]?.value == "pa")
    #expect(merged.passwords["b"] == nil)
    #expect(merged.totps?["a"]?.value == "otpauth://a")
    #expect(merged.savedAt == 200)
    #expect(VaultCacheSnapshot.merged(merged, merged) == merged)
  }

  @Test func `another account's secrets never mix in`() {
    let stranger = VaultCacheSnapshot(account: "other@vault.bitwarden.com", savedAt: 50, entries: [SyncFixture.item("z", 1)],
                                      passwords: ["z": SyncFixture.password("pz", 1)], totps: nil)
    let mixed = VaultCacheSnapshot.merged(newer, stranger)
    #expect(mixed.entries.map(\.item.id) == ["a", "b", "c"])
    #expect(mixed.passwords["z"] == nil)
  }
}

@Suite("Ardia login backup")
struct VaultBackupTests {
  let site = SyncFixture.key("", "https://example.com", "me")
  let other = SyncFixture.key("", "https://other.com", "me")

  func firstBackup() -> ArdiaVaultFile {
    var macA = ArdiaVaultFile(device: "a")
    ArdiaVaultBackupPlan.noteLocal(&macA, read: [""], local: [site: "p1", other: "o1"], now: 100, device: "a")
    return macA
  }

  @Test func `a first backup takes every local login and remembers only fingerprints`() {
    let macA = firstBackup()
    #expect(macA.logins.value(site) == "p1")
    #expect(macA.logins.value(other) == "o1")
    #expect(macA.seen?[site] == ArdiaVaultBackupPlan.fingerprint("p1"))
    #expect(macA.seen?.values.contains("p1") == false)
  }

  @Test func `a new Mac with an empty store removes nothing from the backup`() {
    var newMac = ArdiaVaultFile(device: "b")
    newMac.merge(firstBackup().shared)
    let wiped = ArdiaVaultBackupPlan.noteLocal(&newMac, read: [""], local: [:], now: 200, device: "b")
    #expect(wiped == false)
    #expect(newMac.logins.value(site) == "p1")
  }

  @Test func `a login this Mac never saw stays out of the backup until it changes here`() {
    var stale = ArdiaVaultFile(device: "c")
    stale.merge(firstBackup().shared)
    ArdiaVaultBackupPlan.noteLocal(&stale, read: [""], local: [site: "old"], now: 150, device: "c")
    #expect(stale.logins.value(site) == "p1")
    ArdiaVaultBackupPlan.noteLocal(&stale, read: [""], local: [site: "old"], now: 160, device: "c")
    #expect(stale.logins.value(site) == "p1")
    #expect(ArdiaVaultBackupPlan.updatePlan(stale, present: [site: "old"]).isEmpty)
    ArdiaVaultBackupPlan.noteLocal(&stale, read: [""], local: [site: "changed here"], now: 170, device: "c")
    #expect(stale.logins.value(site) == "changed here")
  }

  @Test func `a change on another Mac wins and is offered as an update`() throws {
    var macA = firstBackup()
    var macB = ArdiaVaultFile(device: "b")
    macB.merge(macA.shared)
    ArdiaVaultBackupPlan.noteLocal(&macB, read: [""], local: [site: "p1", other: "o1"], now: 110, device: "b")
    macA.logins.set(site, "p2", at: 120, device: "a")
    macB.merge(macA.shared)
    ArdiaVaultBackupPlan.noteLocal(&macB, read: [""], local: [site: "p1", other: "o1"], now: 130, device: "b")
    #expect(macB.logins.value(site) == "p2")

    let updates = ArdiaVaultBackupPlan.updatePlan(macB, present: [site: "p1", other: "o1"])
    #expect(updates.count == 1)
    let update = try #require(updates.first)
    #expect(update.password == "p2")
    var updated = macB
    ArdiaVaultBackupPlan.noteUpdated(&updated, update)
    #expect(ArdiaVaultBackupPlan.updatePlan(updated, present: [site: "p2", other: "o1"]).isEmpty)

    var mergedMeanwhile = macB
    var macC = ArdiaVaultFile(device: "c")
    macC.merge(macA.shared)
    macC.logins.set(site, "p3", at: 125, device: "c")
    mergedMeanwhile.merge(macC.shared)
    ArdiaVaultBackupPlan.noteUpdated(&mergedMeanwhile, update)
    #expect(ArdiaVaultBackupPlan.updatePlan(mergedMeanwhile, present: [site: "p2", other: "o1"]).map(\.password) == ["p3"])

    var editedHere = macB
    ArdiaVaultBackupPlan.noteLocal(&editedHere, read: [""], local: [site: "mine now", other: "o1"], now: 1, device: "b")
    #expect(editedHere.logins.value(site) == "mine now")
    #expect(ArdiaVaultBackupPlan.updatePlan(editedHere, present: [site: "mine now", other: "o1"]).isEmpty)

    var older = macB
    older.logins.entries[site]?.stamp = older.seenStamps?[site] ?? 0
    #expect(ArdiaVaultBackupPlan.updatePlan(older, present: [site: "p1", other: "o1"]).isEmpty)

    var unread = macB
    ArdiaVaultBackupPlan.noteLocal(&unread, read: ["work"], local: [:], now: 150, device: "b")
    #expect(unread.logins.value(site) == "p2")

    ArdiaVaultBackupPlan.noteLocal(&macB, read: [""], local: [site: "p1"], now: 140, device: "b")
    #expect(macB.logins.isRemoved(other))
    macA.merge(macB.shared)
    #expect(macA.logins.isRemoved(other))
  }

  @Test func `a store that suddenly reads empty is wiped, but deleting one of many is a deletion`() {
    var many = ArdiaVaultFile(device: "m")
    var locals: [String: String] = [:]
    for n in 0..<10 { locals[SyncFixture.key("", "https://s\(n).com", "me")] = "p\(n)" }
    ArdiaVaultBackupPlan.noteLocal(&many, read: [""], local: locals, now: 1, device: "m")
    ArdiaVaultBackupPlan.noteLocal(&many, read: [""], local: [:], now: 2, device: "m")
    #expect(many.logins.values.count == 10)
    #expect(ArdiaVaultBackupPlan.restorePlan(many, profiles: [""], present: []).count == 10)
    var trimmed = locals
    trimmed.removeValue(forKey: SyncFixture.key("", "https://s0.com", "me"))
    ArdiaVaultBackupPlan.noteLocal(&many, read: [""], local: trimmed, now: 3, device: "m")
    #expect(many.logins.isRemoved(SyncFixture.key("", "https://s0.com", "me")))
    #expect(many.logins.values.count == 9)
  }

  @Test func `an old ardia vault's codes migrate into the merged file`() throws {
    let notOld = try JSONEncoder().encode(VaultCacheSnapshot(account: "ardia", savedAt: 500, entries: [], passwords: [:],
                                                             totps: [site: .init(value: "otpauth://x", itemUpdatedAt: nil)]))
    let migrated = try #require(ArdiaVaultFile.decode(notOld, device: "d", now: 1000))
    #expect(migrated.codes.value(site) == "otpauth://x")
    #expect(migrated.version == ArdiaVaultFile.currentVersion)
    #expect(ArdiaVaultFile.decode(Data("garbage".utf8), device: "d", now: 1) == nil)
  }

  @Test func `the merged file round-trips and iCloud gets no per-Mac fields`() throws {
    let macA = firstBackup()
    let encoded = try JSONEncoder().encode(macA)
    #expect(ArdiaVaultFile.decode(encoded, device: "x", now: 1) == macA)
    #expect(macA.shared.seen == nil)
    #expect(macA.shared.device == nil)
  }
}

@Suite("Ardia login restore")
struct VaultRestoreTests {
  let site = SyncFixture.key("", "https://example.com", "me")
  let work = SyncFixture.key("work-id", "https://example.com", "me")
  let gone = SyncFixture.key("", "https://gone.com", "me")
  let mine = SyncFixture.key("", "https://mine.com", "me")
  let file: ArdiaVaultFile

  init() {
    var file = ArdiaVaultFile(device: "a")
    file.logins.set(site, "p-default", at: 10, device: "a")
    file.logins.set(work, "p-work", at: 20, device: "a")
    file.logins.set(gone, "x", at: 10, device: "a")
    file.logins.set(gone, nil, at: 30, device: "a")
    file.logins.set(mine, "remote", at: 10, device: "a")
    file.codes.set(work, "otpauth://work", at: 20, device: "a")
    self.file = file
  }

  @Test func `one login backed up in two profiles restores once, preferring its own profile`() {
    let plan = ArdiaVaultBackupPlan.restorePlan(file, profiles: [""], present: [mine])
    #expect(plan.count == 1)
    #expect(plan.first?.target.profile == "")
    #expect(plan.first?.password == "p-default")
    #expect(plan.contains { $0.target.origin == "https://gone.com" } == false)
    #expect(plan.contains { $0.target.origin == "https://mine.com" } == false)
  }

  @Test func `a profile this Mac has keeps its logins and codes`() {
    let mapped = ArdiaVaultBackupPlan.restorePlan(file, profiles: ["", "work-id"], present: [mine])
    #expect(mapped.count == 2)
    #expect(mapped.contains { $0.target.profile == "work-id" && $0.code == "otpauth://work" })
  }

  @Test func `a missing profile falls back to the default, and a restore is offered once`() throws {
    var noDefault = file
    noDefault.logins.entries[site] = nil
    let workOnly = ArdiaVaultBackupPlan.restorePlan(noDefault, profiles: [""], present: [mine])
    #expect(workOnly.count == 1)
    let item = try #require(workOnly.first)
    #expect(item.source == work)
    #expect(item.target.profile == "")
    #expect(item.code == "otpauth://work")

    var after = noDefault
    ArdiaVaultBackupPlan.noteRestored(&after, item, now: 50, device: "b")
    #expect(after.codes.value(site) == "otpauth://work")
    #expect(ArdiaVaultBackupPlan.restorePlan(after, profiles: [""], present: [mine, site]).isEmpty)

    var deletedHere = after
    deletedHere.seen = [site: ArdiaVaultBackupPlan.fingerprint("p-work")]
    ArdiaVaultBackupPlan.noteLocal(&deletedHere, read: [""], local: [mine: "remote"], now: 60, device: "b")
    #expect(ArdiaVaultBackupPlan.restorePlan(deletedHere, profiles: [""], present: [mine]).isEmpty)
  }

  @Test func `an empty backup restores nothing`() {
    #expect(ArdiaVaultBackupPlan.restorePlan(ArdiaVaultFile(), profiles: [""], present: []).isEmpty)
  }
}

@Suite("Standalone codes")
struct VaultStandaloneCodeTests {
  let id = "code.11111111-2222-3333-4444-555555555555"

  func madeOnMacA() -> (file: ArdiaVaultFile, changed: Bool) {
    var macA = ArdiaVaultFile(device: "a")
    var raw = macA.standalone.values
    let changed = ArdiaStandaloneCode.apply({ $0[id] = SyncFixture.code("GitHub") }, to: &raw)
    for (key, value) in raw { macA.standalone.set(key, value, at: 100, device: "a") }
    return (macA, changed)
  }

  @Test func `a code made on one Mac merges into another`() {
    let (macA, changed) = madeOnMacA()
    #expect(changed)
    var macB = ArdiaVaultFile(device: "b")
    let merged = macB.merge(macA.shared)
    #expect(merged)
    #expect(macB.standaloneCodes[id]?.label == "GitHub")
  }

  @Test func `a later rename wins over an earlier delete in either merge order`() {
    let macA = madeOnMacA().file
    var macB = ArdiaVaultFile(device: "b")
    macB.merge(macA.shared)
    var renamedA = macA
    renamedA.standalone.set(id, SyncFixture.code("GitHub Work").encoded(), at: 200, device: "a")
    var deletedB = macB
    deletedB.standalone.set(id, nil, at: 150, device: "b")
    var ab = renamedA
    ab.merge(deletedB.shared)
    var ba = deletedB
    ba.merge(renamedA.shared)
    #expect(ab.standalone == ba.standalone)
    #expect(ab.standaloneCodes[id]?.label == "GitHub Work")
  }

  @Test func `a delete leaves a tombstone that an older copy can't undo`() {
    let macA = madeOnMacA().file
    var deletedLater = ArdiaVaultFile(device: "b")
    deletedLater.merge(macA.shared)
    deletedLater.standalone.set(id, nil, at: 300, device: "b")
    var stale = macA
    stale.merge(deletedLater.shared)
    #expect(stale.standaloneCodes[id] == nil)
    #expect(stale.standalone.isRemoved(id))
    stale.merge(macA.shared)
    #expect(stale.standaloneCodes[id] == nil)
  }

  @Test func `login codes and standalone codes live side by side and both go to iCloud`() {
    var login = ArdiaVaultFile(device: "a")
    let loginKey = SyncFixture.key("", "https://example.com", "me")
    login.codes.set(loginKey, "otpauth://totp/x?secret=\(SyncFixture.shortTotpSecret)", at: 1, device: "a")
    login.merge(madeOnMacA().file.shared)
    #expect(login.codes.value(loginKey) != nil)
    #expect(login.standaloneCodes[id] != nil)
    #expect(login.shared.standalone == login.standalone)
    #expect(ArdiaStandaloneCode.isId(loginKey) == false)
  }

  @Test func `a version 3 file without standalone codes opens and is written in the current version`() throws {
    let version3 = Data(#"{"version":3,"codes":{"entries":{}},"logins":{"entries":{}}}"#.utf8)
    let opened = try #require(ArdiaVaultFile.decode(version3, device: "d", now: 1))
    #expect(opened.standalone.entries.isEmpty)
    #expect(opened.version == ArdiaVaultFile.currentVersion)
  }

  @Test func `a Mac on the previous version still opens a file with standalone codes`() throws {
    struct OldReader: Codable { var version: Int; var codes: VaultLedger; var logins: VaultLedger }
    let written = try JSONEncoder().encode(madeOnMacA().file.shared)
    let old = try JSONDecoder().decode(OldReader.self, from: written)
    #expect(old.version >= 3)
  }

  @Test func `only readable entries with the code prefix are standalone codes`() throws {
    let encoded = try #require(SyncFixture.code("A").encoded())
    var untouched = ["code.future": "{not json", id: encoded]
    _ = ArdiaStandaloneCode.apply({ $0[id] = nil }, to: &untouched)
    #expect(untouched["code.future"] == "{not json")
    #expect(untouched[id] == nil)
    var same = [id: encoded]
    let changed = ArdiaStandaloneCode.apply({ _ in }, to: &same)
    #expect(changed == false)
    var notCode = ["not-a-code": encoded]
    #expect(ArdiaStandaloneCode.decodedAll(notCode).isEmpty)
    _ = ArdiaStandaloneCode.apply({ $0["not-a-code"] = nil }, to: &notCode)
    #expect(notCode["not-a-code"] != nil)
  }

  @Test func `a made code needs a label, clips a long one and refuses insecure websites`() {
    #expect(ArdiaStandaloneCode.made(uri: "u", label: "  \n ", issuer: nil, website: nil, at: 1) == nil)
    #expect(ArdiaStandaloneCode.made(uri: "u", label: String(repeating: "L", count: 400), issuer: nil, website: nil, at: 1)?.label.count == ArdiaStandaloneCode.longestLabel)
    #expect(ArdiaStandaloneCode.made(uri: "u", label: "A", issuer: nil, website: "javascript:alert(1)", at: 1) == nil)
    #expect(ArdiaStandaloneCode.made(uri: "u", label: "A", issuer: "", website: " ", at: 1)?.website == nil)
  }

  @Test("A typed website normalizes to an origin or nothing", arguments: [
    ("github.com", "https://github.com"), ("https://GitHub.com/login?x=1", "https://github.com"), ("http://example.com", nil),
    ("http://localhost:3000", "http://localhost:3000"), ("ftp://example.com", nil), ("not a site", nil), ("user:pw@evil.com", nil),
    ("example", nil), ("https://example.com:8443", "https://example.com:8443"), ("..com", nil),
  ] as [(String, String?)])
  func websiteOrigin(text: String, wanted: String?) {
    #expect(ArdiaStandaloneCode.websiteOrigin(text) == wanted)
  }

  @Test("A code fills where its website matches, or when chosen on a secure page", arguments: [
    ("https://github.com", "https://github.com", false, true),
    ("https://github.com", "https://gist.github.com", false, true),
    ("https://github.com", "https://evil.com", false, false),
    ("https://github.com", "http://github.com", true, false),
    (nil, "https://github.com", false, false),
    (nil, "https://github.com", true, true),
  ] as [(String?, String, Bool, Bool)])
  func matches(website: String?, origin: String, userChose: Bool, fills: Bool) {
    #expect(SyncFixture.code("A", website: website).matches(origin: origin, userChose: userChose) == fills)
  }

  @Test func `new standalone ids are standalone ids`() {
    #expect(ArdiaStandaloneCode.isId(ArdiaStandaloneCode.newId()))
  }
}

@Suite("iCloud formats and folder")
struct VaultCloudFormatTests {
  @Test func `a snapshot a newer Ardia wrote is never overwritten and only differences are pushed`() throws {
    let item = VaultItem(provider: "bitwarden", id: "a", title: "A", username: "me", urls: ["https://a.test"], hasTotp: false, updatedAt: 1)
    let local = VaultCacheSnapshot(account: "me", savedAt: 10, entries: [.init(item: item, totpPeriod: nil)],
                                   passwords: ["a": .init(value: "p", itemUpdatedAt: 1)], totps: nil)
    let newer = Data(#"{"version":3,"account":"me","savedAt":20,"entries":[],"passwords":{},"vaults":["new"]}"#.utf8)
    let plan = VaultCacheSnapshot.cloudPlan(local: local, remotes: [newer], account: "me")
    #expect(plan.newerElsewhere)
    #expect(plan.push == nil)
    #expect(plan.local == nil)
    let same = try JSONEncoder().encode(local)
    #expect(VaultCacheSnapshot.cloudPlan(local: local, remotes: [same], account: "me").push == nil)
    #expect(VaultCacheSnapshot.cloudPlan(local: local, remotes: [], account: "me").push == local)
  }

  @Test func `ardia vault from a newer Ardia merges what this Mac understands and is never written back`() throws {
    let secret = SyncFixture.shortTotpSecret
    var file = ArdiaVaultFile()
    file.codes.set("k", "otpauth://totp/x?secret=\(secret)", at: 1, device: "a")
    let future = Data(#"{"version":6,"codes":{"entries":{"j":{"value":"otpauth://totp/y?secret=\#(secret)","stamp":5,"device":"b"}}},"logins":{"entries":{}},"notes":{"entries":{"n":{"value":"keep","stamp":5,"device":"b"}}}}"#.utf8)
    let ardia = ArdiaVaultBackupPlan.cloudPlan(local: file, storedMissing: false, remotes: [future], now: 10)
    #expect(ardia.newerElsewhere)
    #expect(ardia.push == nil)
    #expect(ardia.local.codes.value("j") != nil)
    #expect(ardia.local.version == ArdiaVaultFile.currentVersion)
    let current = try JSONEncoder().encode(file.shared)
    #expect(ArdiaVaultBackupPlan.cloudPlan(local: file, storedMissing: false, remotes: [current], now: 10).push == nil)
    #expect(ArdiaVaultBackupPlan.cloudPlan(local: file, storedMissing: false, remotes: [], now: 10).push != nil)
    #expect(ArdiaVaultFile.isNewerFormat(future))
    #expect(ArdiaVaultFile.isNewerFormat(current) == false)
  }

  @Test func `an iCloud copy from a newer build is kept for that build, not treated as damaged`() throws {
    let key = SymmetricKey(size: .bits256)
    let sealed = try #require(VaultSealed.seal(Data("{}".utf8), with: key, context: "store/bitwarden"))
    var newer = sealed
    newer[newer.startIndex + 3] = UInt8(ascii: "3")
    #expect(VaultCloudFiles.classify(newer, keys: [key], context: "store/bitwarden") == .newerFormat)
    #expect(VaultCloudFiles.classify(sealed, keys: [key], context: "store/bitwarden") == .opened(Data("{}".utf8), current: true))
    #expect(VaultCloudFiles.classify(sealed, keys: [SymmetricKey(size: .bits256)], context: "store/bitwarden") == .unknownKey)
    #expect(VaultCloudFiles.classify(Data(sealed.dropLast(5)), keys: [key], context: "store/bitwarden") == .damaged)
  }

  @Test func `the cloud folder counts sealed, not yet downloaded and unreadable vault files, and nothing else`() throws {
    let sealed = try #require(VaultSealed.seal(Data("{}".utf8), with: SymmetricKey(size: .bits256), context: "store/bitwarden"))
    #expect(VaultCloudFiles.holdsSealedFiles([".bitwarden.vault.icloud"]) { _ in nil })
    #expect(VaultCloudFiles.holdsSealedFiles(["bitwarden.vault"]) { _ in sealed })
    #expect(VaultCloudFiles.holdsSealedFiles(["bitwarden.vault"]) { _ in Data("x".utf8) } == false)
    #expect(VaultCloudFiles.holdsSealedFiles(["bitwarden.vault"]) { _ in nil })
    #expect(VaultCloudFiles.holdsSealedFiles(["bitwarden.vault"]) { _ in Data("ARV3".utf8) + Data(count: VaultSealed.shortestSealed) })
    #expect(VaultCloudFiles.holdsSealedFiles([".ardia-backup-deleted", "notes.txt", ".DS_Store"]) { _ in sealed } == false)
  }

  @Test("Placeholder names map back to the store", arguments: [(".ardia.vault.icloud", "ardia"), (".vault", nil)] as [(String, String?)])
  func placeholderNames(file: String, store: String?) {
    #expect(VaultCloudFiles.name(ofFile: file) == store)
  }

  @Test func `a password changed on another Mac counts as updatable without reading this Mac's passwords`() {
    var seen = ArdiaVaultFile()
    let key = SyncFixture.key("", "https://a.test", "me")
    seen.logins.set(key, "new", at: 2, device: "b")
    seen.seen = [key: ArdiaVaultBackupPlan.fingerprint("old")]
    seen.seenStamps = [key: 1]
    #expect(ArdiaVaultBackupPlan.updatableCount(seen, present: [key]) == 1)
    #expect(ArdiaVaultBackupPlan.updatableCount(seen, present: []) == 0)
    seen.seen = [key: ArdiaVaultBackupPlan.fingerprint("new")]
    #expect(ArdiaVaultBackupPlan.updatableCount(seen, present: [key]) == 0)
  }
}

@Suite("Secret cache")
struct VaultSecretCacheTests {
  let file: ArdiaVaultFile
  let changed: ArdiaVaultFile
  let decode = { @Sendable (values: [String: String]) in values }

  init() {
    var file = ArdiaVaultFile()
    file.codes.set("k", "otpauth://totp/x?secret=\(SyncFixture.shortTotpSecret)", at: 1, device: "a")
    file.passkeys.set("pk", "fixture-" + "passkey-1", at: 1, device: "a")
    var raw: [String: String] = [:]
    _ = ArdiaStandaloneCode.apply({ $0["code.one"] = SyncFixture.code("One") }, to: &raw)
    for (id, value) in raw { file.standalone.set(id, value, at: 1, device: "a") }
    var changed = file
    changed.codes.set("k2", "otpauth://totp/y?secret=\(SyncFixture.shortTotpSecret)", at: 2, device: "b")
    changed.passkeys.set("pk2", "fixture-" + "passkey-2", at: 2, device: "b")
    self.file = file
    self.changed = changed
  }

  @Test func `each kind of secret loads once, and a lock drops them all`() {
    var cache = ArdiaSecretCache<String>()
    var loads = 0
    _ = cache.codes { loads += 1; return file.codes.values }
    _ = cache.standalone { loads += 1; return file.standaloneCodes }
    _ = cache.passkeys { loads += 1; return decode(file.passkeys.values) }
    #expect(cache.holdsSecrets)
    #expect(loads == 3)
    _ = cache.codes { loads += 1; return [:] }
    #expect(loads == 3)

    cache.drop()
    #expect(cache.holdsSecrets == false)
    #expect(cache.codes == nil)
    #expect(cache.standalone == nil)
    #expect(cache.passkeys == nil)

    let changes = cache.refresh(from: changed, passkeys: decode)
    #expect(cache.holdsSecrets == false)
    #expect(changes == .init())
  }

  @Test func `only kinds already in use follow an iCloud change`() {
    var open = ArdiaSecretCache<String>()
    _ = open.codes { file.codes.values }
    let seen = open.refresh(from: changed, passkeys: decode)
    #expect(seen.codes)
    #expect(open.codes?["k2"] != nil)
    #expect(open.passkeys == nil)
    #expect(open.standalone == nil)
    #expect(seen.passkeys == false)
    let next = open.codes { [:] }
    #expect(next["k2"] != nil)
  }
}

@Suite("Profiles on Ardia")
struct ArdiaVaultProfilesTests {
  @Test func `the Default profile's empty engine name can be on Ardia`() {
    var profiles = ArdiaVaultProfiles()
    let changed1 = profiles.replace(with: [""])
    #expect(changed1)
    #expect(profiles.serves("", base: ""))
    #expect(!profiles.serves("Profile 1", base: "Profile 1"))
  }

  @Test func `a private profile follows its base engine name`() {
    var profiles = ArdiaVaultProfiles()
    profiles.replace(with: ["", "Profile 2"])
    #expect(profiles.serves("private-1", base: ""))
    #expect(profiles.serves("private-2", base: "Profile 2"))
    #expect(!profiles.serves("private-3", base: "Profile 3"))
  }

  @Test func `sending the same set again is no change`() {
    var profiles = ArdiaVaultProfiles()
    let changed2 = profiles.replace(with: ["", "Profile 1"])
    #expect(changed2)
    let changed3 = profiles.replace(with: ["Profile 1", "", ""])
    #expect(!changed3)
    let changed4 = profiles.replace(with: [])
    #expect(changed4)
    #expect(!profiles.serves("", base: ""))
  }

  @Test func `only non-private profiles on Ardia are backed up`() {
    var profiles = ArdiaVaultProfiles()
    profiles.replace(with: ["", "Profile 2"])
    let loaded = ["", "Profile 1", "Profile 2", "private-1"]
    #expect(profiles.backedUp(loaded: loaded, isPrivate: { $0.hasPrefix("private") }) == ["", "Profile 2"])
  }

  @Test func `a profile that leaves Ardia keeps its backed up logins`() {
    let kept = SyncFixture.key("Profile 1", "https://example.com", "me")
    let added = SyncFixture.key("Profile 1", "https://new.example.com", "me")
    var file = ArdiaVaultFile(device: "a")
    ArdiaVaultBackupPlan.noteLocal(&file, read: ["Profile 1"], local: [kept: "p1"], now: 100, device: "a")
    var profiles = ArdiaVaultProfiles()
    profiles.replace(with: [""])
    let read = Set(profiles.backedUp(loaded: ["", "Profile 1"], isPrivate: { _ in false }))
    ArdiaVaultBackupPlan.noteLocal(&file, read: read, local: [added: "p2"], now: 200, device: "a")
    #expect(file.logins.value(kept) == "p1")
    #expect(file.logins.value(added) == nil)
  }
}
