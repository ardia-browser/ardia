import Foundation

public enum CrashThread {
  public static func identified(in body: [String: Any]) -> Int? {
    let threads = body["threads"] as? [[String: Any]] ?? []
    if let faulting = body["faultingThread"] as? Int, threads.indices.contains(faulting) { return faulting }
    return threads.firstIndex { $0["triggered"] as? Bool == true }
  }

  public static func stack(in body: [String: Any]) -> Int {
    identified(in: body) ?? 0
  }

  public static func names(in body: [String: Any]) -> (thread: String?, queue: String?) {
    let threads = body["threads"] as? [[String: Any]] ?? []
    guard let index = identified(in: body) else { return (nil, nil) }
    return (threads[index]["name"] as? String, threads[index]["queue"] as? String)
  }
}
