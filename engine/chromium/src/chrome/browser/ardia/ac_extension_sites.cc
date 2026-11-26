// Copyright 2026 Ardia. Apache-2.0.

#include "chrome/browser/ardia/ac_extension_sites_internal.h"

#include <memory>
#include <optional>
#include <string>
#include <utility>

#include "base/functional/bind.h"
#include "base/memory/weak_ptr.h"
#include "chrome/browser/profiles/profile.h"
#include "extensions/browser/extension_prefs.h"
#include "extensions/browser/extension_registry.h"
#include "extensions/browser/permissions/permissions_updater.h"
#include "extensions/browser/permissions/scripting_permissions_modifier.h"
#include "extensions/browser/permissions_manager.h"
#include "extensions/common/extension.h"
#include "extensions/common/manifest_handlers/permissions_parser.h"
#include "extensions/common/permissions/api_permission_set.h"
#include "extensions/common/permissions/manifest_permission_set.h"
#include "extensions/common/permissions/permission_set.h"
#include "extensions/common/url_pattern.h"
#include "extensions/common/url_pattern_set.h"
#include "url/url_constants.h"

namespace ardia::extension_sites_internal {
namespace {

std::optional<URLPattern> RuntimeSitePattern(const std::string& site) {
  URLPattern pattern(URLPattern::SCHEME_HTTP | URLPattern::SCHEME_HTTPS |
                     URLPattern::SCHEME_FILE);
  if (pattern.Parse(site) != URLPattern::ParseResult::kSuccess ||
      pattern.path() != "/*") {
    return std::nullopt;
  }
  pattern.SetValidSchemes(pattern.scheme() == url::kFileScheme
                              ? URLPattern::SCHEME_FILE
                              : URLPattern::SCHEME_HTTP |
                                    URLPattern::SCHEME_HTTPS);
  return pattern;
}

std::unique_ptr<const extensions::PermissionSet> Overlap(
    const extensions::PermissionSet& one,
    const extensions::PermissionSet& other) {
  return extensions::PermissionSet::CreateIntersection(
      one, other, extensions::URLPatternSet::IntersectionBehavior::kDetailed);
}

std::unique_ptr<const extensions::PermissionSet> ApprovedOptionalHosts(
    Profile* profile,
    const extensions::Extension& extension,
    const extensions::PermissionSet& asked) {
  std::unique_ptr<const extensions::PermissionSet> approved =
      extensions::ExtensionPrefs::Get(profile)->GetGrantedPermissions(
          extension.id());
  std::unique_ptr<const extensions::PermissionSet> optional = Overlap(
      asked, extensions::PermissionsParser::GetOptionalPermissions(&extension));
  if (!approved) {
    return std::make_unique<extensions::PermissionSet>();
  }
  std::unique_ptr<const extensions::PermissionSet> hosts =
      Overlap(*optional, *approved);
  return std::make_unique<extensions::PermissionSet>(
      extensions::APIPermissionSet(), extensions::ManifestPermissionSet(),
      hosts->explicit_hosts().Clone(), hosts->scriptable_hosts().Clone());
}

extensions::PermissionSet HostPermissions(const URLPattern& pattern) {
  extensions::URLPatternSet hosts({pattern});
  extensions::URLPatternSet scriptable = hosts.Clone();
  return extensions::PermissionSet(extensions::APIPermissionSet(),
                                   extensions::ManifestPermissionSet(),
                                   std::move(hosts), std::move(scriptable));
}

}

std::string SiteProblem(Profile* profile,
                        const extensions::Extension& extension,
                        const std::string& site,
                        bool grant) {
  if (!extensions::PermissionsManager::Get(profile)->CanAffectExtension(
          extension)) {
    return "Can't change this extension's site access";
  }
  std::optional<URLPattern> pattern = RuntimeSitePattern(site);
  if (!pattern) {
    return "That isn't a site an extension can be given";
  }
  if (!grant) {
    return "";
  }
  extensions::PermissionSet asked = HostPermissions(*pattern);
  if (asked.ShouldWarnAllHosts(false)) {
    return "That covers every site. Choose On all sites instead";
  }
  if (Overlap(asked,
              extensions::PermissionsParser::GetRequiredPermissions(&extension))
          ->effective_hosts()
          .is_empty() &&
      ApprovedOptionalHosts(profile, extension, asked)
          ->effective_hosts()
          .is_empty()) {
    return "This extension doesn't ask for that site";
  }
  return "";
}

void ChangeSite(Profile* profile,
                const extensions::Extension& extension,
                const std::string& site,
                bool grant,
                Reply reply) {
  std::optional<URLPattern> pattern = RuntimeSitePattern(site);
  if (!pattern) {
    return reply.Error("That isn't a site an extension can be given");
  }
  auto done = base::BindOnce([](Reply sent) { sent.Ok(); }, std::move(reply));
  if (!grant) {
    extensions::ScriptingPermissionsModifier(profile, &extension)
        .RemoveHostPermissions(*pattern, std::move(done));
    return;
  }
  extensions::PermissionSet asked = HostPermissions(*pattern);
  std::unique_ptr<const extensions::PermissionSet> optional =
      ApprovedOptionalHosts(profile, extension, asked);
  extensions::PermissionsUpdater updater(profile);
  if (optional->effective_hosts().is_empty()) {
    updater.GrantRuntimePermissions(extension, asked, std::move(done));
    return;
  }
  updater.GrantOptionalPermissions(
      extension, *optional,
      base::BindOnce(
          [](base::WeakPtr<Profile> profile, std::string id,
             extensions::PermissionSet asked, base::OnceClosure done) {
            const extensions::Extension* extension =
                profile ? extensions::ExtensionRegistry::Get(profile.get())
                              ->GetExtensionById(
                                  id, extensions::ExtensionRegistry::EVERYTHING)
                        : nullptr;
            if (!extension) {
              return std::move(done).Run();
            }
            extensions::PermissionsUpdater(profile.get())
                .GrantRuntimePermissions(*extension, asked, std::move(done));
          },
          profile->GetWeakPtr(), extension.id(), std::move(asked),
          std::move(done)));
}

}
