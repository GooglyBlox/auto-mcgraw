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

  if (type === "connect_page_snapshot") {
    return buildConnectSnapshotPrompt(questionData, text);
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

function buildConnectSnapshotPrompt(questionData, baseText) {
  const optionSetBuilder = createOptionSetBuilder();
  const controls = Array.isArray(questionData.controls)
    ? questionData.controls.filter(isUsefulConnectControl).map((control) => {
        const optionSetId = optionSetBuilder.get(control.options || []);
        return compactObject({
          id: control.id,
          selector: control.selector,
          label: control.label,
          text: control.text,
          nearbyText: control.nearbyText,
          value: control.value,
          ...(optionSetId ? { optionSetId } : {}),
          context: compactControlContext(control.context),
          frame: control.frame,
        });
      })
    : [];

  const dropdowns = Array.isArray(questionData.dropdowns)
    ? questionData.dropdowns.map((dropdown) => {
        const optionSetId = optionSetBuilder.get(dropdown.options || []);
        return compactObject({
          id: dropdown.id,
          selector: dropdown.selector,
          label: dropdown.label,
          nearbyText: dropdown.nearbyText,
          ...(optionSetId ? { optionSetId } : {}),
          frame: dropdown.frame,
        });
      })
    : [];
  const optionSets = optionSetBuilder.getOptionSets();

  debugLog("build_connect_snapshot_prompt", {
    controlCount: controls.length,
    dropdownCount: dropdowns.length,
    optionSetCount: optionSets.length,
    controlsWithOptions: controls.filter((control) => control.optionSetId)
      .length,
  });

  let text = `${baseText}\n\nInteractive controls:\n${JSON.stringify(
    controls,
    null,
    2
  )}`;

  text += `\n\nDropdown controls/options:\n${JSON.stringify(
    dropdowns,
    null,
    2
  )}`;

  text += `\n\nDropdown option sets:\n${JSON.stringify(
    optionSets,
    null,
    2
  )}`;

  text +=
    '\n\nThis is a non-SmartBook Connect page with an unknown layout. Return JSON with keys "answer", "explanation", and "actions".';
  text +=
    '\n\nReturn only the raw JSON object. Do not include acknowledgements, corrections, markdown fences, or prose outside the JSON.';
  text +=
    '\n\n"actions" must be a non-empty array when answer controls are present. Each action must include "selector", "action", and "intent".';
  text +=
    '\n\nUse only selectors from Interactive controls. Put answer actions first, then submit/next/continue actions if needed.';
  text +=
    '\n\nUse "intent":"answer" for answer controls and "intent":"submit", "intent":"next", or "intent":"continue" for movement/submission controls.';
  text +=
    '\n\nUse "intent":"continue" for controls that only reveal the real answer editor or worksheet, such as Edit journal entry worksheet, View journal entry worksheet, View transaction list, Add, or similar setup controls.';
  text +=
    '\n\nDo not include next or submit actions when the current answer fields are blank or only a setup/editor-opening control is visible.';
  text +=
    '\n\nIMPORTANT: If an embedded worksheet already shows all required values filled correctly and no required blank answer fields remain, treat that sub-question as complete. Your actions MUST NOT click Record entry, Save entry, Save transaction, Save & Next, or any other embedded save/record button again. Choose the next navigation action instead, usually the main-page Next button when no in-tool next/sub-part control is needed.';
  text +=
    "\n\nOnly click an embedded save/record button when you have just added or changed answer values in this same response. When you do click one, make it the final action. The harness will re-snapshot or advance after the save.";
  text +=
    '\n\nIf the embedded tool exposes Required tabs, sub-page steps, or transaction buttons but no visible save button on the current sub-part, click the relevant navigation control as the final action and stop there. The harness will re-snapshot for the next sub-part.';
  text +=
    '\n\nOnly include a main-page Next or final Submit action when there are no unanswered fields left, or the page is already saved and main-page navigation is the only useful action.';
  text +=
    '\n\nUse the top-level Submit button only to submit the entire assignment after the final item is complete. For moving from one item/question to the next, use the main-page Next button, not Submit.';
  text +=
    '\n\nUse "click" for radio/checkbox/button choices, "fill" for text inputs/textareas/contenteditable elements, and "select" with a "value" for native selects, dropdowns, and combobox cells.';
  text +=
    "\n\nFor spreadsheet-style statement tables, selecting the row label is not enough. If an amount belongs on that row, also add a fill action for the blank amount/value cell in the same row, using the selector for that numeric response cell.";
  text +=
    "\n\nFor negative numeric values in spreadsheet, journal, or statement cells, write them in McGraw's accounting format using parentheses (e.g. \"(4,976)\" or \"(4976)\" instead of \"-4976\"). McGraw spreadsheet cells display and store negatives as parentheses, so using parentheses keeps your input format aligned with what the cell will read back.";
  text +=
    "\n\nSpreadsheet controls may include context.rowIndex, context.columnIndex, and context.rowCells. Use that context to keep row labels, debit/credit amounts, and totals in the correct cells.";
  text +=
    "\n\nFor dropdowns, value must be copied exactly from the matching optionSetId in Dropdown option sets. If your natural answer uses a synonym, choose the exact listed option label instead of paraphrasing.";
  text +=
    "\n\nWhen writing a data-automcgraw-id selector, use single quotes inside the selector string, for example \"[data-automcgraw-id='el-13']\".";
  text +=
    '\n\nIf the answer is a table keyed by row letters such as a, b, c, map each row to the matching control selector and include one action per row.';
  text +=
    '\n\nExplanations should be no more than one sentence. DO NOT acknowledge the correction in your response, only answer the new question.';
  text +=
    '\n\nExample action: {"selector":"[data-automcgraw-id=\'el-13\']","action":"select","value":"Double taxation","intent":"answer"}.';

  return text;
}

function isUsefulConnectControl(control) {
  if (!control || control.disabled) return false;
  if (control.frame !== "main") return true;

  const text = normalizeWhitespace(
    `${control.label || ""} ${control.text || ""} ${control.nearbyText || ""}`
  );
  return /\b(next|submit|record|save)\b/i.test(text);
}

function compactControlContext(context) {
  if (!context) return null;
  return compactObject({
    rowIndex: context.rowIndex,
    columnIndex: context.columnIndex,
    label: context.label,
    rowText: context.rowText,
    headerText: context.headerText,
    leftText: context.leftText,
    rightText: context.rightText,
  });
}

function compactObject(value) {
  const result = {};
  Object.entries(value).forEach(([key, nestedValue]) => {
    if (nestedValue == null || nestedValue === "") return;
    if (Array.isArray(nestedValue) && !nestedValue.length) return;
    if (
      typeof nestedValue === "object" &&
      !Array.isArray(nestedValue) &&
      !Object.keys(nestedValue).length
    ) {
      return;
    }
    result[key] = nestedValue;
  });
  return result;
}

function createOptionSetBuilder() {
  const optionSetIds = new Map();
  const optionSets = [];

  return {
    get(options) {
      const values = Array.isArray(options)
        ? options.map((option) => String(option || "").trim()).filter(Boolean)
        : [];
      if (!values.length) return "";

      const key = JSON.stringify(values);
      if (!optionSetIds.has(key)) {
        const id = `options-${optionSets.length + 1}`;
        optionSetIds.set(key, id);
        optionSets.push({ id, options: values });
      }

      return optionSetIds.get(key);
    },

    getOptionSets() {
      return optionSets;
    },
  };
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
    if (parsed.answer !== undefined || parsed.actions) {
      responseInFlight = true;
      hasResponded = true;
      debugLog("response_json_valid_sending", {
        hasAnswer: parsed.answer !== undefined,
        actionCount: Array.isArray(parsed.actions) ? parsed.actions.length : null,
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
  return text.startsWith("{") && text.endsWith("}") && /"answer"|"actions"/.test(text);
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
