#ifndef ARDIA_WIN_NOW_PLAYING_H_
#define ARDIA_WIN_NOW_PLAYING_H_

#include <cstdint>
#include <optional>
#include <string>
#include <vector>

#include "ardia/win/api.h"
#include "ardia/win/now_playing_artwork.h"
#include "ardia/win/now_playing_state.h"
#include "base/containers/flat_map.h"
#include "base/time/time.h"
#include "base/timer/timer.h"
#include "base/values.h"
#include "content/public/browser/web_contents_observer.h"
#include "content/public/browser/weak_document_ptr.h"
#include "content/public/browser/web_contents_user_data.h"
#include "mojo/public/cpp/bindings/receiver.h"
#include "services/media_session/public/cpp/media_image.h"
#include "services/media_session/public/cpp/media_metadata.h"
#include "services/media_session/public/cpp/media_position.h"
#include "services/media_session/public/mojom/media_session.mojom.h"

namespace content {
class MediaSession;
}

namespace ardia_win {

class NowPlaying : public content::WebContentsObserver,
                   public content::WebContentsUserData<NowPlaying>,
                   public media_session::mojom::MediaSessionObserver {
 public:
  NowPlaying(const NowPlaying&) = delete;
  NowPlaying& operator=(const NowPlaying&) = delete;
  ~NowPlaying() override;

  static void Watch(content::WebContents* contents);
  static void Resend(content::WebContents* contents);
  static void End(content::WebContents* contents);
  static void ReloadToPlay(content::WebContents* contents);
  static void CancelWake(content::WebContents* contents);
  static MediaCommandOutcome Command(content::WebContents* contents,
                                     const MediaCommandArgs& command);
  static void DownloadArtwork(content::WebContents* contents,
                              const base::DictValue& args,
                              Reply reply);
  static void AudioFocusForTest(content::WebContents* contents,
                                const base::DictValue& args,
                                Reply reply);
  static void ActiveSessionForTest(content::WebContents* contents,
                                   const base::DictValue& args,
                                   Reply reply);

 private:
  friend class content::WebContentsUserData<NowPlaying>;

  explicit NowPlaying(content::WebContents* contents);

  void MediaSessionCreated(content::MediaSession* session) override;
  void PrimaryPageChanged(content::Page& page) override;
  void DidStartNavigation(content::NavigationHandle* navigation) override;
  void DidFinishNavigation(content::NavigationHandle* navigation) override;
  void WebContentsDestroyed() override;

  void MediaSessionInfoChanged(
      media_session::mojom::MediaSessionInfoPtr info) override;
  void MediaSessionMetadataChanged(
      const std::optional<media_session::MediaMetadata>& metadata) override;
  void MediaSessionActionsChanged(
      const std::vector<media_session::mojom::MediaSessionAction>& actions)
      override;
  void MediaSessionImagesChanged(
      const base::flat_map<media_session::mojom::MediaSessionImageType,
                           std::vector<media_session::MediaImage>>& images)
      override;
  void MediaSessionPositionChanged(
      const std::optional<media_session::MediaPosition>& position) override;

  void ObserveSession(content::MediaSession* session);
  content::MediaSession* LiveSession() const;
  bool Lists(media_session::mojom::MediaSessionAction action) const;
  bool PageHandles(media_session::mojom::MediaSessionAction action) const;
  void EndWake();
  bool WakeUsable() const;
  MediaCommandOutcome TakeWakeCommand(const MediaCommandArgs& command);
  MediaCommandOutcome RunCommand(const MediaCommandArgs& command);
  MediaCommandResult SeekBy(content::MediaSession* session, double seconds);
  std::optional<NowPlayingState> Current() const;
  void Update();
  void ForceReport();
  void Send(const std::optional<NowPlayingState>& state);

  std::optional<NowPlayingState> sent_;
  bool force_report_ = false;
  base::TimeTicks sent_at_;
  enum class WakeStage { kNone, kLoading, kLoaded };
  WakeStage wake_stage_ = WakeStage::kNone;
  bool wake_reload_starting_ = false;
  base::TimeTicks wake_until_;
  int64_t wake_navigation_ = 0;
  content::WeakDocumentPtr wake_document_;
  std::string wake_key_;
  std::optional<double> wake_play_from_;
  base::OneShotTimer coalesce_;
  base::OneShotTimer seek_report_;
  NowPlayingArtwork artwork_;
  mojo::Receiver<media_session::mojom::MediaSessionObserver> receiver_{this};
  WEB_CONTENTS_USER_DATA_KEY_DECL();
};

}

#endif
