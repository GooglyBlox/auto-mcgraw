let mheTabId = null;
let aiTabId = null;
let aiType = null;
let lastActiveTabId = null;
let processingQuestion = false;
let mheWindowId = null;
let aiWindowId = null;
let duplicateTabId = null;
let originalTabId = null;
let storedResponse = null;
let isProcessingDuplicate = false;
let pendingResponse = null;

const MHE_URL_PATTERNS = [
  "https://learning.mheducation.com/*",
  "https://ezto.mheducation.com/*",
];
const MHE_HOSTS = ["learning.mheducation.com", "ezto.mheducation.com"];
const AI_MODELS = {
  chatgpt: {
    tabQuery: { url: "https://chatgpt.com/*" },
    hosts: ["chatgpt.com"],
  },
  gemini: {
    tabQuery: { url: "https://gemini.google.com/*" },
    hosts: ["gemini.google.com"],
  },
  deepseek: {
    tabQuery: { url: ["https://chat.deepseek.com/*"] },
    hosts: ["chat.deepseek.com"],
  },
};
const AI_RESPONSE_MODEL_BY_MESSAGE_TYPE = {
  chatGPTResponse: "chatgpt",
  geminiResponse: "gemini",
  deepseekResponse: "deepseek",
};

function isMheTabUrl(url = "") {
  return MHE_HOSTS.some((host) => url.includes(host));
}

function getAiModelForUrl(url = "") {
  return (
    Object.entries(AI_MODELS).find(([, config]) =>
      config.hosts.some((host) => url.includes(host)),
    )?.[0] || null
  );
}

function resolveAiModel(preferredModel, storedModel) {
  if (AI_MODELS[preferredModel]) return preferredModel;
  if (AI_MODELS[storedModel]) return storedModel;
  return "chatgpt";
}

chrome.tabs.onActivated.addListener((activeInfo) => {
  lastActiveTabId = activeInfo.tabId;
});

function sendMessageWithRetry(tabId, message, maxAttempts = 3, delay = 1000) {
  return new Promise((resolve, reject) => {
    let attempts = 0;

    function attemptSend() {
      attempts++;
      chrome.tabs.sendMessage(tabId, message, (response) => {
        if (chrome.runtime.lastError) {
          if (attempts < maxAttempts) {
            setTimeout(attemptSend, delay);
          } else {
            reject(chrome.runtime.lastError);
          }
        } else {
          resolve(response);
        }
      });
    }

    attemptSend();
  });
}

async function focusTab(tabId) {
  if (!tabId) return false;

  try {
    const tab = await chrome.tabs.get(tabId);

    if (tab.windowId === chrome.windows.WINDOW_ID_CURRENT) {
      await chrome.tabs.update(tabId, { active: true });
      return true;
    }

    await chrome.windows.update(tab.windowId, { focused: true });
    await chrome.tabs.update(tabId, { active: true });
    return true;
  } catch (error) {
    return false;
  }
}

async function findAndStoreTabs(preferredModel = null) {
  const mheTabs = await chrome.tabs.query({ url: MHE_URL_PATTERNS });
  if (mheTabs.length > 0) {
    const preferredMheTab =
      mheTabs.find((tab) => tab.id === mheTabId) || mheTabs[0];
    mheTabId = preferredMheTab.id;
    mheWindowId = preferredMheTab.windowId;
  }

  const data = await chrome.storage.sync.get("aiModel");
  const aiModel = resolveAiModel(preferredModel, data.aiModel);
  aiType = aiModel;

  const aiModelConfig = AI_MODELS[aiModel];
  const aiTabs = await chrome.tabs.query(aiModelConfig.tabQuery);
  if (aiTabs.length > 0) {
    aiTabId = aiTabs[0].id;
    aiWindowId = aiTabs[0].windowId;
  } else {
    aiTabId = null;
    aiWindowId = null;
  }
}

async function shouldFocusTabs(preferredModel = null) {
  await findAndStoreTabs(preferredModel);
  return mheWindowId === aiWindowId;
}

async function processQuestion(message) {
  if (processingQuestion) return;
  processingQuestion = true;

  try {
    await findAndStoreTabs(message.aiModel);

    if (!aiTabId) {
      await sendMessageWithRetry(mheTabId, {
        type: "alertMessage",
        message: `Please open ${aiType} in another tab before using automation.`,
      });
      await sendMessageWithRetry(mheTabId, {
        type: "stopAutomation",
      });
      processingQuestion = false;
      return;
    }

    if (!mheTabId) {
      mheTabId = message.sourceTabId;
    }

    const sameWindow = await shouldFocusTabs(message.aiModel);

    if (sameWindow) {
      await focusTab(aiTabId);
      await new Promise((resolve) => setTimeout(resolve, 300));
    }

    await sendMessageWithRetry(aiTabId, {
      type: "receiveQuestion",
      question: message.question,
    });

    if (sameWindow && lastActiveTabId && lastActiveTabId !== aiTabId) {
      setTimeout(async () => {
        await focusTab(lastActiveTabId);
      }, 1000);
    }
  } catch (error) {
    if (mheTabId) {
      await sendMessageWithRetry(mheTabId, {
        type: "alertMessage",
        message: `Error communicating with ${aiType}. Please make sure it's open in another tab.`,
      });
      await sendMessageWithRetry(mheTabId, {
        type: "stopAutomation",
      });
    }
  } finally {
    processingQuestion = false;
  }
}

