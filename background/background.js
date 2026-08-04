let aiTabId = null;
let aiType = "openrouter";
let lastActiveTabId = null;
let mheWindowId = null;
let aiWindowId = null;
const tabStates = new Map();
const OPENROUTER_ENDPOINT = "https://openrouter.ai/api/v1/chat/completions";
const DEFAULT_OPENROUTER_MODEL = "openai/gpt-4o-mini";
const DEFAULT_API_BASE_URL = "https://openrouter.ai/api/v1";
const DEEPSEEK_URL_PATTERNS = ["https://chat.deepseek.com/*", "https://deepseek.chat/*"];
const monitoringState = new Map();
let monitoringWriteChain = Promise.resolve();
const monitoringReady = chrome.storage.local.get("monitoringState").then((data) => {
  Object.entries(data.monitoringState || {}).forEach(([tabId, state]) => {
    monitoringState.set(tabId, state);
  });
});

function persistMonitoringState() {
  const snapshot = Object.fromEntries(monitoringState);
  monitoringWriteChain = monitoringWriteChain.then(() =>
    chrome.storage.local.set({ monitoringState: snapshot })
  );
  return monitoringWriteChain;
}

async function updateMonitoring(tabId, patch) {
  if (!Number.isInteger(tabId)) return;
  await monitoringReady;
  const key = String(tabId);
  const previous = monitoringState.get(key) || { tabId };
  monitoringState.set(key, {
    ...previous,
    ...patch,
    tabId,
    updatedAt: Date.now(),
  });
  await persistMonitoringState();
}

async function recordQuestionResult(tabId, incorrect) {
  const stateInfo = findStateForTab(tabId);
  const sourceTabId = stateInfo?.state?.sourceTabId || tabId;
  await monitoringReady;
  const previous = monitoringState.get(String(sourceTabId)) || {};
  const correctCount = (previous.correctCount || 0) + (incorrect ? 0 : 1);
  const incorrectCount = (previous.incorrectCount || 0) + (incorrect ? 1 : 0);
  const consecutiveIncorrect = incorrect
    ? (previous.consecutiveIncorrect || 0) + 1
    : 0;

  await updateMonitoring(sourceTabId, {
    correctCount,
    incorrectCount,
    consecutiveIncorrect,
    lastResult: incorrect ? "incorrect" : "correct",
    lastResultAt: Date.now(),
  });
}

async function recordMonitoringError(tabId, error) {
  await monitoringReady;
  const previous = monitoringState.get(String(tabId)) || {};
  await updateMonitoring(tabId, {
    status: "error",
    error,
    errorCount: (previous.errorCount || 0) + 1,
    finishedAt: Date.now(),
  });
}

function getTabState(tabId) {
  if (!Number.isInteger(tabId)) return null;
  if (!tabStates.has(tabId)) {
    tabStates.set(tabId, {
      processing: false,
      pendingResponse: null,
      duplicateTabId: null,
      originalTabId: null,
      storedResponse: null,
      isProcessingDuplicate: false,
      sourceTabId: tabId,
      model: null,
      aiTabId: null,
      aiWindowId: null,
    });
  }
  return tabStates.get(tabId);
}

function findStateForTab(tabId) {
  if (tabStates.has(tabId)) {
    return { originalTabId: tabId, state: tabStates.get(tabId) };
  }

  for (const [originalTabId, state] of tabStates) {
    if (state.duplicateTabId === tabId || state.aiTabId === tabId) {
      return { originalTabId, state };
    }
  }

  return null;
}

function resetTabState(originalTabId) {
  const state = tabStates.get(originalTabId);
  if (!state) return;
  state.pendingResponse = null;
  state.duplicateTabId = null;
  state.originalTabId = null;
  state.storedResponse = null;
  state.isProcessingDuplicate = false;
  state.model = null;
  state.aiTabId = null;
  state.aiWindowId = null;
}

