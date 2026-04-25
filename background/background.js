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
let backgroundDebugLogs = [];
const BG_DEBUG_LOG_KEY = "automcgraw.backgroundDebugLogs.v1";
const DEBUG_MAX_LOGS = 600;
const DEEPSEEK_URL_PATTERNS = [
  "https://chat.deepseek.com/*",
];

function debugLog(event, details = {}, level = "debug") {
  const entry = {
    ts: new Date().toISOString(),
    side: "background",
    level,
    event,
    state: getDebugState(),
    details: sanitizeDebugValue(details),
  };

  appendDebugEntry(entry);

  const consoleMethod =
    level === "error" ? "error" : level === "warn" ? "warn" : "debug";
  console[consoleMethod]("[AutoMcGraw]", event, entry);
}

function appendDebugEntry(entry) {
  try {
    backgroundDebugLogs.push(entry);
    backgroundDebugLogs = backgroundDebugLogs.slice(-DEBUG_MAX_LOGS);
  } catch (error) {}

  try {
    chrome.storage.local.get(BG_DEBUG_LOG_KEY, (data) => {
      const existing = Array.isArray(data?.[BG_DEBUG_LOG_KEY])
        ? data[BG_DEBUG_LOG_KEY]
        : [];
      existing.push(entry);
      chrome.storage.local.set({
        [BG_DEBUG_LOG_KEY]: existing.slice(-DEBUG_MAX_LOGS),
      });
    });
  } catch (error) {}
}

function getDebugState() {
  return {
    mheTabId,
    aiTabId,
    aiType,
    lastActiveTabId,
    processingQuestion,
    mheWindowId,
    aiWindowId,
    duplicateTabId,
    originalTabId,
    isProcessingDuplicate,
    hasPendingResponse: Boolean(pendingResponse),
    hasStoredResponse: Boolean(storedResponse),
  };
}

function sanitizeDebugValue(value, depth = 0) {
  if (depth > 4) return "[depth-limit]";
  if (value == null || typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "string") {
    return value.length > 1200 ? `${value.slice(0, 1200)}...` : value;
  }
  if (value instanceof Error) {
    return {
      name: value.name,
      message: value.message,
      stack: value.stack?.slice(0, 1600) || "",
    };
  }
  if (Array.isArray(value)) {
    return value.slice(0, 80).map((item) => sanitizeDebugValue(item, depth + 1));
  }
  if (typeof value === "object") {
    const result = {};
    Object.entries(value)
      .slice(0, 80)
      .forEach(([key, nestedValue]) => {
        result[key] = sanitizeDebugValue(nestedValue, depth + 1);
      });
    return result;
  }
  return String(value);
}

function isDeepSeekTabUrl(url = "") {
  return url.includes("chat.deepseek.com") || url.includes("deepseek.chat");
}

chrome.tabs.onActivated.addListener((activeInfo) => {
  lastActiveTabId = activeInfo.tabId;
  debugLog("tab_activated", { tabId: activeInfo.tabId });
});

function sendMessageWithRetry(tabId, message, maxAttempts = 3, delay = 1000) {
  return new Promise((resolve, reject) => {
    let attempts = 0;
    debugLog("send_message_start", {
      tabId,
      type: message?.type,
      maxAttempts,
      delay,
    });

    function attemptSend() {
      attempts++;
      debugLog("send_message_attempt", {
        tabId,
        type: message?.type,
        attempt: attempts,
      });
      chrome.tabs.sendMessage(tabId, message, (response) => {
        if (chrome.runtime.lastError) {
          debugLog(
            "send_message_attempt_error",
            {
              tabId,
              type: message?.type,
              attempt: attempts,
              error: chrome.runtime.lastError.message,
            },
            attempts < maxAttempts ? "warn" : "error"
          );
          if (attempts < maxAttempts) {
            setTimeout(attemptSend, delay);
          } else {
            reject(chrome.runtime.lastError);
          }
        } else {
          debugLog("send_message_success", {
            tabId,
            type: message?.type,
            attempt: attempts,
            response,
          });
          resolve(response);
        }
      });
    }

    attemptSend();
  });
}

