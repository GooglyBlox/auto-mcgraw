document.addEventListener("DOMContentLoaded", function () {
  const AI_MODELS = {
    chatgpt: {
      buttonId: "chatgpt",
      displayName: "ChatGPT",
      tabQuery: { url: "https://chatgpt.com/*" },
    },
    gemini: {
      buttonId: "gemini",
      displayName: "Gemini",
      tabQuery: { url: "https://gemini.google.com/*" },
    },
    deepseek: {
      buttonId: "deepseek",
      displayName: "DeepSeek",
      tabQuery: { url: ["https://chat.deepseek.com/*"] },
    },
  };

  const modelButtons = Object.fromEntries(
    Object.entries(AI_MODELS).map(([model, config]) => [
      model,
      document.getElementById(config.buttonId),
    ])
  );
  const statusMessage = document.getElementById("status-message");
  const currentVersionElement = document.getElementById("current-version");
  const latestVersionElement = document.getElementById("latest-version");
  const versionStatusElement = document.getElementById("version-status");
  const checkUpdatesButton = document.getElementById("check-updates");
  const footerVersionElement = document.getElementById("footer-version");
  const doubleCreditToggle = document.getElementById("double-credit-toggle");
  const randomConfidenceToggle = document.getElementById(
    "random-confidence-toggle"
  );
  const pauseBeforeSubmitToggle = document.getElementById(
    "pause-before-submit-toggle"
  );

  const currentVersion = chrome.runtime.getManifest().version;
  let availabilityRequestId = 0;
  currentVersionElement.textContent = `v${currentVersion}`;
  footerVersionElement.textContent = `v${currentVersion}`;

  checkForUpdates();
  checkUpdatesButton.addEventListener("click", checkForUpdates);

  chrome.storage.sync.get("aiModel", function (data) {
    const currentModel = data.aiModel || "chatgpt";
    setActiveButton(currentModel);
    checkModelAvailability(currentModel);
  });

  Object.keys(AI_MODELS).forEach((model) => {
    modelButtons[model].addEventListener("click", function () {
      setActiveModel(model);
    });
  });

  chrome.storage.sync.get(
    ["doubleCreditMode", "randomConfidence", "pauseBeforeSubmit"],
    function (data) {
      doubleCreditToggle.checked = data.doubleCreditMode || false;
      randomConfidenceToggle.checked = data.randomConfidence || false;
      pauseBeforeSubmitToggle.checked = data.pauseBeforeSubmit || false;
    }
  );

  doubleCreditToggle.addEventListener("change", function () {
    chrome.storage.sync.set({ doubleCreditMode: this.checked });
  });

  randomConfidenceToggle.addEventListener("change", function () {
    chrome.storage.sync.set({ randomConfidence: this.checked });
  });

  pauseBeforeSubmitToggle.addEventListener("change", function () {
    chrome.storage.sync.set({ pauseBeforeSubmit: this.checked });
  });

  setInterval(() => {
    chrome.storage.sync.get("aiModel", function (data) {
      checkModelAvailability(data.aiModel || "chatgpt");
    });
  }, 5000);

  function setActiveModel(model) {
    chrome.storage.sync.set({ aiModel: model }, function () {
      setActiveButton(model);
      checkModelAvailability(model);
    });
  }

  function setActiveButton(activeModel) {
    Object.entries(modelButtons).forEach(([model, button]) => {
      button.classList.toggle("active", model === activeModel);
    });
  }

  async function checkModelAvailability(currentModel) {
    const requestId = ++availabilityRequestId;
    const modelConfig = AI_MODELS[currentModel] || AI_MODELS.chatgpt;
    statusMessage.textContent = "Checking assistant availability...";
    statusMessage.className = "";

    const tabs = await queryTabs(modelConfig.tabQuery);
    if (requestId !== availabilityRequestId) return;

    const isAvailable = tabs.length > 0;
    statusMessage.textContent = isAvailable
      ? `${modelConfig.displayName} tab is open and ready to use.`
      : `Please open ${modelConfig.displayName} in another tab to use this assistant.`;
    statusMessage.className = isAvailable ? "success" : "error";
  }

  async function queryTabs(query) {
    return new Promise((resolve) => {
      chrome.tabs.query(query, resolve);
    });
  }

  async function checkForUpdates() {
    try {
      versionStatusElement.textContent = "Checking for updates...";
      versionStatusElement.className = "checking";
      checkUpdatesButton.disabled = true;
      latestVersionElement.textContent = "Checking...";

      const response = await fetch(
        "https://api.github.com/repos/GooglyBlox/auto-mcgraw/releases/latest"
      );

      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }

      const releaseData = await response.json();
      const latestVersion = releaseData.tag_name.replace(/^v/i, "");
      latestVersionElement.textContent = `v${latestVersion}`;

      if (isNewerVersion(latestVersion, currentVersion)) {
        versionStatusElement.textContent = `New version ${releaseData.tag_name} is available!`;
        versionStatusElement.className = "update-available";
        versionStatusElement.style.cursor = "pointer";
        versionStatusElement.onclick = () => {
          chrome.tabs.create({ url: releaseData.html_url });
        };
      } else {
        versionStatusElement.textContent = "You're using the latest version!";
        versionStatusElement.className = "up-to-date";
        versionStatusElement.style.cursor = "default";
        versionStatusElement.onclick = null;
      }
    } catch (error) {
      console.error("Error checking for updates:", error);
      versionStatusElement.textContent =
        "Error checking for updates. Please try again later.";
      versionStatusElement.className = "error";
      latestVersionElement.textContent = "Error";
    } finally {
      checkUpdatesButton.disabled = false;
    }
  }

  function isNewerVersion(candidateVersion, installedVersion) {
    const candidateParts = parseVersion(candidateVersion);
    const installedParts = parseVersion(installedVersion);
    const partCount = Math.max(candidateParts.length, installedParts.length);

    for (let i = 0; i < partCount; i++) {
      const candidate = candidateParts[i] || 0;
      const installed = installedParts[i] || 0;

      if (candidate > installed) return true;
      if (installed > candidate) return false;
    }

    return false;
  }

  function parseVersion(version) {
    return String(version)
      .split(".")
      .map((part) => Number(part) || 0);
  }
});
