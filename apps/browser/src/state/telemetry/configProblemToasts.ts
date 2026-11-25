let shown = 0;
let dismissed = 0;

export function noteConfigProblemToastShown() {
  shown++;
}

export function noteConfigProblemToastDismissed() {
  dismissed++;
}

export function takeConfigProblemToastCounts() {
  const taken = { config_problem_toasts: shown, config_problem_toast_dismissals: dismissed };
  shown = 0;
  dismissed = 0;
  return taken;
}
