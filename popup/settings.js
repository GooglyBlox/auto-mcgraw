document.addEventListener("DOMContentLoaded", () => {
  const modelButtons = {
    chatgpt: document.getElementById("chatgpt"),
    gemini: document.getElementById("gemini"),
    deepseek: document.getElementById("deepseek"),
    openrouter: document.getElementById("openrouter"),
  };
  const deepseekUrls = ["https://chat.deepseek.com/*", "https://deepseek.chat/*"];
  const openrouterConfig = document.getElementById("openrouter-config");
  const baseUrlInput = document.getElementById("api-base-url");
  const apiKeyInput = document.getElementById("api-key");
  const modelInput = document.getElementById("api-model");
  const providerInput = document.getElementById("api-provider");
  const customProviderInput = document.getElementById("api-provider-custom");
  const saveButton = document.getElementById("save-openrouter");
  const monitoringLink = document.getElementById("monitoring-link");
  const statusMessage = document.getElementById("status-message");
  const currentVersionElement = document.getElementById("current-version");
  const latestVersionElement = document.getElementById("latest-version");
  const versionStatusElement = document.getElementById("version-status");
  const checkUpdatesButton = document.getElementById("check-updates");
  const footerVersionElement = document.getElementById("footer-version");
  const currentVersion = chrome.runtime.getManifest().version;

  currentVersionElement.textContent = `v${currentVersion}`;
  footerVersionElement.textContent = `v${currentVersion}`;

  function setActiveModel(model) {
    Object.entries(modelButtons).forEach(([name, button]) => {
      button.classList.toggle("active", name === model);
    });
    openrouterConfig.hidden = model !== "openrouter";
  }

  function setStatus(message, type = "") {
    statusMessage.textContent = message;
    statusMessage.className = type;
  }

  async function checkModelAvailability(model) {
    if (model === "openrouter") {
      const data = await chrome.storage.local.get(["apiKey", "openrouterApiKey"]);
      if (String(data.apiKey || data.openrouterApiKey || "").trim()) {
        setStatus("Direct API is configured and ready.", "success");
      } else {
        setStatus("Add an API key to use the direct API option.", "error");
      }
      return;
    }

    const url =
      model === "chatgpt"
        ? "https://chatgpt.com/*"
        : model === "gemini"
          ? "https://gemini.google.com/*"
          : deepseekUrls;
    const tabs = await chrome.tabs.query({ url });
    const name = model === "chatgpt" ? "ChatGPT" : model === "gemini" ? "Gemini" : "DeepSeek";
    if (tabs.length) {
      setStatus(`${name} tab is open and ready to use.`, "success");
    } else {
      setStatus(`Please open ${name} in another tab to use this option.`, "error");
    }
  }

  chrome.storage.sync.get("aiModel", async (data) => {
    const model = data.aiModel || "chatgpt";
    setActiveModel(model);
    await checkModelAvailability(model);
  });

  chrome.storage.local.get(["apiKey", "openrouterApiKey"], (data) => {
    apiKeyInput.value = data.apiKey || data.openrouterApiKey || "";
  });
  chrome.storage.sync.get(["apiBaseUrl", "openrouterModel", "apiProvider"], (data) => {
    baseUrlInput.value = data.apiBaseUrl || "https://openrouter.ai/api/v1";
    modelInput.value = data.openrouterModel || "openai/gpt-4o-mini";
    const savedProvider = data.apiProvider || "";
    if (Array.from(providerInput.options).some((option) => option.value === savedProvider)) {
      providerInput.value = savedProvider;
    } else {
      providerInput.value = "";
      customProviderInput.value = savedProvider;
    }
  });

  Object.entries(modelButtons).forEach(([model, button]) => {
    button.addEventListener("click", () => {
      chrome.storage.sync.set({ aiModel: model }, async () => {
        setActiveModel(model);
        await checkModelAvailability(model);
      });
    });
  });

  saveButton.addEventListener("click", () => {
    const apiKey = apiKeyInput.value.trim();
    const model = modelInput.value.trim() || "openai/gpt-4o-mini";
    const baseUrl = baseUrlInput.value.trim() || "https://openrouter.ai/api/v1";
    const provider = customProviderInput.value.trim() || providerInput.value;
    chrome.storage.local.set({ apiKey, openrouterApiKey: apiKey }, () => {
      chrome.storage.sync.set({
        apiBaseUrl: baseUrl,
        openrouterModel: model,
        apiProvider: provider,
        aiModel: "openrouter",
      }, async () => {
        setActiveModel("openrouter");
        await checkModelAvailability("openrouter");
      });
    });
  });

  const doubleCreditToggle = document.getElementById("double-credit-toggle");
  const randomConfidenceToggle = document.getElementById("random-confidence-toggle");
  const pauseBeforeSubmitToggle = document.getElementById("pause-before-submit-toggle");
  const includeImageAltTextToggle = document.getElementById("include-image-alt-text-toggle");
  const fullAutoToggle = document.getElementById("full-auto-toggle");
  chrome.storage.sync.get(
    ["doubleCreditMode", "randomConfidence", "pauseBeforeSubmit", "includeImageAltText", "fullAutoMatching"],
    (data) => {
      doubleCreditToggle.checked = Boolean(data.doubleCreditMode);
      randomConfidenceToggle.checked = Boolean(data.randomConfidence);
      pauseBeforeSubmitToggle.checked = Boolean(data.pauseBeforeSubmit);
      includeImageAltTextToggle.checked = Boolean(data.includeImageAltText);
      fullAutoToggle.checked = Boolean(data.fullAutoMatching);
    }
  );
  doubleCreditToggle.addEventListener("change", () => chrome.storage.sync.set({ doubleCreditMode: doubleCreditToggle.checked }));
  randomConfidenceToggle.addEventListener("change", () => chrome.storage.sync.set({ randomConfidence: randomConfidenceToggle.checked }));
  pauseBeforeSubmitToggle.addEventListener("change", () => chrome.storage.sync.set({ pauseBeforeSubmit: pauseBeforeSubmitToggle.checked }));
  includeImageAltTextToggle.addEventListener("change", () => chrome.storage.sync.set({ includeImageAltText: includeImageAltTextToggle.checked }));
  fullAutoToggle.addEventListener("change", () => chrome.storage.sync.set({ fullAutoMatching: fullAutoToggle.checked }));

  chrome.storage.onChanged.addListener(async (changes, area) => {
    if (area === "sync" && changes.aiModel) {
      const model = changes.aiModel.newValue || "chatgpt";
      setActiveModel(model);
      await checkModelAvailability(model);
    }
    if (area === "local" && (changes.apiKey || changes.openrouterApiKey)) {
      const selected = (await chrome.storage.sync.get("aiModel")).aiModel || "chatgpt";
      if (selected === "openrouter") await checkModelAvailability(selected);
    }
  });

  monitoringLink.addEventListener("click", (event) => {
    event.preventDefault();
    chrome.tabs.create({ url: chrome.runtime.getURL("popup/dashboard.html") });
  });

  checkUpdatesButton.addEventListener("click", checkForUpdates);
  checkForUpdates();

  async function checkForUpdates() {
    try {
      versionStatusElement.textContent = "Checking for updates...";
      versionStatusElement.className = "checking";
      checkUpdatesButton.disabled = true;
      const response = await fetch("https://api.github.com/repos/GooglyBlox/auto-mcgraw/releases/latest");
      if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
      const releaseData = await response.json();
      const latestVersion = releaseData.tag_name.replace(/^v/, "");
      latestVersionElement.textContent = `v${latestVersion}`;
      const compare = (a, b) => {
        const left = a.split(".").map(Number);
        const right = b.split(".").map(Number);
        for (let i = 0; i < Math.max(left.length, right.length); i++) {
          if ((left[i] || 0) !== (right[i] || 0)) return (left[i] || 0) - (right[i] || 0);
        }
        return 0;
      };
      if (compare(latestVersion, currentVersion) > 0) {
        versionStatusElement.textContent = `New version ${releaseData.tag_name} is available!`;
        versionStatusElement.className = "update-available";
        versionStatusElement.onclick = () => chrome.tabs.create({ url: releaseData.html_url });
      } else {
        versionStatusElement.textContent = "You're using the latest version!";
        versionStatusElement.className = "up-to-date";
        versionStatusElement.onclick = null;
      }
    } catch (error) {
      console.error("Error checking for updates:", error);
      versionStatusElement.textContent = "Error checking for updates.";
      versionStatusElement.className = "error";
      latestVersionElement.textContent = "Error";
    } finally {
      checkUpdatesButton.disabled = false;
    }
  }
});
