#include <string_view>
#include <utility>

#include "ardia/linux/ac_linux_profile_service.h"
#include "ardia/linux/ac_linux_profiles.h"
#include "ardia/win/ac_calls.h"
#include "ardia/win/profiles.h"
#include "ardia/win/webui/webui_window_policy.h"
#include "base/functional/callback.h"
#include "chrome/browser/ardia/public/ac_engine.h"
#include "chrome/browser/browser_process.h"
#include "chrome/browser/profiles/profile.h"
#include "chrome/browser/profiles/profile_manager.h"

namespace ardiacore {

namespace {

using linux_profiles::ProfileError;
using linux_profiles::ProfileKind;

Profile* LoadedRegularProfile(const linux_profiles::ProfileName& name) {
  ProfileManager* manager =
      g_browser_process ? g_browser_process->profile_manager() : nullptr;
  if (!manager || name.kind == ProfileKind::kPrivate) {
    return nullptr;
  }
  Profile* profile = manager->GetProfileByPath(
      ardia_win::ProfilePath(ardia_win::ParseProfileName(
          name.id, ardia_win::webui_window::kAppProfileName)));
  return profile && !profile->IsOffTheRecord() && !profile->ShutdownStarted()
             ? profile
             : nullptr;
}

}

bool LinuxProfileHosts(std::string_view id, const Profile* window_profile) {
  const auto parsed = linux_profiles::ParseProfileName(id);
  Profile* profile = parsed ? LoadedRegularProfile(*parsed) : nullptr;
  return profile && profile == window_profile;
}

void ResolveLinuxProfile(std::string_view id, LinuxProfileDone done) {
  const auto parsed = linux_profiles::ParseProfileName(id);
  if (!parsed) {
    return std::move(done).Run(nullptr, ProfileError::kInvalid);
  }
  if (parsed->kind == ProfileKind::kPrivate) {
    return std::move(done).Run(nullptr, ProfileError::kPrivateService);
  }
  Profile* profile = LoadedRegularProfile(*parsed);
  std::move(done).Run(
      profile, profile ? ProfileError::kNone : ProfileError::kUnavailable);
}

}

extern "C" void ac_engine_call(const char* name,
                               const char* profile_dir,
                               const char* args_json,
                               ac_engine_reply_t reply,
                               void* context) {
  ac_engine_call_t call = ardia_win::FindEngineCall(name ? name : "");
  if (!call) {
    reply(context, "{\"error\":\"unknown engine call\"}");
    return;
  }
  call(profile_dir, args_json, reply, context);
}
