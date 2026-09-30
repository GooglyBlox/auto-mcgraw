(() => {
  const DEFAULTS = Object.freeze({
    aiModel: AutoMcGraw.assistants.DEFAULT_ID,
    doubleCreditMode: false,
    randomConfidence: false,
    pauseBeforeSubmit: false,
  });

  function load() {
    return chrome.storage.sync.get({ ...DEFAULTS });
  }

  function save(values) {
    return chrome.storage.sync.set(values);
  }

  function subscribe(listener) {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== "sync") return;
      if (!Object.keys(changes).some((key) => key in DEFAULTS)) return;
      load().then(listener);
    });
  }

  AutoMcGraw.settings = { DEFAULTS, load, save, subscribe };
})();
