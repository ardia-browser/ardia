// Copyright 2026 Ardia. Apache-2.0.

#include "ardia/linux/content_blocker.h"

#include <algorithm>
#include <deque>
#include <map>
#include <memory>
#include <optional>
#include <set>
#include <string>
#include <utility>
#include <vector>

#include "ardia/core/mojom/ardiacore.mojom.h"
#include "ardia/linux/log.h"
#include "ardia/linux/modules/app_modules.h"
#include "ardia/linux/modules/args.h"
#include "ardia/linux/prompts/domains.h"
#include "ardia/linux/ui_host/modules.h"
#include "ardia/win/profiles.h"
#include "ardia/win/tab_state.h"
#include "base/barrier_closure.h"
#include "base/base_paths.h"
#include "base/files/file_path.h"
#include "base/files/file_util.h"
#include "base/functional/bind.h"
#include "base/functional/callback.h"
#include "base/json/json_reader.h"
#include "base/json/json_writer.h"
#include "base/memory/raw_ptr.h"
#include "base/memory/weak_ptr.h"
#include "base/no_destructor.h"
#include "base/one_shot_event.h"
#include "base/path_service.h"
#include "base/process/kill.h"
#include "base/scoped_multi_source_observation.h"
#include "base/scoped_observation.h"
#include "base/strings/string_number_conversions.h"
#include "base/strings/string_util.h"
#include "base/task/single_thread_task_runner.h"
#include "base/task/thread_pool.h"
#include "base/time/time.h"
#include "base/types/expected.h"
#include "chrome/browser/browser_process.h"
#include "chrome/browser/extensions/component_loader.h"
#include "chrome/browser/extensions/extension_view.h"
#include "chrome/browser/extensions/extension_view_host.h"
#include "chrome/browser/profiles/profile.h"
#include "chrome/browser/profiles/profile_manager.h"
#include "chrome/browser/profiles/profile_manager_observer.h"
#include "chrome/browser/profiles/profile_observer.h"
#include "components/input/native_web_keyboard_event.h"
#include "content/public/browser/eye_dropper.h"
#include "content/public/browser/keyboard_event_processing_result.h"
#include "content/public/browser/navigation_handle.h"
#include "content/public/browser/render_frame_host.h"
#include "content/public/browser/web_contents.h"
#include "content/public/browser/web_contents_observer.h"
#include "content/public/browser/web_contents_user_data.h"
#include "extensions/browser/extension_registry.h"
#include "extensions/browser/extension_system.h"
#include "extensions/common/extension.h"
#include "extensions/common/mojom/manifest.mojom-shared.h"
#include "extensions/common/mojom/view_type.mojom-shared.h"
#include "mojo/public/cpp/bindings/associated_remote.h"
#include "mojo/public/cpp/bindings/callback_helpers.h"
#include "net/base/net_errors.h"
#include "third_party/blink/public/common/associated_interfaces/associated_interface_provider.h"
#include "third_party/blink/public/common/loader/resource_type_util.h"
#include "third_party/blink/public/mojom/loader/resource_load_info.mojom.h"
#include "ui/gfx/native_ui_types.h"
#include "url/gurl.h"

namespace ardia_linux {

namespace {

constexpr char kOffDirective[] = "/^(?:ardia-blocking-off|)/";
constexpr char kDefaultProfile[] = "";
constexpr char kBundledName[] = "ublock";
constexpr int kAttempts = 40;
constexpr int kInheritAttempts = 6;
constexpr int kReloadWaitMs = 4000;
constexpr base::TimeDelta kRetry = base::Milliseconds(250);
constexpr base::TimeDelta kOpTime = base::Seconds(20);
constexpr base::TimeDelta kPageIdle = base::Seconds(30);
constexpr base::TimeDelta kBlockedReportDelay = base::Milliseconds(150);

constexpr char kPrelude[] = R"JS(let failing = %@;
const offDirective = %@;
const extensionOrigin = %@;
const deadline = Date.now() + %@;
const left = () => Math.max(0, deadline - Date.now());
let expired = false;
const withDeadline = (promise, what) => new Promise((resolve, reject) => {
  const timer = setTimeout(() => { expired = true; reject(new Error(`${what}: timed out`)); }, left());
  promise.then((v) => { clearTimeout(timer); resolve(v); }, (e) => { clearTimeout(timer); reject(e); });
});
const ready = () => new Promise((resolve, reject) => {
  const look = () => {
    const ublock = chrome.extension.getBackgroundPage()?.µBlock;
    if (ublock?.isReadyPromise) return ublock.isReadyPromise.then(resolve, reject);
    if (left() === 0) return reject(new Error('uBlock Origin never started'));
    setTimeout(look, 10);
  };
  look();
});
const loadScript = (src) => new Promise((resolve, reject) => {
  const element = document.createElement('script');
  element.src = src;
  element.onload = resolve;
  element.onerror = () => reject(new Error(`${src} didn't load`));
  document.head.append(element);
});
const client = () => self.vAPI?.messaging ? Promise.resolve()
  : ['js/vapi.js', 'js/vapi-common.js', 'js/vapi-client.js'].reduce((p, src) => p.then(() => loadScript(src)), Promise.resolve());
const send = (message) => {
  if (expired) return Promise.reject(new Error(`${message.what}: timed out`));
  if (failing) { failing = false; return Promise.reject(new Error(`${message.what}: failed (dev)`)); }
  return client().then(() => {
    if (expired) throw new Error(`${message.what}: timed out`);
    return vAPI.messaging.send('dashboard', message);
  }).then((reply) => {
    if (reply === undefined) throw new Error(`${message.what}: no reply`);
    return reply;
  });
};
const trusted = () => send({what: 'getWhitelist'}).then((t) => {
  if (!t || !Array.isArray(t.whitelist)) throw new Error('getWhitelist: no answer');
  return t;
});
const lists = () => send({what: 'getLists'}).then((l) => {
  if (!l || !l.available || typeof l.available !== 'object') throw new Error('getLists: no answer');
  return l;
});
const selected = (l) => Object.keys(l.available).filter((k) => l.available[k] && l.available[k].off !== true);
const covers = (directive, host) => !directive.includes('/') && (host === directive || host.endsWith('.' + directive));
const sameSet = (a, b) => [...a].sort().join('\n') === [...b].sort().join('\n');
const storageCall = (name, arg) => expired ? Promise.reject(new Error(`storage ${name}: timed out`))
  : new Promise((resolve, reject) => chrome.storage.local[name](arg, (v) =>
    chrome.runtime.lastError ? reject(new Error(chrome.runtime.lastError.message)) : resolve(v || {})));
const local = {get: (k) => storageCall('get', k), set: (v) => storageCall('set', v), remove: (k) => storageCall('remove', k)};
const pendingReload = () => local.get('ardiaReloadPending').then((b) => b.ardiaReloadPending);
const reloadLists = () => pendingReload().then((asked) => send({what: 'reloadAllFilters'})
  .then(pendingReload)
  .then((now) => now === asked ? local.remove('ardiaReloadPending') : reloadLists()));
const reloadWait = () => new Promise((resolve) => setTimeout(resolve, Math.min(%@, Math.max(0, left() - 1000))));
const askReload = () => local.set({ardiaReloadPending: `${Date.now()}-${Math.random()}`});
const applyLists = (toSelect) => askReload()
  .then(() => send({what: 'applyFilterListSelection', toSelect}))
  .then(askReload)
  .then(() => Promise.race([reloadLists(), reloadWait()]));
const resumePendingReload = () => { pendingReload().then((asked) => asked ? reloadLists() : null).catch(() => {}); };
Promise.resolve().then(() => { if (location.origin !== extensionOrigin) throw new Error(`not the extension page: ${location.href}`); })
.then(() => withDeadline(ready(), 'uBlock Origin'))
.then(() => { resumePendingReload(); return withDeadline(Promise.resolve().then(() => (%@)), 'the call'); })
.then((v) => post('result', JSON.stringify({value: v === undefined ? null : v})),
(e) => post('result', JSON.stringify({error: String(e && e.message || e)})));)JS";

constexpr char kRead[] =
    "Promise.all([lists(), trusted()]).then(([l, t]) => ({lists: "
    "selected(l).sort(), whitelist: [...t.whitelist].sort(), autoUpdate: "
    "l.autoUpdate !== false}))";

constexpr char kFollow[] = R"JS(Promise.all([lists(), trusted()]).then(([l, t]) => {
  const want = %@;
  if (!Array.isArray(want.lists) || !Array.isArray(want.whitelist)) throw new Error('no settings to copy');
  let written = Promise.resolve(null);
  if (!sameSet(selected(l), want.lists))
    written = written.then(() => applyLists(want.lists));
  if (!sameSet(t.whitelist, want.whitelist))
    written = written.then(() => send({what: 'setWhitelist', whitelist: want.whitelist.join('\n')}));
  if ((l.autoUpdate !== false) !== (want.autoUpdate !== false))
    written = written.then(() => send({what: 'userSettings', name: 'autoUpdate', value: want.autoUpdate !== false}));
  return written.then(() => null);
}))JS";