function isDeepSeekTabUrl(url = "") {
  return url.includes("chat.deepseek.com") || url.includes("deepseek.chat");
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

async function findAndStoreTabs() {
  const mheTabs = await chrome.tabs.query({
    url: [
      "https://learning.mheducation.com/*",
      "https://ezto.mheducation.com/*",
    ],
  });
  if (mheTabs.length > 0) {
    mheWindowId = mheTabs[0].windowId;
  }

  aiTabId = null;
  aiWindowId = null;
  aiType = "openrouter";
}

async function shouldFocusTabs() {
  await findAndStoreTabs();
  return mheWindowId === aiWindowId;
}

function buildOpenRouterPrompt(questionData) {
  const { type, question, options, imageAltText, previousCorrection } = questionData || {};
  let text = `Type: ${type}\nQuestion: ${question}`;

  if (Array.isArray(imageAltText) && imageAltText.length > 0) {
    text +=
      "\n\nImage alternative text:\n" +
      imageAltText.map((alt, index) => `${index + 1}. ${alt}`).join("\n");
  }

  if (
    previousCorrection &&
    previousCorrection.question &&
    previousCorrection.correctAnswer
  ) {
    text =
      `CORRECTION FROM PREVIOUS ANSWER: For the question "${
        previousCorrection.question
      }", your answer was incorrect. The correct answer was: ${JSON.stringify(
        previousCorrection.correctAnswer
      )}\n\nNow answer this new question:\n\n` + text;
  }

  if (type === "matching" && options?.prompts && options?.choices) {
    text +=
      "\nPrompts:\n" +
      options.prompts.map((prompt, i) => `${i + 1}. ${prompt}`).join("\n");
    text +=
      "\nChoices:\n" +
      options.choices.map((choice, i) => `${i + 1}. ${choice}`).join("\n");
    text +=
      '\n\nMatch each prompt with the correct choice. Set "answer" to an array of strings using the exact format "Prompt -> Choice". Include one entry per prompt, use exact prompt and choice text, and use each choice at most once.';
  } else if (type === "fill_in_the_blank") {
    text +=
      "\n\nThis is a fill in the blank question. If there are multiple blanks, provide answers as an array in order of appearance. For a single blank, provide a string.";
  } else if (Array.isArray(options) && options.length > 0) {
    text += "\nOptions:\n" + options.map((opt, i) => `${i + 1}. ${opt}`).join("\n");
    text +=
      "\n\nYour answer must exactly match one or more of the options. Do not include option numbers.";
  }

  return text;
}

function extractJsonObject(value) {
  const rawText = Array.isArray(value)
    ? value
        .map((part) => (typeof part === "string" ? part : part?.text || ""))
        .join("")
    : value;
  const text = String(rawText || "")
    .replace(/```(?:json)?/gi, "")
    .replace(/```/g, "")
    .trim();
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) {
    throw new Error("OpenRouter returned a response without JSON.");
  }
  const parsed = JSON.parse(text.slice(start, end + 1));
  if (!parsed || !Object.prototype.hasOwnProperty.call(parsed, "answer")) {
    throw new Error("OpenRouter response did not include an answer.");
  }
  return JSON.stringify(parsed);
}

function normalizeApiEndpoint(baseUrl) {
  const normalized = String(baseUrl || DEFAULT_API_BASE_URL)
    .trim()
    .replace(/\/+$/, "");
  return normalized.endsWith("/chat/completions")
    ? normalized
    : `${normalized}/chat/completions`;
}

function isOpenRouterEndpoint(endpoint) {
  try {
    return new URL(endpoint).hostname === "openrouter.ai";
  } catch (error) {
    return false;
  }
}

async function requestCompatibleApi(questionData) {
  const [localData, syncData] = await Promise.all([
    chrome.storage.local.get(["apiKey", "openrouterApiKey"]),
    chrome.storage.sync.get(["apiBaseUrl", "openrouterModel", "apiProvider"]),
  ]);
  const apiKey = String(localData.apiKey || localData.openrouterApiKey || "").trim();
  const model = String(syncData.openrouterModel || DEFAULT_OPENROUTER_MODEL).trim();
  const endpoint = normalizeApiEndpoint(syncData.apiBaseUrl || DEFAULT_API_BASE_URL);
  const provider = String(syncData.apiProvider || "").trim();

  if (!apiKey) {
    throw new Error("API key is not configured. Open Auto-McGraw settings to add it.");
  }

  const body = {
    model,
    messages: [
      {
        role: "system",
        content:
          'Answer the question accurately. Return only valid JSON with exactly these keys: "answer" and "explanation". The answer must be a string, boolean, or array of strings. Keep explanation to one short sentence.',
      },
      { role: "user", content: buildOpenRouterPrompt(questionData) },
    ],
    temperature: 0,
    response_format: {
      type: "json_schema",
      json_schema: {
        name: "smartbook_answer",
        strict: true,
        schema: {
          type: "object",
          properties: {
            answer: {
              description: "The selected answer or ordered answers.",
              anyOf: [
                { type: "string" },
                { type: "boolean" },
                { type: "array", items: { type: "string" } },
              ],
            },
            explanation: { type: "string" },
          },
          required: ["answer", "explanation"],
          additionalProperties: false,
        },
      },
    },
  };

  if (provider && isOpenRouterEndpoint(endpoint)) {
    body.provider = { only: [provider] };
  }

  const requestOptions = {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  };
  if (isOpenRouterEndpoint(endpoint)) {
    requestOptions.headers["HTTP-Referer"] = "https://learning.mheducation.com/";
    requestOptions.headers["X-Title"] = "Auto-McGraw Smartbook";
  }
  let response = await fetch(endpoint, requestOptions);
  let payload = await response.json().catch(() => ({}));

  // Some OpenRouter models support JSON mode but not JSON Schema. Retry once
  // with the broader JSON response format before surfacing the API error.
  if (!response.ok && response.status === 400 && body.response_format) {
    body.response_format = { type: "json_object" };
    requestOptions.body = JSON.stringify(body);
    response = await fetch(endpoint, requestOptions);
    payload = await response.json().catch(() => ({}));
  }

  if (!response.ok && response.status === 400 && body.response_format) {
    delete body.response_format;
    requestOptions.body = JSON.stringify(body);
    response = await fetch(endpoint, requestOptions);
    payload = await response.json().catch(() => ({}));
  }

  if (!response.ok) {
    const detail = payload?.error?.message || `HTTP ${response.status}`;
    throw new Error(`API request failed: ${detail}`);
  }

  const content = payload?.choices?.[0]?.message?.content;
  return extractJsonObject(content);
}

