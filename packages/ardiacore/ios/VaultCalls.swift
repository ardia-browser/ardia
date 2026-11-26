import ExpoModulesCore

func vaultCallTable(state stateHandler: @escaping CallHandler, screenLocked screenLockedHandler: @escaping CallHandler, signIn signInHandler: @escaping CallHandler, cancelSignIn cancelSignInHandler: @escaping CallHandler, warm warmHandler: @escaping CallHandler, saveSecret saveSecretHandler: @escaping CallHandler, keepOfferedCode keepOfferedCodeHandler: @escaping CallHandler, hasSecret hasSecretHandler: @escaping CallHandler, secrets secretsHandler: @escaping CallHandler, removeSecret removeSecretHandler: @escaping CallHandler, always alwaysHandler: @escaping CallHandler, setAlways setAlwaysHandler: @escaping CallHandler, authenticate authenticateHandler: @escaping CallHandler, cancelAuthenticate cancelAuthenticateHandler: @escaping CallHandler, appendLog appendLogHandler: @escaping CallHandler, readLog readLogHandler: @escaping CallHandler) -> CallTable {
  CallTable(domain: "vault", handlers: [
    "state": stateHandler,
    "screenLocked": screenLockedHandler,
    "signIn": signInHandler,
    "cancelSignIn": cancelSignInHandler,
    "warm": warmHandler,
    "saveSecret": saveSecretHandler,
    "keepOfferedCode": keepOfferedCodeHandler,
    "hasSecret": hasSecretHandler,
    "secrets": secretsHandler,
    "removeSecret": removeSecretHandler,
    "always": alwaysHandler,
    "setAlways": setAlwaysHandler,
    "authenticate": authenticateHandler,
    "cancelAuthenticate": cancelAuthenticateHandler,
    "appendLog": appendLogHandler,
    "readLog": readLogHandler,
  ])
}
