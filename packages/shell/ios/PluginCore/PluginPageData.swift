import WebKit

enum PluginPageData {
  static func remove(_ identifier: UUID, done: @escaping (Error?) -> Void) {
    _ = WKWebViewConfiguration()
    WKWebsiteDataStore.remove(forIdentifier: identifier, completionHandler: done)
  }
}
