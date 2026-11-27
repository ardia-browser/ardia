import Foundation

public enum PageHost {
  public static func key(_ url: URL?) -> String? {
    guard let url, let components = URLComponents(url: url, resolvingAgainstBaseURL: false) else { return nil }
    guard var host = components.encodedHost?.lowercased(), !host.isEmpty else { return nil }
    while host.hasSuffix(".") { host.removeLast() }
    return host.isEmpty ? nil : host
  }
}
