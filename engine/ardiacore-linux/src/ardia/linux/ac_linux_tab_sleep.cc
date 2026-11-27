#include "ardia/linux/ac_linux_tab_sleep.h"

#include <cmath>
#include <optional>
#include <utility>
#include <vector>

#include "base/memory/weak_ptr.h"
#include "base/time/time.h"
#include "chrome/browser/performance_manager/policies/cannot_discard_reason.h"
#include "chrome/browser/performance_manager/policies/discard_eligibility_policy.h"
#include "chrome/browser/performance_manager/policies/page_discarding_helper.h"
#include "components/performance_manager/public/graph/graph.h"
#include "components/performance_manager/public/graph/page_node.h"
#include "components/performance_manager/public/performance_manager.h"
#include "content/public/browser/web_contents.h"

namespace ardiacore {

namespace {

base::ListValue Unavailable() {
  base::ListValue codes;
  codes.Append(base::Value(kLinuxSleepUnavailable));
  return codes;
}

namespace policies = performance_manager::policies;

struct LinuxSleepTarget {
  base::WeakPtr<performance_manager::PageNode> page;
  policies::DiscardEligibilityPolicy* eligibility = nullptr;
  policies::PageDiscardingHelper* discarding = nullptr;
};

std::optional<LinuxSleepTarget> TargetFor(content::WebContents* contents) {
  using performance_manager::PerformanceManager;
  if (!PerformanceManager::IsAvailable()) return std::nullopt;
  base::WeakPtr<performance_manager::PageNode> page = PerformanceManager::GetPrimaryPageNodeForWebContents(contents);
  if (!page) return std::nullopt;
  performance_manager::Graph* graph = page->GetGraph();
  auto* eligibility = policies::DiscardEligibilityPolicy::GetFromGraph(graph);
  auto* discarding = policies::PageDiscardingHelper::GetFromGraph(graph);
  if (!eligibility || !discarding) return std::nullopt;
  return LinuxSleepTarget{page, eligibility, discarding};
}

std::vector<int> KeptAwakeCodes(const LinuxTabKeptAwake& kept_awake) {
  std::vector<int> codes;
  if (kept_awake.posted_document) codes.push_back(kLinuxKeptByPostedDocument);
  if (kept_awake.before_unload) codes.push_back(kLinuxKeptByBeforeUnload);
  if (kept_awake.download) codes.push_back(kLinuxKeptByDownload);
  return codes;
}

bool IsSoftKeep(policies::CannotDiscardReason reason) {
  return reason == policies::CannotDiscardReason::kNotificationsEnabled || reason == policies::CannotDiscardReason::kPinnedTab ||
         reason == policies::CannotDiscardReason::kBackgroundActivity;
}

base::ListValue CodesList(const std::vector<int>& codes) {
  base::ListValue list;
  for (int code : codes) list.Append(base::Value(code));
  return list;
}

enum class SoftKeeps { kKeep, kPass };

base::ListValue SleepLinuxTab(content::WebContents* contents, double seconds, const LinuxTabKeptAwake& kept_awake, SoftKeeps soft) {
  if (!contents || contents->WasDiscarded()) return Unavailable();
  const auto target = TargetFor(contents);
  if (!target) return Unavailable();
  const auto reason = policies::DiscardEligibilityPolicy::DiscardReason::PROACTIVE;
  std::vector<policies::CannotDiscardReason> kept_by;
  const bool eligible = target->eligibility->CanDiscardWithCustomRecentVisibilityWindow(target->page.get(), reason, base::Seconds(seconds), &kept_by) ==
                        policies::CanDiscardResult::kEligible;
  std::vector<int> codes = KeptAwakeCodes(kept_awake);
  bool only_soft = codes.empty() && !kept_by.empty();
  for (policies::CannotDiscardReason kept : kept_by) {
    codes.push_back(static_cast<int>(kept));
    only_soft = only_soft && IsSoftKeep(kept);
  }
  if (eligible && codes.empty()) {
    if (!target->discarding->ImmediatelyDiscardMultiplePages({target->page.get()}, reason)) return Unavailable();
    return base::ListValue();
  }
  if (codes.empty()) return Unavailable();
  if (soft == SoftKeeps::kKeep || !only_soft) return CodesList(codes);
  if (!target->discarding->ImmediatelyDiscardMultiplePages({target->page.get()}, policies::DiscardEligibilityPolicy::DiscardReason::EXTERNAL)) {
    return CodesList(codes);
  }
  return CodesList({kLinuxSleptPastSoftKeeps});
}

}

std::optional<double> ParseLinuxSleepSeconds(const base::ListValue& args) {
  if (args.size() != 1 || !(args[0].is_int() || args[0].is_double())) return std::nullopt;
  const double seconds = args[0].GetDouble();
  if (!std::isfinite(seconds) || seconds < 0 || seconds > kLinuxSleepLongestHiddenSeconds) return std::nullopt;
  return seconds;
}

base::ListValue SleepLinuxTabIfHidden(content::WebContents* contents, double seconds, const LinuxTabKeptAwake& kept_awake) {
  return SleepLinuxTab(contents, seconds, kept_awake, SoftKeeps::kKeep);
}

base::ListValue SleepLinuxTabIfUnused(content::WebContents* contents, double seconds, const LinuxTabKeptAwake& kept_awake) {
  return SleepLinuxTab(contents, seconds, kept_awake, SoftKeeps::kPass);
}

}