constexpr char kState[] = R"JS(Promise.all([lists(), trusted(), fetch('/assets/assets.json').then((r) => r.json())]).then(([l, t, assets]) => {
  const langs = new Set([chrome.i18n.getUILanguage(), ...(navigator.languages || [])].map((x) => (/^[a-z]+/.exec(x) || [])[0]).filter(Boolean));
  const forLanguages = (lang) => typeof lang === 'string' && lang.split(/\s+/).some((x) => langs.has(x));
  const onByDefault = (id) => !!assets[id] && (assets[id].off !== true || forLanguages(assets[id].lang));
  return {
    lists: Object.entries(l.available)
      .filter(([id, list]) => list && list.content === 'filters' && list.group !== 'user' && list.group !== 'custom')
      .map(([id, list]) => ({id, title: list.title || id, group: list.group || '', enabled: list.off !== true,
        defaultOn: onByDefault(id), filters: list.entryCount || 0})),
    networkFilters: l.netFilterCount || 0,
    cosmeticFilters: l.cosmeticFilterCount || 0,
    enabled: !t.whitelist.includes(offDirective),
    allowedHosts: t.whitelist.filter((d) => !d.includes('/') && !d.startsWith('#') && !(t.whitelistDefault || []).includes(d)),
  };
}))JS";

constexpr char kSetEnabled[] = R"JS(trusted().then((t) => {
  const on = %@;
  const kept = t.whitelist.filter((d) => d !== offDirective);
  return send({what: 'setWhitelist', whitelist: (on ? kept : kept.concat([offDirective])).join('\n')});
}).then(() => send({what: 'userSettings', name: 'autoUpdate', value: %@})))JS";

constexpr char kSetList[] = R"JS(lists().then((l) => {
  const [id, on] = [%@, %@];
  if (!l.available[id]) throw new Error(`no list ${id}`);
  const keep = selected(l).filter((x) => x !== id);
  return applyLists(on ? keep.concat([id]) : keep);
}))JS";

constexpr char kIsAllowed[] =
    "trusted().then((t) => t.whitelist.some((d) => covers(d, %@)))";

constexpr char kSetAllowed[] = R"JS(trusted().then((t) => {
  const [allowed, host] = [%@, %@];
  const kept = t.whitelist.filter((d) => allowed ? d !== host : !covers(d, host));
  return send({what: 'setWhitelist', whitelist: (allowed ? kept.concat([host]) : kept).join('\n')});
}))JS";

std::string Json(const base::Value& value) {
  return base::WriteJson(value).value_or("null");
}

std::string Quoted(std::string_view text) {
  return Json(base::Value(text));
}

using Done = base::OnceCallback<void(base::Value value, std::string error)>;
using Settled = base::OnceCallback<void(std::string error)>;

class HiddenView : public extensions::ExtensionView {
 public:
  explicit HiddenView(base::RepeatingClosure loaded)
      : loaded_(std::move(loaded)) {}

  gfx::NativeView GetNativeView() override { return gfx::NativeView(); }
  void ResizeDueToAutoResize(content::WebContents* web_contents,
                             const gfx::Size& new_size) override {}
  void RenderFrameCreated(content::RenderFrameHost* frame) override {}
  bool HandleKeyboardEvent(
      content::WebContents* source,
      const input::NativeWebKeyboardEvent& event) override {
    return false;
  }
  void OnLoaded() override { loaded_.Run(); }

 private:
  base::RepeatingClosure loaded_;
};

