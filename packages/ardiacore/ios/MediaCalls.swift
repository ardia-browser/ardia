import ExpoModulesCore

func mediaCallTable(displayMediaSources displayMediaSourcesHandler: @escaping CallHandler, displayMediaThumbnails displayMediaThumbnailsHandler: @escaping CallHandler, screenRecordingAllowed screenRecordingAllowedHandler: @escaping CallHandler, requestScreenRecording requestScreenRecordingHandler: @escaping CallHandler, selectDevice selectDeviceHandler: @escaping CallHandler, cancelDeviceChooser cancelDeviceChooserHandler: @escaping CallHandler, refreshDeviceChooser refreshDeviceChooserHandler: @escaping CallHandler, openBluetoothSettings openBluetoothSettingsHandler: @escaping CallHandler, devShowBluetoothChooser devShowBluetoothChooserHandler: @escaping CallHandler, devChooserEvents devChooserEventsHandler: @escaping CallHandler, showCastDialog showCastDialogHandler: @escaping CallHandler, startCasting startCastingHandler: @escaping CallHandler, stopCasting stopCastingHandler: @escaping CallHandler, closeCastDialog closeCastDialogHandler: @escaping CallHandler, watchCastRoutes watchCastRoutesHandler: @escaping CallHandler, terminateCastRoute terminateCastRouteHandler: @escaping CallHandler, changeCaptureSource changeCaptureSourceHandler: @escaping CallHandler, stopCapture stopCaptureHandler: @escaping CallHandler) -> CallTable {
  CallTable(domain: "media", handlers: [
    "displayMediaSources": displayMediaSourcesHandler,
    "displayMediaThumbnails": displayMediaThumbnailsHandler,
    "screenRecordingAllowed": screenRecordingAllowedHandler,
    "requestScreenRecording": requestScreenRecordingHandler,
    "selectDevice": selectDeviceHandler,
    "cancelDeviceChooser": cancelDeviceChooserHandler,
    "refreshDeviceChooser": refreshDeviceChooserHandler,
    "openBluetoothSettings": openBluetoothSettingsHandler,
    "devShowBluetoothChooser": devShowBluetoothChooserHandler,
    "devChooserEvents": devChooserEventsHandler,
    "showCastDialog": showCastDialogHandler,
    "startCasting": startCastingHandler,
    "stopCasting": stopCastingHandler,
    "closeCastDialog": closeCastDialogHandler,
    "watchCastRoutes": watchCastRoutesHandler,
    "terminateCastRoute": terminateCastRouteHandler,
    "changeCaptureSource": changeCaptureSourceHandler,
    "stopCapture": stopCaptureHandler,
  ])
}
