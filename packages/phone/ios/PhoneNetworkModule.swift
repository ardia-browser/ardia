import ExpoModulesCore
import Foundation
import Network
import os

final class PhoneNetwork: @unchecked Sendable {
  static let shared = PhoneNetwork()

  private let monitor = NWPathMonitor()
  private let queue = DispatchQueue(label: "ardia.phone.network")
  private let state = OSAllocatedUnfairLock<(online: Bool?, lostSinceWatch: Bool, listener: (@Sendable (Bool) -> Void)?)>(initialState: (nil, false, nil))

  private init() {
    monitor.pathUpdateHandler = { [weak self] path in self?.changed(path.status == .satisfied) }
    monitor.start(queue: queue)
  }

  var isOnline: Bool {
    state.withLock { $0.online } ?? (monitor.currentPath.status == .satisfied)
  }

  func watch(_ listener: @escaping @Sendable (Bool) -> Void) {
    let online = isOnline
    state.withLock {
      $0.listener = listener
      $0.lostSinceWatch = !online
    }
  }

  func unwatch() {
    state.withLock { $0.listener = nil }
  }

  private func changed(_ online: Bool) {
    let send: (@Sendable (Bool) -> Void, Bool)? = state.withLock { current in
      let before = current.online
      current.online = online
      guard let listener = current.listener, before != online else { return nil }
      if !online {
        current.lostSinceWatch = true
        return (listener, false)
      }
      guard current.lostSinceWatch else { return nil }
      current.lostSinceWatch = false
      return (listener, true)
    }
    if let send { send.0(send.1) }
  }
}

public final class PhoneNetworkModule: Module {
  public func definition() -> ModuleDefinition {
    Name("ArdiaPhoneNetwork")

    Events("onNetwork")

    Function("isOnline") { () -> Bool in
      PhoneNetwork.shared.isOnline
    }

    OnStartObserving {
      PhoneNetwork.shared.watch { [weak self] online in
        self?.sendEvent("onNetwork", ["online": online])
      }
    }

    OnStopObserving {
      PhoneNetwork.shared.unwatch()
    }

    OnDestroy {
      PhoneNetwork.shared.unwatch()
    }
  }
}