class HiddenViewDelegate : public extensions::ExtensionViewHost::Delegate {
 public:
  content::WebContents* OpenURL(
      const content::OpenURLParams& params,
      base::OnceCallback<void(content::NavigationHandle&)> callback) override {
    return nullptr;
  }
  content::KeyboardEventProcessingResult PreHandleKeyboardEvent(
      content::WebContents* source,
      const input::NativeWebKeyboardEvent& event) override {
    return content::KeyboardEventProcessingResult::NOT_HANDLED;
  }
  std::unique_ptr<content::EyeDropper> OpenEyeDropper(
      content::RenderFrameHost* frame,
      content::EyeDropperListener* listener) override {
    return nullptr;
  }
  extensions::WindowController* GetExtensionWindowController() override {
    return nullptr;
  }
};

class BlockerPage : public content::WebContentsObserver {
 public:
  BlockerPage(Profile* profile, const extensions::Extension* extension)
      : origin_(extension->url().spec()) {
    view_ = std::make_unique<HiddenView>(base::BindRepeating(
        &BlockerPage::Loaded, weak_factory_.GetWeakPtr()));
    host_ = std::make_unique<extensions::ExtensionViewHost>(
        extension, profile, extension->ResolveExtensionURL("blank.html"),
        extensions::mojom::ViewType::kExtensionPopup,
        std::make_unique<HiddenViewDelegate>());
    host_->set_view(view_.get());
    host_->SetCloseHandler(base::BindOnce(
        [](base::WeakPtr<BlockerPage> page, extensions::ExtensionHost*) {
          if (page) {
            page->Fail("closed");
          }
        },
        weak_factory_.GetWeakPtr()));
    Observe(host_->host_contents());
    host_->CreateRendererSoon();
  }

  ~BlockerPage() override { Fail("closed"); }

  bool dead() const { return dead_; }

  bool OnOwnPage() const {
    if (dead_ || !host_) {
      return false;
    }
    return base::StartsWith(
        host_->host_contents()->GetLastCommittedURL().spec(), origin_);
  }

  void Run(std::string script, Done done) {
    if (dead_) {
      std::move(done).Run(base::Value(), "closed");
      return;
    }
    calls_.emplace_back(std::move(script), std::move(done));
    Next();
  }

  void Fail(const std::string& error) {
    if (dead_) {
      return;
    }
    dead_ = true;
    Observe(nullptr);
    std::deque<std::pair<std::string, Done>> calls = std::move(calls_);
    calls_.clear();
    Done inflight = std::move(inflight_);
    page_.reset();
    base::SingleThreadTaskRunner::GetCurrentDefault()->PostTask(
        FROM_HERE,
        base::BindOnce(
            [](std::unique_ptr<extensions::ExtensionViewHost> host,
               std::unique_ptr<HiddenView> view, Done inflight,
               std::deque<std::pair<std::string, Done>> calls,
               std::string error) {
              host.reset();
              view.reset();
              if (inflight) {
                std::move(inflight).Run(base::Value(), error);
              }
              for (auto& call : calls) {
                std::move(call.second).Run(base::Value(), error);
              }
            },
            std::move(host_), std::move(view_), std::move(inflight),
            std::move(calls), error));
  }

  void PrimaryMainFrameRenderProcessGone(
      base::TerminationStatus status) override {
    Fail("renderer gone");
  }

  void DidFinishNavigation(content::NavigationHandle* navigation) override {
    if (!navigation->IsInPrimaryMainFrame()) {
      return;
    }
    if (navigation->HasCommitted() && !OnOwnPage()) {
      LeftOwnPage();
      return;
    }
    if (!navigation->HasCommitted() &&
        navigation->GetNetErrorCode() != net::ERR_ABORTED) {
      Fail(net::ErrorToShortString(navigation->GetNetErrorCode()));
    }
  }

 private:
  void Loaded() {
    loaded_ = true;
    Next();
  }

  void LeftOwnPage() {
    Fail("not the extension page: " +
         (host_ ? host_->host_contents()->GetLastCommittedURL().spec()
                : std::string()));
  }

  void Next() {
    if (dead_ || !loaded_ || inflight_ || calls_.empty()) {
      return;
    }
    if (!OnOwnPage()) {
      LeftOwnPage();
      return;
    }
    content::RenderFrameHost* frame =
        host_->host_contents()->GetPrimaryMainFrame();
    if (!frame->IsRenderFrameLive()) {
      Fail("renderer not live");
      return;
    }
    std::string script = std::move(calls_.front().first);
    inflight_ = std::move(calls_.front().second);
    calls_.pop_front();
    page_.reset();
    frame->GetRemoteAssociatedInterfaces()->GetInterface(&page_);
    page_->Evaluate(script, mojo::WrapCallbackWithDefaultInvokeIfNotRun(
                                base::BindOnce(&BlockerPage::Answered,
                                               weak_factory_.GetWeakPtr()),
                                std::nullopt));
  }

  void Answered(const std::optional<std::string>& json) {
    if (!inflight_) {
      return;
    }
    if (!OnOwnPage()) {
      LeftOwnPage();
      return;
    }
    Done done = std::move(inflight_);
    std::optional<base::Value> answer =
        json ? base::JSONReader::Read(*json, base::JSON_PARSE_RFC)
             : std::nullopt;
    const base::DictValue* fields = answer ? answer->GetIfDict() : nullptr;
    std::string error;
    base::Value value;
    if (!fields) {
      error = "no answer";
    } else if (const std::string* failure = fields->FindString("error")) {
      error = *failure;
    } else if (const base::Value* found = fields->Find("value")) {
      value = found->Clone();
    }
    base::WeakPtr<BlockerPage> alive = weak_factory_.GetWeakPtr();
    std::move(done).Run(std::move(value), error);
    if (alive) {
      Next();
    }
  }

  std::string origin_;
  std::unique_ptr<HiddenView> view_;
  std::unique_ptr<extensions::ExtensionViewHost> host_;
  std::deque<std::pair<std::string, Done>> calls_;
  Done inflight_;
  mojo::AssociatedRemote<ardiacore::mojom::ACPage> page_;
  bool loaded_ = false;
  bool dead_ = false;
  base::WeakPtrFactory<BlockerPage> weak_factory_{this};
};

struct Op {
  uint64_t id = 0;
  std::string profile;
  std::string expression;
  Done done;
  int attempts_left = kAttempts;
  bool fail_next = false;
  base::TimeTicks deadline;
  int attempt = 0;
};

std::string CategoryOf(std::string_view list_id, std::string_view group) {
  if (group == "regions") {
    return "regional";
  }
  if (list_id.find("cookie") != std::string_view::npos) {
    return "cookies";
  }
  if (group == "privacy" || list_id == "ublock-privacy") {
    return "trackers";
  }
  if (group == "malware" || list_id == "ublock-badware") {
    return "security";
  }
  if (group == "annoyances" || group == "social") {
    return "annoyances";
  }
  return "ads";
}

