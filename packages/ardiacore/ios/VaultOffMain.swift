import Foundation

enum VaultOffMain {
  static func check(_ work: StaticString = #function) {
    #if DEBUG
    if Thread.isMainThread { preconditionFailure("\(work) is vault work and must not run on the main thread") }
    #endif
  }
}
