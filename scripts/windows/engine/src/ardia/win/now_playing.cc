#include "ardia/win/now_playing.h"

#include <algorithm>
#include <cmath>
#include <utility>

#include "ardia/win/main.h"
#include "ardia/win/tab_state.h"
#include "base/functional/bind.h"
#include "base/location.h"
#include "content/common/content_export.h"
#include "content/public/browser/media_session.h"
#include "content/public/browser/navigation_controller.h"
#include "content/public/browser/navigation_handle.h"
#include "content/public/browser/page.h"
#include "content/public/browser/reload_type.h"
#include "content/public/browser/render_frame_host.h"
#include "content/public/browser/web_contents.h"

namespace content {
CONTENT_EXPORT bool ArdiaWinMediaSessionOnPrimaryPage(WebContents* contents);
}

namespace ardia_win {

namespace {

using Action = media_session::mojom::MediaSessionAction;
using SessionState = media_session::mojom::MediaSessionInfo::SessionState;

constexpr size_t kActionLimit = 32;
constexpr int kMostImagePixels = 512;
constexpr base::TimeDelta kReportGap = base::Milliseconds(100);
constexpr base::TimeDelta kWakeToPlay = base::Seconds(20);

}

NowPlaying::NowPlaying(content::WebContents* contents)
    : content::WebContentsObserver(contents),
      content::WebContentsUserData<NowPlaying>(*contents),
      artwork_(*contents) {
  ObserveSession(content::MediaSession::GetIfExists(contents));
}

NowPlaying::~NowPlaying() = default;

void NowPlaying::Watch(content::WebContents* contents) {
  if (contents && !FromWebContents(contents)) {
    CreateForWebContents(contents);
  }
}

void NowPlaying::Resend(content::WebContents* contents) {
  if (NowPlaying* now = contents ? FromWebContents(contents) : nullptr) {
    now->Send(now->Current());
  }
}

void NowPlaying::End(content::WebContents* contents) {
  NowPlaying* now = contents ? FromWebContents(contents) : nullptr;
  if (now) {
    now->EndWake();
  }
  if (now && now->sent_) {
    now->Send(std::nullopt);
  }
}

void NowPlaying::ReloadToPlay(content::WebContents* contents) {
  Watch(contents);
  NowPlaying* now = FromWebContents(contents);
  const TabState* tab = TabState::FromWebContents(contents);
  if (now->wake_stage_ == WakeStage::kLoading &&
      base::TimeTicks::Now() < now->wake_until_) {
    NoteForTest("now playing " + (tab ? tab->key() : std::string()) +
                ": wake kept: a reload is already pending");
    return;
  }
  const bool stale_wake = now->wake_stage_ == WakeStage::kLoading;
  now->EndWake();
  const bool wakes = (contents->WasDiscarded() || stale_wake) && tab &&
                     !tab->key().empty();
  if (wakes) {
    now->wake_key_ = tab->key();
    now->wake_reload_starting_ = true;
  }
  contents->GetController().Reload(content::ReloadType::NORMAL, true);
  now->wake_reload_starting_ = false;
  if (now->wake_stage_ != WakeStage::kLoading) {
    now->EndWake();
  }
}

void NowPlaying::CancelWake(content::WebContents* contents) {
  if (NowPlaying* now = contents ? FromWebContents(contents) : nullptr) {
    now->EndWake();
  }
}

void NowPlaying::EndWake() {
  wake_stage_ = WakeStage::kNone;
  wake_until_ = base::TimeTicks();
  wake_navigation_ = 0;
  wake_document_ = content::WeakDocumentPtr();
  wake_key_.clear();
  wake_play_from_.reset();
}

bool NowPlaying::WakeUsable() const {
  if (wake_stage_ != WakeStage::kLoaded) {
    return false;
  }
  content::WebContents* contents = web_contents();
  const TabState* tab = contents ? TabState::FromWebContents(contents) : nullptr;
  content::RenderFrameHost* document =
      wake_document_.AsRenderFrameHostIfValid();
  return contents && !contents->WasDiscarded() && tab &&
         tab->key() == wake_key_ && document &&
         document == contents->GetPrimaryMainFrame() &&
         base::TimeTicks::Now() < wake_until_;
}

MediaCommandOutcome NowPlaying::Command(content::WebContents* contents,
                                        const MediaCommandArgs& command) {
  NowPlaying* now = contents ? FromWebContents(contents) : nullptr;
  return now ? now->RunCommand(command) : MediaCommandOutcome();
}

void NowPlaying::DownloadArtwork(content::WebContents* contents,
                                 const base::DictValue& args,
                                 Reply reply) {
  NowPlaying* now = contents ? FromWebContents(contents) : nullptr;
  const std::string* url = args.FindString("url");
  const double limit = args.FindDouble("maxPixels").value_or(0);
  if (!now || !url || !std::isfinite(limit) || limit < 1) {
    base::DictValue none;
    none.Set("uri", base::Value());
    std::move(reply).Run(std::move(none));
    return;
  }
  now->artwork_.Download(
      *url, static_cast<int>(std::min<double>(limit, kMostImagePixels)),
      std::move(reply));
}

void NowPlaying::ObserveSession(content::MediaSession* session) {
  if (!session || receiver_.is_bound()) {
    return;
  }
  session->AddObserver(receiver_.BindNewPipeAndPassRemote());
}

content::MediaSession* NowPlaying::LiveSession() const {
  content::WebContents* contents = web_contents();
  content::MediaSession* session =
      contents ? content::MediaSession::GetIfExists(contents) : nullptr;
  if (!session || !content::ArdiaWinMediaSessionOnPrimaryPage(contents)) {
    return nullptr;
  }
  media_session::mojom::MediaSessionInfoPtr info =
      session->GetMediaSessionInfoSync();
  if (!info || info->state == SessionState::kInactive ||
      !info->is_controllable) {
    return nullptr;
  }
  return session;
}

std::optional<NowPlayingState> NowPlaying::Current() const {
  content::MediaSession* session = LiveSession();
  if (!session) {
    return std::nullopt;
  }
  media_session::mojom::MediaSessionInfoPtr info =
      session->GetMediaSessionInfoSync();
  const media_session::MediaMetadata& metadata =
      session->GetMediaSessionMetadata();
  NowPlayingState state;
  state.timestamp = NowMs();
  state.title = BoundedText(metadata.title);
  state.artist = BoundedText(metadata.artist);
  state.album = BoundedText(metadata.album);
  state.artwork = LargestArtwork(artwork_.Declared());
  state.playback_state =
      info->playback_state == media_session::mojom::MediaPlaybackState::kPlaying
          ? "playing"
          : "paused";
  if (const std::optional<media_session::MediaPosition> position =
          session->GetMediaSessionPosition()) {
    const double at =
        position->GetPositionAtTime(base::TimeTicks::Now()).InSecondsF();
    state.position = std::isfinite(at) ? std::max(0.0, at) : 0;
    const base::TimeDelta duration = position->duration();
    if (!duration.is_max() && duration.is_positive()) {
      state.duration = duration.InSecondsF();
      state.position = std::min(state.position, *state.duration);
    }
    const double rate = position->playback_rate();
    state.playback_rate = std::isfinite(rate) && rate != 0 ? rate : 1;
  }
  state.has_video = SessionHasVideo(*info);
  for (const Action action : session->GetMediaSessionActionsSync()) {
    if (state.actions.size() >= kActionLimit) {
      break;
    }
    const std::optional<std::string_view> name = MediaActionName(action);
    if (name && std::ranges::find(state.actions, *name) == state.actions.end()) {
      state.actions.emplace_back(*name);
    }
  }
  state.controllable = info->is_controllable;
  return state;
}

void NowPlaying::Update() {
  std::optional<NowPlayingState> state = Current();
  if (!force_report_ && SameReport(sent_, state)) {
    coalesce_.Stop();
    return;
  }
  const base::TimeTicks now = base::TimeTicks::Now();
  if (now - sent_at_ >= kReportGap) {
    Send(state);
    return;
  }
  if (!coalesce_.IsRunning()) {
    coalesce_.Start(FROM_HERE, sent_at_ + kReportGap - now,
                    base::BindOnce(&NowPlaying::Update, base::Unretained(this)));
  }
}

void NowPlaying::ForceReport() {
  force_report_ = true;
  Update();
}

void NowPlaying::Send(const std::optional<NowPlayingState>& state) {
  coalesce_.Stop();
  seek_report_.Stop();
  force_report_ = false;
  sent_ = state;
  sent_at_ = base::TimeTicks::Now();
  TabState* tab =
      web_contents() ? TabState::FromWebContents(web_contents()) : nullptr;
  if (!tab) {
    return;
  }
  std::optional<std::string> artwork;
  if (state && state->artwork) {
    artwork = artwork_.Reported(*state->artwork);
  }
  tab->Send("nowPlaying", NowPlayingEventData(state, std::move(artwork)));
}

void NowPlaying::MediaSessionCreated(content::MediaSession* session) {
  ObserveSession(session);
}

void NowPlaying::PrimaryPageChanged(content::Page& page) {
  artwork_.PageChanged();
  if (wake_stage_ != WakeStage::kNone &&
      wake_stage_ != WakeStage::kLoading) {
    EndWake();
  }
  Update();
}

void NowPlaying::DidStartNavigation(content::NavigationHandle* navigation) {
  if (!navigation->IsInPrimaryMainFrame() || navigation->IsSameDocument()) {
    return;
  }
  if (wake_reload_starting_ && wake_stage_ == WakeStage::kNone &&
      navigation->GetReloadType() != content::ReloadType::NONE &&
      !navigation->IsRendererInitiated()) {
    wake_stage_ = WakeStage::kLoading;
    wake_navigation_ = navigation->GetNavigationId();
    wake_until_ = base::TimeTicks::Now() + kWakeToPlay;
    return;
  }
  if (wake_stage_ != WakeStage::kNone) {
    EndWake();
  }
}

void NowPlaying::DidFinishNavigation(content::NavigationHandle* navigation) {
  if (wake_stage_ != WakeStage::kLoading ||
      navigation->GetNavigationId() != wake_navigation_) {
    return;
  }
  if (!navigation->HasCommitted() || navigation->IsErrorPage()) {
    EndWake();
    return;
  }
  content::RenderFrameHost* committed = navigation->GetRenderFrameHost();
  if (!committed || !committed->IsInPrimaryMainFrame()) {
    EndWake();
    return;
  }
  wake_stage_ = WakeStage::kLoaded;
  wake_document_ = committed->GetWeakDocumentPtr();
}

void NowPlaying::WebContentsDestroyed() {
  coalesce_.Stop();
  seek_report_.Stop();
  receiver_.reset();
  artwork_.AnswerAll();
}

void NowPlaying::MediaSessionInfoChanged(
    media_session::mojom::MediaSessionInfoPtr info) {
  Update();
}

void NowPlaying::MediaSessionMetadataChanged(
    const std::optional<media_session::MediaMetadata>& metadata) {
  Update();
}

void NowPlaying::MediaSessionActionsChanged(
    const std::vector<media_session::mojom::MediaSessionAction>& actions) {
  Update();
}

void NowPlaying::MediaSessionImagesChanged(
    const base::flat_map<media_session::mojom::MediaSessionImageType,
                         std::vector<media_session::MediaImage>>& images) {
  Update();
}

void NowPlaying::MediaSessionPositionChanged(
    const std::optional<media_session::MediaPosition>& position) {
  Update();
}

WEB_CONTENTS_USER_DATA_KEY_IMPL(NowPlaying);

}
