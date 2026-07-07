(() => {
  const DEFAULTS = {
    enabled: false,
    baseSeconds: 8,
    deviationSeconds: 2,
  };

  const state = {
    enabled: DEFAULTS.enabled,
    baseSeconds: DEFAULTS.baseSeconds,
    deviationSeconds: DEFAULTS.deviationSeconds,
  };

  function normalizeSeconds(value, fallback) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed < 0) {
      return fallback;
    }

    return parsed;
  }

  function applySettings(data) {
    const settings = data || {};

    state.enabled = settings.inputDelayEnabled || false;
    state.baseSeconds = normalizeSeconds(
      settings.inputDelayBaseSeconds,
      DEFAULTS.baseSeconds
    );
    state.deviationSeconds = normalizeSeconds(
      settings.inputDelayDeviationSeconds,
      DEFAULTS.deviationSeconds
    );
  }

  function loadSettings() {
    chrome.storage.sync.get(
      [
        "inputDelayEnabled",
        "inputDelayBaseSeconds",
        "inputDelayDeviationSeconds",
      ],
      applySettings
    );
  }

  function getDelayMs() {
    if (!state.enabled) {
      return 0;
    }

    const baseMs = state.baseSeconds * 1000;
    const deviationMs = state.deviationSeconds * 1000;
    const offset = (Math.random() * 2 - 1) * deviationMs;

    return Math.max(0, Math.round(baseMs + offset));
  }

  function getSubmitDelayMs() {
    return 1000 + Math.floor(Math.random() * 1001);
  }

  loadSettings();

  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName && areaName !== "sync") {
      return;
    }

    if (changes.inputDelayEnabled) {
      state.enabled = changes.inputDelayEnabled.newValue || false;
    }

    if (changes.inputDelayBaseSeconds) {
      state.baseSeconds = normalizeSeconds(
        changes.inputDelayBaseSeconds.newValue,
        DEFAULTS.baseSeconds
      );
    }

    if (changes.inputDelayDeviationSeconds) {
      state.deviationSeconds = normalizeSeconds(
        changes.inputDelayDeviationSeconds.newValue,
        DEFAULTS.deviationSeconds
      );
    }
  });

  window.AutoMcGrawInputDelay = {
    getDelayMs,
    getInputDelayMs: getDelayMs,
    getSubmitDelayMs,
    reload: loadSettings,
  };
})();
