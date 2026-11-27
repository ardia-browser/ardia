#ifndef ARDIA_MAC_AC_MAC_PIP_H_
#define ARDIA_MAC_AC_MAC_PIP_H_

#include <cstdint>
#include <memory>
#include <optional>
#include <string>
#include <string_view>
#include <vector>

#include "ardia/mac/ac_mac_pip_policy.h"
#include "base/functional/callback.h"
#include "base/memory/raw_ptr.h"
#include "base/memory/weak_ptr.h"
#include "base/time/time.h"
#include "base/timer/timer.h"
#include "base/values.h"
#include "components/viz/common/surfaces/surface_id.h"
#include "content/public/browser/overlay_window.h"
#include "services/media_session/public/cpp/media_position.h"
#include "ui/display/display_observer.h"
#include "ui/gfx/geometry/rect.h"
#include "ui/gfx/geometry/size.h"

namespace views {
class NativeViewHost;
}

class VideoOverlayWindowViews;

namespace content {
class VideoPictureInPictureWindowController;
class WebContents;
}

namespace ardia_mac {

class PipPresenter;
class ShellHostView;

class PipPlayer : public content::VideoOverlayWindow {
 public:
  explicit PipPlayer(content::VideoPictureInPictureWindowController* controller);
  PipPlayer(const PipPlayer&) = delete;
  PipPlayer& operator=(const PipPlayer&) = delete;
  ~PipPlayer() override;

  bool IsActive() const override;
  void Close() override;
  void ShowInactive() override;
  void Hide() override;
  bool IsVisible() const override;
  gfx::Rect GetBounds() override;
  void UpdateNaturalSize(const gfx::Size& natural_size) override;
  void SetPlaybackState(PlaybackState playback_state) override;
  void SetPlayPauseButtonVisibility(bool is_visible) override;
  void SetSkipAdButtonVisibility(bool is_visible) override;
  void SetNextTrackButtonVisibility(bool is_visible) override;
  void SetPreviousTrackButtonVisibility(bool is_visible) override;
  void SetHidePictureInPictureButtonVisibility(bool is_visible) override;
  void SetMicrophoneMuted(bool muted) override;
  void SetCameraState(bool turned_on) override;
  void SetMediaMuted(bool muted) override;
  void SetToggleMicrophoneButtonVisibility(bool is_visible) override;
  void SetToggleCameraButtonVisibility(bool is_visible) override;
  void SetHangUpButtonVisibility(bool is_visible) override;
  void SetNextSlideButtonVisibility(bool is_visible) override;
  void SetPreviousSlideButtonVisibility(bool is_visible) override;
  void SetMediaPosition(const media_session::MediaPosition& position) override;
  void SetSourceTitle(const std::u16string& source_title) override;
  void SetFaviconImages(const std::vector<media_session::MediaImage>& images) override;
  void SetSurfaceId(const viz::SurfaceId& surface_id) override;
  void SetPlaybackControlsVisibility(bool is_visible) override;
  void SetImmersiveVideoOptions(const content::ImmersiveOptions& options) override;

  uint64_t presented_generation() const { return presented_generation_; }
  content::WebContents* source() const;
  const gfx::Size& natural_size() const { return natural_size_; }
  PlaybackState playback_state() const { return playback_state_; }
  const std::optional<media_session::MediaPosition>& position() const { return position_; }
  const std::u16string& source_title() const { return source_title_; }
  bool play_pause_visible() const { return play_pause_visible_; }
  const viz::SurfaceId& surface_id() const { return surface_id_; }

  void SetInWindowScreenBounds(const gfx::Rect& bounds);
  void TogglePlayPause();
  void SeekTo(double seconds);
  void SeekBy(double seconds);
  void BackToTab();
  void CloseFromPlayer();
  void PopOut(std::optional<gfx::Rect> screen_bounds);
  void PresenterGone(PipPresenter* presenter);
  base::WeakPtr<PipPlayer> GetWeakPtr() { return weak_factory_.GetWeakPtr(); }

 private:
  enum class Mode { kIdle, kInWindow, kWindow, kDeclined };

