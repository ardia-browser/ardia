import Darwin
import Foundation

enum PluginFileBatch {
  static let inlineFileBytes = 256 * 1024
  static let inlineBudget = 640 * 1024

  struct Opened {
    var files: [[String: Any]] = []
    var handles: [String] = []
  }

  static func encodedLength(_ text: String) -> Int {
    guard let data = try? JSONSerialization.data(withJSONObject: [text]) else { return Int.max }
    return data.count - 4
  }

  private enum Inline {
    case fits(data: String, encoding: String, cost: Int)
    case handle
    case unreadable
  }

  private static func inline(_ fd: Int32, size: Int, textual: Bool, budget: Int) -> Inline {
    guard size <= inlineFileBytes, textual || (size + 2) / 3 * 4 <= budget else { return .handle }
    guard let bytes = PluginBoundedFile.readWhole(fd, max: inlineFileBytes) else { return .unreadable }
    if textual, let text = String(data: bytes, encoding: .utf8) {
      let cost = encodedLength(text)
      return cost <= budget ? .fits(data: text, encoding: "utf8", cost: cost) : .handle
    }
    let encoded = bytes.base64EncodedString()
    return encoded.utf8.count <= budget ? .fits(data: encoded, encoding: "base64", cost: encoded.utf8.count) : .handle
  }

  static func open(
    _ paths: [String], maxBytes: Int, skipRefused: Bool = false, textual: (String) -> Bool, mimeType: (String) -> String, register: (Int32, Int) -> String?,
    discard: ([String]) -> Void
  ) -> Result<Opened, FolderRefusal> {
    var opened = Opened()
    var budget = inlineBudget
    var skipped: String?
    func refuse(_ reason: String) -> Result<Opened, FolderRefusal> {
      discard(opened.handles)
      return .failure(FolderRefusal(reason: reason))
    }
    for path in paths {
      let name = URL(fileURLWithPath: path).lastPathComponent
      switch PluginBoundedFile.openRegular(path) {
      case .failure(let refusal):
        if skipRefused {
          skipped = skipped ?? "\(name): \(refusal.reason)"
          continue
        }
        return refuse("\(name): \(refusal.reason)")
      case .success(let file):
        guard file.size <= maxBytes else {
          Darwin.close(file.fd)
          let reason = "\(name) is over \(maxBytes >> 20 > 0 ? "\(maxBytes >> 20) MB" : "\(maxBytes) bytes")"
          if skipRefused {
            skipped = skipped ?? reason
            continue
          }
          return refuse(reason)
        }
        var row: [String: Any] = ["name": name, "size": file.size, "mimeType": mimeType(path)]
        switch inline(file.fd, size: file.size, textual: textual(path), budget: budget) {
        case .unreadable:
          Darwin.close(file.fd)
          return refuse("\(name) couldn't be read")
        case .fits(let data, let encoding, let cost):
          Darwin.close(file.fd)
          budget -= cost
          row["data"] = data
          row["encoding"] = encoding
        case .handle:
          guard let handle = register(file.fd, file.size) else { return refuse("the plugin has too many files open, or it stopped") }
          opened.handles.append(handle)
          row["data"] = ""
          row["encoding"] = "base64"
          row["handle"] = handle
        }
        opened.files.append(row)
      }
    }
    if opened.files.isEmpty, let skipped { return .failure(FolderRefusal(reason: skipped)) }
    return .success(opened)
  }
}