double Count(const base::Value* value) {
  return value ? value->GetIfDouble().value_or(0) : 0;
}

class Blocker : public ProfileManagerObserver, public ProfileObserver {
 public:
  static Blocker& Get() {
    static base::NoDestructor<Blocker> blocker;
    return *blocker;
  }

  void Start() {
    if (started_) {
      return;
    }
    started_ = true;
    base::FilePath exe;
    base::PathService::Get(base::DIR_EXE, &exe);
    base::ThreadPool::PostTaskAndReplyWithResult(
        FROM_HERE, {base::MayBlock(), base::TaskPriority::USER_VISIBLE},
        base::BindOnce(&FindBundled,
                       exe.AppendASCII("Extensions").AppendASCII(kBundledName)),
        base::BindOnce(&Blocker::Prepared, weak_factory_.GetWeakPtr()));
  }

  void Call(std::string profile, std::string expression, Done done) {
    auto op = std::make_unique<Op>();
    op->id = ++last_op_;
    op->profile = std::move(profile);
    op->expression = std::move(expression);
    op->done = std::move(done);
    op->deadline = base::TimeTicks::Now() + kOpTime;
    if (fail_next_message_ && op->expression != "null") {
      op->fail_next = true;
      fail_next_message_ = false;
    }
    const std::string key = op->profile;
    queues_[key].push_back(std::move(op));
    Pump(key);
  }

  void State(base::OnceCallback<void(base::DictValue)> done) {
    if (!default_settled_) {
      settled_waiters_.push_back(base::BindOnce(
          &Blocker::State, weak_factory_.GetWeakPtr(), std::move(done)));
      return;
    }
    Call(kDefaultProfile, kState,
         base::BindOnce(&Blocker::StateRead, weak_factory_.GetWeakPtr(),
                        std::move(done)));
  }

  void SetEnabled(bool enabled, Settled done) {
    Call(kDefaultProfile,
         ContentBlockerScript(kSetEnabled, {Json(base::Value(enabled)),
                                            Json(base::Value(enabled))}),
         base::BindOnce(&Blocker::Changed, weak_factory_.GetWeakPtr(),
                        std::move(done)));
  }

  void SetList(const std::string& id, bool enabled, Settled done) {
    Call(kDefaultProfile,
         ContentBlockerScript(kSetList,
                              {Quoted(id), Json(base::Value(enabled))}),
         base::BindOnce(&Blocker::ListsChanged, weak_factory_.GetWeakPtr(),
                        std::move(done)));
  }

  void IsAllowed(const std::string& host,
                 base::OnceCallback<void(bool)> done) {
    Call(kDefaultProfile,
         ContentBlockerScript(kIsAllowed, {Quoted(base::ToLowerASCII(host))}),
         base::BindOnce(
             [](base::OnceCallback<void(bool)> done, base::Value value,
                std::string error) {
               std::move(done).Run(error.empty() && value.is_bool() &&
                                   value.GetBool());
             },
             std::move(done)));
  }

  void SetAllowed(bool allowed, const std::string& host, Settled done) {
    Call(kDefaultProfile,
         ContentBlockerScript(kSetAllowed, {Json(base::Value(allowed)),
                                            Quoted(base::ToLowerASCII(host))}),
         base::BindOnce(&Blocker::Changed, weak_factory_.GetWeakPtr(),
                        std::move(done)));
  }

  void FailNextMessage() { fail_next_message_ = true; }
  void DelayNextLoad(double ms) { delay_next_load_ms_ = ms; }

  void OnProfileAdded(Profile* profile) override { Adopt(profile); }

  void OnProfileManagerDestroying() override {
    profile_manager_observation_.Reset();
  }

  void OnProfileWillBeDestroyed(Profile* profile) override {
    profile_observations_.RemoveObservation(profile);
    for (auto it = profiles_.begin(); it != profiles_.end();) {
      if (it->second != profile) {
        ++it;
        continue;
      }
      const std::string name = it->first;
      it = profiles_.erase(it);
      loaded_.erase(name);
      if (auto page = pages_.find(name); page != pages_.end()) {
        page->second->Fail("profile gone");
        pages_.erase(page);
      }
    }
  }

 private:
  friend class base::NoDestructor<Blocker>;

  struct Bundled {
    base::FilePath path;
    std::string version;
  };

  Blocker() = default;
  ~Blocker() override = default;

  static std::optional<Bundled> FindBundled(base::FilePath path) {
    std::string manifest;
    if (!base::ReadFileToString(path.AppendASCII("manifest.json"),
                                &manifest)) {
      return std::nullopt;
    }
    Bundled bundled{base::MakeAbsoluteFilePath(path), std::string()};
    if (bundled.path.empty()) {
      return std::nullopt;
    }
    std::optional<base::Value> parsed =
        base::JSONReader::Read(manifest, base::JSON_PARSE_RFC);
    if (parsed && parsed->is_dict()) {
      for (const char* key : {"version_name", "version"}) {
        if (const std::string* version = parsed->GetDict().FindString(key)) {
          bundled.version = *version;
          break;
        }
      }
    }
    return bundled;
  }

  void Prepared(std::optional<Bundled> bundled) {
    prepared_ = true;
    if (bundled) {
      path_ = bundled->path;
      version_ = bundled->version;
    } else {
      Note("blocker", "no bundled uBlock Origin beside the binary");
      CountLinux("contentBlockerMissing");
    }
    if (ProfileManager* manager = g_browser_process->profile_manager()) {
      profile_manager_observation_.Observe(manager);
      for (Profile* profile : manager->GetLoadedProfiles()) {
        Adopt(profile);
      }
    }
    if (!profiles_.contains(kDefaultProfile)) {
      ardia_win::WithProfile(
          kDefaultProfile,
          base::BindOnce(&Blocker::AdoptLoaded, weak_factory_.GetWeakPtr()));
    }
    std::vector<base::OnceClosure> waiting = std::move(prepared_waiters_);
    prepared_waiters_.clear();
    for (base::OnceClosure& run : waiting) {
      std::move(run).Run();
    }
  }

  void AdoptLoaded(Profile* profile) {
    if (profile) {
      Adopt(profile);
    }
  }

