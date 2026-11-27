#include "ardia/mac/ac_mac_system.h"

#import <AppKit/AppKit.h>
#import <ServiceManagement/ServiceManagement.h>
#import <UniformTypeIdentifiers/UniformTypeIdentifiers.h>
#include <objc/runtime.h>

#include <algorithm>
#include <memory>
#include <set>
#include <utility>

#include "ardia/mac/ac_mac_shell_host.h"
#include "ardia/mac/ac_mac_system_policy.h"
#include "base/apple/foundation_util.h"
#include "base/base64.h"
#include "base/files/file_path.h"
#include "base/files/file_util.h"
#include "base/functional/bind.h"
#include "base/json/json_reader.h"
#include "base/json/json_writer.h"
#include "base/logging.h"
#include "base/no_destructor.h"
#include "base/scoped_observation.h"
#include "base/strings/string_number_conversions.h"
#include "base/strings/string_util.h"
#include "base/strings/sys_string_conversions.h"
#include "base/task/sequenced_task_runner.h"
#include "base/task/thread_pool.h"
#include "base/time/time.h"
#include "chrome/browser/download/download_crx_util.h"
#include "chrome/browser/lifetime/browser_shutdown.h"
#include "chrome/browser/profiles/profile.h"
#include "chrome/browser/ui/browser_window/public/browser_window_interface.h"
#include "chrome/browser/ui/tabs/tab_strip_model.h"
#include "components/download/content/public/all_download_item_notifier.h"
#include "components/download/public/common/download_interrupt_reasons.h"
#include "components/download/public/common/download_item.h"
#include "content/public/browser/download_item_utils.h"
#include "content/public/browser/download_manager.h"
#include "extensions/browser/webstore_installer.h"
#include "ui/base/base_window.h"
#include "url/gurl.h"

