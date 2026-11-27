import Foundation

public struct SparkleFailure: Equatable {
  public enum Stage: String { case download, install }

  public let stage: Stage
  public let reason: String

  public static let sparkleDomain = "SUSparkleErrorDomain"

  public init(stage: Stage, reason: String) {
    self.stage = stage
    self.reason = reason
  }

  public static func of(domain: String, code: Int, downloading: Bool) -> SparkleFailure? {
    guard domain == sparkleDomain else {
      return downloading ? SparkleFailure(stage: .download, reason: domain == NSURLErrorDomain ? "network" : "other") : nil
    }
    switch code {
    case 2000: return SparkleFailure(stage: .download, reason: "disk")
    case 2001: return SparkleFailure(stage: .download, reason: "network")
    case 3000: return SparkleFailure(stage: .install, reason: "extract")
    case 3001, 3002: return SparkleFailure(stage: .install, reason: "signature")
    case 4000, 4012: return SparkleFailure(stage: .install, reason: "disk")
    case 4001: return SparkleFailure(stage: .install, reason: "auth")
    case 4002, 4003: return SparkleFailure(stage: .install, reason: "missing")
    case 4004: return SparkleFailure(stage: .install, reason: "relaunch")
    case 4005, 4010: return SparkleFailure(stage: .install, reason: "install")
    case 4006: return SparkleFailure(stage: .install, reason: "notNewer")
    case 4009: return SparkleFailure(stage: .install, reason: "kind")
    default: return downloading ? SparkleFailure(stage: .download, reason: "other") : nil
    }
  }

  public var event: [String: Any] { ["type": "updateFailed", "stage": stage.rawValue, "reason": reason] }
}