  void Adopt(Profile* profile) {
    if (!profile || !profile->IsRegularProfile()) {
      return;
    }
    const std::string name = ardia_win::NameOfProfile(profile);
    if (profiles_.contains(name)) {
      return;
    }
    profiles_[name] = profile;
    if (!profile_observations_.IsObservingSource(profile)) {
      profile_observations_.AddObservation(profile);
    }
    const double delay = std::exchange(delay_next_load_ms_, 0);
    if (delay > 0) {
      base::SingleThreadTaskRunner::GetCurrentDefault()->PostDelayedTask(
          FROM_HERE,
          base::BindOnce(&Blocker::LoadHeld, weak_factory_.GetWeakPtr(), name),
          base::Milliseconds(delay));
      return;
    }
    LoadHeld(name);
  }

  Profile* ProfileNamed(const std::string& name) const {
    auto it = profiles_.find(name);
    return it == profiles_.end() ? nullptr : it->second.get();
  }

  void LoadIntoProfile(const std::string& name, Settled then) {
    if (!prepared_) {
      prepared_waiters_.push_back(base::BindOnce(
          &Blocker::LoadIntoProfile, weak_factory_.GetWeakPtr(), name,
          std::move(then)));
      return;
    }
    if (loaded_.contains(name)) {
      std::move(then).Run(std::string());
      return;
    }
    Profile* profile = ProfileNamed(name);
    if (!profile || path_.empty()) {
      std::move(then).Run("not loaded");
      return;
    }
    extensions::ExtensionSystem* system =
        extensions::ExtensionSystem::Get(profile);
    if (!system) {
      std::move(then).Run("not loaded");
      return;
    }
    if (!system->is_ready()) {
      system->ready().Post(
          FROM_HERE, base::BindOnce(&Blocker::LoadIntoProfile,
                                    weak_factory_.GetWeakPtr(), name,
                                    std::move(then)));
      return;
    }
    std::string loaded_id;
    for (const auto& extension :
         extensions::ExtensionRegistry::Get(profile)->enabled_extensions()) {
      if (extension->location() ==
              extensions::mojom::ManifestLocation::kComponent &&
          extension->path() == path_) {
        loaded_id = extension->id();
      }
    }
    if (loaded_id.empty()) {
      if (extensions::ComponentLoader* loader =
              extensions::ComponentLoader::Get(profile)) {
        loaded_id = loader->AddOrReplace(path_);
      }
    }
    if (loaded_id != kContentBlockerExtensionId) {
      Note("blocker", "component load failed (" + loaded_id + ")");
      CountLinux("contentBlockerLoadFailures");
      std::move(then).Run("not loaded");
      return;
    }
    CountLinux("contentBlockerLoads");
    loaded_.insert(name);
    std::move(then).Run(std::string());
  }

  void LoadHeld(const std::string& name) {
    const bool is_default = name.empty();
    LoadIntoProfile(
        name, base::BindOnce(&Blocker::LoadedHeld, weak_factory_.GetWeakPtr(),
                             name, is_default));
  }

  void LoadedHeld(const std::string& name,
                  bool is_default,
                  std::string error) {
    if (!error.empty()) {
      Note("blocker",
           "the content blocker didn't load into a profile: " + error);
      if (is_default) {
        DefaultSettled();
      }
      return;
    }
    if (!is_default) {
      WhenDefaultSettled(base::BindOnce(&Blocker::Inherit,
                                        weak_factory_.GetWeakPtr(), name, 0));
      return;
    }
    Call(name, "null",
         base::BindOnce(
             [](base::WeakPtr<Blocker> blocker, base::Value,
                std::string ready_error) {
               if (!blocker) {
                 return;
               }
               if (!ready_error.empty()) {
                 Note("blocker", "uBlock Origin isn't ready: " + ready_error);
               }
               blocker->DefaultSettled();
             },
             weak_factory_.GetWeakPtr()));
  }

  void WhenDefaultSettled(base::OnceClosure then) {
    if (default_settled_) {
      std::move(then).Run();
      return;
    }
    settled_waiters_.push_back(std::move(then));
  }

  void DefaultSettled() {
    default_settled_ = true;
    std::vector<base::OnceClosure> waiters = std::move(settled_waiters_);
    settled_waiters_.clear();
    for (base::OnceClosure& waiter : waiters) {
      std::move(waiter).Run();
    }
  }

  void Inherit(const std::string& name, int attempt) {
    FollowDefault(
        std::vector<std::string>{name},
        base::BindOnce(
            [](base::WeakPtr<Blocker> blocker, std::string name, int attempt,
               std::string error) {
              if (!blocker) {
                return;
              }
              const bool gone = !blocker->ProfileNamed(name) ||
                                !blocker->loaded_.contains(name);
              if (error.empty() || gone || attempt + 1 >= kInheritAttempts) {
                if (!error.empty() && !gone) {
                  Note("blocker",
                       "a profile didn't take the default profile's settings: " +
                           error);
                }
                return;
              }
              base::SingleThreadTaskRunner::GetCurrentDefault()
                  ->PostDelayedTask(
                      FROM_HERE,
                      base::BindOnce(&Blocker::Inherit, blocker, name,
                                     attempt + 1),
                      base::Seconds(1 << attempt));
            },
            weak_factory_.GetWeakPtr(), name, attempt));
  }

  void FollowDefault(std::optional<std::vector<std::string>> only,
                     Settled done) {
    if (!default_settled_) {
      WhenDefaultSettled(base::BindOnce(&Blocker::FollowDefault,
                                        weak_factory_.GetWeakPtr(),
                                        std::move(only), std::move(done)));
      return;
    }
    std::vector<std::string> profiles;
    if (only) {
      profiles = std::move(*only);
    } else {
      profiles.assign(loaded_.begin(), loaded_.end());
    }
    std::erase_if(profiles,
                  [](const std::string& name) { return name.empty(); });
    if (profiles.empty()) {
      std::move(done).Run(std::string());
      return;
    }
    Call(kDefaultProfile, kRead,
         base::BindOnce(&Blocker::CopyDefault, weak_factory_.GetWeakPtr(),
                        std::move(profiles), std::move(done)));
  }

