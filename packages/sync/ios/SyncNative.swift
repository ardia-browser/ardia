import ExpoModulesCore

protocol SyncNative {
  static var queue: DispatchQueue { get }
  static var core: String { get }
  static func folderInfo(_ path: String?) -> [String: Any]
  static func chooseFolder(_ current: String?, _ promise: Promise)
  static func newDeviceId() -> String
  static func takeOpenFailures() -> [String: Int]
  static func deviceName() -> String
  func createPhrase(_ account: String) -> Bool
  func enterPhrase(_ account: String, _ text: String, _ folder: String) throws -> [String: Any]
  func unlock(_ account: String) -> Bool
  func forget(_ account: String)
  func chainStatus(_ folder: String) throws -> String
  func createChain(_ folder: String) throws
  func write(_ folder: String, _ scope: String, _ payload: String) throws -> String
  func read(_ folder: String, _ scope: String, _ known: [String]) throws -> [String: Any]
  func remove(_ folder: String, _ scope: String, _ ids: [String]) throws
  func deleteChain(_ folder: String) throws
  func sealLocal(_ text: String) throws -> String
  func openLocal(_ sealed: String) -> String?
  func recoveryWords(_ promise: Promise)
  func qrCode(_ promise: Promise)
  func recoveryKitPreview(_ width: Double) throws -> String?
  func saveRecoveryKit(_ format: String, _ promise: Promise)
  func copyRecoveryKit(_ promise: Promise)
  func shareRecoveryKit(_ promise: Promise)
  func copyRecoveryPhrase(_ promise: Promise)
  static func revealFolder(_ path: String)
  func readPasswords(_ engineProfile: String, _ promise: Promise)
  func savePassword(_ engineProfile: String, _ origin: String, _ username: String, _ sealed: String, _ replacing: Bool, _ promise: Promise)
}

extension SyncNative {
  static var moduleName: String { "ArdiaSync" }

  static var coreConstant: AnyDefinition {
    Constant("core") { () -> String in Self.core }
  }

  static var folderInfoFunction: AnyDefinition {
    AsyncFunction("folderInfo") { (path: String?) -> [String: Any] in Self.folderInfo(path) }.runOnQueue(Self.queue)
  }

  static var chooseFolderFunction: AnyDefinition {
    AsyncFunction("chooseFolder") { (current: String?, promise: Promise) in Self.chooseFolder(current, promise) }.runOnQueue(.main)
  }

  static var newDeviceIdFunction: AnyDefinition {
    Function("newDeviceId") { () -> String in Self.newDeviceId() }
  }

  static var takeOpenFailuresFunction: AnyDefinition {
    Function("takeOpenFailures") { () -> [String: Int] in Self.takeOpenFailures() }
  }

  static var deviceNameFunction: AnyDefinition {
    Function("deviceName") { () -> String in Self.deviceName() }
  }

  static var revealFolderFunction: AnyDefinition {
    AsyncFunction("revealFolder") { (path: String) in Self.revealFolder(path) }.runOnQueue(.main)
  }
}

extension SyncNative where Self: Module {
  var createPhraseFunction: AnyDefinition {
    AsyncFunction("createPhrase") { (account: String) -> Bool in self.createPhrase(account) }.runOnQueue(Self.queue)
  }

  var enterPhraseFunction: AnyDefinition {
    AsyncFunction("enterPhrase") { (account: String, text: String, folder: String) throws -> [String: Any] in try self.enterPhrase(account, text, folder) }.runOnQueue(Self.queue)
  }

  var unlockFunction: AnyDefinition {
    AsyncFunction("unlock") { (account: String) -> Bool in self.unlock(account) }.runOnQueue(Self.queue)
  }

  var forgetFunction: AnyDefinition {
    AsyncFunction("forget") { (account: String) in self.forget(account) }.runOnQueue(Self.queue)
  }

  var chainStatusFunction: AnyDefinition {
    AsyncFunction("chainStatus") { (folder: String) throws -> String in try self.chainStatus(folder) }.runOnQueue(Self.queue)
  }

  var createChainFunction: AnyDefinition {
    AsyncFunction("createChain") { (folder: String) throws in try self.createChain(folder) }.runOnQueue(Self.queue)
  }

  var writeFunction: AnyDefinition {
    AsyncFunction("write") { (folder: String, scope: String, payload: String) throws -> String in try self.write(folder, scope, payload) }.runOnQueue(Self.queue)
  }

  var readFunction: AnyDefinition {
    AsyncFunction("read") { (folder: String, scope: String, known: [String]) throws -> [String: Any] in try self.read(folder, scope, known) }.runOnQueue(Self.queue)
  }

  var removeFunction: AnyDefinition {
    AsyncFunction("remove") { (folder: String, scope: String, ids: [String]) throws in try self.remove(folder, scope, ids) }.runOnQueue(Self.queue)
  }

