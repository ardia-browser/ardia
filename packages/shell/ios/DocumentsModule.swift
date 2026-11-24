import ExpoModulesCore

public class DocumentsModule: Module, DocumentsNative {
  static func readDocument(_ name: String) -> String? { DocumentStore.read(name) }

  static func documentExists(_ name: String) -> Bool { DocumentStore.exists(name) }

  static func writeDocument(_ name: String, _ contents: String) throws { try DocumentStore.write(name, contents) }

  static func documentSaved(_ name: String, _ promise: Promise) throws {
    try DocumentStore.whenSaved(name) { error in
      if let error { promise.reject("ERR_SAVE_DOCUMENT", error.localizedDescription) } else { promise.resolve(nil) }
    }
  }

  static func createDocument(_ name: String, _ contents: String, _ promise: Promise) throws {
    try DocumentStore.create(name, contents) { error in
      guard let error else { return promise.resolve(nil) }
      let exists = (error as? CocoaError)?.code == .fileWriteFileExists
      promise.reject(exists ? "ERR_DOCUMENT_EXISTS" : "ERR_CREATE_DOCUMENT", error.localizedDescription)
    }
  }

  static func listDocuments(_ prefix: String) -> [String] { DocumentStore.list(prefix) }

  static func removeDocument(_ name: String) throws { try DocumentStore.remove(name) }

  static func copyDocument(_ name: String, _ copyName: String, _ promise: Promise) throws {
    try DocumentStore.copy(name, to: copyName) { error in
      guard let error else { return promise.resolve(nil) }
      promise.reject(error is DocumentStore.DocumentGone ? "ERR_DOCUMENT_GONE" : "ERR_COPY_DOCUMENT", error.localizedDescription)
    }
  }

  static func syncDocument(_ name: String, _ promise: Promise) throws {
    try DocumentStore.sync(name) { error in
      guard let error else { return promise.resolve(nil) }
      promise.reject(error is DocumentStore.DocumentGone ? "ERR_DOCUMENT_GONE" : "ERR_SYNC_DOCUMENT", error.localizedDescription)
    }
  }

  static func saveDocument(_ name: String, _ contents: String, _ promise: Promise) throws {
    try DocumentStore.write(name, contents) { error in
      if let error { promise.reject("ERR_SAVE_DOCUMENT", error.localizedDescription) } else { promise.resolve(nil) }
    }
  }

  public func definition() -> ModuleDefinition {
    Name(Self.moduleName)

    Self.readDocumentFunction
    Self.documentExistsFunction
    Self.writeDocumentFunction
    Self.documentSavedFunction
    Self.createDocumentFunction
    Self.listDocumentsFunction
    Self.removeDocumentFunction
    Self.copyDocumentFunction
    Self.syncDocumentFunction
    Self.saveDocumentFunction
  }
}
