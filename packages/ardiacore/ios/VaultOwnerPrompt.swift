import LocalAuthentication

enum VaultOwnerPrompt {
  enum Outcome: Equatable, Sendable {
    case granted
    case denied
    case askWithPassword
  }

  static func afterBiometrics(granted: Bool, code: LAError.Code?) -> Outcome {
    if granted { return .granted }
    switch code {
    case .userFallback?, .biometryLockout?, .biometryDisconnected?, .biometryNotAvailable?, .biometryNotEnrolled?, .biometryNotPaired?:
      return .askWithPassword
    default: return .denied
    }
  }
}