namespace ardia_mac {

namespace policy = system_policy;

using download::DownloadItem;
using Done = SystemServices::Done;

namespace {

constexpr base::TaskTraits kFileReads = {base::MayBlock(), base::TaskPriority::USER_VISIBLE,
                                         base::TaskShutdownBehavior::SKIP_ON_SHUTDOWN};
constexpr base::TaskTraits kFileWrites = {base::MayBlock(), base::TaskPriority::USER_VISIBLE,
                                          base::TaskShutdownBehavior::BLOCK_SHUTDOWN};

void Fail(Done done, std::string_view code, std::string_view message) {
  std::move(done).Run(false, Failure(code, message));
}

void ReplyJson(Done done, const base::Value& value) {
  std::move(done).Run(true, base::Value(base::WriteJson(value).value_or("null")));
}

double NowMs() {
  return (base::TimeTicks::Now() - base::TimeTicks()).InMillisecondsF();
}

bool Listed(DownloadItem* item) {
  if (item->IsTransient() || item->GetDownloadSource() == download::DownloadSource::EXTENSION_INSTALLER ||
      extensions::WebstoreInstaller::GetAssociatedApproval(*item)) {
    return false;
  }
  content::BrowserContext* context = content::DownloadItemUtils::GetBrowserContext(item);
  return !context || !download_crx_util::IsTrustedExtensionDownload(Profile::FromBrowserContext(context), *item);
}

const char* StateName(const DownloadItem& item) {
  switch (item.GetState()) {
    case DownloadItem::COMPLETE:
      return "finished";
    case DownloadItem::CANCELLED:
      return "cancelled";
    case DownloadItem::INTERRUPTED:
      return "failed";
    default:
      return "downloading";
  }
}

base::FilePath TargetPath(const DownloadItem& item) {
  base::FilePath path = item.GetTargetFilePath();
  return path.empty() ? item.GetFullPath() : path;
}

base::DictValue Describe(DownloadItem* item) {
  const base::FilePath path = TargetPath(*item);
  base::FilePath name = item->GetFileNameToReportUser();
  if (name.empty()) {
    name = path.BaseName();
  }
  const int64_t total = item->GetTotalBytes();
  return base::DictValue()
      .Set("id", item->GetGuid())
      .Set("url", item->GetOriginalUrl().spec())
      .Set("filename", name.value())
      .Set("path", path.value())
      .Set("state", StateName(*item))
      .Set("paused", item->IsPaused())
      .Set("received", static_cast<double>(item->GetReceivedBytes()))
      .Set("total", total > 0 ? static_cast<double>(total) : -1.0)
      .Set("speed", static_cast<double>(item->CurrentSpeed()))
      .Set("mimeType", item->GetMimeType())
      .Set("dangerous", item->IsDangerous() || item->IsInsecure())
      .Set("error", item->GetLastReason() == download::DOWNLOAD_INTERRUPT_REASON_NONE
                        ? base::Value()
                        : base::Value(download::DownloadInterruptReasonToString(item->GetLastReason())))
      .Set("offTheRecord", false)
      .Set("startTime", item->GetStartTime().InMillisecondsFSinceUnixEpoch())
      .Set("sha256", item->GetState() == DownloadItem::COMPLETE && !item->GetHash().empty()
                         ? base::Value(base::ToLowerASCII(base::HexEncode(item->GetHash())))
                         : base::Value());
}

std::optional<base::DictValue> ParseInput(const base::Value* args) {
  if (args && !args->is_string() && !args->is_none()) {
    return std::nullopt;
  }
  const std::string json = args && args->is_string() ? args->GetString() : "{}";
  if (json.size() > 1024 * 1024 || json.find('\0') != std::string::npos) {
    return std::nullopt;
  }
  std::optional<base::Value> parsed = base::JSONReader::Read(json, base::JSON_PARSE_RFC, 16);
  if (!parsed || !parsed->is_dict()) {
    return std::nullopt;
  }
  return std::move(parsed->GetDict());
}

std::string ValidateDownloads(std::string_view name, const base::DictValue& input) {
  if (name == "downloads.list") {
    return input.empty() ? std::string() : "Listing downloads takes no arguments";
  }
  if (name == "downloads.remove") {
    const std::string* id = input.FindString("id");
    return input.size() == 1 && id && policy::ValidDownloadId(*id) ? std::string()
                                                                  : "A valid download id is required";
  }
  const base::Value* keep = input.Find("keep");
  const base::Value* before = input.Find("before");
  if (input.size() != 2 || !keep || !before || !keep->is_list() || !(before->is_int() || before->is_double())) {
    return "Clearing downloads requires the kept ids and a cutoff";
  }
  if (keep->GetList().size() > policy::kMaxKeptDownloads) {
    return "Too many kept downloads";
  }
  for (const base::Value& id : keep->GetList()) {
    if (!id.is_string() || !policy::ValidDownloadId(id.GetString())) {
      return "Kept downloads need valid ids";
    }
  }
  return policy::ValidClearCutoff(before->GetDouble()) ? std::string() : "The clearing cutoff must be a time";
}

NSWindow* HostWindow(ShellHostView* host) {
  BrowserWindowInterface* browser = host ? host->browser() : nullptr;
  ui::BaseWindow* window = browser ? browser->GetWindow() : nullptr;
  return window ? window->GetNativeWindow().GetNativeNSWindow() : nil;
}

std::shared_ptr<Done> Share(Done done) {
  return std::make_shared<Done>(std::move(done));
}

void Settle(scoped_refptr<base::SequencedTaskRunner> runner, std::shared_ptr<Done> done, bool success,
            base::Value value) {
  runner->PostTask(FROM_HERE, base::BindOnce(
                                  [](std::shared_ptr<Done> done, bool success, base::Value value) {
                                    if (*done) {
                                      std::move(*done).Run(success, std::move(value));
                                    }
                                  },
                                  std::move(done), success, std::move(value)));
}

std::optional<std::string> PngDataUrl(NSImage* image, double points) {
  if (!image) {
    return std::nullopt;
  }
  const NSInteger pixels = policy::IconPixels(points);
  NSBitmapImageRep* rep = [[NSBitmapImageRep alloc] initWithBitmapDataPlanes:nullptr
                                                                  pixelsWide:pixels
                                                                  pixelsHigh:pixels
                                                               bitsPerSample:8
                                                             samplesPerPixel:4
                                                                    hasAlpha:YES
                                                                    isPlanar:NO
                                                              colorSpaceName:NSDeviceRGBColorSpace
                                                                 bytesPerRow:0
                                                                bitsPerPixel:0];
  if (!rep) {
    return std::nullopt;
  }
  [NSGraphicsContext saveGraphicsState];
  NSGraphicsContext* context = [NSGraphicsContext graphicsContextWithBitmapImageRep:rep];
  [NSGraphicsContext setCurrentContext:context];
  [image drawInRect:NSMakeRect(0, 0, pixels, pixels)
           fromRect:NSZeroRect
          operation:NSCompositingOperationCopy
           fraction:1.0];
  [context flushGraphics];
  [NSGraphicsContext restoreGraphicsState];
  NSData* png = [rep representationUsingType:NSBitmapImageFileTypePNG properties:@{}];
  if (png.length == 0) {
    return std::nullopt;
  }
  return "data:image/png;base64," +
         base::Base64Encode(base::apple::NSDataToSpan(png));
}

policy::OpenUrlInbox& OpenUrls() {
  static base::NoDestructor<policy::OpenUrlInbox> inbox;
  return *inbox;
}

using OpenUrlsImp = void (*)(id, SEL, NSApplication*, NSArray<NSURL*>*);
OpenUrlsImp g_original_open_urls = nullptr;
bool g_open_urls_host_seen = false;

void ArdiaOpenUrls(id self, SEL command, NSApplication* application, NSArray<NSURL*>* urls) {
  NSMutableArray<NSURL*>* rest = [NSMutableArray array];
  std::vector<std::string> shell;
  const bool hosted = policy::CapturesOpenUrls(true, !Hosts().empty(), g_open_urls_host_seen);
  for (NSURL* url in urls) {
    const std::string spec = base::SysNSStringToUTF8(url.absoluteString ?: @"");
    if (hosted && policy::SchemeGoesToShell(spec)) {
      shell.push_back(spec);
    } else {
      [rest addObject:url];
    }
  }
  if (!shell.empty()) {
    const size_t added = OpenUrls().Add(shell);
    Trace("open urls: " + base::NumberToString(added) + " for the shell");
    SystemServices::DeliverOpenUrls();
  }
  if (rest.count && g_original_open_urls) {
    g_original_open_urls(self, command, application, rest);
  }
}

}

void InstallOpenUrlsHook() {
  static bool installed = false;
  if (installed) {
    return;
  }
  id delegate = NSApp.delegate;
  Method method = delegate ? class_getInstanceMethod([delegate class], @selector(application:openURLs:)) : nullptr;
  if (!method) {
    return;
  }
  g_original_open_urls = reinterpret_cast<OpenUrlsImp>(
      method_setImplementation(method, reinterpret_cast<IMP>(&ArdiaOpenUrls)));
  installed = true;
}

namespace {

bool g_thin_scroll_bars = false;
using PreferredStyleImp = NSScrollerStyle (*)(id, SEL);
PreferredStyleImp g_system_scroller_style = nullptr;

NSScrollerStyle ArdiaPreferredScrollerStyle(id self, SEL command) {
  if (g_thin_scroll_bars) {
    return NSScrollerStyleOverlay;
  }
  return g_system_scroller_style ? g_system_scroller_style(self, command) : NSScrollerStyleLegacy;
}

void SetThinScrollBars(bool thin) {
  if (thin == g_thin_scroll_bars) {
    return;
  }
  if (thin && !g_system_scroller_style) {
    Method method = class_getClassMethod([NSScroller class], @selector(preferredScrollerStyle));
    if (!method) {
      return;
    }
    g_system_scroller_style = reinterpret_cast<PreferredStyleImp>(
        method_setImplementation(method, reinterpret_cast<IMP>(&ArdiaPreferredScrollerStyle)));
  }
  g_thin_scroll_bars = thin;
  [NSNotificationCenter.defaultCenter postNotificationName:NSPreferredScrollerStyleDidChangeNotification
                                                    object:nil];
}

bool IsDefaultBrowser() {
  NSURL* probe = [NSURL URLWithString:@"https://example.com"];
  NSURL* handler = [NSWorkspace.sharedWorkspace URLForApplicationToOpenURL:probe];
  return handler && [handler.URLByStandardizingPath isEqual:NSBundle.mainBundle.bundleURL.URLByStandardizingPath];
}

std::string LaunchAtLoginStatus() {
  if (@available(macOS 13.0, *)) {
    return std::string(policy::LoginStatusName(
        policy::LoginStatusFor(static_cast<long>(SMAppService.mainAppService.status))));
  }
  return std::string(policy::LoginStatusName(policy::LoginStatus::kNotFound));
}

std::optional<std::string> ChangeLaunchAtLogin(bool enabled) {
  if (@available(macOS 13.0, *)) {
    NSError* error = nil;
    const BOOL ok = enabled ? [SMAppService.mainAppService registerAndReturnError:&error]
                            : [SMAppService.mainAppService unregisterAndReturnError:&error];
    if (ok) {
      return std::nullopt;
    }
    return base::SysNSStringToUTF8(error.localizedDescription ?: @"The login item could not be changed");
  }
  return std::string("Opening at login needs macOS 13");
}

std::optional<std::string> PathArgument(const base::ListValue& values) {
  if (values.size() != 1 || !values[0].is_string() || !policy::ValidLocalPath(values[0].GetString())) {
    return std::nullopt;
  }
  return values[0].GetString();
}

}

class DownloadWatch : public download::AllDownloadItemNotifier::Observer {
 public:
  DownloadWatch(SystemServices* owner, Profile* profile)
      : owner_(owner), profile_(profile), notifier_(profile->GetDownloadManager(), this) {
    SeedRunning();
  }
  DownloadWatch(const DownloadWatch&) = delete;
  DownloadWatch& operator=(const DownloadWatch&) = delete;
  ~DownloadWatch() override { Refuse(ready_.Drop()); }