async function stopMheAutomation(tabId, message) {
  if (!Number.isInteger(tabId)) return;
  try {
    await sendMessageWithRetry(tabId, { type: "alertMessage", message });
    await sendMessageWithRetry(tabId, { type: "stopAutomation" });
  } catch (error) {
    console.error(`Unable to notify MHEducation tab ${tabId}:`, error);
  }
}

async function getSelectedModel() {
  const data = await chrome.storage.sync.get("aiModel");
  return data.aiModel || "chatgpt";
}

async function findAssistantTab(model) {
  const url =
    model === "chatgpt"
      ? "https://chatgpt.com/*"
      : model === "gemini"
        ? "https://gemini.google.com/*"
        : DEEPSEEK_URL_PATTERNS;
  const tabs = await chrome.tabs.query({ url });
  return tabs[0] || null;
}

async function processQuestion(message) {
  const sourceTabId = message.sourceTabId;
  const state = getTabState(sourceTabId);
  if (!state || state.processing) return;
  state.processing = true;

  try {
    const sourceTab = await chrome.tabs.get(sourceTabId);
    mheWindowId = sourceTab.windowId;
    state.model = await getSelectedModel();
    await updateMonitoring(sourceTabId, {
      status: "requesting",
      model: state.model,
      startedAt: Date.now(),
      tabTitle: sourceTab.title || `Tab ${sourceTabId}`,
      questionPreview: String(message.question?.question || "").slice(0, 140),
      error: null,
    });

    if (state.model === "openrouter") {
      const response = await requestCompatibleApi(message.question);
      await processResponse({ response, sourceTabId });
      return;
    }

    const assistantTab = await findAssistantTab(state.model);
    if (!assistantTab?.id) {
      const modelName =
        state.model === "gemini"
          ? "Gemini"
          : state.model === "deepseek"
            ? "DeepSeek"
            : "ChatGPT";
      await stopMheAutomation(
        sourceTabId,
        `Please open ${modelName} in another tab before using automation.`
      );
      await recordMonitoringError(
        sourceTabId,
        `Please open ${modelName} in another tab before using automation.`
      );
      return;
    }

    state.aiTabId = assistantTab.id;
    state.aiWindowId = assistantTab.windowId;
    const sameWindow = sourceTab.windowId === assistantTab.windowId;
    if (sameWindow) {
      await focusTab(assistantTab.id);
      await new Promise((resolve) => setTimeout(resolve, 300));
    }

    await sendMessageWithRetry(assistantTab.id, {
      type: "receiveQuestion",
      question: message.question,
    });
    await updateMonitoring(sourceTabId, {
      status: "waiting-assistant",
      assistantTabId: assistantTab.id,
    });

    if (sameWindow) {
      setTimeout(() => {
        focusTab(sourceTabId);
      }, 1000);
    }
  } catch (error) {
    console.error("API request error:", error);
    await recordMonitoringError(
      sourceTabId,
      error.message || "Unable to get an answer from the API."
    );
    await stopMheAutomation(
      sourceTabId,
      error.message || "Unable to get an answer from OpenRouter."
    );
  } finally {
    state.processing = false;
  }
}

