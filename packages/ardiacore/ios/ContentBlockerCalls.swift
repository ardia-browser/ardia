import ExpoModulesCore

func contentBlockerCallTable(state stateHandler: @escaping CallHandler, setEnabled setEnabledHandler: @escaping CallHandler, setListEnabled setListEnabledHandler: @escaping CallHandler, addList addListHandler: @escaping CallHandler, removeList removeListHandler: @escaping CallHandler, isAllowed isAllowedHandler: @escaping CallHandler, setAllowed setAllowedHandler: @escaping CallHandler, removeAllowed removeAllowedHandler: @escaping CallHandler, hiddenElements hiddenElementsHandler: @escaping CallHandler, hideElements hideElementsHandler: @escaping CallHandler, restoreElements restoreElementsHandler: @escaping CallHandler, devFailNextMessage devFailNextMessageHandler: @escaping CallHandler, devDelayNextLoad devDelayNextLoadHandler: @escaping CallHandler) -> CallTable {
  CallTable(domain: "contentBlocker", handlers: [
    "state": stateHandler,
    "setEnabled": setEnabledHandler,
    "setListEnabled": setListEnabledHandler,
    "addList": addListHandler,
    "removeList": removeListHandler,
    "isAllowed": isAllowedHandler,
    "setAllowed": setAllowedHandler,
    "removeAllowed": removeAllowedHandler,
    "hiddenElements": hiddenElementsHandler,
    "hideElements": hideElementsHandler,
    "restoreElements": restoreElementsHandler,
    "devFailNextMessage": devFailNextMessageHandler,
    "devDelayNextLoad": devDelayNextLoadHandler,
  ])
}