async function processResponse(message) {
  try {
    pendingResponse = message.response;

    if (duplicateTabId && isProcessingDuplicate) {
      await sendMessageWithRetry(duplicateTabId, {
        type: "processChatGPTResponse",
        response: message.response,
        isDuplicateTab: true,
      });
      return;
    }

    if (originalTabId) {
      storedResponse = message.response;
      await sendMessageWithRetry(originalTabId, {
        type: "processChatGPTResponse",
        response: message.response,
        isDuplicateTab: false,
      });
      return;
    }

    if (!mheTabId) {
      const mheTabs = await chrome.tabs.query({ url: MHE_URL_PATTERNS });
      if (mheTabs.length > 0) {
        mheTabId = mheTabs[0].id;
        mheWindowId = mheTabs[0].windowId;
      } else {
        return;
      }
    }

    const responseModel =
      AI_RESPONSE_MODEL_BY_MESSAGE_TYPE[message.type] || null;
    const sameWindow = await shouldFocusTabs(responseModel);

    if (sameWindow) {
      await focusTab(mheTabId);
      await new Promise((resolve) => setTimeout(resolve, 300));
    }

    await sendMessageWithRetry(mheTabId, {
      type: "processChatGPTResponse",
      response: message.response,
    });
  } catch (error) {
    console.error("Error processing AI response:", error);
  }
}

async function processAiResponseTimeout(message) {
  try {
    if (!mheTabId) {
      await findAndStoreTabs(message.aiModel);
    }

    if (!mheTabId) return;

    await sendMessageWithRetry(mheTabId, {
      type: "stopAutomation",
      reason:
        message.reason ||
        "AI did not produce a response before the automation timeout.",
    });
  } catch (error) {}
}

async function cancelAiResponseTimeout(message) {
  try {
    if (!aiTabId) {
      await findAndStoreTabs(message?.aiModel);
    }
    if (!aiTabId) return;

    await sendMessageWithRetry(
      aiTabId,
      { type: "cancelResponseObservation" },
      1,
      300,
    );
  } catch (error) {}
}

async function waitForTabReady(tabId, maxAttempts = 8) {
  for (let i = 0; i < maxAttempts; i++) {
    try {
      await chrome.tabs.get(tabId);

      await sendMessageWithRetry(tabId, { type: "ping" }, 1, 300);

      const tab = await chrome.tabs.get(tabId);
      if (tab.status === "complete") {
        await new Promise((resolve) => setTimeout(resolve, 300));
        return true;
      }
    } catch (error) {
      console.log(`Tab ${tabId} not ready, attempt ${i + 1}:`, error);
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return false;
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (sender.tab) {
    message.sourceTabId = sender.tab.id;

    const senderUrl = sender.tab.url || "";
    const senderAiModel = getAiModelForUrl(senderUrl);

    if (isMheTabUrl(senderUrl)) {
      if (!originalTabId && !duplicateTabId) {
        mheTabId = sender.tab.id;
        mheWindowId = sender.tab.windowId;
      }
    } else if (senderAiModel) {
      aiTabId = sender.tab.id;
      aiWindowId = sender.tab.windowId;
      aiType = senderAiModel;
    }
  }

  if (message.type === "ping") {
    sendResponse({ received: true });
    return true;
  }

  if (message.type === "sendQuestionToChatGPT") {
    processQuestion(message);
    sendResponse({ received: true });
    return true;
  }

  if (
    message.type === "chatGPTResponse" ||
    message.type === "geminiResponse" ||
    message.type === "deepseekResponse"
  ) {
    processResponse(message);
    sendResponse({ received: true });
    return true;
  }

  if (message.type === "aiResponseTimeout") {
    processAiResponseTimeout(message);
    sendResponse({ received: true });
    return true;
  }

  if (message.type === "cancelAiResponseTimeout") {
    cancelAiResponseTimeout(message);
    sendResponse({ received: true });
    return true;
  }

  if (message.type === "createDuplicateTab") {
    originalTabId = sender.tab.id;
    storedResponse = pendingResponse;

    chrome.tabs.duplicate(sender.tab.id, async (newTab) => {
      duplicateTabId = newTab.id;

      const isReady = await waitForTabReady(duplicateTabId);

      if (isReady) {
        try {
          await sendMessageWithRetry(duplicateTabId, {
            type: "processDuplicateTab",
            response: storedResponse,
          });
        } catch (error) {
          console.error("Error sending message to duplicate tab:", error);
        }
      } else {
        console.error("Duplicate tab failed to become ready");
      }
    });
    sendResponse({ received: true });
    return true;
  }

  if (message.type === "closeDuplicateTab") {
    if (duplicateTabId) {
      if (originalTabId) {
        focusTab(originalTabId);
      }

      chrome.tabs.remove(duplicateTabId, () => {
        duplicateTabId = null;
        isProcessingDuplicate = false;
      });
    }
    sendResponse({ received: true });
    return true;
  }

  if (message.type === "finishDoubleCredit") {
    if (originalTabId) {
      sendMessageWithRetry(originalTabId, {
        type: "completeDoubleCredit",
      });
    }
    sendResponse({ received: true });
    return true;
  }

  if (message.type === "resetTabTracking") {
    duplicateTabId = null;
    originalTabId = null;
    storedResponse = null;
    isProcessingDuplicate = false;
    pendingResponse = null;
    sendResponse({ received: true });
    return true;
  }

  if (message.type === "openSettings") {
    chrome.windows.create({
      url: chrome.runtime.getURL("popup/settings.html"),
      type: "popup",
      width: 500,
      height: 600,
    });
    sendResponse({ received: true });
    return true;
  }

  sendResponse({ received: false });
  return false;
});

findAndStoreTabs();

chrome.tabs.onRemoved.addListener((tabId) => {
  if (tabId === mheTabId) mheTabId = null;
  if (tabId === aiTabId) aiTabId = null;
  if (tabId === duplicateTabId) {
    duplicateTabId = null;
    isProcessingDuplicate = false;
  }
  if (tabId === originalTabId) {
    originalTabId = null;
    storedResponse = null;
  }
});
