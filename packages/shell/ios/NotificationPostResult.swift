struct NotificationPostResult {
  var id: String?
  var icon: NotificationIcon
  var errorDomain: String?
  var errorCode: Int?

  var payload: [String: Any] {
    var out: [String: Any] = ["icon": icon.status]
    if let id { out["id"] = id }
    if let iconErrorCode = icon.errorCode { out["iconErrorCode"] = iconErrorCode }
    if let errorDomain { out["errorDomain"] = errorDomain }
    if let errorCode { out["errorCode"] = errorCode }
    return out
  }
}
