import AppKit
import ArdiaCore
import AuthenticationServices
import ExpoModulesCore

public class CredentialExchangeModule: Module {
  private var observer: NSObjectProtocol?
  private static let passwordsApp = URL(fileURLWithPath: "/System/Applications/Passwords.app")

  public func definition() -> ModuleDefinition {
    Name("ArdiaCredentialExchange")
    Events("onCredentialExchange")

    OnStartObserving {
      self.observer = NotificationCenter.default.addObserver(forName: CredentialExchangeInbox.arrived, object: nil, queue: .main) { [weak self] _ in
        self?.sendEvent("onCredentialExchange", ["pending": CredentialExchangeInbox.shared.pending])
      }
    }

    OnStopObserving {
      if let observer = self.observer { NotificationCenter.default.removeObserver(observer) }
      self.observer = nil
    }

    Function("status") { () -> [String: Any] in
      var supported = false
      if #available(macOS 26, *) { supported = true }
      let fixture = CredentialExchangeInbox.fixturePath != nil
      return [
        "supported": supported,
        "receivable": supported && (CredentialExchangeInbox.extensionShipped || fixture),
        "fixture": fixture,
        "pending": CredentialExchangeInbox.shared.pending,
      ]
    }

    AsyncFunction("request") { (promise: Promise) in
      if let path = CredentialExchangeInbox.fixturePath {
        guard let data = FileManager.default.contents(atPath: (path as NSString).expandingTildeInPath) else {
          return promise.reject("notFound", "No credential exchange fixture at that path")
        }
        CredentialExchangeInbox.shared.deliver(.fixture(data))
        return promise.resolve("fixture")
      }
      if LaunchConfig.shared.background {
        NSLog("[ardia] credential exchange: would open Passwords (background mode)")
        return promise.resolve("logged")
      }
      NSWorkspace.shared.openApplication(at: Self.passwordsApp, configuration: NSWorkspace.OpenConfiguration()) { app, _ in
        promise.resolve(app == nil ? "failed" : "opened")
      }
    }.runOnQueue(.main)

    AsyncFunction("take") { (promise: Promise) in
      guard #available(macOS 26, *) else { return promise.reject("unsupported", "Credential exchange needs macOS 26") }
      guard let delivery = CredentialExchangeInbox.shared.take() else { return promise.resolve(nil) }
      Task.detached(priority: .userInitiated) {
        do {
          let started = Date()
          let data: ASExportedCredentialData
          switch delivery {
          case .token(let token): data = try await ASCredentialImportManager().importCredentials(token: token)
          case .fixture(let bytes): data = try CredentialExchange.decode(bytes)
          }
          let received = Date()
          let summary = CredentialExchange.summarize(data)
          var json = try JSONSerialization.jsonObject(with: JSONEncoder().encode(summary)) as? [String: Any] ?? [:]
          json["receiveMs"] = Int(received.timeIntervalSince(started) * 1000)
          json["parseMs"] = Int(Date().timeIntervalSince(received) * 1000)
          promise.resolve(String(decoding: try JSONSerialization.data(withJSONObject: json), as: UTF8.self))
        } catch let error as ImportError {
          promise.reject(error.code, error.description)
        } catch {
          promise.reject("unreadable", error.localizedDescription)
        }
      }
    }
  }
}