async function processResponse(message) {
  const responseSourceTabId = message.sourceTabId;
  try {
    const sourceTabId = responseSourceTabId;
    const stateInfo = findStateForTab(sourceTabId);
    const state = stateInfo?.state;
    if (!state) return;
    state.pendingResponse = message.response;
    await monitoringReady;
    const monitoringEntry = monitoringState.get(String(state.sourceTabId));
    const responseReceivedAt = Date.now();
    await updateMonitoring(state.sourceTabId, {
      status: "answering",
      responseReceivedAt,
      latencyMs: monitoringEntry?.startedAt
        ? responseReceivedAt - monitoringEntry.startedAt
        : null,
    });

    if (state.duplicateTabId && state.isProcessingDuplicate) {
      await sendMessageWithRetry(state.duplicateTabId, {
        type: "processChatGPTResponse",
        response: message.response,
        isDuplicateTab: true,
      });
      await updateMonitoring(state.sourceTabId, {
        status: "answering-duplicate",
      });
      return;
    }

    if (state.originalTabId) {
      state.storedResponse = message.response;
      await sendMessageWithRetry(state.originalTabId, {
        type: "processChatGPTResponse",
        response: message.response,
        isDuplicateTab: false,
      });
      await updateMonitoring(state.sourceTabId, {
        status: "completed",
        finishedAt: Date.now(),
      });
      return;
    }

    await sendMessageWithRetry(state.sourceTabId, {
      type: "processChatGPTResponse",
      response: message.response,
    });
    await updateMonitoring(state.sourceTabId, {
      status: "completed",
      finishedAt: Date.now(),
      error: null,
    });
  } catch (error) {
    console.error("Error processing AI response:", error);
    const failureState = findStateForTab(responseSourceTabId);
    await recordMonitoringError(
      failureState?.state?.sourceTabId || responseSourceTabId,
      error.message || "Unable to process the assistant response."
    );
  }
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

    if (
      sender.tab.url.includes("learning.mheducation.com") ||
      sender.tab.url.includes("ezto.mheducation.com")
    ) {
      mheWindowId = sender.tab.windowId;
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

  if (message.type === "createDuplicateTab") {
    const originalTabId = sender.tab.id;
    const state = getTabState(originalTabId);
    state.originalTabId = originalTabId;
    state.storedResponse = state.pendingResponse;
    state.isProcessingDuplicate = true;
    void updateMonitoring(originalTabId, {
      status: "answering-duplicate",
    });

    chrome.tabs.duplicate(originalTabId, async (newTab) => {
      if (chrome.runtime.lastError || !newTab?.id) {
        console.error("Could not create duplicate MHEducation tab:", chrome.runtime.lastError);
        state.isProcessingDuplicate = false;
        return;
      }

      state.duplicateTabId = newTab.id;

      const isReady = await waitForTabReady(state.duplicateTabId);

      if (isReady) {
        try {
          await sendMessageWithRetry(state.duplicateTabId, {
            type: "processDuplicateTab",
            response: state.storedResponse,
          });
        } catch (error) {
          console.error(`Error sending message to duplicate tab ${state.duplicateTabId}:`, error);
        }
      } else {
        console.error(`Duplicate tab ${state.duplicateTabId} failed to become ready`);
      }
    });
    sendResponse({ received: true });
    return true;
  }

  if (message.type === "closeDuplicateTab") {
    const stateInfo = findStateForTab(sender.tab?.id);
    const state = stateInfo?.state;
    if (state?.duplicateTabId) {
      const duplicateTabId = state.duplicateTabId;
      chrome.tabs.remove(duplicateTabId, () => {
        resetTabState(stateInfo.originalTabId);
      });
    }
    sendResponse({ received: true });
    return true;
  }

  if (message.type === "finishDoubleCredit") {
    const stateInfo = findStateForTab(sender.tab?.id);
    if (stateInfo?.state.originalTabId) {
      sendMessageWithRetry(stateInfo.state.originalTabId, {
        type: "completeDoubleCredit",
      });
    }
    sendResponse({ received: true });
    return true;
  }

  if (message.type === "resetTabTracking") {
    const stateInfo = findStateForTab(sender.tab?.id);
    if (stateInfo) {
      resetTabState(stateInfo.originalTabId);
    }
    sendResponse({ received: true });
    return true;
  }

  if (message.type === "clearMonitoring") {
    monitoringState.clear();
    void persistMonitoringState();
    sendResponse({ received: true });
    return true;
  }

  if (message.type === "reportQuestionResult") {
    void recordQuestionResult(sender.tab?.id, Boolean(message.incorrect));
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
  if (tabId === aiTabId) aiTabId = null;
  const stateInfo = findStateForTab(tabId);
  if (!stateInfo) return;

  if (stateInfo.originalTabId === tabId) {
    tabStates.delete(stateInfo.originalTabId);
  } else if (stateInfo.state.duplicateTabId === tabId) {
    stateInfo.state.duplicateTabId = null;
    stateInfo.state.isProcessingDuplicate = false;
  }
});
