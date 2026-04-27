let hasResponded = false;
let messageCountAtQuestion = 0;
let observationStartTime = 0;
let observationTimeout = null;
let observationInterval = null;
let observer = null;
let responseInFlight = false;
let lastSentResponseText = "";
let assistantTextAtQuestion = "";
let pendingCandidateText = "";
let pendingCandidateSeenAt = 0;
const DEBUG_LOG_KEY = "automcgraw.debugLogs.v1";
const DEBUG_MAX_LOGS = 600;

window.__automcgrawDebugLogs = window.__automcgrawDebugLogs || [];

function debugLog(event, details = {}, level = "debug") {
  const entry = {
    ts: new Date().toISOString(),
    side: "chatgpt",
    level,
    event,
    page: getDebugPageState(),
    details: sanitizeDebugValue(details),
  };

  appendDebugEntry(entry);

  const consoleMethod =
    level === "error" ? "error" : level === "warn" ? "warn" : "debug";
  console[consoleMethod]("[AutoMcGraw]", event, entry);
}

function appendDebugEntry(entry) {
  try {
    window.__automcgrawDebugLogs.push(entry);
    window.__automcgrawDebugLogs = window.__automcgrawDebugLogs.slice(
      -DEBUG_MAX_LOGS
    );
  } catch (error) {}

  try {
    const existing = JSON.parse(localStorage.getItem(DEBUG_LOG_KEY) || "[]");
    existing.push(entry);
    localStorage.setItem(
      DEBUG_LOG_KEY,
      JSON.stringify(existing.slice(-DEBUG_MAX_LOGS))
    );
  } catch (error) {}

  try {
    document.documentElement.setAttribute(
      "data-automcgraw-last-debug",
      `${entry.ts} ${entry.event}`
    );
  } catch (error) {}
}

function getDebugLogs() {
  try {
    return JSON.parse(localStorage.getItem(DEBUG_LOG_KEY) || "[]");
  } catch (error) {
    return window.__automcgrawDebugLogs || [];
  }
}

function clearDebugLogs(reason = "manual") {
  try {
    window.__automcgrawDebugLogs = [];
    localStorage.removeItem(DEBUG_LOG_KEY);
  } catch (error) {}
  debugLog("debug_logs_cleared", { reason });
}

