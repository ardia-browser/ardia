import ExpoModulesCore

public class DocumentsModule: Module {
  public func definition() -> ModuleDefinition {
    Name("ArdiaDocuments")

    Function("readDocument") { (name: String) -> String? in DocumentStore.read(name) }
    Function("documentExists") { (name: String) -> Bool in DocumentStore.exists(name) }
    Function("writeDocument") { (name: String, contents: String) in try DocumentStore.write(name, contents) }
    AsyncFunction("documentSaved") { (name: String, promise: Promise) in
      try DocumentStore.whenSaved(name) { error in
        if let error { promise.reject("ERR_SAVE_DOCUMENT", error.localizedDescription) } else { promise.resolve(nil) }
      }
    }
    AsyncFunction("createDocument") { (name: String, contents: String, promise: Promise) in
      try DocumentStore.create(name, contents) { error in
        guard let error else { return promise.resolve(nil) }
        let exists = (error as? CocoaError)?.code == .fileWriteFileExists
        promise.reject(exists ? "ERR_DOCUMENT_EXISTS" : "ERR_CREATE_DOCUMENT", error.localizedDescription)
      }
    }
    Function("listDocuments") { (prefix: String) -> [String] in DocumentStore.list(prefix) }
    Function("removeDocument") { (name: String) in try DocumentStore.remove(name) }
    AsyncFunction("copyDocument") { (name: String, copyName: String, promise: Promise) in
      try DocumentStore.copy(name, to: copyName) { error in
        guard let error else { return promise.resolve(nil) }
        promise.reject(error is DocumentStore.DocumentGone ? "ERR_DOCUMENT_GONE" : "ERR_COPY_DOCUMENT", error.localizedDescription)
      }
    }
    AsyncFunction("syncDocument") { (name: String, promise: Promise) in
      try DocumentStore.sync(name) { error in
        guard let error else { return promise.resolve(nil) }
        promise.reject(error is DocumentStore.DocumentGone ? "ERR_DOCUMENT_GONE" : "ERR_SYNC_DOCUMENT", error.localizedDescription)
      }
    }
    AsyncFunction("saveDocument") { (name: String, contents: String, promise: Promise) in
      try DocumentStore.write(name, contents) { error in
        if let error { promise.reject("ERR_SAVE_DOCUMENT", error.localizedDescription) } else { promise.resolve(nil) }
      }
    }
  }
}