  using Waiter = base::OnceCallback<void(bool)>;

  content::DownloadManager* manager() const { return notifier_.GetManager(); }

  void WhenReady(Waiter ready) {
    content::DownloadManager* downloads = manager();
    if (ready_.closed() || !downloads) {
      std::vector<Waiter> refused;
      refused.push_back(std::move(ready));
      return Refuse(std::move(refused));
    }
    if (std::optional<Waiter> now = ready_.Hold(!downloads || downloads->IsManagerInitialized(), std::move(ready))) {
      std::move(*now).Run(true);
    }
  }

  void SeedRunning() {
    const double now = NowMs();
    for (DownloadItem* item : All()) {
      if (item->GetState() == DownloadItem::IN_PROGRESS && !marks_.contains(item->GetGuid())) {
        marks_[item->GetGuid()] =
            policy::SeededMark(true, item->IsPaused(), item->IsDangerous() || item->IsInsecure(), now);
      }
    }
  }

  std::vector<DownloadItem*> All() const {
    std::vector<DownloadItem*> items;
    content::DownloadManager* downloads = manager();
    if (!downloads) {
      return items;
    }
    content::DownloadManager::DownloadVector all;
    downloads->GetAllDownloads(&all);
    for (DownloadItem* item : all) {
      if (Listed(item)) {
        items.push_back(item);
      }
    }
    std::sort(items.begin(), items.end(),
              [](DownloadItem* a, DownloadItem* b) { return a->GetStartTime() > b->GetStartTime(); });
    return items;
  }

 private:
  void OnManagerInitialized(content::DownloadManager*) override {
    SeedRunning();
    for (Waiter& ready : ready_.Release()) {
      std::move(ready).Run(true);
    }
  }

  static void Refuse(std::vector<Waiter> waiting) {
    for (Waiter& refused : waiting) {
      base::SequencedTaskRunner::GetCurrentDefault()->PostTask(FROM_HERE,
                                                               base::BindOnce(std::move(refused), false));
    }
  }

  void OnManagerGoingDown(content::DownloadManager*) override {
    Refuse(ready_.Close());
    base::SequencedTaskRunner::GetCurrentDefault()->PostTask(
        FROM_HERE, base::BindOnce(&SystemServices::WatchGone, owner_->GetWeakPtr(),
                                  reinterpret_cast<uintptr_t>(profile_.get())));
  }

  void OnDownloadCreated(content::DownloadManager*, DownloadItem* item) override { Changed(item); }

  void OnDownloadUpdated(content::DownloadManager*, DownloadItem* item) override { Changed(item); }

  void OnDownloadRemoved(content::DownloadManager*, DownloadItem* item) override {
    const auto found = marks_.find(item->GetGuid());
    const bool emitted = found != marks_.end() && found->second.emitted;
    if (found != marks_.end()) {
      marks_.erase(found);
    }
    if (emitted || Listed(item)) {
      owner_->DownloadRemoved(profile_, item->GetGuid());
    }
  }

