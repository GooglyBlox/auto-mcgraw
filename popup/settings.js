document.addEventListener("DOMContentLoaded", function () {
  const chatgptButton = document.getElementById("chatgpt");
  const geminiButton = document.getElementById("gemini");
  const deepseekButton = document.getElementById("deepseek");
  const statusMessage = document.getElementById("status-message");
  const currentVersionElement = document.getElementById("current-version");
  const latestVersionElement = document.getElementById("latest-version");
  const versionStatusElement = document.getElementById("version-status");
  const checkUpdatesButton = document.getElementById("check-updates");
  const footerVersionElement = document.getElementById("footer-version");

  const currentVersion = chrome.runtime.getManifest().version;
  currentVersionElement.textContent = `v${currentVersion}`;
  footerVersionElement.textContent = `v${currentVersion}`;

  checkForUpdates();

  checkUpdatesButton.addEventListener("click", checkForUpdates);

  chrome.storage.sync.get("aiModel", function (data) {
    const currentModel = data.aiModel || "chatgpt";

    chatgptButton.classList.remove("active");
    geminiButton.classList.remove("active");
    deepseekButton.classList.remove("active");

    if (currentModel === "chatgpt") {
      chatgptButton.classList.add("active");
    } else if (currentModel === "gemini") {
      geminiButton.classList.add("active");
    } else if (currentModel === "deepseek") {
      deepseekButton.classList.add("active");
    }

    checkModelAvailability(currentModel);
  });

  chatgptButton.addEventListener("click", function () {
    setActiveModel("chatgpt");
  });

  geminiButton.addEventListener("click", function () {
    setActiveModel("gemini");
  });

  deepseekButton.addEventListener("click", function () {
    setActiveModel("deepseek");
  });

  function setActiveModel(model) {
    chrome.storage.sync.set({ aiModel: model }, function () {
      chatgptButton.classList.remove("active");
      geminiButton.classList.remove("active");
      deepseekButton.classList.remove("active");

      if (model === "chatgpt") {
        chatgptButton.classList.add("active");
      } else if (model === "gemini") {
        geminiButton.classList.add("active");
      } else if (model === "deepseek") {
        deepseekButton.classList.add("active");
      }

      checkModelAvailability(model);
    });
  }

  function checkModelAvailability(currentModel) {
    statusMessage.textContent = "Checking assistant availability...";
    statusMessage.className = "";

    chrome.tabs.query({ url: "https://chatgpt.com/*" }, (chatgptTabs) => {
      const chatgptAvailable = chatgptTabs.length > 0;

      chrome.tabs.query(
        { url: "https://gemini.google.com/*" },
        (geminiTabs) => {
          const geminiAvailable = geminiTabs.length > 0;

          chrome.tabs.query(
            { url: "https://chat.deepseek.com/*" },
            (deepseekTabs) => {
              const deepseekAvailable = deepseekTabs.length > 0;

              if (currentModel === "chatgpt") {
                if (chatgptAvailable) {
                  statusMessage.textContent =
                    "ChatGPT tab is open and ready to use.";
                  statusMessage.className = "success";
                } else {
                  statusMessage.textContent =
                    "Please open ChatGPT in another tab to use this assistant.";
                  statusMessage.className = "error";
                }
              } else if (currentModel === "gemini") {
                if (geminiAvailable) {
                  statusMessage.textContent =
                    "Gemini tab is open and ready to use.";
                  statusMessage.className = "success";
                } else {
                  statusMessage.textContent =
                    "Please open Gemini in another tab to use this assistant.";
                  statusMessage.className = "error";
                }
              } else if (currentModel === "deepseek") {
                if (deepseekAvailable) {
                  statusMessage.textContent =
                    "DeepSeek tab is open and ready to use.";
                  statusMessage.className = "success";
                } else {
                  statusMessage.textContent =
                    "Please open DeepSeek in another tab to use this assistant.";
                  statusMessage.className = "error";
                }
              }
            }
          );
        }
      );
    });
  }

  setInterval(() => {
    chrome.storage.sync.get("aiModel", function (data) {
      const currentModel = data.aiModel || "chatgpt";
      checkModelAvailability(currentModel);
    });
  }, 5000);

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
      const latestVersion = releaseData.tag_name.replace("v", "");
      latestVersionElement.textContent = `v${latestVersion}`;

      const currentVersionParts = currentVersion.split(".").map(Number);
      const latestVersionParts = latestVersion.split(".").map(Number);

      let isUpdateAvailable = false;

      for (
        let i = 0;
        i < Math.max(currentVersionParts.length, latestVersionParts.length);
        i++
      ) {
        const current = currentVersionParts[i] || 0;
        const latest = latestVersionParts[i] || 0;

        if (latest > current) {
          isUpdateAvailable = true;
          break;
        } else if (current > latest) {
          break;
        }
      }

      if (isUpdateAvailable) {
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
});