  void EnterInWindow(PipPresenter* presenter);
  void EnterWindow(std::optional<gfx::Rect> screen_bounds);
  void ReplayInto(VideoOverlayWindowViews* window);
  void FinishHandoff(uint64_t generation);
  void ReleasePresenter(base::TimeDelta fade);
  void Changed();
  void EndSessionSoon();
  void EndSession(uint64_t generation);
  bool CurrentPictureInPicture() const;
  bool Windowed() const { return mode_ == Mode::kWindow && window_; }

  raw_ptr<content::VideoPictureInPictureWindowController> controller_;
  std::unique_ptr<VideoOverlayWindowViews> window_;
  base::WeakPtr<PipPresenter> presenter_;
  Mode mode_ = Mode::kIdle;
  bool visible_ = false;
  uint64_t generation_ = 0;
  uint64_t presented_generation_ = 0;
  gfx::Rect bounds_;
  base::TimeDelta hide_fade_;
  gfx::Size natural_size_;
  PlaybackState playback_state_ = kPaused;
  std::optional<media_session::MediaPosition> position_;
  std::u16string source_title_;
  std::vector<media_session::MediaImage> favicon_images_;
  viz::SurfaceId surface_id_;
  bool play_pause_visible_ = true;
  bool skip_ad_visible_ = false;
  bool next_track_visible_ = false;
  bool previous_track_visible_ = false;
  bool hide_button_visible_ = false;
  bool microphone_muted_ = false;
  bool camera_on_ = false;
  bool media_muted_ = false;
  bool toggle_microphone_visible_ = false;
  bool toggle_camera_visible_ = false;
  bool hang_up_visible_ = false;
  bool next_slide_visible_ = false;
  bool previous_slide_visible_ = false;
  bool playback_controls_visible_ = true;
  std::optional<content::ImmersiveOptions> immersive_options_;
  base::OneShotTimer handoff_timer_;
  base::WeakPtrFactory<PipPlayer> weak_factory_{this};
};

class PipPlane;

class PipPresenter : public display::DisplayObserver {
 public:
  using Done = base::OnceCallback<void(bool, base::Value)>;

  explicit PipPresenter(ShellHostView* host);
  PipPresenter(const PipPresenter&) = delete;
  PipPresenter& operator=(const PipPresenter&) = delete;
  ~PipPresenter() override;

  static bool Handles(std::string_view method);
  static bool HandlesEngineCall(std::string_view name);
  static void AppendCapabilities(base::ListValue& capabilities);
  static PipPresenter* Find(content::WebContents* source);

  void Invoke(const std::string& method, const base::DictValue& args, Done done);
  void EngineCall(const std::string& name, const base::Value* args, Done done);
  void RendererRetired();
  void CheckSource();

  bool PresentsPlayerFor(content::WebContents* source) const;
  void ShowPlayer(PipPlayer* player);
  void PlayerChanged(PipPlayer* player);
  void PlayerSurfaceChanged(PipPlayer* player);
  void HidePlayer(PipPlayer* player, base::TimeDelta fade);
  gfx::Rect DefaultPlayerScreenBounds(const gfx::Size& natural_size) const;
  base::WeakPtr<PipPresenter> GetWeakPtr() { return weak_factory_.GetWeakPtr(); }

 private:
  void OnDisplayMetricsChanged(const display::Display& display, uint32_t changed_metrics) override;
  void Viewport(const base::DictValue& args, Done done);
  void Command(const base::DictValue& args, Done done);
  void SendPlayerEvent(const PipPlayer& player);
  void SendLeaving(uint64_t owner, base::TimeDelta fade);
  void DropPlayerView(uint64_t owner);
  void ReleasePlayer();
  void RemovePlane();
  void SizePlane();

  raw_ptr<ShellHostView> host_;
  base::WeakPtr<PipPlayer> player_;
  raw_ptr<views::NativeViewHost> player_view_ = nullptr;
  std::unique_ptr<PipPlane> plane_;
  uint64_t player_view_owner_ = 0;
  std::optional<uint64_t> attached_generation_;
  display::ScopedOptionalDisplayObserver display_observer_;
  base::WeakPtrFactory<PipPresenter> weak_factory_{this};
};

}

#endif