  void CopyDefault(std::vector<std::string> profiles,
                   Settled done,
                   base::Value settings,
                   std::string error) {
    if (!error.empty()) {
      std::move(done).Run(error);
      return;
    }
    if (!settings.is_dict()) {
      std::move(done).Run("no settings to copy");
      return;
    }
    auto failed = std::make_shared<std::string>();
    base::RepeatingClosure finished = base::BarrierClosure(
        profiles.size(),
        base::BindOnce(
            [](std::shared_ptr<std::string> failed, Settled done) {
              std::move(done).Run(*failed);
            },
            failed, std::move(done)));
    const std::string script =
        ContentBlockerScript(kFollow, {Json(settings)});
    for (const std::string& name : profiles) {
      Call(name, script,
           base::BindOnce(
               [](base::WeakPtr<Blocker> blocker, std::string name,
                  std::shared_ptr<std::string> failed,
                  base::RepeatingClosure finished, base::Value,
                  std::string error) {
                 const bool gone = !blocker || !blocker->ProfileNamed(name);
                 if (!gone && failed->empty()) {
                   *failed = error;
                 }
                 finished.Run();
               },
               weak_factory_.GetWeakPtr(), name, failed, finished));
    }
  }

  void StateRead(base::OnceCallback<void(base::DictValue)> done,
                 base::Value read,
                 std::string error) {
    const base::DictValue* fields = read.GetIfDict();
    const base::ListValue* read_lists =
        fields ? fields->FindList("lists") : nullptr;
    if (!read_lists) {
      base::DictValue stats;
      stats.Set("ready", false);
      stats.Set("enabled", false);
      stats.Set("parseMs", 0);
      stats.Set("lookups", 0);
      stats.Set("averageLookupMicros", 0);
      stats.Set("maxLookupMicros", 0);
      stats.Set("error", error.empty() ? std::string("unavailable") : error);
      base::DictValue state;
      state.Set("enabled", false);
      state.Set("lists", base::ListValue());
      state.Set("allowedHosts", base::ListValue());
      state.Set("version", version_);
      state.Set("stats", std::move(stats));
      std::move(done).Run(std::move(state));
      return;
    }
    base::ListValue lists;
    for (const base::Value& entry : *read_lists) {
      const base::DictValue* list = entry.GetIfDict();
      const std::string* id = list ? list->FindString("id") : nullptr;
      if (!id) {
        continue;
      }
      const std::string* title = list->FindString("title");
      const std::string* group = list->FindString("group");
      base::DictValue out;
      out.Set("id", *id);
      out.Set("title", title ? *title : *id);
      out.Set("category", CategoryOf(*id, group ? *group : std::string()));
      out.Set("enabled", list->FindBool("enabled").value_or(false));
      out.Set("defaultOn", list->FindBool("defaultOn").value_or(false));
      out.Set("filters", Count(list->Find("filters")));
      lists.Append(std::move(out));
    }
    base::ListValue allowed;
    if (const base::ListValue* hosts = fields->FindList("allowedHosts")) {
      for (const base::Value& host : *hosts) {
        if (host.is_string()) {
          allowed.Append(host.GetString());
        }
      }
    }
    const bool on = fields->FindBool("enabled").value_or(false);
    base::DictValue stats;
    stats.Set("ready", true);
    stats.Set("enabled", on);
    stats.Set("networkFilters", Count(fields->Find("networkFilters")));
    stats.Set("cosmeticFilters", Count(fields->Find("cosmeticFilters")));
    stats.Set("parseMs", 0);
    stats.Set("lookups", 0);
    stats.Set("averageLookupMicros", 0);
    stats.Set("maxLookupMicros", 0);
    base::DictValue state;
    state.Set("enabled", on);
    state.Set("version", version_);
    state.Set("lists", std::move(lists));
    state.Set("allowedHosts", std::move(allowed));
    state.Set("stats", std::move(stats));
    std::move(done).Run(std::move(state));
  }

  void EmitChanged() {
    State(base::BindOnce([](base::DictValue state) {
      base::Value stats(base::Value::Type::DICT);
      if (base::DictValue* found = state.FindDict("stats")) {
        stats = base::Value(std::move(*found));
      }
      EmitDomainEvent("contentBlocker", "changed", std::move(stats));
    }));
  }

  void Changed(Settled done, base::Value, std::string error) {
    if (!error.empty()) {
      CountLinux("contentBlockerWriteFailures");
      std::move(done).Run(error);
      return;
    }
    FollowDefault(std::nullopt,
                  base::BindOnce(
                      [](base::WeakPtr<Blocker> blocker, Settled done,
                         std::string follow_error) {
                        if (blocker) {
                          blocker->EmitChanged();
                        }
                        std::move(done).Run(follow_error);
                      },
                      weak_factory_.GetWeakPtr(), std::move(done)));
  }

  void ListsChanged(Settled done, base::Value, std::string error) {
    if (!error.empty()) {
      CountLinux("contentBlockerWriteFailures");
      std::move(done).Run(error);
      return;
    }
    std::move(done).Run(std::string());
    EmitChanged();
    FollowDefault(std::nullopt, base::BindOnce([](std::string follow_error) {
                    if (!follow_error.empty()) {
                      Note("blocker",
                           "the other profiles didn't take the list change: " +
                               follow_error);
                    }
                  }));
  }

  BlockerPage* PageFor(const std::string& name) {
    auto it = pages_.find(name);
    if (it != pages_.end() && !it->second->dead()) {
      return it->second.get();
    }
    Profile* profile = ProfileNamed(name);
    if (!profile) {
      return nullptr;
    }
    const extensions::Extension* extension =
        extensions::ExtensionRegistry::Get(profile)->enabled_extensions().GetByID(
            kContentBlockerExtensionId);
    if (!extension) {
      return nullptr;
    }
    auto page = std::make_unique<BlockerPage>(profile, extension);
    BlockerPage* made = page.get();
    pages_[name] = std::move(page);
    return made;
  }

  Op* Front(const std::string& profile) {
    auto it = queues_.find(profile);
    return it == queues_.end() || it->second.empty() ? nullptr
                                                     : it->second.front().get();
  }

  void Pump(const std::string& profile) {
    if (busy_.contains(profile)) {
      return;
    }
    Op* op = Front(profile);
    if (!op) {
      return;
    }
    busy_.insert(profile);
    Attempt(profile, op->id);
  }

  void Finish(const std::string& profile,
              uint64_t id,
              base::Value value,
              std::string error) {
    Op* op = Front(profile);
    if (!op || op->id != id) {
      return;
    }
    std::unique_ptr<Op> done = std::move(queues_[profile].front());
    queues_[profile].pop_front();
    busy_.erase(profile);
    if (!error.empty()) {
      Note("blocker", "a call failed: " + error);
    }
    std::move(done->done).Run(std::move(value), error);
    Pump(profile);
    if (!Front(profile)) {
      CloseWhenIdle(profile);
    }
  }

