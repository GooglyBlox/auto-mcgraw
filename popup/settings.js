(() => {
  const { assistants, settings } = AutoMcGraw;

  const RELEASE_API_URL =
    "https://api.github.com/repos/GooglyBlox/auto-mcgraw/releases/latest";
  const RELEASE_CACHE_KEY = "latestRelease";
  const RELEASE_CACHE_MS = 60 * 60 * 1000;
  const REFRESH_DEBOUNCE_MS = 150;

  const installedVersion = chrome.runtime.getManifest().version;

  const assistantInputs = Array.from(
    document.querySelectorAll('input[name="assistant"]')
  );
  const settingToggles = Array.from(
    document.querySelectorAll("input[data-setting]")
  );
  const headerVersion = document.getElementById("header-version");
  const installedVersionElement = document.getElementById("installed-version");
  const latestVersionElement = document.getElementById("latest-version");
  const updateStatus = document.getElementById("update-status");
  const updateLink = document.getElementById("update-link");
  const checkUpdatesButton = document.getElementById("check-updates");

  let refreshTimer = null;

  function logError(error) {
    console.error("[Auto-McGraw]", error);
  }

  function compareVersions(a, b) {
    const left = a.split(".").map(Number);
    const right = b.split(".").map(Number);
    for (
      let index = 0;
      index < Math.max(left.length, right.length);
      index += 1
    ) {
      const difference = (left[index] || 0) - (right[index] || 0);
      if (difference !== 0) return Math.sign(difference);
    }
    return 0;
  }

  function describeAssistant(assistant, isSelected, isOpen) {
    if (isSelected && isOpen) return { state: "ready", label: "Ready to use" };
    if (isSelected) {
      return {
        state: "missing",
        label: `Open ${assistant.name} in another tab to use it`,
      };
    }
    if (isOpen) return { state: "open", label: "Tab open" };
    return { state: "closed", label: "No tab open" };
  }

  async function renderAssistants() {
    const [{ aiModel }, openTabs] = await Promise.all([
      settings.load(),
      Promise.all(
        assistants.list.map((assistant) =>
          chrome.tabs.query({ url: assistant.match })
        )
      ),
    ]);
    const selectedId = assistants.get(aiModel).id;

    assistants.list.forEach((assistant, index) => {
      const option = document.querySelector(
        `[data-assistant="${assistant.id}"]`
      );
      if (!option) return;

      const isSelected = assistant.id === selectedId;
      const { state, label } = describeAssistant(
        assistant,
        isSelected,
        openTabs[index].length > 0
      );
      option.querySelector("input").checked = isSelected;
      option.dataset.state = state;
      option.querySelector("[data-status]").textContent = label;
    });
  }

  async function renderToggles() {
    const values = await settings.load();
    settingToggles.forEach((toggle) => {
      toggle.checked = Boolean(values[toggle.dataset.setting]);
    });
  }

  function scheduleAssistantRefresh() {
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(
      () => renderAssistants().catch(logError),
      REFRESH_DEBOUNCE_MS
    );
  }

  function setUpdateStatus(state, message) {
    updateStatus.dataset.state = state;
    updateStatus.textContent = message;
  }

  async function fetchLatestRelease() {
    const response = await fetch(RELEASE_API_URL, {
      headers: { Accept: "application/vnd.github+json" },
    });
    if (!response.ok) {
      throw new Error(`GitHub responded with ${response.status}`);
    }

    const release = await response.json();
    return {
      version: release.tag_name.replace(/^v/, ""),
      url: release.html_url,
      checkedAt: Date.now(),
    };
  }

  async function getLatestRelease(force) {
    if (!force) {
      const { [RELEASE_CACHE_KEY]: cached } =
        await chrome.storage.local.get(RELEASE_CACHE_KEY);
      if (cached && Date.now() - cached.checkedAt < RELEASE_CACHE_MS) {
        return cached;
      }
    }

    const release = await fetchLatestRelease();
    await chrome.storage.local.set({ [RELEASE_CACHE_KEY]: release });
    return release;
  }

  async function checkForUpdates(force = false) {
    checkUpdatesButton.disabled = true;
    updateLink.hidden = true;
    latestVersionElement.textContent = "Checking...";
    setUpdateStatus("checking", "Checking for updates...");

    try {
      const release = await getLatestRelease(force);
      latestVersionElement.textContent = `v${release.version}`;

      if (compareVersions(release.version, installedVersion) > 0) {
        setUpdateStatus(
          "available",
          `Version ${release.version} is available.`
        );
        updateLink.href = release.url;
        updateLink.hidden = false;
      } else {
        setUpdateStatus("current", "You're on the latest version.");
      }
    } catch (error) {
      logError(error);
      latestVersionElement.textContent = "Unavailable";
      setUpdateStatus("error", "Couldn't check for updates. Try again later.");
    } finally {
      checkUpdatesButton.disabled = false;
    }
  }

  headerVersion.textContent = `v${installedVersion}`;
  installedVersionElement.textContent = `v${installedVersion}`;

  assistantInputs.forEach((input) => {
    input.addEventListener("change", () => {
      if (input.checked) {
        settings.save({ aiModel: input.value }).catch(logError);
      }
    });
  });

  settingToggles.forEach((toggle) => {
    toggle.addEventListener("change", () => {
      settings
        .save({ [toggle.dataset.setting]: toggle.checked })
        .catch(logError);
    });
  });

  checkUpdatesButton.addEventListener("click", () => checkForUpdates(true));

  settings.subscribe(() => {
    renderAssistants().catch(logError);
    renderToggles().catch(logError);
  });

  chrome.tabs.onCreated.addListener(scheduleAssistantRefresh);
  chrome.tabs.onRemoved.addListener(scheduleAssistantRefresh);
  chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
    if (changeInfo.url || changeInfo.status === "complete") {
      scheduleAssistantRefresh();
    }
  });

  renderAssistants().catch(logError);
  renderToggles().catch(logError);
  checkForUpdates();
})();