function getDebugPageState() {
  return {
    title: document.title,
    url: location.href,
    hasResponded,
    responseInFlight,
    messageCountAtQuestion,
    observationActive: Boolean(observationStartTime),
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
  if (value instanceof Element) {
    return describeElementForDebug(value);
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

function describeElementForDebug(element) {
  return {
    tagName: element.tagName,
    id: element.id || "",
    className: String(element.className || ""),
    text: normalizeWhitespace(
      element.innerText || element.textContent || element.value || ""
    ).slice(0, 500),
    ariaLabel: element.getAttribute("aria-label") || "",
    testId: element.getAttribute("data-testid") || "",
  };
}

function normalizeWhitespace(text) {
  return String(text || "").replace(/\s+/g, " ").trim();
}

debugLog("content_script_loaded", { href: location.href });
setupDebugBridge();

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  debugLog("message_received", { type: message.type });

  if (message.type === "ping") {
    sendResponse({ received: true });
    return true;
  }

  if (message.type === "getDebugLogs") {
    sendResponse({ received: true, logs: getDebugLogs() });
    return true;
  }

  if (message.type === "clearDebugLogs") {
    clearDebugLogs(message.reason || "message");
    sendResponse({ received: true });
    return true;
  }

  if (message.type === "receiveQuestion") {
    debugLog("receive_question_start", {
      questionType: message.question?.type,
      questionLength: String(message.question?.question || "").length,
      controlCount: message.question?.controls?.length || 0,
      dropdownCount: message.question?.dropdowns?.length || 0,
    });
    resetObservation();

    const messages = document.querySelectorAll(
      '[data-message-author-role="assistant"]'
    );
    messageCountAtQuestion = messages.length;
    assistantTextAtQuestion = getLatestAssistantResponseText();
    hasResponded = false;

    insertQuestion(message.question)
      .then(() => {
        debugLog("receive_question_inserted");
        sendResponse({ received: true, status: "processing" });
      })
      .catch((error) => {
        debugLog("receive_question_error", { error }, "error");
        sendResponse({ received: false, error: error.message });
      });

    return true;
  }
});

function setupDebugBridge() {
  if (window.__automcgrawDebugBridgeInstalled) return;
  window.__automcgrawDebugBridgeInstalled = true;

  window.addEventListener("message", (event) => {
    if (event.source !== window) return;
    const data = event.data || {};
    if (data.source !== "automcgraw-debug" || data.type !== "collect") return;

    const payload = {
      source: "automcgraw-debug",
      type: "logs",
      side: "chatgpt",
      requestId: data.requestId || "",
      logs: getDebugLogs(),
      backgroundLogs: [],
      backgroundError: "",
      backgroundResponse: null,
    };

    try {
      chrome.runtime.sendMessage(chrome.runtime.id, { type: "getBackgroundDebugLogs" }, (response) => {
        payload.backgroundResponse = response || null;
        if (chrome.runtime.lastError) {
          payload.backgroundError = chrome.runtime.lastError.message;
        } else if (!response?.received) {
          payload.backgroundError = `Unexpected background response: ${JSON.stringify(
            response
          )}`;
        } else {
          payload.backgroundLogs = Array.isArray(response?.logs)
            ? response.logs
            : [];
        }
        window.postMessage(payload, "*");
      });
    } catch (error) {
      payload.backgroundError = error.message;
      window.postMessage(payload, "*");
    }
  });
}

function resetObservation() {
  debugLog("observation_reset", {
    hadTimeout: Boolean(observationTimeout),
    hadInterval: Boolean(observationInterval),
    hadObserver: Boolean(observer),
  });
  hasResponded = false;
  responseInFlight = false;
  observationStartTime = 0;
  pendingCandidateText = "";
  pendingCandidateSeenAt = 0;
  if (observationTimeout) {
    clearTimeout(observationTimeout);
    observationTimeout = null;
  }
  if (observationInterval) {
    clearInterval(observationInterval);
    observationInterval = null;
  }
  if (observer) {
    observer.disconnect();
    observer = null;
  }
}

async function insertQuestion(questionData) {
  const text = buildPrompt(questionData);
  debugLog("insert_question_start", {
    promptLength: text.length,
    promptPreview: text.slice(0, 1200),
  });
  const inputArea = await waitForChatInput();
  debugLog("insert_question_input_found", { inputArea });

  inputArea.focus();

  if ("value" in inputArea) {
    inputArea.value = text;
    inputArea.dispatchEvent(
      new InputEvent("input", {
        bubbles: true,
        inputType: "insertText",
        data: text,
      })
    );
  } else {
    inputArea.textContent = "";
    const inserted = document.execCommand("insertText", false, text);
    if (!inserted) {
      inputArea.textContent = text;
    }
    inputArea.dispatchEvent(
      new InputEvent("input", {
        bubbles: true,
        inputType: "insertText",
        data: text,
      })
    );
  }

  inputArea.dispatchEvent(new Event("change", { bubbles: true }));

  const sendButton = await waitForSendButton();
  debugLog("insert_question_send_button_found", { sendButton });
  sendButton.click();
  debugLog("insert_question_send_clicked");
  startObserving();
}

function buildPrompt(questionData) {
  const { type, question, options, previousCorrection } = questionData;
  let text = `Type: ${type}\nQuestion: ${question}`;

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

  if (type === "connect_slot_graph") {
    return buildSlotGraphPrompt(questionData);
  }

  if (type === "matching") {
    text +=
      "\nPrompts:\n" +
      options.prompts.map((prompt, i) => `${i + 1}. ${prompt}`).join("\n");
    text +=
      "\nChoices:\n" +
      options.choices.map((choice, i) => `${i + 1}. ${choice}`).join("\n");
    text +=
      '\n\nPlease match each prompt with the correct choice. Set "answer" to an array of strings using the exact format \'Prompt -> Choice\'. Include one entry per prompt, use exact prompt and choice text, and use each choice at most once.';
  } else if (type === "fill_in_the_blank") {
    text +=
      "\n\nThis is a fill in the blank question. If there are multiple blanks, provide answers as an array in order of appearance. For a single blank, you can provide a string.";
  } else if (options && options.length > 0) {
    text +=
      "\nOptions:\n" + options.map((opt, i) => `${i + 1}. ${opt}`).join("\n");
    text +=
      "\n\nIMPORTANT: Your answer must EXACTLY match one of the above options. Do not include numbers in your answer. If there are periods, include them.";
  }

  text +=
    '\n\nPlease provide your answer in JSON format with keys "answer" and "explanation". Explanations should be no more than one sentence. DO NOT acknowledge the correction in your response, only answer the new question.';

  return text;
}

function buildSlotGraphPrompt(questionData) {
  const { prompt, context, slots, previousCorrection } = questionData;
  const slotList = Array.isArray(slots) ? slots : [];

  let text = "";

  if (
    previousCorrection &&
    previousCorrection.question &&
    previousCorrection.correctAnswer
  ) {
    text +=
      `CORRECTION FROM PREVIOUS ANSWER: For the question "${previousCorrection.question}", your answer was incorrect. The correct answer was: ${JSON.stringify(
        previousCorrection.correctAnswer
      )}\n\nNow answer this new question.\n\n`;
  }

  text += `Question / page prompt:\n${prompt || ""}`;

  if (context && context !== prompt) {
    text += `\n\nFull page context:\n${context}`;
  }

  text += `\n\nFillable slots (you must return a value for each slot you can answer):\n${JSON.stringify(
    slotList,
    null,
    2
  )}`;

  text += `\n\nReturn JSON of the form: {"slots": {"<slot id>": <value>, ...}, "explanation": "<one sentence>"}`;
  text += `\n\nReturn only the raw JSON object — no markdown fences, no acknowledgements, no prose outside the JSON.`;
  text += `\n\nRules:`;
  text += `\n- Use the exact slot ids from the slots list as the keys.`;
  text += `\n- For dropdown slots, the value must be EXACTLY one of the option strings shown in that slot's "options".`;
  text += `\n- For choice / boolean slots (single selection), the value is the exact option string you want to pick.`;
  text += `\n- For multi_choice slots, the value is an array of exact option strings.`;
  text += `\n- For number slots, write the number as you would type it. For NEGATIVE numbers in McGraw's accounting cells, use parentheses, e.g. "(4,976)" — McGraw stores negatives that way.`;
  text += `\n- For text slots, write the natural-language answer as a string.`;
  text += `\n- If a slot has no answer (truly blank cell), omit it or set its value to null. Do not invent values.`;
  text += `\n- Use slot "hint", "group", and "groupRole" to keep paired cells (label/amount, debit/credit, row 1/row 2) consistent.`;
  text += `\n- Do NOT emit any other keys (no "actions", no selectors). The page knows how to apply each slot.`;
  text += `\n\nDO NOT acknowledge any correction in your response, only answer the new question.`;

  return text;
}

function waitForChatInput(timeout = 15000) {
  return waitForElement(
    [
      "#prompt-textarea",
      '[contenteditable="true"][data-lexical-editor="true"]',
      'textarea[data-testid="prompt-textarea"]',
      "textarea",
    ],
    timeout,
    (element) => !element.disabled && !element.getAttribute("aria-disabled")
  );
}

function waitForSendButton(timeout = 10000) {
  return waitForElement(
    [
      '[data-testid="send-button"]',
      'button[aria-label="Send prompt"]',
      'button[aria-label="Send message"]',
      'button[data-testid="fruitjuice-send-button"]',
    ],
    timeout,
    (element) => !element.disabled && element.getAttribute("aria-disabled") !== "true"
  );
}

function waitForElement(selectors, timeout, predicate = () => true) {
  const startedAt = Date.now();
  debugLog("wait_for_element_start", { selectors, timeout });

  return new Promise((resolve, reject) => {
    const interval = setInterval(() => {
      for (const selector of selectors) {
        const element = document.querySelector(selector);
        if (element && predicate(element)) {
          clearInterval(interval);
          debugLog("wait_for_element_found", {
            selectors,
            selector,
            elapsed: Date.now() - startedAt,
            element,
          });
          resolve(element);
          return;
        }
      }

      if (Date.now() - startedAt > timeout) {
        clearInterval(interval);
        debugLog(
          "wait_for_element_timeout",
          { selectors, timeout },
          "error"
        );
        reject(new Error(`Element not found: ${selectors.join(", ")}`));
      }
    }, 150);
  });
}

function startObserving() {
  observationStartTime = Date.now();
  debugLog("observation_start", {
    messageCountAtQuestion,
    assistantTextLength: assistantTextAtQuestion.length,
  });
  observationTimeout = setTimeout(() => {
    if (!hasResponded) {
      debugLog("observation_timeout", {}, "warn");
      notifyAiResponseTimeout();
      resetObservation();
    }
  }, 180000);

  observationInterval = setInterval(() => {
    tryCaptureLatestResponse();
  }, 1000);

  observer = new MutationObserver(() => {
    tryCaptureLatestResponse();
  });

  observer.observe(document.body, {
    childList: true,
    subtree: true,
    characterData: true,
  });
}

function tryCaptureLatestResponse() {
  if (responseInFlight || !observationStartTime) return;

  const messages = document.querySelectorAll(
    '[data-message-author-role="assistant"]'
  );
  if (messages.length <= messageCountAtQuestion) return;

  const latestMessage = messages[messages.length - 1];
  if (isResponseStillGenerating(latestMessage)) return;

  const responseText = repairJsonResponseText(extractJsonText(latestMessage));
  if (responseText) {
    debugLog("response_candidate", {
      responseLength: responseText.length,
      responsePreview: responseText.slice(0, 1200),
    });
  }
  if (
    !responseText ||
    responseText === lastSentResponseText ||
    responseText === assistantTextAtQuestion
  ) {
    return;
  }

  if (responseText !== pendingCandidateText) {
    pendingCandidateText = responseText;
    pendingCandidateSeenAt = Date.now();
    return;
  }

  if (Date.now() - pendingCandidateSeenAt < 600) {
    return;
  }

  try {
    const parsed = JSON.parse(responseText);
    if (parsed.answer !== undefined || parsed.actions || parsed.slots) {
      responseInFlight = true;
      hasResponded = true;
      debugLog("response_json_valid_sending", {
        hasAnswer: parsed.answer !== undefined,
        actionCount: Array.isArray(parsed.actions) ? parsed.actions.length : null,
        slotCount: parsed.slots ? Object.keys(parsed.slots).length : null,
      });
      chrome.runtime
        .sendMessage({
          type: "chatGPTResponse",
          response: responseText,
        })
        .then(() => {
          debugLog("response_sent_to_background");
          lastSentResponseText = responseText;
          resetObservation();
        })
        .catch((error) => {
          responseInFlight = false;
          hasResponded = false;
          debugLog("response_send_error", { error }, "error");
          console.error("Error sending response:", error);
        });
    }
  } catch (error) {
    debugLog("response_json_parse_error", { error }, "warn");
    if (Date.now() - observationStartTime > 30000) {
      const fallback = repairJsonResponseText(
        findJsonObject(latestMessage.textContent.trim())
      );
      if (
        fallback &&
        fallback !== lastSentResponseText &&
        fallback !== assistantTextAtQuestion
      ) {
        responseInFlight = true;
        hasResponded = true;
        debugLog("response_fallback_sending", {
          fallbackLength: fallback.length,
          fallbackPreview: fallback.slice(0, 1200),
        });
        chrome.runtime
          .sendMessage({
            type: "chatGPTResponse",
            response: fallback,
          })
          .then(() => {
            debugLog("response_fallback_sent_to_background");
            lastSentResponseText = fallback;
            resetObservation();
          })
          .catch((sendError) => {
            responseInFlight = false;
            hasResponded = false;
            debugLog("response_fallback_send_error", { sendError }, "error");
            console.error("Error sending fallback response:", sendError);
          });
      }
    }
  }
}

function notifyAiResponseTimeout() {
  try {
    chrome.runtime.sendMessage({
      type: "aiResponseTimeout",
      aiModel: "chatgpt",
      reason: "ChatGPT did not produce a response within 180 seconds.",
    });
  } catch (error) {
    debugLog("observation_timeout_notify_error", { error }, "error");
  }
}

function isResponseStillGenerating(message) {
  return Boolean(
    document.querySelector('[data-testid="stop-button"]') ||
      message.querySelector(".result-streaming") ||
      message.closest('[data-message-author-role="assistant"]')?.querySelector(
        '[aria-label*="Stop"], [data-testid*="stop"]'
      )
  );
}

function getLatestAssistantResponseText() {
  const messages = document.querySelectorAll(
    '[data-message-author-role="assistant"]'
  );
  if (!messages.length) return "";

  const latestMessage = messages[messages.length - 1];
  return repairJsonResponseText(extractJsonText(latestMessage));
}

function extractJsonText(message) {
  const codeBlocks = message.querySelectorAll("pre code");

  for (const block of codeBlocks) {
    const text = sanitizeResponseText(block.textContent);
    if (looksLikeJsonResponse(text)) return text;
  }

  const text = sanitizeResponseText(message.textContent);
  return findJsonObject(text);
}

function sanitizeResponseText(text) {
  return String(text || "")
    .replace(/[\u200B-\u200D\uFEFF]/g, "")
    .trim();
}

function looksLikeJsonResponse(text) {
  return text.startsWith("{") && text.endsWith("}") && /"answer"|"actions"|"slots"/.test(text);
}

function findJsonObject(text) {
  const value = sanitizeResponseText(text);
  if (looksLikeJsonResponse(value)) return value;

  const firstBrace = value.indexOf("{");
  const lastBrace = value.lastIndexOf("}");
  if (firstBrace === -1 || lastBrace === -1 || lastBrace <= firstBrace) {
    return "";
  }

  return value.slice(firstBrace, lastBrace + 1);
}

function repairJsonResponseText(text) {
  return String(text || "")
    .replace(
      /\[data-automcgraw-id="([^"]+)"\]/g,
      "[data-automcgraw-id='$1']"
    )
    .replace(/\[id="([^"]+)"\]/g, "[id='$1']");
}
