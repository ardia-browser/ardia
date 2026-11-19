#include "ardia/win/now_playing_state.h"

#include <algorithm>
#include <cmath>
#include <utility>

#include "base/strings/string_util.h"
#include "base/strings/utf_string_conversions.h"
#include "base/time/time.h"
#include "ui/gfx/geometry/size.h"
#include "url/gurl.h"

namespace ardia_win {

namespace {

using Action = media_session::mojom::MediaSessionAction;

constexpr size_t kTextLimit = 1024;
constexpr size_t kImageUrlLimit = 1 << 20;
constexpr double kSeekLimit = 366.0 * 24 * 60 * 60;
constexpr double kDriftSeconds = 0.5;

bool AllowedImage(const GURL& url) {
  if (!url.is_valid() || url.spec().size() > kImageUrlLimit) {
    return false;
  }
  return url.SchemeIsHTTPOrHTTPS() ||
         base::StartsWith(url.spec(), "data:image/",
                          base::CompareCase::INSENSITIVE_ASCII);
}

int WidestSize(const media_session::MediaImage& image) {
  int widest = 0;
  for (const gfx::Size& size : image.sizes) {
    widest = std::max(widest, size.width());
  }
  return widest;
}

}

std::optional<MediaCommandArgs> ParseMediaCommand(const base::DictValue& args) {
  static constexpr std::pair<std::string_view, MediaAction> kActions[] = {
      {"play", MediaAction::kPlay},       {"pause", MediaAction::kPause},
      {"toggle", MediaAction::kToggle},   {"next", MediaAction::kNext},
      {"previous", MediaAction::kPrevious}, {"seekBy", MediaAction::kSeekBy},
      {"seekTo", MediaAction::kSeekTo},   {"stop", MediaAction::kStop},
  };
  const std::string* name = args.FindString("action");
  if (!name) {
    return std::nullopt;
  }
  std::optional<MediaAction> action;
  for (const auto& [known, value] : kActions) {
    if (*name == known) {
      action = value;
    }
  }
  if (!action) {
    return std::nullopt;
  }
  const base::Value* seconds = args.Find("seconds");
  const bool finite = seconds && (seconds->is_int() || seconds->is_double()) &&
                      std::isfinite(seconds->GetDouble());
  if (seconds && !seconds->is_none() && !finite) {
    return std::nullopt;
  }
  if (*action != MediaAction::kSeekBy && *action != MediaAction::kSeekTo) {
    return MediaCommandArgs{*action, 0};
  }
  if (!finite) {
    return std::nullopt;
  }
  const double value = seconds->GetDouble();
  if (std::abs(value) > kSeekLimit ||
      (*action == MediaAction::kSeekTo && value < 0)) {
    return std::nullopt;
  }
  return MediaCommandArgs{*action, value};
}

std::string BoundedText(const std::u16string& text) {
  std::u16string bounded = text.substr(0, kTextLimit);
  if (!bounded.empty() && bounded.back() >= 0xD800 &&
      bounded.back() <= 0xDBFF) {
    bounded.pop_back();
  }
  return base::UTF16ToUTF8(bounded);
}

std::optional<std::string_view> MediaActionName(Action action) {
  switch (action) {
    case Action::kPlay:
      return "play";
    case Action::kPause:
      return "pause";
    case Action::kPreviousTrack:
      return "previoustrack";
    case Action::kNextTrack:
      return "nexttrack";
    case Action::kSeekBackward:
      return "seekbackward";
    case Action::kSeekForward:
      return "seekforward";
    case Action::kSkipAd:
      return "skipad";
    case Action::kStop:
      return "stop";
    case Action::kSeekTo:
      return "seekto";
    case Action::kEnterPictureInPicture:
      return "enterpictureinpicture";
    case Action::kExitPictureInPicture:
      return "exitpictureinpicture";
    case Action::kToggleMicrophone:
      return "togglemicrophone";
    case Action::kToggleCamera:
      return "togglecamera";
    case Action::kHangUp:
      return "hangup";
    case Action::kPreviousSlide:
      return "previousslide";
    case Action::kNextSlide:
      return "nextslide";
    case Action::kEnterAutoPictureInPicture:
      return "enterautopictureinpicture";
    default:
      return std::nullopt;
  }
}

bool SessionHasVideo(const media_session::mojom::MediaSessionInfo& info) {
  if (!info.audio_video_states) {
    return false;
  }
  return std::ranges::any_of(*info.audio_video_states, [](auto state) {
    return state == media_session::mojom::MediaAudioVideoState::kAudioVideo ||
           state == media_session::mojom::MediaAudioVideoState::kVideoOnly;
  });
}

std::optional<std::string> LargestArtwork(
    const std::vector<media_session::MediaImage>& images) {
  const media_session::MediaImage* chosen = nullptr;
  for (const media_session::MediaImage& image : images) {
    if (AllowedImage(image.src) &&
        (!chosen || WidestSize(image) > WidestSize(*chosen))) {
      chosen = &image;
    }
  }
  return chosen ? std::optional<std::string>(chosen->src.spec())
                : std::nullopt;
}

double NowMs() {
  return base::Time::Now().InMillisecondsFSinceUnixEpoch();
}

double Projected(const NowPlayingState& state, double at_ms) {
  const double elapsed = state.playback_state == "playing"
                             ? (at_ms - state.timestamp) / 1000 *
                                   state.playback_rate
                             : 0;
  const double reached = std::max(0.0, state.position + elapsed);
  return state.duration ? std::min(reached, *state.duration) : reached;
}

bool SameReport(const std::optional<NowPlayingState>& before,
                const std::optional<NowPlayingState>& after) {
  if (!before || !after) {
    return !before && !after;
  }
  NowPlayingState anchored = *after;
  anchored.position = before->position;
  anchored.timestamp = before->timestamp;
  return anchored == *before &&
         std::abs(Projected(*before, after->timestamp) - after->position) <
             kDriftSeconds;
}

base::DictValue NowPlayingEventData(const std::optional<NowPlayingState>& state,
                                    std::optional<std::string> artwork) {
  base::DictValue data;
  if (!state) {
    data.Set("state", base::Value());
    return data;
  }
  base::ListValue actions;
  for (const std::string& action : state->actions) {
    actions.Append(action);
  }
  base::DictValue fields;
  fields.Set("title", state->title);
  fields.Set("artist", state->artist);
  fields.Set("album", state->album);
  fields.Set("artwork",
             artwork ? base::Value(std::move(*artwork)) : base::Value());
  fields.Set("playbackState", state->playback_state);
  fields.Set("position", state->position);
  fields.Set("duration",
             state->duration ? base::Value(*state->duration) : base::Value());
  fields.Set("playbackRate", state->playback_rate);
  fields.Set("timestamp", state->timestamp);
  fields.Set("hasVideo", state->has_video);
  fields.Set("actions", std::move(actions));
  fields.Set("controllable", state->controllable);
  fields.Set("loop", false);
  data.Set("state", std::move(fields));
  return data;
}

}