async function focusTab(tabId) {
  if (!tabId) {
    debugLog("focus_tab_missing_id", {}, "warn");
    return false;
  }

  try {
    const tab = await chrome.tabs.get(tabId);

    if (tab.windowId === chrome.windows.WINDOW_ID_CURRENT) {
      await chrome.tabs.update(tabId, { active: true });
      debugLog("focus_tab_current_window", { tabId, windowId: tab.windowId });
      return true;
    }

    await chrome.windows.update(tab.windowId, { focused: true });
    await chrome.tabs.update(tabId, { active: true });
    debugLog("focus_tab_other_window", { tabId, windowId: tab.windowId });
    return true;
  } catch (error) {
    debugLog("focus_tab_error", { tabId, error }, "error");
    return false;
  }
}

async function findAndStoreTabs(preferredModel = null) {
  debugLog("find_tabs_start", { preferredModel });
  const mheTabs = await chrome.tabs.query({
    url: [
      "https://learning.mheducation.com/*",
      "https://ezto.mheducation.com/*",
      "https://newconnect.mheducation.com/*",
    ],
  });
  if (mheTabs.length > 0) {
    const preferredMheTab =
      mheTabs.find((tab) => tab.id === mheTabId) || mheTabs[0];
    mheTabId = preferredMheTab.id;
    mheWindowId = preferredMheTab.windowId;
  }

  const data = await chrome.storage.sync.get("aiModel");
  const aiModel = preferredModel || data.aiModel || "chatgpt";
  aiType = aiModel;

  if (aiModel === "chatgpt") {
    const tabs = await chrome.tabs.query({ url: "https://chatgpt.com/*" });
    if (tabs.length > 0) {
      aiTabId = tabs[0].id;
      aiWindowId = tabs[0].windowId;
    } else {
      aiTabId = null;
    }
  } else if (aiModel === "gemini") {
    const tabs = await chrome.tabs.query({
      url: "https://gemini.google.com/*",
    });
    if (tabs.length > 0) {
      aiTabId = tabs[0].id;
      aiWindowId = tabs[0].windowId;
    } else {
      aiTabId = null;
    }
  } else if (aiModel === "deepseek") {
    const tabs = await chrome.tabs.query({
      url: DEEPSEEK_URL_PATTERNS,
    });
    if (tabs.length > 0) {
      const preferredTab =
        tabs.find((tab) => tab.url && tab.url.includes("chat.deepseek.com")) ||
        tabs[0];
      aiTabId = preferredTab.id;
      aiWindowId = preferredTab.windowId;
    } else {
      aiTabId = null;
    }
  }
  debugLog("find_tabs_complete", {
    preferredModel,
    aiModel,
    mheTabs: mheTabs.map((tab) => ({
      id: tab.id,
      windowId: tab.windowId,
      url: tab.url,
      title: tab.title,
    })),
    mheTabId,
    aiTabId,
    aiWindowId,
    mheWindowId,
  });
}

async function shouldFocusTabs(preferredModel = null) {
  await findAndStoreTabs(preferredModel);
  const sameWindow = mheWindowId === aiWindowId;
  debugLog("should_focus_tabs", { preferredModel, sameWindow });
  return sameWindow;
}

