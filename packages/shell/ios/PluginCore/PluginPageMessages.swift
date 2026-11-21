import Foundation

struct PageMessageRefusal: Error, Equatable {
  let reason: String
}

struct PagePost: Equatable {
  let view: String?
  let json: String
}

enum PluginPageMessages {
  static let maxFromPage = 64 << 10
  static let maxToPage = 256 << 10
  static let perSecond = 100

  static func line(_ object: [String: Any]) -> Data {
    var data = (try? JSONSerialization.data(withJSONObject: object, options: [.sortedKeys, .fragmentsAllowed])) ?? Data()
    data.append(10)
    return data
  }

  static func fromPage(_ body: Any, view: String) -> Data? {
    guard let text = body as? String, text.utf8.count <= maxFromPage, let message = try? JSONSerialization.jsonObject(with: Data(text.utf8), options: [.fragmentsAllowed])
    else { return nil }
    return line(["pageMessage": message, "view": view])
  }

  static func toPage(_ params: [String: Any]) -> Result<PagePost, PageMessageRefusal> {
    if params["view"] != nil && !(params["view"] is String) { return .failure(.init(reason: "view must be the id a page message came with")) }
    guard let message = params["message"] else { return .failure(.init(reason: "page.post needs a message")) }
    guard let data = try? JSONSerialization.data(withJSONObject: message, options: [.fragmentsAllowed]), let json = String(data: data, encoding: .utf8) else {
      return .failure(.init(reason: "the message must be JSON"))
    }
    guard data.count <= maxToPage else { return .failure(.init(reason: "a message to a page can be at most 256 KB")) }
    return .success(PagePost(view: params["view"] as? String, json: json))
  }

  static func answer(_ line: String, hasPage: Bool, post: (PagePost) -> String?) -> Data? {
    guard let object = try? JSONSerialization.jsonObject(with: Data(line.utf8)) as? [String: Any], object["method"] as? String == "page.post" else { return nil }
    var reply: [String: Any]
    if !hasPage {
      reply = ["error": ["code": "refused", "message": "This plugin has no page."]]
    } else {
      switch toPage(object["params"] as? [String: Any] ?? [:]) {
      case .success(let message):
        if let code = post(message) {
          reply = ["error": ["code": code, "message": "The page has too many messages waiting; send more once it has caught up."]]
        } else {
          reply = ["result": ["ok": true]]
        }
      case .failure(let refusal):
        reply = ["error": ["code": "bad_request", "message": refusal.reason]]
      }
    }
    if let id = object["id"] { reply["id"] = id }
    return self.line(reply)
  }

  final class Limit {
    private var windowStart: TimeInterval = -.infinity
    private var count = 0

    func allow(now: TimeInterval) -> Bool {
      if now - windowStart >= 1 {
        windowStart = now
        count = 0
      }
      count += 1
      return count <= PluginPageMessages.perSecond
    }
  }
}
