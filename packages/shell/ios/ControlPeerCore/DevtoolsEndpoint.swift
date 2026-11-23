import Darwin
import Foundation

public struct DevtoolsEndpoint: Equatable {
  public let port: Int
  public let generation: Int
  public let token: String

  public enum Problem: String, Error, CaseIterable {
    case off
    case unreadable
    case stale
  }

  public static let maxFileBytes = 64 * 1024

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

  public static func read(status: [String: Any], pid: Int32 = getpid()) -> Result<DevtoolsEndpoint, Problem> {
    guard status["state"] as? String == "on", let port = whole(status["port"]), (1...65535).contains(port), let generation = whole(status["generation"]), generation > 0 else {
      return .failure(.off)
    }
    guard let path = status["file"] as? String, path.hasPrefix("/"), let file = ownFile(path) else { return .failure(.unreadable) }
    guard whole(file["port"]) == port, whole(file["generation"]) == generation, whole(file["pid"]) == Int(pid) else { return .failure(.stale) }
    guard let token = file["token"] as? String, isToken(token) else { return .failure(.unreadable) }
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

  private static func ownFile(_ path: String) -> [String: Any]? {
    let fd = open(path, O_RDONLY | O_NOFOLLOW | O_CLOEXEC | O_NONBLOCK)
    guard fd >= 0 else { return nil }
    defer { close(fd) }
    var info = stat()
    guard PrivateFolder.privateFile(fd), fstat(fd, &info) == 0, info.st_size > 0, info.st_size <= off_t(maxFileBytes) else { return nil }
    var bytes = [UInt8](repeating: 0, count: maxFileBytes + 1)
    var filled = 0
    while filled < bytes.count {
      let got = bytes.withUnsafeMutableBytes { Darwin.read(fd, $0.baseAddress! + filled, $0.count - filled) }
      if got < 0 && errno == EINTR { continue }
      guard got >= 0 else { return nil }
      if got == 0 { break }
      filled += got
    }
    defer { bytes.withUnsafeMutableBytes { _ = memset_s($0.baseAddress, $0.count, 0, $0.count) } }
    guard filled <= maxFileBytes else { return nil }
    return (try? JSONSerialization.jsonObject(with: Data(bytes[0..<filled]))) as? [String: Any]
  }
}
