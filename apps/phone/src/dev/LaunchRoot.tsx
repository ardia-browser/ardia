import { pages } from "@ardia/phone-native";
import { useEffect, useState } from "react";
import { AppState } from "react-native";
import App from "../App";
import { PageLab } from "./PageLab";

const LAUNCH_POLL_MILLIS = 50;
const LAUNCH_POLL_LIMIT = 60;

const launchMode = (): "app" | "lab" | null => {
  const options = pages.launchOptions();
  return options === null ? null : options.pageLab ? "lab" : "app";
};

export function LaunchRoot() {
  const [first] = useState(launchMode);
  const [mode, setMode] = useState<"app" | "lab">(first ?? "app");
  useEffect(() => {
    if (first !== null) return;
    let attempts = 0;
    const timer = setInterval(() => {
      attempts += 1;
      const known = launchMode();
      if (known === null && attempts < LAUNCH_POLL_LIMIT) return;
      clearInterval(timer);
      if (known === "lab") setMode("lab");
    }, LAUNCH_POLL_MILLIS);
    return () => clearInterval(timer);
  }, [first]);
  useEffect(() => {
    if (mode !== "app") return;
    const resumed = AppState.addEventListener("change", (state) => {
      if (state === "active" && pages.launchOptions()?.pageLab) setMode("lab");
    });
    return () => resumed.remove();
  }, [mode]);
  return mode === "lab" ? <PageLab /> : <App />;
}
