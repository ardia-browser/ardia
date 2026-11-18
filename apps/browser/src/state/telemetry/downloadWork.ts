let progressUpdates = 0;
let historyWrites = 0;
let historyCharacters = 0;

export const noteDownloadProgressUpdate = () => progressUpdates++;

export function noteDownloadHistoryWrite(characters: number) {
  historyWrites++;
  historyCharacters += characters;
}

export function takeDownloadWork() {
  const taken = {
    download_progress_updates: progressUpdates,
    download_history_writes: historyWrites,
    download_history_kb_written: Math.round(historyCharacters / 1024),
  };
  progressUpdates = 0;
  historyWrites = 0;
  historyCharacters = 0;
  return taken;
}
