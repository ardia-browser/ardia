import ExpoModulesCore

func passwordsCallTable(list listHandler: @escaping CallHandler, unlock unlockHandler: @escaping CallHandler, reveal revealHandler: @escaping CallHandler, remove removeHandler: @escaping CallHandler, neverSaveOrigins neverSaveOriginsHandler: @escaping CallHandler, allowSaving allowSavingHandler: @escaping CallHandler, export exportHandler: @escaping CallHandler, autofillEnabled autofillEnabledHandler: @escaping CallHandler, setAutofillEnabled setAutofillEnabledHandler: @escaping CallHandler, setFieldProviders setFieldProvidersHandler: @escaping CallHandler, showSystemPanel showSystemPanelHandler: @escaping CallHandler, showPanelHint showPanelHintHandler: @escaping CallHandler, systemPanelAvailable systemPanelAvailableHandler: @escaping CallHandler, otpauthHandler otpauthHandlerHandler: @escaping CallHandler, setUpVerificationCode setUpVerificationCodeHandler: @escaping CallHandler) -> CallTable {
  CallTable(domain: "passwords", handlers: [
    "list": listHandler,
    "unlock": unlockHandler,
    "reveal": revealHandler,
    "remove": removeHandler,
    "neverSaveOrigins": neverSaveOriginsHandler,
    "allowSaving": allowSavingHandler,
    "export": exportHandler,
    "autofillEnabled": autofillEnabledHandler,
    "setAutofillEnabled": setAutofillEnabledHandler,
    "setFieldProviders": setFieldProvidersHandler,
    "showSystemPanel": showSystemPanelHandler,
    "showPanelHint": showPanelHintHandler,
    "systemPanelAvailable": systemPanelAvailableHandler,
    "otpauthHandler": otpauthHandlerHandler,
    "setUpVerificationCode": setUpVerificationCodeHandler,
  ])
}