async function processQuestion(message) {
  debugLog("process_question_start", {
    aiModel: message.aiModel,
    questionType: message.question?.type,
    questionLength: String(message.question?.question || "").length,
  });
  if (processingQuestion) {
    debugLog("process_question_ignored_already_processing", {}, "warn");
    return;
  }
  processingQuestion = true;

  try {
    await findAndStoreTabs(message.aiModel);

    if (!aiTabId) {
      debugLog("process_question_no_ai_tab", { aiType }, "error");
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
    debugLog("process_question_routing", {
      sameWindow,
      aiTabId,
      mheTabId,
      lastActiveTabId,
    });

    if (sameWindow) {
      await focusTab(aiTabId);
      await new Promise((resolve) => setTimeout(resolve, 300));
    }

    await sendMessageWithRetry(aiTabId, {
      type: "receiveQuestion",
      question: message.question,
    });
    debugLog("process_question_sent_to_ai", { aiTabId });

    if (sameWindow && lastActiveTabId && lastActiveTabId !== aiTabId) {
      setTimeout(async () => {
        await focusTab(lastActiveTabId);
      }, 1000);
    }
  } catch (error) {
    debugLog("process_question_error", { error }, "error");
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
    debugLog("process_question_complete");
  }
}

async function processResponse(message) {
  try {
    debugLog("process_response_start", {
      type: message.type,
      responseLength: String(message.response || "").length,
      responsePreview: String(message.response || "").slice(0, 1200),
    });
    pendingResponse = message.response;

    if (duplicateTabId && isProcessingDuplicate) {
      await sendMessageWithRetry(duplicateTabId, {
        type: "processChatGPTResponse",
        response: message.response,
        isDuplicateTab: true,
      });
      debugLog("process_response_sent_duplicate", { duplicateTabId });
      return;
    }

    if (originalTabId) {
      storedResponse = message.response;
      await sendMessageWithRetry(originalTabId, {
        type: "processChatGPTResponse",
        response: message.response,
        isDuplicateTab: false,
      });
      debugLog("process_response_sent_original", { originalTabId });
      return;
    }

    if (!mheTabId) {
      const mheTabs = await chrome.tabs.query({
        url: [
          "https://learning.mheducation.com/*",
          "https://ezto.mheducation.com/*",
          "https://newconnect.mheducation.com/*",
        ],
      });
      if (mheTabs.length > 0) {
        mheTabId = mheTabs[0].id;
        mheWindowId = mheTabs[0].windowId;
      } else {
        debugLog("process_response_no_mhe_tab", {}, "error");
        return;
      }
    }

    const responseModel =
      message.type === "chatGPTResponse"
        ? "chatgpt"
        : message.type === "geminiResponse"
        ? "gemini"
        : message.type === "deepseekResponse"
        ? "deepseek"
        : null;
    const sameWindow = await shouldFocusTabs(responseModel);

    if (sameWindow) {
      await focusTab(mheTabId);
      await new Promise((resolve) => setTimeout(resolve, 300));
    }

    await sendMessageWithRetry(mheTabId, {
      type: "processChatGPTResponse",
      response: message.response,
    });
    debugLog("process_response_sent_to_mhe", { mheTabId, sameWindow });
  } catch (error) {
    debugLog("process_response_error", { error }, "error");
    console.error("Error processing AI response:", error);
  }
}

async function processAiResponseTimeout(message) {
  try {
    debugLog("ai_response_timeout", {
      aiModel: message.aiModel,
      reason: message.reason,
    }, "warn");

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
  } catch (error) {
    debugLog("ai_response_timeout_error", { error }, "error");
  }
}

async function waitForTabReady(tabId, maxAttempts = 8) {
  debugLog("wait_for_tab_ready_start", { tabId, maxAttempts });
  for (let i = 0; i < maxAttempts; i++) {
    try {
      await chrome.tabs.get(tabId);

      await sendMessageWithRetry(tabId, { type: "ping" }, 1, 300);

      const tab = await chrome.tabs.get(tabId);
      if (tab.status === "complete") {
        await new Promise((resolve) => setTimeout(resolve, 300));
        debugLog("wait_for_tab_ready_complete", {
          tabId,
          attempt: i + 1,
          status: tab.status,
        });
        return true;
      }
    } catch (error) {
      debugLog(
        "wait_for_tab_ready_attempt_error",
        { tabId, attempt: i + 1, error },
        "warn"
      );
      console.log(`Tab ${tabId} not ready, attempt ${i + 1}:`, error);
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  debugLog("wait_for_tab_ready_timeout", { tabId, maxAttempts }, "error");
  return false;
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  debugLog("runtime_message_received", {
    type: message.type,
    senderTabId: sender.tab?.id || null,
    senderUrl: sender.tab?.url || "",
  });
  if (sender.tab) {
    message.sourceTabId = sender.tab.id;

    if (
      sender.tab.url.includes("learning.mheducation.com") ||
      sender.tab.url.includes("ezto.mheducation.com") ||
      sender.tab.url.includes("newconnect.mheducation.com")
    ) {
      if (!originalTabId && !duplicateTabId) {
        mheTabId = sender.tab.id;
        mheWindowId = sender.tab.windowId;
      }
    } else if (sender.tab.url.includes("chatgpt.com")) {
      aiTabId = sender.tab.id;
      aiWindowId = sender.tab.windowId;
      aiType = "chatgpt";
    } else if (sender.tab.url.includes("gemini.google.com")) {
      aiTabId = sender.tab.id;
      aiWindowId = sender.tab.windowId;
      aiType = "gemini";
    } else if (isDeepSeekTabUrl(sender.tab.url || "")) {
      aiTabId = sender.tab.id;
      aiWindowId = sender.tab.windowId;
      aiType = "deepseek";
    }
  }

  if (message.type === "ping") {
    sendResponse({ received: true });
    return true;
  }

  if (message.type === "getBackgroundDebugLogs") {
    backgroundDebugLogs.push({
      ts: new Date().toISOString(),
      side: "background",
      level: "debug",
      event: "get_background_debug_logs_request",
      state: getDebugState(),
      details: {
        senderTabId: sender.tab?.id || null,
        senderUrl: sender.tab?.url || "",
      },
    });
    backgroundDebugLogs = backgroundDebugLogs.slice(-DEBUG_MAX_LOGS);

    chrome.storage.local.get(BG_DEBUG_LOG_KEY, (data) => {
      const storedLogs = Array.isArray(data?.[BG_DEBUG_LOG_KEY])
        ? data[BG_DEBUG_LOG_KEY]
        : [];
      sendResponse({
        received: true,
        logs: storedLogs.length ? storedLogs : backgroundDebugLogs,
      });
    });
    return true;
  }

  if (message.type === "clearBackgroundDebugLogs") {
    chrome.storage.local.set({ [BG_DEBUG_LOG_KEY]: [] }, () => {
      debugLog("background_debug_logs_cleared", {
        reason: message.reason || "message",
      });
      sendResponse({ received: true });
    });
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

  if (message.type === "createDuplicateTab") {
    originalTabId = sender.tab.id;
    storedResponse = pendingResponse;
    debugLog("create_duplicate_tab_start", { originalTabId });

    chrome.tabs.duplicate(sender.tab.id, async (newTab) => {
      duplicateTabId = newTab.id;
      debugLog("create_duplicate_tab_created", { duplicateTabId });

      const isReady = await waitForTabReady(duplicateTabId);

      if (isReady) {
        try {
          await sendMessageWithRetry(duplicateTabId, {
            type: "processDuplicateTab",
            response: storedResponse,
          });
          debugLog("create_duplicate_tab_sent_process_message", {
            duplicateTabId,
          });
        } catch (error) {
          debugLog("create_duplicate_tab_send_error", { error }, "error");
          console.error("Error sending message to duplicate tab:", error);
        }
      } else {
        debugLog("create_duplicate_tab_not_ready", { duplicateTabId }, "error");
        console.error("Duplicate tab failed to become ready");
      }
    });
    sendResponse({ received: true });
    return true;
  }

  if (message.type === "closeDuplicateTab") {
    debugLog("close_duplicate_tab", { duplicateTabId, originalTabId });
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
    debugLog("finish_double_credit", { originalTabId });
    if (originalTabId) {
      sendMessageWithRetry(originalTabId, {
        type: "completeDoubleCredit",
      });
    }
    sendResponse({ received: true });
    return true;
  }

  if (message.type === "resetTabTracking") {
    debugLog("reset_tab_tracking");
    duplicateTabId = null;
    originalTabId = null;
    storedResponse = null;
    isProcessingDuplicate = false;
    pendingResponse = null;
    sendResponse({ received: true });
    return true;
  }

  if (message.type === "openSettings") {
    debugLog("open_settings");
    chrome.windows.create({
      url: chrome.runtime.getURL("popup/settings.html"),
      type: "popup",
      width: 500,
      height: 600,
    });
    sendResponse({ received: true });
    return true;
  }

  sendResponse({
    received: false,
    unknownType: message?.type || null,
    keys: message ? Object.keys(message) : [],
  });
  return false;
});

findAndStoreTabs();
debugLog("background_loaded");

chrome.tabs.onRemoved.addListener((tabId) => {
  debugLog("tab_removed", { tabId });
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
