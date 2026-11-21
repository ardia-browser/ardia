let runs = 0;
let moved = 0;
let undos = 0;
let topicRuns = 0;
let topicFallbacks = 0;
let topicDownloads = 0;

export function noteTidyTabsRun(tabsMoved: number) {
  runs++;
  moved += tabsMoved;
}

export const noteTidyTabsUndo = () => undos++;

export const noteTidyTopicRun = () => topicRuns++;

export const noteTidyTopicFallback = () => topicFallbacks++;

export const noteTidyTopicModelDownload = () => topicDownloads++;

export function takeTidyTabsCounts() {
  const taken = {
    tidy_tabs_runs: runs,
    tidy_tabs_moved: moved,
    tidy_tabs_undos: undos,
    tidy_topic_runs: topicRuns,
    tidy_topic_fallbacks: topicFallbacks,
    tidy_topic_model_downloads: topicDownloads,
  };
  runs = 0;
  moved = 0;
  undos = 0;
  topicRuns = 0;
  topicFallbacks = 0;
  topicDownloads = 0;
  return taken;
}
