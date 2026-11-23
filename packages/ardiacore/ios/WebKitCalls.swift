import ExpoModulesCore

func webKitCallTable(removeDownloadStaging removeDownloadStagingHandler: @escaping CallHandler, endPrivateSession endPrivateSessionHandler: @escaping CallHandler, cookieStoreKey cookieStoreKeyHandler: @escaping CallHandler, importCookies importCookiesHandler: @escaping CallHandler, exportCookies exportCookiesHandler: @escaping CallHandler, writeCopiedAddress writeCopiedAddressHandler: @escaping CallHandler, setFraudWarnings setFraudWarningsHandler: @escaping CallHandler, watchSiteData watchSiteDataHandler: @escaping CallHandler, siteDataReady siteDataReadyHandler: @escaping CallHandler, readSiteData readSiteDataHandler: @escaping CallHandler, writeSiteData writeSiteDataHandler: @escaping CallHandler, setZoom setZoomHandler: @escaping CallHandler, notificationAction notificationActionHandler: @escaping CallHandler, passkeyAccess passkeyAccessHandler: @escaping CallHandler, requestPasskeyAccess requestPasskeyAccessHandler: @escaping CallHandler, devStoreExists devStoreExistsHandler: @escaping CallHandler, devHoldStore devHoldStoreHandler: @escaping CallHandler, devTouchStore devTouchStoreHandler: @escaping CallHandler, devParkedTransfers devParkedTransfersHandler: @escaping CallHandler, devContentBlocker devContentBlockerHandler: @escaping CallHandler) -> CallTable {
  CallTable(domain: "webKit", handlers: [
    "removeDownloadStaging": removeDownloadStagingHandler,
    "endPrivateSession": endPrivateSessionHandler,
    "cookieStoreKey": cookieStoreKeyHandler,
    "importCookies": importCookiesHandler,
    "exportCookies": exportCookiesHandler,
    "writeCopiedAddress": writeCopiedAddressHandler,
    "setFraudWarnings": setFraudWarningsHandler,
    "watchSiteData": watchSiteDataHandler,
    "siteDataReady": siteDataReadyHandler,
    "readSiteData": readSiteDataHandler,
    "writeSiteData": writeSiteDataHandler,
    "setZoom": setZoomHandler,
    "notificationAction": notificationActionHandler,
    "passkeyAccess": passkeyAccessHandler,
    "requestPasskeyAccess": requestPasskeyAccessHandler,
    "devStoreExists": devStoreExistsHandler,
    "devHoldStore": devHoldStoreHandler,
    "devTouchStore": devTouchStoreHandler,
    "devParkedTransfers": devParkedTransfersHandler,
    "devContentBlocker": devContentBlockerHandler,
  ])
}
