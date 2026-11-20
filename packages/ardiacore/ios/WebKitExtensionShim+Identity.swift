extension WebKitExtensionShimNamespace {
  static let identity = WebKitExtensionShimNamespace(name: "identity", script: #"""
      if (APIS.includes("identity") && !CONTENT) {
        const identity = api("identity", ["launchWebAuthFlow"], ["onSignInChanged"], { AccountStatus: { SYNC: "SYNC", ANY: "ANY" } });
        identity.getRedirectURL = (path) => `https://${runtime.id}.chromiumapp.org/${typeof path === "string" ? path.replace(/^\//, "") : ""}`;
        const manifest = typeof runtime.getManifest === "function" ? runtime.getManifest() : {};
        const clientId = manifest && manifest.oauth2 && manifest.oauth2.client_id;
        identity.getAuthToken = withCallback(() => failure(clientId ? "The user is not signed in." : "Invalid OAuth2 Client ID."));
        identity.removeCachedAuthToken = withCallback(() => Promise.resolve());
        identity.clearAllCachedAuthTokens = withCallback(() => Promise.resolve());
        identity.getAccounts = withCallback(() => Promise.resolve([]));
        identity.getProfileUserInfo = withCallback(() => Promise.resolve({ email: "", id: "" }));
        define("identity", identity);
      }
    """#)
}
