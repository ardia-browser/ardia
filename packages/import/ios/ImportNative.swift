import ExpoModulesCore

protocol ImportNative {
  func listBrowsers(_ promise: Promise)
  func importData(_ jobId: String, _ browserId: String, _ profileId: String, _ kinds: [ImportKind], _ options: ImportRequestOptions, _ promise: Promise)
  func cancelImport(_ jobId: String)
  func unlockBrowser(_ browserId: String, _ primaryPassword: String?, _ promise: Promise)
  func isBrowserUnlocked(_ browserId: String) -> Bool
  func forgetUnlockedKeys()
  func writeImported(_ token: String, _ profile: String, _ kinds: [ImportKind], _ promise: Promise)
  func discardImported(_ token: String)
  func listExtensions(_ browserId: String, _ profileId: String, _ promise: Promise)
  func importSafariExport(_ jobId: String, _ path: String, _ promise: Promise)
  static func safariHasFullDiskAccess() -> Bool
  static func openFullDiskAccessSettings(_ promise: Promise)
  func importSafariDirect(_ jobId: String, _ promise: Promise)
  func readDiaTabs(_ promise: Promise)
  func importBookmarksHTML(_ path: String, _ promise: Promise)
  func importPasswordsCSV(_ path: String, _ promise: Promise)
  static func chooseImportFile(_ kind: ImportFileKind, _ promise: Promise)
}

extension ImportNative {
  static var moduleName: String { "ArdiaImport" }

  static var eventsDefinition: AnyDefinition {
    Events("onImportEvent")
  }

  static var safariHasFullDiskAccessFunction: AnyDefinition {
    Function("safariHasFullDiskAccess") { () -> Bool in Self.safariHasFullDiskAccess() }
  }

  static var openFullDiskAccessSettingsFunction: AnyDefinition {
    AsyncFunction("openFullDiskAccessSettings") { (promise: Promise) in Self.openFullDiskAccessSettings(promise) }.runOnQueue(.main)
  }

  static var chooseImportFileFunction: AnyDefinition {
    AsyncFunction("chooseImportFile") { (kind: ImportFileKind, promise: Promise) in Self.chooseImportFile(kind, promise) }.runOnQueue(.main)
  }
}

extension ImportNative where Self: Module {
  func sendOnImportEvent(_ payload: [String: Any?]) { sendEvent("onImportEvent", payload) }

  var listBrowsersFunction: AnyDefinition {
    AsyncFunction("listBrowsers") { (promise: Promise) in self.listBrowsers(promise) }
  }

  var importDataFunction: AnyDefinition {
    AsyncFunction("importData") { (jobId: String, browserId: String, profileId: String, kinds: [ImportKind], options: ImportRequestOptions, promise: Promise) in self.importData(jobId, browserId, profileId, kinds, options, promise) }
  }

  var cancelImportFunction: AnyDefinition {
    Function("cancelImport") { (jobId: String) in self.cancelImport(jobId) }
  }

  var unlockBrowserFunction: AnyDefinition {
    AsyncFunction("unlockBrowser") { (browserId: String, primaryPassword: String?, promise: Promise) in self.unlockBrowser(browserId, primaryPassword, promise) }
  }

  var isBrowserUnlockedFunction: AnyDefinition {
    Function("isBrowserUnlocked") { (browserId: String) -> Bool in self.isBrowserUnlocked(browserId) }
  }

  var forgetUnlockedKeysFunction: AnyDefinition {
    Function("forgetUnlockedKeys") { () in self.forgetUnlockedKeys() }
  }

  var writeImportedFunction: AnyDefinition {
    AsyncFunction("writeImported") { (token: String, profile: String, kinds: [ImportKind], promise: Promise) in self.writeImported(token, profile, kinds, promise) }
  }

  var discardImportedFunction: AnyDefinition {
    Function("discardImported") { (token: String) in self.discardImported(token) }
  }

  var listExtensionsFunction: AnyDefinition {
    AsyncFunction("listExtensions") { (browserId: String, profileId: String, promise: Promise) in self.listExtensions(browserId, profileId, promise) }
  }

  var importSafariExportFunction: AnyDefinition {
    AsyncFunction("importSafariExport") { (jobId: String, path: String, promise: Promise) in self.importSafariExport(jobId, path, promise) }
  }

  var importSafariDirectFunction: AnyDefinition {
    AsyncFunction("importSafariDirect") { (jobId: String, promise: Promise) in self.importSafariDirect(jobId, promise) }
  }

  var readDiaTabsFunction: AnyDefinition {
    AsyncFunction("readDiaTabs") { (promise: Promise) in self.readDiaTabs(promise) }
  }

  var importBookmarksHTMLFunction: AnyDefinition {
    AsyncFunction("importBookmarksHTML") { (path: String, promise: Promise) in self.importBookmarksHTML(path, promise) }
  }

  var importPasswordsCSVFunction: AnyDefinition {
    AsyncFunction("importPasswordsCSV") { (path: String, promise: Promise) in self.importPasswordsCSV(path, promise) }
  }
}
