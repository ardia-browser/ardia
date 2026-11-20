import Foundation
import Network
import os

enum VaultNetwork {
  private static let reachable = OSAllocatedUnfairLock(initialState: true)
  private static let monitor: NWPathMonitor = {
    let monitor = NWPathMonitor()
    monitor.pathUpdateHandler = { path in reachable.withLock { $0 = path.status == .satisfied } }
    monitor.start(queue: DispatchQueue(label: "dev.ardia.vaults.network", qos: .utility))
    return monitor
  }()

  static func start() { _ = monitor }

  static var isOffline: Bool {
    start()
    return !reachable.withLock { $0 }
  }
}
