let mheTabId = null;
let aiTabId = null;
let aiType = null;
let lastActiveTabId = null;
let processingQuestion = false;
let mheWindowId = null;
let aiWindowId = null;

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

async function findAndStoreTabs() {
  const mheTabs = await chrome.tabs.query({
    url: "https://learning.mheducation.com/*",
  });
  if (mheTabs.length > 0) {
    mheTabId = mheTabs[0].id;
    mheWindowId = mheTabs[0].windowId;
  }

  const data = await chrome.storage.sync.get("aiModel");
  const aiModel = data.aiModel || "chatgpt";
  aiType = aiModel;

  if (aiModel === "chatgpt") {
    const tabs = await chrome.tabs.query({ url: "https://chatgpt.com/*" });
    if (tabs.length > 0) {
      aiTabId = tabs[0].id;
      aiWindowId = tabs[0].windowId;
    }
  } else if (aiModel === "gemini") {
    const tabs = await chrome.tabs.query({
      url: "https://gemini.google.com/*",
    });
    if (tabs.length > 0) {
      aiTabId = tabs[0].id;
      aiWindowId = tabs[0].windowId;
    }
  } else if (aiModel === "deepseek") {
    const tabs = await chrome.tabs.query({
      url: "https://chat.deepseek.com/*",
    });
    if (tabs.length > 0) {
      aiTabId = tabs[0].id;
      aiWindowId = tabs[0].windowId;
    }
  }
}

async function shouldFocusTabs() {
  await findAndStoreTabs();
  return mheWindowId === aiWindowId;
}

async function processQuestion(message) {
  if (processingQuestion) return;
  processingQuestion = true;

  try {
    await findAndStoreTabs();

    if (!aiTabId) {
      await sendMessageWithRetry(mheTabId, {
        type: "alertMessage",
        message: `Please open ${aiType} in another tab before using automation.`,
      });
      processingQuestion = false;
      return;
    }

    if (!mheTabId) {
      mheTabId = message.sourceTabId;
    }

    const sameWindow = await shouldFocusTabs();

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
    }
  } finally {
    processingQuestion = false;
  }
}

async function processResponse(message) {
  try {
    if (!mheTabId) {
      const mheTabs = await chrome.tabs.query({
        url: "https://learning.mheducation.com/*",
      });
      if (mheTabs.length > 0) {
        mheTabId = mheTabs[0].id;
        mheWindowId = mheTabs[0].windowId;
      } else {
        return;
      }
    }

    const sameWindow = await shouldFocusTabs();

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

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (sender.tab) {
    message.sourceTabId = sender.tab.id;

    if (sender.tab.url.includes("learning.mheducation.com")) {
      mheTabId = sender.tab.id;
      mheWindowId = sender.tab.windowId;
    } else if (sender.tab.url.includes("chatgpt.com")) {
      aiTabId = sender.tab.id;
      aiWindowId = sender.tab.windowId;
      aiType = "chatgpt";
    } else if (sender.tab.url.includes("gemini.google.com")) {
      aiTabId = sender.tab.id;
      aiWindowId = sender.tab.windowId;
      aiType = "gemini";
    } else if (sender.tab.url.includes("chat.deepseek.com")) {
      aiTabId = sender.tab.id;
      aiWindowId = sender.tab.windowId;
      aiType = "deepseek";
    }
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

  if (message.type === "openSettings") {
    chrome.windows.create({
      url: chrome.runtime.getURL("popup/settings.html"),
      type: "popup",
      width: 500,
      height: 520,
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
});
