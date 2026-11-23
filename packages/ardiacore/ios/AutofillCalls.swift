import ExpoModulesCore

func autofillCallTable(settings settingsHandler: @escaping CallHandler, setSettings setSettingsHandler: @escaping CallHandler, addresses addressesHandler: @escaping CallHandler, saveAddress saveAddressHandler: @escaping CallHandler, cards cardsHandler: @escaping CallHandler, remove removeHandler: @escaping CallHandler, cardNumber cardNumberHandler: @escaping CallHandler, showSuggestions showSuggestionsHandler: @escaping CallHandler) -> CallTable {
  CallTable(domain: "autofill", handlers: [
    "settings": settingsHandler,
    "setSettings": setSettingsHandler,
    "addresses": addressesHandler,
    "saveAddress": saveAddressHandler,
    "cards": cardsHandler,
    "remove": removeHandler,
    "cardNumber": cardNumberHandler,
    "showSuggestions": showSuggestionsHandler,
  ])
}
