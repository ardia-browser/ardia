#ifndef ARDIA_WIN_NOW_PLAYING_ARTWORK_H_
#define ARDIA_WIN_NOW_PLAYING_ARTWORK_H_

#include <optional>
#include <string>
#include <vector>

#include "ardia/win/api.h"
#include "base/memory/raw_ref.h"
#include "base/memory/weak_ptr.h"
#include "base/timer/timer.h"
#include "services/media_session/public/cpp/media_image.h"

class SkBitmap;

namespace content {
class WebContents;
}

namespace ardia_win {

class NowPlayingArtwork {
 public:
  explicit NowPlayingArtwork(content::WebContents& contents);
  NowPlayingArtwork(const NowPlayingArtwork&) = delete;
  NowPlayingArtwork& operator=(const NowPlayingArtwork&) = delete;
  ~NowPlayingArtwork();

  std::vector<media_session::MediaImage> Declared() const;
  void PageChanged();
  std::string Reported(const std::string& url);
  void Download(const std::string& asked, int pixels, Reply reply);
  void AnswerAll();

 private:
  struct Ask {
    media_session::MediaImage image;
    int pixels = 0;
    Reply reply;
  };

  bool StillDeclared(const media_session::MediaImage& image) const;
  void Start(Ask ask);
  void Got(const SkBitmap& bitmap);
  void TimedOut();
  void Finish(base::DictValue result);
  void Answer(Reply reply, base::DictValue result);

  const raw_ref<content::WebContents> contents_;
  std::string long_url_;
  std::string long_token_;
  int tokens_ = 0;
  std::optional<Ask> current_;
  std::optional<Ask> queued_;
  base::OneShotTimer deadline_;
  base::WeakPtrFactory<NowPlayingArtwork> weak_factory_{this};
};

}

#endif