  void CloseWhenIdle(const std::string& profile) {
    const int use = ++uses_[profile];
    base::SingleThreadTaskRunner::GetCurrentDefault()->PostDelayedTask(
        FROM_HERE,
        base::BindOnce(
            [](base::WeakPtr<Blocker> blocker, std::string profile, int use) {
              if (!blocker || blocker->uses_[profile] != use ||
                  blocker->busy_.contains(profile) || blocker->Front(profile)) {
                return;
              }
              if (auto it = blocker->pages_.find(profile);
                  it != blocker->pages_.end()) {
                it->second->Fail("idle");
                blocker->pages_.erase(it);
              }
            },
            weak_factory_.GetWeakPtr(), profile, use),
        kPageIdle);
  }

  static bool Retriable(const std::string& error, BlockerPage* page) {
    if (!page || !page->OnOwnPage()) {
      return true;
    }
    for (const char* sign :
         {"no reply", "no answer", "context invalidated",
          "not the extension page", "renderer ", "closed"}) {
      if (error.find(sign) != std::string::npos) {
        return true;
      }
    }
    return false;
  }

  void Attempt(const std::string& profile, uint64_t id) {
    Op* op = Front(profile);
    if (!op || op->id != id) {
      return;
    }
    if (!loaded_.contains(profile)) {
      LoadIntoProfile(
          profile,
          base::BindOnce(
              [](base::WeakPtr<Blocker> blocker, std::string profile,
                 uint64_t id, std::string error) {
                if (!blocker) {
                  return;
                }
                if (!error.empty()) {
                  blocker->Finish(profile, id, base::Value(), error);
                } else {
                  blocker->Attempt(profile, id);
                }
              },
              weak_factory_.GetWeakPtr(), profile, id));
      return;
    }
    BlockerPage* page = PageFor(profile);
    if (!page) {
      Finish(profile, id, base::Value(), "not loaded");
      return;
    }
    const int64_t left_ms = std::max<int64_t>(
        0, (op->deadline - base::TimeTicks::Now()).InMilliseconds());
    const std::string script = ContentBlockerScript(
        kPrelude,
        {op->fail_next ? "true" : "false", Quoted(kOffDirective),
         Quoted(std::string("chrome-extension://") +
                kContentBlockerExtensionId),
         base::NumberToString(left_ms), base::NumberToString(kReloadWaitMs),
         op->expression});
    const int attempt = ++op->attempt;
    base::SingleThreadTaskRunner::GetCurrentDefault()->PostDelayedTask(
        FROM_HERE,
        base::BindOnce(
            [](base::WeakPtr<Blocker> blocker, std::string profile,
               uint64_t id, int attempt) {
              if (!blocker) {
                return;
              }
              Op* op = blocker->Front(profile);
              if (!op || op->id != id || op->attempt != attempt) {
                return;
              }
              if (auto it = blocker->pages_.find(profile);
                  it != blocker->pages_.end()) {
                it->second->Fail("the call timed out");
              }
            },
            weak_factory_.GetWeakPtr(), profile, id, attempt),
        base::Milliseconds(left_ms + 2000));
    page->Run(script, base::BindOnce(&Blocker::Ran, weak_factory_.GetWeakPtr(),
                                     profile, id, attempt));
  }

  void Ran(const std::string& profile,
           uint64_t id,
           int attempt,
           base::Value value,
           std::string error) {
    Op* op = Front(profile);
    if (!op || op->id != id || op->attempt != attempt) {
      return;
    }
    if (base::EndsWith(error, "failed (dev)")) {
      op->fail_next = false;
    }
    auto page_it = pages_.find(profile);
    BlockerPage* page = page_it == pages_.end() ? nullptr : page_it->second.get();
    if (page && error.find("timed out") != std::string::npos) {
      page->Fail(error);
    }
    const bool in_time = base::TimeTicks::Now() < op->deadline;
    if (!error.empty() && op->attempts_left > 0 && in_time &&
        Retriable(error, page) && loaded_.contains(profile) &&
        ProfileNamed(profile)) {
      --op->attempts_left;
      if (page) {
        page->Fail("uBlock Origin restarted");
      }
      base::SingleThreadTaskRunner::GetCurrentDefault()->PostDelayedTask(
          FROM_HERE,
          base::BindOnce(&Blocker::Attempt, weak_factory_.GetWeakPtr(),
                         profile, id),
          kRetry);
      return;
    }
    Finish(profile, id, std::move(value), error);
  }

  bool started_ = false;
  bool prepared_ = false;
  bool default_settled_ = false;
  bool fail_next_message_ = false;
  double delay_next_load_ms_ = 0;
  uint64_t last_op_ = 0;
  base::FilePath path_;
  std::string version_;
  std::map<std::string, raw_ptr<Profile>> profiles_;
  std::set<std::string> loaded_;
  std::map<std::string, std::unique_ptr<BlockerPage>> pages_;
  std::map<std::string, std::deque<std::unique_ptr<Op>>> queues_;
  std::set<std::string> busy_;
  std::map<std::string, int> uses_;
  std::vector<base::OnceClosure> prepared_waiters_;
  std::vector<base::OnceClosure> settled_waiters_;
  base::ScopedObservation<ProfileManager, ProfileManagerObserver>
      profile_manager_observation_{this};
  base::ScopedMultiSourceObservation<Profile, ProfileObserver>
      profile_observations_{this};
  base::WeakPtrFactory<Blocker> weak_factory_{this};
};

void ReplySettled(ModuleReply reply, std::string error) {
  if (!error.empty()) {
    ReplyError(std::move(reply), error, "ERR_CONTENT_BLOCKER");
    return;
  }
  ReplyNull(std::move(reply));
}

void StateVerb(const std::string&, base::DictValue, ModuleReply reply) {
  Blocker::Get().State(base::BindOnce(
      [](ModuleReply reply, base::DictValue state) {
        ReplyJson(std::move(reply), base::Value(std::move(state)));
      },
      std::move(reply)));
}

void SetEnabledVerb(const std::string&,
                    base::DictValue args,
                    ModuleReply reply) {
  Blocker::Get().SetEnabled(args.FindBool("enabled").value_or(false),
                            base::BindOnce(&ReplySettled, std::move(reply)));
}

