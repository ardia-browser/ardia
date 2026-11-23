import Foundation

public struct DevtoolsEndpoint: Equatable {
  public let port: Int
  public let generation: Int
  public let token: String

  public enum Problem: String, Error, CaseIterable {
    case off
    case unreadable
  }

  public init(port: Int, generation: Int, token: String) {
    self.port = port
    self.generation = generation
    self.token = token
  }

  public var reply: [String: Any] { ["port": port, "generation": generation, "token": token] }

  public static let engineCall = "ac_cli_devtools_endpoint"

  public static func read(engineReply reply: [String: Any]) -> Result<DevtoolsEndpoint, Problem> {
    guard let port = whole(reply["port"]), (1...65535).contains(port), let generation = whole(reply["generation"]), generation > 0 else { return .failure(.off) }
    guard let token = reply["token"] as? String, isToken(token) else { return .failure(.unreadable) }
    return .success(DevtoolsEndpoint(port: port, generation: generation, token: token))
  }

  public static func isToken(_ text: String) -> Bool {
    (16...256).contains(text.utf8.count) && text.utf8.allSatisfy { byte in
      (byte >= 0x30 && byte <= 0x39) || (byte >= 0x41 && byte <= 0x5A) || (byte >= 0x61 && byte <= 0x7A) || byte == 0x2D || byte == 0x5F
    }
  }

  private static func whole(_ value: Any?) -> Int? {
    guard let number = value as? NSNumber, CFGetTypeID(number) != CFBooleanGetTypeID() else { return nil }
    let double = number.doubleValue
    guard double.isFinite, double == double.rounded(), abs(double) < 1e15 else { return nil }
    return Int(double)
  }
}
