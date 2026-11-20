extension WebKitExtensionShimNamespace {
  static let tts = WebKitExtensionShimNamespace(name: "tts", script: #"""
      if (APIS.includes("tts") && !CONTENT) {
        const spoken = new Map();
        const finals = ["end", "interrupted", "cancelled", "error"];
        signals.set("ttsEvent", (message) => {
          const entry = spoken.get(message.utterance);
          if (!entry) return;
          const event = Object.assign({}, message.event);
          if (finals.includes(event.type)) {
            spoken.delete(message.utterance);
            hold("tts", false);
          }
          try {
            entry(event);
          } catch (error) {
            console.error(error);
          }
        });
        const tts = api("tts", ["stop", "pause", "resume", "isSpeaking", "getVoices"], ["onVoicesChanged"], {
          EventType: { START: "start", END: "end", WORD: "word", SENTENCE: "sentence", MARKER: "marker", INTERRUPTED: "interrupted", CANCELLED: "cancelled", ERROR: "error", PAUSE: "pause", RESUME: "resume" },
          VoiceGender: { MALE: "male", FEMALE: "female" },
        });
        tts.speak = withCallback((utterance, options) => {
          const copy = Object.assign({}, options || {});
          const onEvent = typeof copy.onEvent === "function" ? copy.onEvent : null;
          delete copy.onEvent;
          const id = `${CONTEXT}:${Date.now().toString(36)}:${Math.random().toString(36).slice(2)}`;
          copy.__utterance = id;
          copy.__events = !!onEvent;
          if (onEvent) {
            spoken.set(id, onEvent);
            hold("tts", true);
          }
          return request("tts", "speak", [String(utterance), copy]).catch((error) => {
            if (spoken.delete(id)) hold("tts", false);
            throw error;
          });
        });
        define("tts", tts);
      }
    """#)
}