  var deleteChainFunction: AnyDefinition {
    AsyncFunction("deleteChain") { (folder: String) throws in try self.deleteChain(folder) }.runOnQueue(Self.queue)
  }

  var sealLocalFunction: AnyDefinition {
    AsyncFunction("sealLocal") { (text: String) throws -> String in try self.sealLocal(text) }.runOnQueue(Self.queue)
  }

  var openLocalFunction: AnyDefinition {
    AsyncFunction("openLocal") { (sealed: String) -> String? in self.openLocal(sealed) }.runOnQueue(Self.queue)
  }

  var recoveryWordsFunction: AnyDefinition {
    AsyncFunction("recoveryWords") { (promise: Promise) in self.recoveryWords(promise) }.runOnQueue(Self.queue)
  }

  var qrCodeFunction: AnyDefinition {
    AsyncFunction("qrCode") { (promise: Promise) in self.qrCode(promise) }.runOnQueue(Self.queue)
  }

  var recoveryKitPreviewFunction: AnyDefinition {
    AsyncFunction("recoveryKitPreview") { (width: Double) throws -> String? in try self.recoveryKitPreview(width) }.runOnQueue(.main)
  }

  var saveRecoveryKitFunction: AnyDefinition {
    AsyncFunction("saveRecoveryKit") { (format: String, promise: Promise) in self.saveRecoveryKit(format, promise) }.runOnQueue(.main)
  }

  var copyRecoveryKitFunction: AnyDefinition {
    AsyncFunction("copyRecoveryKit") { (promise: Promise) in self.copyRecoveryKit(promise) }.runOnQueue(.main)
  }

  var shareRecoveryKitFunction: AnyDefinition {
    AsyncFunction("shareRecoveryKit") { (promise: Promise) in self.shareRecoveryKit(promise) }.runOnQueue(.main)
  }

  var copyRecoveryPhraseFunction: AnyDefinition {
    AsyncFunction("copyRecoveryPhrase") { (promise: Promise) in self.copyRecoveryPhrase(promise) }.runOnQueue(.main)
  }

  var readPasswordsFunction: AnyDefinition {
    AsyncFunction("readPasswords") { (engineProfile: String, promise: Promise) in self.readPasswords(engineProfile, promise) }
  }

  var savePasswordFunction: AnyDefinition {
    AsyncFunction("savePassword") { (engineProfile: String, origin: String, username: String, sealed: String, replacing: Bool, promise: Promise) in self.savePassword(engineProfile, origin, username, sealed, replacing, promise) }.runOnQueue(Self.queue)
  }
}

protocol SharedFoldersNative {
  static var queue: DispatchQueue { get }
  static func location() -> [String: Any]
  static func read(_ path: String, _ identity: [String: Int]?) -> [String: Any]
  static func apply(_ path: String, _ ops: String, _ identity: [String: Int]?) throws -> [String: Any]
  static func resolve(_ path: String, _ promise: Promise)
  static func discard(_ path: String, _ identity: [String: Int]) -> Bool
  static func create(_ parent: String, _ parentIdentity: [String: Int]?, _ name: String) throws -> [String: Any]
  func watch(_ paths: [String])
}

extension SharedFoldersNative {
  static var moduleName: String { "ArdiaSharedFolders" }

  static var eventsDefinition: AnyDefinition {
    Events("onChange")
  }

  static var locationFunction: AnyDefinition {
    Function("location") { () -> [String: Any] in Self.location() }
  }

  static var readFunction: AnyDefinition {
    AsyncFunction("read") { (path: String, identity: [String: Int]?) -> [String: Any] in Self.read(path, identity) }.runOnQueue(Self.queue)
  }

  static var applyFunction: AnyDefinition {
    AsyncFunction("apply") { (path: String, ops: String, identity: [String: Int]?) throws -> [String: Any] in try Self.apply(path, ops, identity) }.runOnQueue(Self.queue)
  }

  static var resolveFunction: AnyDefinition {
    AsyncFunction("resolve") { (path: String, promise: Promise) in Self.resolve(path, promise) }.runOnQueue(Self.queue)
  }

  static var discardFunction: AnyDefinition {
    AsyncFunction("discard") { (path: String, identity: [String: Int]) -> Bool in Self.discard(path, identity) }.runOnQueue(Self.queue)
  }

  static var createFunction: AnyDefinition {
    AsyncFunction("create") { (parent: String, parentIdentity: [String: Int]?, name: String) throws -> [String: Any] in try Self.create(parent, parentIdentity, name) }.runOnQueue(Self.queue)
  }
}

extension SharedFoldersNative where Self: Module {
  func sendOnChange(_ payload: [String: Any?]) { sendEvent("onChange", payload) }

  var watchFunction: AnyDefinition {
    Function("watch") { [weak self] (paths: [String]) in self?.watch(paths) }
  }
}