void SetListEnabledVerb(const std::string&,
                        base::DictValue args,
                        ModuleReply reply) {
  const std::string* id = args.FindString("id");
  if (!id) {
    ReplyError(std::move(reply), "contentBlocker.setListEnabled: no id",
               "ERR_BAD_ARGS");
    return;
  }
  Blocker::Get().SetList(*id, args.FindBool("enabled").value_or(false),
                         base::BindOnce(&ReplySettled, std::move(reply)));
}

void IsAllowedVerb(const std::string&, base::DictValue args, ModuleReply reply) {
  const std::string* host = args.FindString("host");
  Blocker::Get().IsAllowed(
      host ? *host : std::string(),
      base::BindOnce(
          [](ModuleReply reply, bool allowed) {
            ReplyJson(std::move(reply), base::Value(allowed));
          },
          std::move(reply)));
}

void SetAllowedVerb(const std::string&,
                    base::DictValue args,
                    ModuleReply reply) {
  const std::string* host = args.FindString("host");
  if (!host || host->empty()) {
    ReplyError(std::move(reply), "contentBlocker.setAllowed: no host",
               "ERR_BAD_ARGS");
    return;
  }
  Blocker::Get().SetAllowed(args.FindBool("allowed").value_or(false), *host,
                            base::BindOnce(&ReplySettled, std::move(reply)));
}

void DevFailNextMessageVerb(const std::string&,
                            base::DictValue,
                            ModuleReply reply) {
  Blocker::Get().FailNextMessage();
  ReplyNull(std::move(reply));
}

void DevDelayNextLoadVerb(const std::string&,
                          base::DictValue args,
                          ModuleReply reply) {
  Blocker::Get().DelayNextLoad(args.FindDouble("ms").value_or(0));
  ReplyNull(std::move(reply));
}

class BlockedRequests
    : public content::WebContentsObserver,
      public content::WebContentsUserData<BlockedRequests> {
 public:
  ~BlockedRequests() override = default;

  void ResourceLoadComplete(
      content::RenderFrameHost* frame,
      const content::GlobalRequestID& request_id,
      const GURL& original_url,
      const blink::mojom::ResourceLoadInfo& info) override {
    if (info.net_error != net::ERR_BLOCKED_BY_CLIENT ||
        blink::IsRequestDestinationFrame(info.request_destination) ||
        !InPrimaryPage(frame)) {
      return;
    }
    NoteBlocked(original_url);
  }

  void DidFinishNavigation(content::NavigationHandle* navigation) override {
    if (navigation->GetNetErrorCode() != net::ERR_BLOCKED_BY_CLIENT) {
      return;
    }
    const bool counted =
        navigation->IsInMainFrame()
            ? navigation->IsInPrimaryMainFrame()
            : InPrimaryPage(navigation->GetParentFrameOrOuterDocument());
    if (counted) {
      NoteBlocked(navigation->GetURL());
    }
  }

  void DidStartLoading() override {
    ++generation_;
    report_queued_ = false;
    const bool had = count_ > 0 || !last_url_.empty();
    count_ = 0;
    last_url_.clear();
    if (had) {
      Report(0, std::string());
    }
  }

 private:
  friend class content::WebContentsUserData<BlockedRequests>;

  explicit BlockedRequests(content::WebContents* contents)
      : content::WebContentsObserver(contents),
        content::WebContentsUserData<BlockedRequests>(*contents) {}

  static bool InPrimaryPage(content::RenderFrameHost* frame) {
    return frame && frame->GetOutermostMainFrame()->IsInPrimaryMainFrame();
  }

  void NoteBlocked(const GURL& url) {
    ++count_;
    last_url_ = url.spec();
    if (report_queued_) {
      return;
    }
    report_queued_ = true;
    base::SingleThreadTaskRunner::GetCurrentDefault()->PostDelayedTask(
        FROM_HERE,
        base::BindOnce(
            [](base::WeakPtr<BlockedRequests> self, uint64_t generation) {
              if (!self || self->generation_ != generation) {
                return;
              }
              self->report_queued_ = false;
              self->Report(self->count_, self->last_url_);
            },
            weak_factory_.GetWeakPtr(), generation_),
        kBlockedReportDelay);
  }

  void Report(int count, const std::string& url) {
    ardia_win::TabState* state =
        ardia_win::TabState::FromWebContents(web_contents());
    if (!state) {
      return;
    }
    base::DictValue data;
    data.Set("count", count);
    data.Set("url", url);
    state->Send("contentBlocked", std::move(data));
  }

  int count_ = 0;
  std::string last_url_;
  bool report_queued_ = false;
  uint64_t generation_ = 0;
  base::WeakPtrFactory<BlockedRequests> weak_factory_{this};
  WEB_CONTENTS_USER_DATA_KEY_DECL();
};

WEB_CONTENTS_USER_DATA_KEY_IMPL(BlockedRequests);

}

std::string ContentBlockerScript(std::string_view format,
                                 const std::vector<std::string>& pieces) {
  std::string out;
  size_t piece = 0;
  size_t from = 0;
  while (true) {
    const size_t at = format.find("%@", from);
    if (at == std::string_view::npos) {
      out.append(format.substr(from));
      return out;
    }
    out.append(format.substr(from, at - from));
    out.append(piece < pieces.size() ? pieces[piece] : std::string("null"));
    ++piece;
    from = at + 2;
  }
}

std::string ContentBlockerCategory(std::string_view list_id,
                                   std::string_view group) {
  return CategoryOf(list_id, group);
}

void WatchBlockedRequests(content::WebContents* contents) {
  BlockedRequests::CreateForWebContents(contents);
}

void AddContentBlockerVerbs(DomainVerbs& verbs) {
  Blocker::Get().Start();
  verbs.Add("contentBlocker", "state", base::BindRepeating(&StateVerb));
  verbs.Add("contentBlocker", "setEnabled",
            base::BindRepeating(&SetEnabledVerb));
  verbs.Add("contentBlocker", "setListEnabled",
            base::BindRepeating(&SetListEnabledVerb));
  verbs.Add("contentBlocker", "isAllowed", base::BindRepeating(&IsAllowedVerb));
  verbs.Add("contentBlocker", "setAllowed",
            base::BindRepeating(&SetAllowedVerb));
  verbs.Add("contentBlocker", "devFailNextMessage",
            base::BindRepeating(&DevFailNextMessageVerb));
  verbs.Add("contentBlocker", "devDelayNextLoad",
            base::BindRepeating(&DevDelayNextLoadVerb));
}

}
