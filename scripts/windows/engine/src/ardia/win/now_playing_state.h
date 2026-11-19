#ifndef ARDIA_WIN_NOW_PLAYING_STATE_H_
#define ARDIA_WIN_NOW_PLAYING_STATE_H_

#include <optional>
#include <string>
#include <string_view>
#include <vector>

#include "base/values.h"
#include "services/media_session/public/cpp/media_image.h"
#include "services/media_session/public/mojom/media_session.mojom.h"

namespace ardia_win {

struct NowPlayingState {
  std::string title;
  std::string artist;
  std::string album;
  std::optional<std::string> artwork;
  std::string playback_state;
  double position = 0;
  std::optional<double> duration;
  double playback_rate = 1;
  double timestamp = 0;
  bool has_video = false;
  std::vector<std::string> actions;
  bool controllable = false;
  bool operator==(const NowPlayingState&) const = default;
};

enum class MediaAction { kPlay, kPause, kToggle, kNext, kPrevious, kSeekBy, kSeekTo, kStop };

struct MediaCommandArgs {
  MediaAction action;
  double seconds = 0;
};

enum class MediaCommandResult {
  kDone,
  kNotDone,
  kRefused,
  kPlayByScript,
  kSeekRecorded
};

struct MediaCommandOutcome {
  MediaCommandResult result = MediaCommandResult::kNotDone;
  std::optional<double> play_from;
};

std::optional<MediaCommandArgs> ParseMediaCommand(const base::DictValue& args);
std::string BoundedText(const std::u16string& text);
std::optional<std::string_view> MediaActionName(
    media_session::mojom::MediaSessionAction action);
bool SessionHasVideo(const media_session::mojom::MediaSessionInfo& info);
std::optional<std::string> LargestArtwork(
    const std::vector<media_session::MediaImage>& images);
double NowMs();
double Projected(const NowPlayingState& state, double at_ms);
bool SameReport(const std::optional<NowPlayingState>& before,
                const std::optional<NowPlayingState>& after);
base::DictValue NowPlayingEventData(const std::optional<NowPlayingState>& state,
                                    std::optional<std::string> artwork);

}

#endif
