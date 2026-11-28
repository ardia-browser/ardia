import Foundation

enum ResponseDownload {
  static func wanted(canShow: Bool, mainFrame: Bool, disposition: String?, response: URL?, page: URL?) -> Bool {
    if !canShow { return true }
    guard let disposition, disposition.trimmingCharacters(in: .whitespaces).lowercased().hasPrefix("attachment") else { return false }
    if mainFrame { return true }
    guard let host = PageHost.key(response) else { return false }
    return host == PageHost.key(page)
  }
}
