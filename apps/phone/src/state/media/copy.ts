export const PICTURE_IN_PICTURE_COPY = {
  title: "Picture in Picture",
  automatic: "Automatic Picture in Picture",
  automaticFooter: "A playing video floats over your other apps when you go Home, open the app switcher or lock iPhone. Its return button brings you back to its tab.",
  automaticUnsupported: "This iPhone can’t show Picture in Picture, so videos keep playing as sound instead.",
  keepsPlaying: "Keep playing in the background",
  keepsPlayingFooter: "Videos and music keep playing when you switch tabs or leave Ardia, with controls on the Lock Screen.",
  miniPlayerSection: "Mini player",
  miniPlayer: "Mini player",
  miniPlayerFooter: "Shows what’s playing when its tab isn’t on screen. Tap it to go back to the tab. Closing it never stops the sound.",
  everySpace: "Show in every space",
  everySpaceFooter: "Off, the mini player shows only in the space whose tab is playing.",
  skipLength: "Skip length",
  seconds: (seconds: number) => `${seconds} seconds`,
} as const;

export const MINI_PLAYER_WORDS = {
  play: "Play",
  pause: "Pause",
  back: (seconds: number) => `Back ${seconds} seconds`,
  forward: (seconds: number) => `Forward ${seconds} seconds`,
  previous: "Previous",
  next: "Next",
  pictureInPicture: "Picture in Picture",
  leavePictureInPicture: "Back from Picture in Picture",
  close: "Close Mini Player",
  open: (title: string) => `Now playing: ${title}`,
  openHint: "Goes to its tab.",
} as const;