  void Changed(DownloadItem* item) {
    if (!Listed(item)) {
      const auto found = marks_.find(item->GetGuid());
      if (found != marks_.end()) {
        const bool emitted = found->second.emitted;
        marks_.erase(found);
        if (emitted) {
          owner_->DownloadRemoved(profile_, item->GetGuid());
        }
      }
      return;
    }
    policy::ProgressMark& mark = marks_[item->GetGuid()];
    if (policy::EmitsChange(mark, item->GetState() == DownloadItem::IN_PROGRESS, item->IsPaused(),
                            item->IsDangerous() || item->IsInsecure(), NowMs())) {
      owner_->DownloadChanged(profile_, item);
    }
  }

  raw_ptr<SystemServices> owner_;
  raw_ptr<Profile> profile_;
  std::map<std::string, policy::ProgressMark> marks_;
  policy::ReadyQueue<base::OnceCallback<void(bool)>> ready_;
  download::AllDownloadItemNotifier notifier_;
};

SystemServices::SystemServices(ShellHostView* host) : host_(host) {
  InstallOpenUrlsHook();
  g_open_urls_host_seen = true;
  SyncWatches();
}

SystemServices::~SystemServices() {
  weak_factory_.InvalidateWeakPtrs();
  watches_.clear();
  base::SequencedTaskRunner::GetCurrentDefault()->PostTask(FROM_HERE,
                                                           base::BindOnce(&SystemServices::HandOffOpenUrls));
}

void SystemServices::HandOffOpenUrls() {
  if (!Hosts().empty()) {
    return DeliverOpenUrls();
  }
  const bool quitting = browser_shutdown::IsTryingToQuit() || browser_shutdown::HasShutdownStarted();
  if (!policy::HandsLinksToChrome(false, OpenUrls().pending(), quitting)) {
    if (quitting && !OpenUrls().empty()) {
      Trace("open urls: " + base::NumberToString(OpenUrls().pending()) + " dropped while quitting");
      while (!OpenUrls().empty()) {
        OpenUrls().Take();
      }
    }
    return;
  }
  NSMutableArray<NSURL*>* urls = [NSMutableArray array];
  while (!OpenUrls().empty()) {
    for (const std::string& spec : OpenUrls().Take()) {
      if (NSURL* url = [NSURL URLWithString:base::SysUTF8ToNSString(spec)]) {
        [urls addObject:url];
      }
    }
  }
  id delegate = NSApp.delegate;
  Trace("open urls: " + base::NumberToString(urls.count) + " handed back to Chrome");
  if (urls.count && delegate && g_original_open_urls) {
    g_original_open_urls(delegate, @selector(application:openURLs:), NSApp, urls);
  }
}

bool SystemServices::Handles(std::string_view method) {
  return std::ranges::find(policy::kSystemMethods, method) != std::end(policy::kSystemMethods);
}

bool SystemServices::HandlesEngineCall(std::string_view name) {
  return std::ranges::find(policy::kDownloadCalls, name) != std::end(policy::kDownloadCalls);
}

void SystemServices::AppendCapabilities(base::ListValue& capabilities) {
  for (std::string_view method : policy::kSystemMethods) {
    capabilities.Append(method);
  }
  capabilities.Append(policy::kOpenUrlsEvent);
  for (std::string_view call : policy::kDownloadCalls) {
    capabilities.Append(call);
  }
}

void SystemServices::WatchDownloads(Profile* profile) {
  if (!profile || profile->IsOffTheRecord() || profile->ShutdownStarted() || watches_.contains(profile) ||
      !profile->GetDownloadManager()) {
    return;
  }
  watches_[profile] = std::make_unique<DownloadWatch>(this, profile);
}

std::set<Profile*> SystemServices::MemberProfiles() const {
  std::set<Profile*> profiles;
  for (BrowserWindowInterface* member : host_->Members()) {
    Profile* profile = member ? member->GetProfile() : nullptr;
    const int tabs = member && member->GetTabStripModel() ? member->GetTabStripModel()->count() : 0;
    if (profile && !profile->IsOffTheRecord() && !profile->ShutdownStarted() &&
        policy::DownloadMember(member == host_->browser(), tabs)) {
      profiles.insert(profile);
    }
  }
  return profiles;
}

void SystemServices::SyncWatches() {
  const std::set<Profile*> members = MemberProfiles();
  std::erase_if(watches_, [&members](const auto& entry) { return !members.contains(entry.first); });
  for (Profile* profile : members) {
    WatchDownloads(profile);
  }
}

void SystemServices::SyncWatchesSoon() {
  base::SequencedTaskRunner::GetCurrentDefault()->PostTask(
      FROM_HERE, base::BindOnce(&SystemServices::SyncWatches, GetWeakPtr()));
}

void SystemServices::WatchGone(uintptr_t profile) {
  std::erase_if(watches_, [profile](const auto& entry) { return reinterpret_cast<uintptr_t>(entry.first) == profile; });
}

std::vector<std::string> SystemServices::DownloadTargets(bool finished_only) const {
  std::vector<std::string> targets;
  for (const auto& [profile, watch] : watches_) {
    for (DownloadItem* item : watch->All()) {
      if (finished_only && item->GetState() != DownloadItem::COMPLETE) {
        continue;
      }
      const base::FilePath path = TargetPath(*item);
      if (!path.empty()) {
        targets.push_back(path.value());
      }
    }
  }
  return targets;
}

void SystemServices::DownloadChanged(Profile* profile, DownloadItem* item) {
  if (!MemberProfiles().contains(profile)) {
    return SyncWatchesSoon();
  }
  base::DictValue data = Describe(item);
  data.Set("profile", ProfileName(profile));
  host_->Emit("ArdiaDownloads", "downloads",
              base::Value(base::DictValue().Set("name", "downloads.changed").Set("data", std::move(data))));
}

void SystemServices::DownloadRemoved(Profile* profile, const std::string& id) {
  if (!MemberProfiles().contains(profile)) {
    return SyncWatchesSoon();
  }
  host_->Emit("ArdiaDownloads", "downloads",
              base::Value(base::DictValue()
                              .Set("name", "downloads.removed")
                              .Set("data", base::DictValue().Set("id", id).Set("profile", ProfileName(profile)))));
}

void SystemServices::EngineCall(const std::string& name, Profile* profile, const base::Value* args, Done done) {
  std::optional<base::DictValue> input = ParseInput(args);
  if (!input) {
    return Fail(std::move(done), "ERR_DOWNLOAD_REQUEST", "Download arguments must be a JSON object");
  }
  if (const std::string invalid = ValidateDownloads(name, *input); !invalid.empty()) {
    return Fail(std::move(done), "ERR_DOWNLOAD_REQUEST", invalid);
  }
  const bool usable = profile && !profile->IsOffTheRecord() && !profile->ShutdownStarted();
  if (usable) {
    SyncWatches();
  }
  DownloadsCall(name, usable ? profile : nullptr, std::move(*input), std::move(done));
}

void SystemServices::RefuseQueued(Done done) {
  base::SequencedTaskRunner::GetCurrentDefault()->PostTask(
      FROM_HERE, base::BindOnce(
                     [](Done done) {
                       Fail(std::move(done), "ERR_PROFILE_WINDOW", "This profile no longer has tabs in this window");
                     },
                     std::move(done)));
}

void SystemServices::DownloadsCall(const std::string& name, Profile* profile, base::DictValue input, Done done) {
  const auto found = profile ? watches_.find(profile) : watches_.end();
  const bool watched = found != watches_.end();
  switch (policy::RouteDownloadRequest(name, profile != nullptr, watched, watched && found->second->manager())) {
    case policy::DownloadRoute::kRefuseQueued:
      return RefuseQueued(std::move(done));
    case policy::DownloadRoute::kUnavailable:
      return Fail(std::move(done), "ERR_PROFILE_WINDOW", "This profile has no tabs in this window");
    case policy::DownloadRoute::kServe:
      break;
  }
  DownloadWatch* watch = found->second.get();
  if (name == "downloads.remove") {
    DownloadItem* item = watch->manager()->GetDownloadByGuid(*input.FindString("id"));
    if (!item || !Listed(item)) {
      return Fail(std::move(done), "ERR_ENGINE", "no such download");
    }
    if (!policy::Removable(item->GetState() == DownloadItem::IN_PROGRESS)) {
      return Fail(std::move(done), "ERR_ENGINE", "the download is still running");
    }
    item->Remove();
    return std::move(done).Run(true, base::Value("null"));
  }
  watch->WhenReady(base::BindOnce(
      [](base::WeakPtr<SystemServices> self, base::WeakPtr<Profile> weak_profile, std::string name,
         base::DictValue input, Done done, bool ready) {
        if (!ready) {
          return Fail(std::move(done), "ERR_PROFILE_WINDOW", "This profile no longer has tabs in this window");
        }
        Profile* profile = weak_profile.get();
        if (self && profile && !self->MemberProfiles().contains(profile)) {
          self->SyncWatchesSoon();
          return Fail(std::move(done), "ERR_PROFILE_WINDOW", "This profile has no tabs in this window");
        }
        if (!self || !profile || !self->watches_.contains(profile)) {
          return Fail(std::move(done), "ERR_PROFILE_UNAVAILABLE", "This window's downloads are unavailable");
        }
        const auto found = self->watches_.find(profile);
        if (name == "downloads.list") {
          found->second->SeedRunning();
          base::ListValue listed;
          for (DownloadItem* item : found->second->All()) {
            base::DictValue described = Describe(item);
            described.Set("profile", ProfileName(profile));
            listed.Append(std::move(described));
          }
          return ReplyJson(std::move(done), base::Value(std::move(listed)));
        }
        std::set<std::string> kept;
        for (const base::Value& id : *input.FindList("keep")) {
          kept.insert(id.GetString());
        }
        const double cutoff = input.Find("before")->GetDouble();
        for (DownloadItem* item : found->second->All()) {
          if (policy::ClearsDownload(item->GetState() == DownloadItem::IN_PROGRESS, kept.contains(item->GetGuid()),
                                     item->GetStartTime().InMillisecondsFSinceUnixEpoch(), cutoff)) {
            item->Remove();
          }
        }
        std::move(done).Run(true, base::Value("null"));
      },
      GetWeakPtr(), profile->GetWeakPtr(), name, std::move(input), std::move(done)));
}

bool SystemServices::ListeningForOpenUrls() const {
  return open_urls_listener_ && *open_urls_listener_ == host_->renderer_generation_;
}

void SystemServices::SendOpenUrls(base::ListValue urls) {
  host_->Emit("ArdiaShell", "onOpenURLs", base::Value(base::DictValue().Set("urls", std::move(urls))));
}

void SystemServices::DeliverOpenUrls() {
  if (OpenUrls().empty()) {
    return;
  }
  ShellHostView* chosen = nullptr;
  for (ShellHostView* host : Hosts()) {
    SystemServices* services = host->system();
    if (!services || !services->ListeningForOpenUrls()) {
      continue;
    }
    NSWindow* window = HostWindow(host);
    if (!chosen || (window && window.isKeyWindow)) {
      chosen = host;
    }
  }
  if (!chosen) {
    return;
  }
  base::ListValue urls;
  for (std::string& url : OpenUrls().Take()) {
    urls.Append(std::move(url));
  }
  if (!urls.empty()) {
    chosen->system()->SendOpenUrls(std::move(urls));
  }
  if (!OpenUrls().empty()) {
    base::SequencedTaskRunner::GetCurrentDefault()->PostTask(FROM_HERE,
                                                             base::BindOnce(&SystemServices::DeliverOpenUrls));
  }
}

void SystemServices::RendererRetired() {
  open_urls_listener_.reset();
}

void SystemServices::Invoke(const std::string& method, const base::ListValue* given, Done done) {
  SyncWatches();
  const base::ListValue empty;
  const base::ListValue& values = given ? *given : empty;
  if (method == policy::kOpenUrlsListen) {
    if (!values.empty()) {
      return Fail(std::move(done), "ERR_SYSTEM_REQUEST", "listenForOpenURLs takes no arguments");
    }
    open_urls_listener_ = host_->renderer_generation_;
    std::move(done).Run(true, base::Value());
    base::SequencedTaskRunner::GetCurrentDefault()->PostTask(FROM_HERE,
                                                             base::BindOnce(&SystemServices::DeliverOpenUrls));
    return;
  }
  if (method == "ArdiaShell.pickFiles") {
    return PickFiles(values, std::move(done));
  }
  if (method == "ArdiaShell.pickFolder") {
    return PickFolder(values, std::move(done));
  }
  if (method == "ArdiaApp.openExternalURL") {
    if (values.size() != 1 || !values[0].is_string()) {
      return Fail(std::move(done), "ERR_SYSTEM_REQUEST", "A URL is required");
    }
    const std::string& text = values[0].GetString();
    const GURL url(text);
    if (!policy::ExternalTextAllowed(text) || !url.is_valid() || !policy::ExternalSchemeAllowed(url.scheme()) ||
        ((url.SchemeIsHTTPOrHTTPS()) && (!url.has_host() || url.has_username() || url.has_password()))) {
      return std::move(done).Run(true, base::Value(false));
    }
    if (BackgroundInstance()) {
      Trace("background instance: not opening a " + std::string(url.scheme()) + " link in another app");
      return std::move(done).Run(true, base::Value(false));
    }
    NSURL* target = [NSURL URLWithString:base::SysUTF8ToNSString(url.spec())];
    return std::move(done).Run(true, base::Value(target && [NSWorkspace.sharedWorkspace openURL:target]));
  }
  if (method == "ArdiaSystem.isDefaultBrowser" || method == "ArdiaSystem.setAsDefaultBrowser") {
    if (!values.empty()) {
      return Fail(std::move(done), "ERR_SYSTEM_REQUEST", "The default browser calls take no arguments");
    }
    if (method == "ArdiaSystem.isDefaultBrowser") {
      return std::move(done).Run(true, base::Value(IsDefaultBrowser()));
    }
    if (BackgroundInstance()) {
      Trace("background instance: not setting the default browser");
      return std::move(done).Run(true, base::Value(false));
    }
    NSURL* app = NSBundle.mainBundle.bundleURL;
    std::shared_ptr<Done> shared = Share(std::move(done));
    scoped_refptr<base::SequencedTaskRunner> runner = base::SequencedTaskRunner::GetCurrentDefault();
    [NSWorkspace.sharedWorkspace setDefaultApplicationAtURL:app
                                       toOpenURLsWithScheme:@"http"
                                          completionHandler:^(NSError* http_error) {
                                            if (http_error) {
                                              return Settle(runner, shared, true, base::Value(false));
                                            }
                                            [NSWorkspace.sharedWorkspace
                                                setDefaultApplicationAtURL:app
                                                      toOpenURLsWithScheme:@"https"
                                                         completionHandler:^(NSError*) {
                                                           runner->PostTask(
                                                               FROM_HERE,
                                                               base::BindOnce(
                                                                   [](std::shared_ptr<Done> done) {
                                                                     if (*done) {
                                                                       std::move(*done).Run(
                                                                           true, base::Value(IsDefaultBrowser()));
                                                                     }
                                                                   },
                                                                   shared));
                                                         }];
                                          }];
    return;
  }
  if (method == "ArdiaSystem.launchAtLoginStatus") {
    if (!values.empty()) {
      return Fail(std::move(done), "ERR_SYSTEM_REQUEST", "The login status takes no arguments");
    }
    return std::move(done).Run(true, base::Value(LaunchAtLoginStatus()));
  }
  if (method == "ArdiaSystem.setLaunchAtLogin") {
    if (values.size() != 1 || !values[0].is_bool()) {
      return Fail(std::move(done), "ERR_SYSTEM_REQUEST", "Opening at login takes one boolean");
    }
    if (BackgroundInstance()) {
      Trace("background instance: not changing launch at login");
      return std::move(done).Run(true, base::Value());
    }
    if (const std::optional<std::string> error = ChangeLaunchAtLogin(values[0].GetBool())) {
      return Fail(std::move(done), "ERR_LOGIN_ITEM", *error);
    }
    return std::move(done).Run(true, base::Value());
  }
  if (method == "ArdiaSystem.hapticTick") {
    if (!BackgroundInstance()) {
      [NSHapticFeedbackManager.defaultPerformer performFeedbackPattern:NSHapticFeedbackPatternAlignment
                                                       performanceTime:NSHapticFeedbackPerformanceTimeNow];
    }
    return std::move(done).Run(true, base::Value());
  }
  if (method == "ArdiaSystem.setThinScrollBars") {
    if (values.size() != 1 || !values[0].is_bool()) {
      return Fail(std::move(done), "ERR_SYSTEM_REQUEST", "The scroll bar style takes one boolean");
    }
    SetThinScrollBars(values[0].GetBool());
    return std::move(done).Run(true, base::Value());
  }
  if (method == "ArdiaSystem.runningAppIcon") {
    const std::optional<int> pid =
        values.size() == 2 && (values[0].is_int() || values[0].is_double()) ? policy::ProcessId(values[0].GetDouble())
                                                                             : std::nullopt;
    if (!pid || !(values[1].is_int() || values[1].is_double())) {
      return Fail(std::move(done), "ERR_SYSTEM_REQUEST", "A process id and icon size are required");
    }
    NSRunningApplication* app = [NSRunningApplication runningApplicationWithProcessIdentifier:*pid];
    const std::optional<std::string> icon = PngDataUrl(app.icon, values[1].GetDouble());
    return std::move(done).Run(true, icon ? base::Value(*icon) : base::Value());
  }
  FileCall(method, values, std::move(done));
}

void SystemServices::FileCall(const std::string& method, const base::ListValue& values, Done done) {
  if (method == "ArdiaSystem.fileStatus") {
    if (values.size() != 1 || !values[0].is_list() || values[0].GetList().size() > policy::kMaxStatusPaths) {
      return Fail(std::move(done), "ERR_FILE_PATH", "A bounded list of paths is required");
    }
    const std::vector<std::string> targets = DownloadTargets(false);
    std::vector<std::pair<std::string, bool>> paths;
    for (const base::Value& path : values[0].GetList()) {
      if (!path.is_string() || path.GetString().size() > policy::kMaxPathBytes) {
        return Fail(std::move(done), "ERR_FILE_PATH", "Paths must be strings");
      }
      paths.emplace_back(path.GetString(), policy::PathListed(path.GetString(), targets));
    }
    base::ThreadPool::PostTaskAndReplyWithResult(
        FROM_HERE, kFileReads,
        base::BindOnce(
            [](std::vector<std::pair<std::string, bool>> paths) {
              base::ListValue status;
              for (const auto& [path, listed] : paths) {
                status.Append(listed && base::PathExists(base::FilePath(path)));
              }
              return status;
            },
            std::move(paths)),
        base::BindOnce([](Done done, base::ListValue status) { std::move(done).Run(true, base::Value(std::move(status))); },
                       std::move(done)));
    return;
  }
  if (method == "ArdiaSystem.fileIcon") {
    if (values.size() != 2 || !values[0].is_string() || !(values[1].is_int() || values[1].is_double()) ||
        !policy::IconPathAllowed(values[0].GetString(), DownloadTargets(false))) {
      return Fail(std::move(done), "ERR_FILE_NOT_ALLOWED", "Icons are only available for downloads and file names");
    }
    const std::string path = values[0].GetString();
    NSImage* icon = nil;
    if (path.find('/') != std::string::npos && base::PathExists(base::FilePath(path))) {
      icon = [NSWorkspace.sharedWorkspace iconForFile:base::SysUTF8ToNSString(path)];
    } else {
      const base::FilePath name(path);
      const std::string extension = name.Extension().empty() ? std::string() : name.Extension().substr(1);
      UTType* type = extension.empty() ? UTTypeData : [UTType typeWithFilenameExtension:base::SysUTF8ToNSString(extension)];
      icon = [NSWorkspace.sharedWorkspace iconForContentType:type ?: UTTypeData];
    }
    const std::optional<std::string> png = PngDataUrl(icon, values[1].GetDouble());
    return std::move(done).Run(true, png ? base::Value(*png) : base::Value());
  }
  const std::optional<std::string> path = PathArgument(values);
  if (!path) {
    return Fail(std::move(done), "ERR_FILE_PATH", "An absolute file path is required");
  }
  const bool reveal = method == "ArdiaSystem.revealFile";
  if (!policy::PathListed(*path, DownloadTargets(!reveal))) {
    return Fail(std::move(done), "ERR_FILE_NOT_ALLOWED",
                reveal ? "Only downloaded files can be shown" : "Only finished downloads can be used");
  }
  if (method == "ArdiaSystem.moveToTrash") {
    base::ThreadPool::PostTaskAndReplyWithResult(
        FROM_HERE, kFileWrites,
        base::BindOnce(
            [](std::string path) {
              NSURL* url = [NSURL fileURLWithPath:base::SysUTF8ToNSString(path)];
              if (![NSFileManager.defaultManager fileExistsAtPath:url.path]) {
                return false;
              }
              NSError* error = nil;
              return static_cast<bool>([NSFileManager.defaultManager trashItemAtURL:url
                                                                   resultingItemURL:nil
                                                                              error:&error]);
            },
            *path),
        base::BindOnce([](Done done, bool trashed) { std::move(done).Run(true, base::Value(trashed)); },
                       std::move(done)));
    return;
  }
  base::ThreadPool::PostTaskAndReplyWithResult(
      FROM_HERE, kFileReads, base::BindOnce(&base::PathExists, base::FilePath(*path)),
      base::BindOnce(
          [](std::string method, std::string path, Done done, bool exists) {
            if (!exists) {
              return std::move(done).Run(true, base::Value(false));
            }
            NSURL* url = [NSURL fileURLWithPath:base::SysUTF8ToNSString(path)];
            if (BackgroundInstance()) {
              Trace("background instance: not handing a download to Finder (" + method + ")");
              return std::move(done).Run(true, base::Value(true));
            }
            if (method == "ArdiaSystem.revealFile") {
              [NSWorkspace.sharedWorkspace activateFileViewerSelectingURLs:@[ url ]];
              return std::move(done).Run(true, base::Value(true));
            }
            if (method != "ArdiaSystem.openFile") {
              return Fail(std::move(done), "ERR_UNKNOWN_CALL", "Unsupported file operation");
            }
            std::shared_ptr<Done> shared = Share(std::move(done));
            scoped_refptr<base::SequencedTaskRunner> runner = base::SequencedTaskRunner::GetCurrentDefault();
            [NSWorkspace.sharedWorkspace openURL:url
                                   configuration:[NSWorkspaceOpenConfiguration configuration]
                               completionHandler:^(NSRunningApplication*, NSError* error) {
                                 Settle(runner, shared, true, base::Value(error == nil));
                               }];
          },
          method, *path, std::move(done)));
}

void SystemServices::PickFiles(const base::ListValue& values, Done done) {
  if (!values.empty()) {
    return Fail(std::move(done), "ERR_FILES_REQUEST", "Choosing files to open takes no arguments");
  }
  if (BackgroundInstance()) {
    Trace("background instance: file picker requested, answering cancelled");
    return std::move(done).Run(true, base::Value(base::ListValue()));
  }
  NSWindow* window = HostWindow(host_);
  if (!window) {
    return Fail(std::move(done), "ERR_WINDOW_CLOSED", "The window closed before the file panel opened");
  }
  if (policy::AdmitPicker(picking_) == policy::PickerAdmission::kAlreadyOpen) {
    return Fail(std::move(done), "ERR_FILE_PICKER_OPEN", "A file dialog is already open in this window");
  }
  picking_ = true;
  NSOpenPanel* panel = [NSOpenPanel openPanel];
  panel.allowsMultipleSelection = YES;
  panel.canChooseDirectories = NO;
  panel.canChooseFiles = YES;
  std::shared_ptr<Done> shared = Share(std::move(done));
  scoped_refptr<base::SequencedTaskRunner> runner = base::SequencedTaskRunner::GetCurrentDefault();
  base::WeakPtr<SystemServices> weak = GetWeakPtr();
  [panel beginSheetModalForWindow:window
                completionHandler:^(NSModalResponse response) {
                  base::ListValue urls;
                  if (response == NSModalResponseOK) {
                    for (NSURL* url in panel.URLs) {
                      if (url.isFileURL && urls.size() < policy::kOpenUrlBatch) {
                        urls.Append(base::SysNSStringToUTF8(url.absoluteString));
                      }
                    }
                  }
                  runner->PostTask(FROM_HERE, base::BindOnce(
                                                  [](base::WeakPtr<SystemServices> self) {
                                                    if (self) {
                                                      self->picking_ = false;
                                                    }
                                                  },
                                                  weak));
                  Settle(runner, shared, true, base::Value(std::move(urls)));
                }];
}

void SystemServices::PickFolder(const base::ListValue& values, Done done) {
  if (values.size() > 2 || std::ranges::any_of(values, [](const base::Value& value) {
        return !value.is_string() && !value.is_none();
      })) {
    return Fail(std::move(done), "ERR_FOLDER_REQUEST", "A current folder and button title, or null, are expected");
  }
  const std::string current = !values.empty() && values[0].is_string() ? values[0].GetString() : std::string();
  const std::string prompt = values.size() == 2 && values[1].is_string() ? values[1].GetString() : std::string();
  if (BackgroundInstance()) {
    Trace("background instance: folder picker requested, answering cancelled");
    return std::move(done).Run(true, base::Value());
  }
  NSWindow* window = HostWindow(host_);
  if (!window) {
    return Fail(std::move(done), "ERR_WINDOW_CLOSED", "The window closed before the folder panel opened");
  }
  if (policy::AdmitPicker(picking_) == policy::PickerAdmission::kAlreadyOpen) {
    return Fail(std::move(done), "ERR_FOLDER_PICKER_OPEN", "A folder dialog is already open in this window");
  }
  picking_ = true;
  NSOpenPanel* panel = [NSOpenPanel openPanel];
  panel.canChooseFiles = NO;
  panel.canChooseDirectories = YES;
  panel.canCreateDirectories = YES;
  panel.allowsMultipleSelection = NO;
  if (policy::PickerPromptUsable(prompt) && base::IsStringUTF8(prompt)) {
    panel.prompt = base::SysUTF8ToNSString(prompt);
  }
  if (policy::ValidLocalPath(current)) {
    panel.directoryURL = [NSURL fileURLWithPath:base::SysUTF8ToNSString(current) isDirectory:YES];
  }
  std::shared_ptr<Done> shared = Share(std::move(done));
  scoped_refptr<base::SequencedTaskRunner> runner = base::SequencedTaskRunner::GetCurrentDefault();
  base::WeakPtr<SystemServices> weak = GetWeakPtr();
  [panel beginSheetModalForWindow:window
                completionHandler:^(NSModalResponse response) {
                  const std::string path =
                      response == NSModalResponseOK && panel.URL.isFileURL ? base::SysNSStringToUTF8(panel.URL.path)
                                                                          : std::string();
                  runner->PostTask(FROM_HERE, base::BindOnce(
                                                  [](base::WeakPtr<SystemServices> self) {
                                                    if (self) {
                                                      self->picking_ = false;
                                                    }
                                                  },
                                                  weak));
                  Settle(runner, shared, true,
                         policy::ValidLocalPath(path) ? base::Value(path) : base::Value());
                }];
}

}
