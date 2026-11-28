import ExpoModulesCore

func boostsCallTable(setProfileBoosts setProfileBoostsHandler: @escaping CallHandler, previewBoost previewBoostHandler: @escaping CallHandler, clearBoostPreview clearBoostPreviewHandler: @escaping CallHandler) -> CallTable {
  CallTable(domain: "boosts", handlers: [
    "setProfileBoosts": setProfileBoostsHandler,
    "previewBoost": previewBoostHandler,
    "clearBoostPreview": clearBoostPreviewHandler,
  ])
}
