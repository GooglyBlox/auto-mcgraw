let messageListener = null;
let isAutomating = false;
let lastIncorrectQuestion = null;
let lastCorrectAnswer = null;
let buttonAdded = false;
let automationIdCounter = 1;
let lastQuestionData = null;
let answeredQuestionNumbers = new Set();
let answeredAssessmentWorkUnitIds = new Set();
let lastAnswerActionAt = 0;
let awaitingAiResponse = false;
let processingAiResponse = false;
let heldMainNextAfterLocalAnswer = false;
const dropdownOptionsCache = new WeakMap();

const AUTOMCGRAW_ID = "data-automcgraw-id";
const MAX_TEXT_LENGTH = 18000;
const MAX_CONTROLS = 120;
const DEBUG_LOG_KEY = "automcgraw.debugLogs.v1";
const DEBUG_MAX_LOGS = 600;
const DEFAULT_AI_MODEL = "chatgpt";

document.documentElement.setAttribute("data-automcgraw-ezto-loaded", "true");
window.__automcgrawDebugLogs = window.__automcgrawDebugLogs || [];

function debugLog(event, details = {}, level = "debug") {
  const entry = {
    ts: new Date().toISOString(),
    side: "connect",
    level,
    event,
    page: getDebugPageState(),
    details: sanitizeDebugValue(details),
  };

  appendDebugEntry(entry);

  // Use console.log for the default level so events show up without having
  // to enable DevTools' Verbose level. Errors and warnings still use the
  // matching console method so they get DevTools' built-in highlighting.
  const consoleMethod =
    level === "error" ? "error" : level === "warn" ? "warn" : "log";
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
    button: document.querySelector(".header__automcgraw--main")?.textContent?.trim() || "",
    progress: document.querySelector(".footer__progress__heading")?.innerText?.trim() || "",
    questionNumber: getCurrentQuestionNumber?.() || null,
    activeAssessmentTab: getActiveAssessmentTabLabel?.() || "",
    diagnostic:
      document.documentElement.getAttribute("data-automcgraw-diagnostic") || "",
    automating: isAutomating,
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
    automcgrawId: element.getAttribute(AUTOMCGRAW_ID) || "",
    text: normalizeWhitespace(
      element.innerText || element.textContent || element.value || ""
    ).slice(0, 500),
    label: element.getAttribute("aria-label") || "",
    visible: isElementVisibleEnough(element),
    disabled: isDisabledControl(element),
  };
}

debugLog("content_script_loaded", {
  topWindow: isTopWindow(),
  href: location.href,
});
setupDebugBridge();

function setupMessageListener() {
  if (messageListener) {
    chrome.runtime.onMessage.removeListener(messageListener);
  }

  messageListener = (message, sender, sendResponse) => {
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

    if (message.type === "processChatGPTResponse") {
      debugLog("process_response_message", {
        responseLength: String(message.response || "").length,
        responsePreview: String(message.response || "").slice(0, 1200),
      });
      processChatGPTResponse(message.response)
        .then(() => {
          debugLog("process_response_message_complete");
          sendResponse({ received: true });
        })
        .catch((error) => {
          debugLog("process_response_message_error", { error }, "error");
          console.error("Error processing ChatGPT response:", error);
          stopAutomation("Error processing AI response: " + error.message);
          sendResponse({ received: false, error: error.message });
        });
      return true;
    }

    if (message.type === "stopAutomation") {
      debugLog("stop_message", { reason: message.reason || "Automation stopped" });
      stopAutomation(message.reason || "Automation stopped");
      sendResponse({ received: true });
      return true;
    }

    if (message.type === "alertMessage") {
      alert(message.message);
      sendResponse({ received: true });
      return true;
    }
  };

  chrome.runtime.onMessage.addListener(messageListener);
}

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
      side: "connect",
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

function isTopWindow() {
  try {
    return window.top === window;
  } catch (error) {
    return true;
  }
}

function isQuizPage() {
  return (
    document.querySelector(".question") &&
    (document.querySelector(".answers-wrap.multiple-choice") ||
      document.querySelector(".answers-wrap.boolean") ||
      document.querySelector(".answers-wrap.input-response"))
  );
}

function isConnectAssignmentPage() {
  return Boolean(
    document.querySelector(".question-wrap") ||
      document.querySelector(".worksheet-wrap") ||
      document.querySelector("iframe[title*='Assessment']") ||
      document.querySelector(".footer__navigation--wrap") ||
      document.querySelector(".header__exits")
  );
}

function checkForQuizAndAddButton() {
  if (!isTopWindow()) return;

  const existingButton = document.querySelector(".header__automcgraw");
  if (existingButton) {
    buttonAdded = true;
    return;
  }

  if (buttonAdded) {
    buttonAdded = false;
  }

  if (isQuizPage() || isConnectAssignmentPage()) {
    debugLog("assistant_button_added", {
      quizPage: isQuizPage(),
      connectAssignmentPage: isConnectAssignmentPage(),
    });
    addAssistantButton();
    buttonAdded = true;
  }
}

function startPageObserver() {
  if (!document.body || !isTopWindow()) return;

  const observer = new MutationObserver(() => {
    checkForQuizAndAddButton();
  });

  observer.observe(document.body, {
    childList: true,
    subtree: true,
  });

  checkForQuizAndAddButton();
}

function checkForQuizEnd() {
  const progressInfo = document.querySelector(".footer__progress__heading");

  if (progressInfo) {
    const progressText = progressInfo.textContent;
    const match = progressText.match(/(\d+)\s+of\s+(\d+)/);
    if (match) {
      const current = parseInt(match[1], 10);
      const total = parseInt(match[2], 10);
      if (current > total) {
        return true;
      }
    }
  }

  return false;
}

function stopAutomation(reason = "Quiz completed") {
  debugLog("automation_stop", {
    reason,
    answeredQuestionNumbers: Array.from(answeredQuestionNumbers),
    answeredAssessmentWorkUnitIds: Array.from(answeredAssessmentWorkUnitIds),
  });
  isAutomating = false;
  awaitingAiResponse = false;
  processingAiResponse = false;

  const btn = document.querySelector(".header__automcgraw--main");
  if (btn) {
    btn.textContent = "Ask AI";
  }

  if (reason) {
    alert(`Automation stopped: ${reason}`);
  }
}

async function checkForNextStep() {
  if (!isAutomating) return;

  debugLog("next_step_start");

  if (awaitingAiResponse || processingAiResponse) {
    debugLog("next_step_waiting_for_response", {
      awaitingAiResponse,
      processingAiResponse,
    });
    return;
  }

  if (isAssignmentSubmittedPage()) {
    debugLog("next_step_already_submitted", {}, "warn");
    stopAutomation("Assignment already submitted");
    return;
  }

  await waitForConnectContentReady();
  // Settle buffer: waitForConnectContentReady only confirms answer-control
  // selectors exist; embedded tools often need extra time to fully render
  // their controls and labels. Without this we sometimes snapshot an empty
  // or partial widget and ship that to the AI, which then "answers" with
  // just a Next click and skips the question.
  if (!isQuizPage()) {
    await delay(1500);
  }

  const questionData = isQuizPage()
    ? parseQuestion()
    : await parseConnectPageSnapshot();

  if (questionData) {
    lastQuestionData = questionData;
    const aiModel = await getSelectedAiModel();
    debugLog("next_step_question_ready", {
      type: questionData.type,
      questionLength: String(questionData.question || "").length,
      controls: questionData.controls?.length || 0,
      dropdowns: questionData.dropdowns?.length || 0,
      activeAssessmentTab: getActiveAssessmentTabLabel(),
      visibleAssessmentTabs: getVisibleAssessmentTabLabels(),
      aiModel,
    });
    awaitingAiResponse = true;
    chrome.runtime.sendMessage(
      {
        type: "sendQuestionToChatGPT",
        question: questionData,
        aiModel,
      },
      (response) => {
        if (chrome.runtime.lastError || !response?.received) {
          awaitingAiResponse = false;
          debugLog(
            "next_step_send_question_failed",
            {
              error: chrome.runtime.lastError?.message || "",
              response,
            },
            "error"
          );
          stopAutomation("Could not send question to the selected AI assistant");
        }
      }
    );
  } else {
    debugLog("next_step_no_question", {}, "warn");
    stopAutomation("No question found or question type not supported");
  }
}

function isAssignmentSubmittedPage() {
  return /you(?:'|’|&rsquo;)re done!\s+you submitted this assignment/i.test(
    document.body?.innerText || ""
  );
}

function getSelectedAiModel() {
  return new Promise((resolve) => {
    try {
      chrome.storage.sync.get("aiModel", (data) => {
        resolve(data?.aiModel || DEFAULT_AI_MODEL);
      });
    } catch (error) {
      debugLog("selected_ai_model_fallback", { error }, "warn");
      resolve(DEFAULT_AI_MODEL);
    }
  });
}

async function waitForConnectContentReady(timeout = 5000) {
  if (isQuizPage()) return;

  debugLog("wait_for_connect_ready_start", { timeout });
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeout) {
    const frames = getAccessibleDocuments();
    const hasAssessmentFrame = frames.some((frame) => frame.frame !== "main");
    const hasAnswerControls = frames.some((frame) => {
      if (frame.frame === "main") return false;
      return Boolean(
        frame.doc.querySelector(
          "td.responseCell, .groupResponse, .dropDownList, input:not([type='hidden']), textarea, select"
        )
      );
    });

    if (!hasAssessmentFrame || hasAnswerControls) {
      debugLog("wait_for_connect_ready_done", {
        elapsed: Date.now() - startedAt,
        hasAssessmentFrame,
        hasAnswerControls,
      });
      return;
    }
    await delay(250);
  }

  debugLog("wait_for_connect_ready_timeout", { timeout }, "warn");
}

function parseQuestion() {
  const questionElement = document.querySelector(".question");
  if (!questionElement) {
    return null;
  }

  let questionType = "";
  let options = [];

  if (document.querySelector(".answers-wrap.multiple-choice")) {
    questionType = "multiple_choice";
    const optionElements = document.querySelectorAll(
      ".answers--mc .answer__label--mc"
    );
    options = Array.from(optionElements).map((el) => {
      const textContent = el.textContent.trim();
      return textContent.replace(/^[a-z]\s+/, "");
    });
  } else if (document.querySelector(".answers-wrap.boolean")) {
    questionType = "true_false";
    options = ["True", "False"];
  } else if (document.querySelector(".answers-wrap.input-response")) {
    questionType = "fill_in_the_blank";
    options = [];
  } else {
    return null;
  }

  let questionText = "";
  if (questionType === "fill_in_the_blank") {
    const questionClone = questionElement.cloneNode(true);

    const blankSpans = questionClone.querySelectorAll(
      'span[aria-hidden="true"]'
    );
    blankSpans.forEach((span) => {
      if (span.textContent.includes("_")) {
        span.textContent = "[BLANK]";
      }
    });

    const hiddenSpans = questionClone.querySelectorAll(
      'span[style*="position: absolute"]'
    );
    hiddenSpans.forEach((span) => span.remove());

    questionText = normalizeWhitespace(questionClone.textContent);
  } else {
    questionText = normalizeWhitespace(questionElement.textContent);
  }

  return {
    type: questionType,
    question: questionText,
    options,
    previousCorrection: getPreviousCorrection(),
  };
}

async function parseConnectPageSnapshot() {
  const frames = getAccessibleDocuments();
  const controls = [];
  const dropdowns = [];
  const pageSections = [];

  frames.forEach((frame) => prepareDocumentForSnapshot(frame.doc));

  debugLog("snapshot_start", {
    frameCount: frames.length,
    frames: frames.map((frame) => ({
      label: frame.label,
      frame: frame.frame,
      textLength: frame.doc.body?.innerText?.length || 0,
    })),
  });

  for (const frame of frames) {
    const text = extractVisibleText(frame.doc);
    if (text) {
      pageSections.push(`${frame.label}:\n${text}`);
    }

    const elements = getInteractiveElements(frame.doc);
    for (const element of elements) {
      if (controls.length >= MAX_CONTROLS) break;

      const control = await describeControl(element, frame);
      if (!control) continue;

      controls.push(control);
      if (isDropdownLike(element) || control.options.length) {
        dropdowns.push({
          id: control.id,
          selector: control.selector,
          label: control.label,
          nearbyText: control.nearbyText,
          options: control.options,
          frame: control.frame,
        });
      }
    }
  }

  const pageText = limitText(pageSections.join("\n\n"), MAX_TEXT_LENGTH);
  if (!pageText && !controls.length) return null;

  debugLog("snapshot_complete", {
    pageTextLength: pageText.length,
    controls: controls.length,
    dropdowns: dropdowns.length,
    controlSummary: controls.slice(0, 40).map((control) => ({
      id: control.id,
      selector: control.selector,
      type: control.type,
      label: control.label,
      text: control.text,
      options: control.options?.length || 0,
      frame: control.frame,
      context: control.context
        ? {
            rowIndex: control.context.rowIndex,
            columnIndex: control.context.columnIndex,
            label: control.context.label,
            rowText: control.context.rowText,
          }
        : null,
    })),
  });

  return {
    type: "connect_page_snapshot",
    question: pageText,
    pageText,
    controls,
    dropdowns,
    previousCorrection: getPreviousCorrection(),
  };
}

function getPreviousCorrection() {
  return lastIncorrectQuestion
    ? {
        question: lastIncorrectQuestion,
        correctAnswer: lastCorrectAnswer,
      }
    : null;
}

function getAccessibleDocuments() {
  const docs = [
    {
      doc: document,
      label: "Main page",
      frame: "main",
    },
  ];

  document.querySelectorAll("iframe").forEach((iframe, index) => {
    try {
      if (iframe.contentDocument && iframe.contentDocument.body) {
        docs.push({
          doc: iframe.contentDocument,
          label:
            `FRAME ${index}: ` +
            (iframe.getAttribute("title") || iframe.name || iframe.id || "iframe"),
          frame: index,
        });
      }
    } catch (error) {
      docs.push({
        doc: null,
        label:
          `FRAME ${index}: ` +
          (iframe.getAttribute("title") || iframe.name || iframe.id || "iframe") +
          " (cross-origin, content unavailable)",
        frame: index,
      });
    }
  });

  return docs.filter((entry) => entry.doc && entry.doc.body);
}

function getInteractiveElements(doc) {
  const selector = [
    "button",
    "a[href]",
    "input:not([type='hidden'])",
    "textarea",
    "select",
    "[contenteditable='true']",
    "[role='button']",
    "[role='checkbox']",
    "[role='radio']",
    "[role='combobox']",
    ".dropDownList",
    ".responseCell",
    ".groupResponse",
    ".responseCell[tabindex]",
  ].join(",");

  const seen = new Set();
  const seenControlKeys = new Set();
  return Array.from(doc.querySelectorAll(selector)).filter((element) => {
    if (seen.has(element)) return false;
    seen.add(element);
    if (element.closest(".header__automcgraw")) return false;
    if (isCheckMyWorkControl(element)) return false;
    if (isAccountingNavigationControl(element)) return false;
    if (isStaleAccountingClone(element)) return false;
    if (!isElementVisibleEnough(element)) return false;
    const duplicateKey = getDuplicateControlKey(element);
    if (duplicateKey) {
      if (seenControlKeys.has(duplicateKey)) return false;
      seenControlKeys.add(duplicateKey);
    }
    if (isDisabledControl(element)) return false;
    if (element.matches("a[href]") && !normalizeWhitespace(element.textContent)) {
      return false;
    }
    return true;
  });
}

function getDuplicateControlKey(element) {
  if (isAnswerCell(element)) return "";

  const tagName = element.tagName.toLowerCase();
  const role = element.getAttribute("role") || "";
  const type = element.getAttribute("type") || "";
  const isClickableControl =
    tagName === "button" ||
    tagName === "a" ||
    role === "button" ||
    ["button", "submit"].includes(type);

  if (!isClickableControl && !element.classList.contains("transactionButton")) {
    return "";
  }

  const text = normalizeWhitespace(
    element.value ||
      element.innerText ||
      element.textContent ||
      element.getAttribute("aria-label") ||
      ""
  );
  const label = normalizeWhitespace(element.getAttribute("aria-label") || "");
  const classes = normalizeWhitespace(String(element.className || ""));

  if (!element.id && !text && !label) return "";
  return `${tagName}|${element.id}|${type}|${role}|${text}|${label}|${classes}`;
}

function isAnswerCell(element) {
  return (
    element.tagName?.toLowerCase() === "td" &&
    (element.classList.contains("responseCell") ||
      element.classList.contains("groupResponse") ||
      element.classList.contains("dropDownList"))
  );
}

function getSpreadsheetCellContext(element) {
  const row = element.closest("tr");
  if (!row || !element.closest("table")) return null;

  const rowIndex = Array.from(row.parentElement?.children || []).indexOf(row);
  const columnIndex = Array.from(row.children).indexOf(element);
  const rowCells = Array.from(row.children)
    .filter((cell) => isElementVisibleEnough(cell))
    .map((cell) => ({
      columnIndex: Array.from(row.children).indexOf(cell),
      selector: buildStableSelector(cell, ensureAutomationId(cell)),
      text: normalizeWhitespace(cell.innerText || cell.textContent || ""),
      isAnswer: isAnswerCell(cell),
      isDropdown: isDropdownLike(cell),
      classes: normalizeWhitespace(String(cell.className || "")),
    }));
  const headerText = getHeaderTextForCell(element);
  const leftCell = row.children[columnIndex - 1];
  const rightCell = row.children[columnIndex + 1];
  const leftText = normalizeWhitespace(
    leftCell?.innerText || leftCell?.textContent || ""
  );
  const rightText = normalizeWhitespace(
    rightCell?.innerText || rightCell?.textContent || ""
  );
  const rowText = normalizeWhitespace(row.innerText || row.textContent || "");

  return {
    rowIndex,
    columnIndex,
    label: buildSpreadsheetCellLabel(
      element,
      rowIndex,
      columnIndex,
      leftCell,
      headerText
    ),
    rowText,
    headerText,
    leftText,
    rightText,
    rowCells,
  };
}

function buildSpreadsheetCellLabel(
  element,
  rowIndex,
  columnIndex,
  leftCell,
  headerText
) {
  const isBlankNumericCell =
    isSpreadsheetFillCell(element) &&
    !normalizeWhitespace(element.innerText || element.textContent || "");
  const leftText = normalizeWhitespace(
    leftCell?.innerText || leftCell?.textContent || ""
  );
  const leftSelector = leftCell
    ? buildStableSelector(leftCell, ensureAutomationId(leftCell))
    : "";

  if (isBlankNumericCell && leftCell) {
    return normalizeWhitespace(
      `Amount/value cell in worksheet row ${rowIndex + 1}, column ${
        columnIndex + 1
      }, immediately right of ${
        leftText || `selectable label cell ${leftSelector}`
      }`
    );
  }

  return normalizeWhitespace(
    [
      `Worksheet cell row ${rowIndex + 1}, column ${columnIndex + 1}`,
      headerText && `headers: ${headerText}`,
    ]
      .filter(Boolean)
      .join(", ")
  );
}

function getHeaderTextForCell(element) {
  const doc = element.ownerDocument;
  const headerIds = normalizeWhitespace(element.getAttribute("headers") || "")
    .split(/\s+/)
    .filter(Boolean);

  return normalizeWhitespace(
    headerIds
      .map((id) => doc.getElementById(id))
      .filter(Boolean)
      .map((header) => header.innerText || header.textContent || "")
      .join(" ")
  );
}

async function describeControl(element, frame) {
  const id = ensureAutomationId(element);
  const options = await getOptionsForControl(element, frame.doc);
  const text = normalizeWhitespace(element.innerText || element.textContent || "");
  const cellContext = isAnswerCell(element)
    ? getSpreadsheetCellContext(element)
    : null;
  const nearbyText = getNearbyText(element) || cellContext?.rowText || "";
  const rawLabel = getElementLabel(element);
  const label =
    isAnswerCell(element) && getLeadingAnswerKey(nearbyText)
      ? nearbyText
      : rawLabel || cellContext?.label || "";
  const tagName = element.tagName.toLowerCase();

  if (!label && !text && !nearbyText && !options.length && !cellContext) {
    return null;
  }

  return {
    id,
    selector: buildStableSelector(element, id),
    tagName,
    type: element.getAttribute("type") || element.getAttribute("role") || "",
    label,
    text,
    nearbyText,
    value: getElementValue(element),
    checked: Boolean(element.checked),
    disabled:
      Boolean(element.disabled) ||
      element.getAttribute("aria-disabled") === "true" ||
      element.classList.contains("is-disabled"),
    options,
    context: cellContext,
    frame: frame.frame,
    frameLabel: frame.label,
  };
}

function buildStableSelector(element, automationId) {
  if (
    element.id &&
    element.ownerDocument.querySelectorAll(
      attributeSelector("id", element.id)
    ).length === 1
  ) {
    return attributeSelector("id", element.id);
  }

  return attributeSelector(AUTOMCGRAW_ID, automationId);
}

function ensureAutomationId(element) {
  let id = element.getAttribute(AUTOMCGRAW_ID);
  if (!id) {
    id = `el-${automationIdCounter++}`;
    element.setAttribute(AUTOMCGRAW_ID, id);
  }
  return id;
}

async function getOptionsForControl(element, doc) {
  if (element.tagName.toLowerCase() === "select") {
    const nativeOptions = uniqueStrings(
      Array.from(element.options)
        .map((option) => normalizeWhitespace(option.textContent))
        .filter(Boolean)
    );
    debugLog("dropdown_options_native", {
      element,
      options: nativeOptions,
    });
    return nativeOptions;
  }

  if (!isDropdownLike(element)) return [];

  let options = [];
  const cacheKey = getDropdownOptionCacheKey(element);
  const cachedOptions = getExactCachedDropdownOptions(doc, cacheKey);
  if (cachedOptions.length) {
    debugLog("dropdown_options_cache_hit", {
      element,
      cacheKey,
      optionCount: cachedOptions.length,
      options: cachedOptions,
    });
    return cachedOptions;
  }

  try {
    debugLog("dropdown_options_open_start", { element, cacheKey });
    element.scrollIntoView({ block: "center", inline: "center" });
    dispatchMouseSequence(element);
    await delay(250);
    options = readDropdownOptions(element, doc);
  } catch (error) {
    console.warn("Could not open dropdown while reading options:", error);
  } finally {
    closeDropdownOverlays(doc);
  }

  if (options.length) {
    setCachedDropdownOptions(doc, cacheKey, options);
    debugLog("dropdown_options_open_success", {
      element,
      cacheKey,
      optionCount: options.length,
      options,
    });
    return options;
  }

  options = readDropdownOptions(element, doc);
  if (options.length) {
    setCachedDropdownOptions(doc, cacheKey, options);
    debugLog("dropdown_options_read_success", {
      element,
      cacheKey,
      optionCount: options.length,
      options,
    });
    return options;
  }

  const fallbackOptions = getCachedDropdownOptions(doc, cacheKey);
  debugLog("dropdown_options_cache", {
    element,
    cacheKey,
    optionCount: fallbackOptions.length,
    options: fallbackOptions,
  });
  return fallbackOptions;
}

function getDropdownOptionCacheKey(element) {
  return [
    element.getAttribute("dropdownid") || "",
    element.getAttribute("dropdowntype") || "",
    element.getAttribute("aria-controls") || "",
    element.closest("table")?.id || "",
  ].join("|");
}

function getCachedDropdownOptions(doc, key) {
  const docCache = dropdownOptionsCache.get(doc);
  return docCache?.get(key) || docCache?.get("__last__") || [];
}

function getExactCachedDropdownOptions(doc, key) {
  const docCache = dropdownOptionsCache.get(doc);
  return docCache?.get(key) || [];
}

function setCachedDropdownOptions(doc, key, options) {
  let docCache = dropdownOptionsCache.get(doc);
  if (!docCache) {
    docCache = new Map();
    dropdownOptionsCache.set(doc, docCache);
  }

  const values = uniqueStrings(options);
  docCache.set(key, values);
  docCache.set("__last__", values);
}

function readDropdownOptions(element, doc) {
  const optionTexts = [];
  const controlsId = element.getAttribute("aria-controls");
  const listRoots = [];

  if (controlsId) {
    const controlled = doc.getElementById(controlsId);
    if (controlled) listRoots.push(controlled);
  }

  doc.querySelectorAll(".listContainer, [role='listbox']").forEach((root) => {
    listRoots.push(root);
  });

  for (const root of listRoots) {
    const options = root.querySelectorAll(
      "[role='option'], li, option, .list_content"
    );
    options.forEach((option) => {
      const text = normalizeWhitespace(option.innerText || option.textContent || "");
      if (text) optionTexts.push(text);
    });
  }

  return uniqueStrings(optionTexts);
}

function closeDropdownOverlays(doc) {
  const win = doc.defaultView || window;
  const targets = [doc.activeElement, doc.body, doc.documentElement, doc]
    .filter(Boolean);

  targets.forEach((target) => {
    ["keydown", "keyup"].forEach((type) => {
      target.dispatchEvent(
        new win.KeyboardEvent(type, {
          key: "Escape",
          code: "Escape",
          keyCode: 27,
          which: 27,
          bubbles: true,
          cancelable: true,
        })
      );
    });
  });

  doc.activeElement?.blur?.();
}

function prepareDocumentForSnapshot(doc) {
  if (!doc?.body) return;

  closeDropdownOverlays(doc);
  normalizeAllSpreadsheetCellClasses(doc);
  repairDuplicatedAccountingChrome(doc);
}

function normalizeAllSpreadsheetCellClasses(doc) {
  doc.querySelectorAll("td.responseCell, td.groupResponse, td.dropDownList")
    .forEach((cell) => normalizeSpreadsheetCellClasses(cell));
}

function repairDuplicatedAccountingChrome(doc) {
  const workspace = doc.querySelector("#workspace");
  if (!workspace || !doc.querySelector("#transactionDetails")) return;

  const repairedGroups = [];
  repairedGroups.push(
    ...hideDuplicateVisibleElements(
      Array.from(workspace.querySelectorAll("#transactionDetails > .clearfix"))
        .filter((element) => element.querySelector("#transactionHeader")),
      scoreTransactionHeaderBlock
    )
  );
  repairedGroups.push(
    ...hideDuplicateVisibleElements(
      Array.from(
        workspace.querySelectorAll(
          "#transactionDetails > .accountingtool_navigationcarousel"
        )
      ),
      scoreTransactionCarousel
    )
  );
  repairedGroups.push(
    ...hideDuplicateVisibleElements(
      Array.from(workspace.querySelectorAll("#transactionDetails > div"))
        .filter((element) =>
          /enter debits before credits/i.test(
            element.innerText || element.textContent || ""
          )
        ),
      () => 1
    )
  );
  repairedGroups.push(
    ...hideDuplicateVisibleElements(
      Array.from(workspace.querySelectorAll(":scope > #trans_button_wrpr")),
      scoreTransactionButtonWrapper
    )
  );
  repairedGroups.push(
    ...hideDuplicateVisibleElements(
      Array.from(workspace.querySelectorAll(":scope > #clearTransactionDialog")),
      () => 1
    )
  );

  if (repairedGroups.length) {
    debugLog("accounting_duplicate_chrome_repaired", {
      hiddenCount: repairedGroups.length,
      hidden: repairedGroups.map((element) => describeElementForDebug(element)),
    });
  }
}

function hideDuplicateVisibleElements(elements, scoreElement) {
  const visibleElements = elements.filter((element) =>
    isElementVisibleEnough(element)
  );
  if (visibleElements.length <= 1) return [];

  const keep = visibleElements
    .map((element, index) => ({ element, index, score: scoreElement(element) }))
    .sort((a, b) => b.score - a.score || a.index - b.index)[0].element;
  const hidden = [];

  visibleElements.forEach((element) => {
    if (element === keep) return;
    element.setAttribute("data-automcgraw-hidden-duplicate", "true");
    element.style.display = "none";
    hidden.push(element);
  });

  return hidden;
}

function scoreTransactionHeaderBlock(element) {
  const text = normalizeWhitespace(element.innerText || element.textContent || "");
  let score = 1;
  if (/journal entry worksheet/i.test(text)) score += 2;
  if (/transaction index/i.test(text)) score += 1;
  return score;
}

function scoreTransactionCarousel(element) {
  const text = normalizeWhitespace(element.innerText || element.textContent || "");
  const ariaText = Array.from(element.querySelectorAll("[aria-label]"))
    .map((control) => control.getAttribute("aria-label") || "")
    .join(" ");
  let score = 1;
  if (/[A-Za-z]{4,}/.test(text)) score += 4;
  if (/\bnot yet entered\b/i.test(ariaText)) score += 3;
  if (/\bentry entered\b/i.test(ariaText)) score += 1;
  if (/^\.*$/.test(text)) score -= 4;
  return score;
}

function scoreTransactionButtonWrapper(element) {
  const text = normalizeWhitespace(element.innerText || element.textContent || "");
  let score = 1;
  if (/\brecord entry\b/i.test(text)) score += 3;
  if (/\bview general journal\b/i.test(text)) score += 1;
  return score;
}

function isDropdownLike(element) {
  const tagName = element.tagName.toLowerCase();
  return (
    tagName === "select" ||
    element.getAttribute("role") === "combobox" ||
    element.classList.contains("dropDownList") ||
    element.getAttribute("dropdowntype") ||
    element.getAttribute("aria-haspopup") === "listbox"
  );
}

function isCheckMyWorkControl(element) {
  const text = getControlText(element);
  return (
    element.classList.contains("button--check-my-work") ||
    /\bcheck my work\b/i.test(text)
  );
}

function isAccountingNavigationControl(element) {
  if (!element?.closest) return false;
  const carousel = element.closest(".accountingtool_navigationcarousel");
  if (!carousel) return false;

  const text = getControlText(element, { preferAriaLabel: true });
  return (
    element.matches("[role='tab'], input[type='button'], button, [role='button']") ||
    /\bmove to (previous|next) transaction\b/i.test(text) ||
    /\btransaction number\b/i.test(text) ||
    /^\d+$/.test(text)
  );
}

function getControlText(element, options = {}) {
  const ariaLabel = element?.getAttribute?.("aria-label") || "";
  return normalizeWhitespace(
    options.preferAriaLabel
      ? ariaLabel ||
          element.value ||
          element.innerText ||
          element.textContent ||
          ""
      : element.value ||
          element.innerText ||
          element.textContent ||
          ariaLabel ||
          ""
  );
}

async function processChatGPTResponse(responseText) {
  if (!isAutomating) {
    setAutomationDiagnostic("ignored_response_not_automating");
    debugLog("response_ignored_not_automating", {
      responseLength: String(responseText || "").length,
    });
    return;
  }

  awaitingAiResponse = false;
  processingAiResponse = true;
  setAutomationDiagnostic("processing_response");
  try {
    debugLog("response_processing_start", {
      responseLength: String(responseText || "").length,
      responsePreview: String(responseText || "").slice(0, 1500),
    });
    const response = parseJsonResponse(responseText);
    if (!response || typeof response !== "object") {
      throw new Error("AI response was not a JSON object");
    }
    const answer = response.answer;
    let actions = sanitizeActions(normalizeActions(response.actions));
    debugLog("response_parsed", {
      answer,
      rawActionCount: Array.isArray(response.actions) ? response.actions.length : 0,
      actionCountAfterSanitize: actions.length,
      actions,
    });
    actions = trimActionsAfterInToolSubmit(actions);
    debugLog("response_actions_trimmed", {
      actionCountAfterTrim: actions.length,
      actions,
    });
    actions = expandWorksheetValueActions(actions, answer);
    debugLog("response_actions_expanded", {
      actionCountAfterExpand: actions.length,
      actions,
    });
    const mainNextSafety = holdMainNextAfterLocalAnswer(actions);
    actions = mainNextSafety.actions;
    heldMainNextAfterLocalAnswer = mainNextSafety.held;
    debugLog("response_actions_local_next_safe", {
      heldMainNextAfterLocalAnswer,
      actionCountAfterLocalNextSafety: actions.length,
      actions,
    });

    console.log(
      "[AutoMcGraw][AI-RESPONSE]",
      `progress=${getProgress()?.current || "?"}/${
        getProgress()?.total || "?"
      }`,
      `activeTab="${getActiveAssessmentTabLabel() || ""}"`,
      `heldMainNext=${heldMainNextAfterLocalAnswer}`,
      "actions=",
      actions.map((action) => ({
        intent: action.intent,
        action: action.action,
        selector: action.selector,
        value: action.value,
        frame: getActionFrame(action),
        controlText:
          findLastControlForAction(action)?.text ||
          findLastControlForAction(action)?.label ||
          "",
      }))
    );

    if (actions.length) {
      try {
        await executeActionsWithPreSubmitRepair(actions, answer);
      } catch (error) {
        setAutomationDiagnostic(`action_error:${error.message}`);
        debugLog("response_actions_execute_error", {
          error,
          completedActions: error.completedActions || [],
          actions,
        }, "error");
        if (
          error.completedActions?.some((action) => isAnswerAction(action)) ||
          actions.some((action) => isAnswerAction(action))
        ) {
          throw error;
        }

        const fallbackActions = expandWorksheetValueActions(
          buildActionsFromAnswer(answer),
          answer
        );
        debugLog("response_actions_fallback", { fallbackActions }, "warn");
        if (!fallbackActions.length) throw error;
        await executeActionsWithPreSubmitRepair(fallbackActions, answer);
      }
      debugLog("response_processing_complete", { actions });
      await continueAfterResponse(actions);
      return;
    }

    if (lastQuestionData && lastQuestionData.type === "connect_page_snapshot") {
      const fallbackActions = expandWorksheetValueActions(
        buildActionsFromAnswer(answer),
        answer
      );
      if (fallbackActions.length) {
        debugLog("response_no_actions_using_fallback", { fallbackActions }, "warn");
        await executeActionsWithPreSubmitRepair(fallbackActions, answer);
        await continueAfterResponse(fallbackActions);
        return;
      }
      debugLog("response_no_executable_actions", { answer }, "error");
      throw new Error("AI response did not include executable actions");
    }

    let legacyAnswerHandled = false;
    if (document.querySelector(".answers-wrap.multiple-choice")) {
      legacyAnswerHandled = handleMultipleChoiceAnswer(answer);
    } else if (document.querySelector(".answers-wrap.boolean")) {
      legacyAnswerHandled = handleTrueFalseAnswer(answer);
    } else if (document.querySelector(".answers-wrap.input-response")) {
      legacyAnswerHandled = await handleFillInTheBlankAnswer(answer);
    }

    if (!legacyAnswerHandled) {
      throw new Error("Could not apply AI answer to the current question");
    }
    markCurrentQuestionAnswered();

    await continueAfterResponse([]);
  } finally {
    processingAiResponse = false;
  }
}

async function executeActionsWithPreSubmitRepair(actions, answer) {
  const submitIndex = actions.findIndex((action) => isInToolSubmitAction(action));
  if (submitIndex === -1) {
    await executeActions(actions);
    await repairWorksheetLabelCells(actions, answer);
    return;
  }

  const answerActions = actions.slice(0, submitIndex);
  const submitActions = actions.slice(submitIndex);
  debugLog("execute_actions_split_submit", {
    answerActionCount: answerActions.length,
    submitActionCount: submitActions.length,
    submitActions,
  });

  if (answerActions.length) {
    await executeActions(answerActions);
    await repairWorksheetLabelCells(answerActions, answer);
  }

  await executeActions(submitActions);
}

function parseJsonResponse(responseText) {
  if (typeof responseText !== "string") return responseText;
  const repairedText = repairJsonResponseText(responseText);

  try {
    return JSON.parse(repairedText);
  } catch (error) {
    const jsonMatch = repairedText.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      return JSON.parse(jsonMatch[0]);
    }
    throw error;
  }
}

function repairJsonResponseText(text) {
  return String(text || "").replace(
    /\[data-automcgraw-id="([^"]+)"\]/g,
    "[data-automcgraw-id='$1']"
  ).replace(
    /\[id="([^"]+)"\]/g,
    "[id='$1']"
  );
}

function normalizeActions(actions) {
  if (!Array.isArray(actions)) return [];

  return actions
    .filter((action) => action && action.selector && action.action)
    .map((action) => ({
      selector: action.selector,
      action: String(action.action).toLowerCase(),
      value: action.value,
      intent: action.intent || "answer",
    }));
}

function sanitizeActions(actions) {
  return actions.flatMap((action) => {
    const control = findLastControlForAction(action);
    const target = control ? null : findElementDeep(action.selector);
    if (target && isAccountingNavigationControl(target)) return [];
    if (!control) return [action];

    const text = `${control.label || ""} ${control.text || ""} ${
      control.nearbyText || ""
    }`;
    if (/\bcheck my work\b/i.test(text)) return [];

    if (isTopLevelAssignmentSubmitControl(control)) {
      if (canAutoSubmitAssignment()) return [action];

      const nextAction = buildMainNextAction();
      debugLog(
        "sanitize_premature_submit_replaced",
        { action, replacement: nextAction, submitState: getAutoSubmitDebugState() },
        "warn"
      );
      return nextAction ? [nextAction] : [];
    }

    return [action];
  });
}

function trimActionsAfterInToolSubmit(actions) {
  const submitIndex = actions.findIndex((action) =>
    isInToolSubmitAction(action)
  );
  if (submitIndex === -1) return actions;

  return actions.slice(0, submitIndex + 1);
}

function isTopLevelAssignmentSubmitControl(control) {
  if (!control || control.frame !== "main") return false;

  const text = normalizeWhitespace(
    `${control.label || ""} ${control.text || ""} ${
      control.value || ""
    }`
  );
  if (!/\bsubmit\b/i.test(text)) return false;

  const target = findElementDeep(control.selector);
  return Boolean(
    target?.classList?.contains("header__exit--submit") ||
      target?.closest?.(".header__exits")
  );
}

function buildMainNextAction() {
  if (!lastQuestionData || !Array.isArray(lastQuestionData.controls)) return null;

  const nextControl = lastQuestionData.controls.find((control) => {
    if (control.frame !== "main") return false;
    const text = normalizeWhitespace(
      `${control.label || ""} ${control.text || ""} ${control.value || ""}`
    );
    return /\bnext\b/i.test(text);
  });

  return nextControl
    ? {
        selector: nextControl.selector,
        action: "click",
        intent: "next",
      }
    : null;
}

function holdMainNextAfterLocalAnswer(actions) {
  const hasLocalAnswer = actions.some(
    (action) => isAnswerAction(action) && getActionFrame(action) !== "main"
  );
  const hasMainNext = actions.some((action) => isMainNextAction(action));
  if (!hasLocalAnswer || !hasMainNext) {
    return { actions, held: false };
  }

  const filteredActions = actions.filter((action) => !isMainNextAction(action));
  debugLog(
    "main_next_held_after_local_answer",
    { actions, filteredActions },
    "warn"
  );
  return { actions: filteredActions, held: true };
}

function isMainNextAction(action) {
  if (action.intent !== "next" && !isMovementAction(action)) return false;

  const control = findLastControlForAction(action);
  if (!control || control.frame !== "main") return false;

  const text = `${control.label || ""} ${control.text || ""} ${
    control.nearbyText || ""
  }`;
  return /\bnext\b/i.test(text);
}

function getActionFrame(action) {
  const control = findLastControlForAction(action);
  if (control) return control.frame;
  const target = findElementDeep(action.selector);
  return target?.ownerDocument === document ? "main" : "embedded";
}

function isInToolSubmitAction(action) {
  if (
    action.action !== "click" &&
    !["submit", "continue"].includes(action.intent)
  ) {
    return false;
  }

  const control = findLastControlForAction(action);
  if (!control) return false;
  if (control.frame === "main") return false;

  // Trust the AI's intent annotation: any iframe action it labelled as a
  // movement is treated as an in-tool save and trims everything after it.
  // This is what blocks queued main-page Next actions from firing on the
  // next sub-question after the embedded tool auto-advanced.
  if (["submit", "continue"].includes(action.intent)) return true;

  const text = `${control.label || ""} ${control.text || ""} ${
    control.nearbyText || ""
  }`;
  return /\b(record entry|save entry|save transaction)\b/i.test(text);
}

function expandWorksheetValueActions(actions, answer) {
  if (!answer || typeof answer !== "object" || Array.isArray(answer)) {
    return actions;
  }

  const expanded = [];
  const existingSelectors = new Set(actions.map((action) => action.selector));

  actions.forEach((action) => {
    expanded.push(action);

    if (
      action.intent !== "answer" ||
      action.action !== "select" ||
      action.value == null
    ) {
      return;
    }

    const pairedValue = findAnswerValueForLabel(answer, action.value);
    if (pairedValue == null || String(pairedValue).trim() === "") return;

    const labelCell = findElementDeep(action.selector);
    if (!labelCell || !isAnswerCell(labelCell)) return;

    const amountCell = findPairedAmountCell(labelCell);
    if (!amountCell) return;

    const selector = buildStableSelector(
      amountCell,
      ensureAutomationId(amountCell)
    );
    if (existingSelectors.has(selector)) return;

    expanded.push({
      selector,
      action: "fill",
      value: pairedValue,
      intent: "answer",
    });
    existingSelectors.add(selector);
  });

  return expanded;
}

function findAnswerValueForLabel(answer, label) {
  const target = normalizeComparable(label);
  const entry = Object.entries(answer).find(
    ([key]) => normalizeComparable(key) === target
  );
  if (entry) return entry[1];

  const fuzzyEntry = Object.entries(answer).find(([key]) => {
    const keyText = normalizeComparable(key);
    return (
      keyText &&
      target &&
      (keyText.includes(target) || target.includes(keyText))
    );
  });
  return fuzzyEntry ? fuzzyEntry[1] : null;
}

function findPairedAmountCell(labelCell) {
  const row = labelCell.closest("tr");
  if (!row) return null;

  const cells = Array.from(row.children);
  const labelIndex = cells.indexOf(labelCell);
  return cells
    .slice(labelIndex + 1)
    .find(
      (cell) =>
        isSpreadsheetFillCell(cell) &&
        !isDropdownLike(cell) &&
        isElementVisibleEnough(cell)
    );
}

async function repairWorksheetLabelCells(actions, answer) {
  if (!answer || typeof answer !== "object" || Array.isArray(answer)) return;

  const usedLabels = new Set();
  debugLog("worksheet_label_repair_start", {
    actionCount: actions.length,
    answerKeys: Object.keys(answer),
  });

  for (const action of actions) {
    if (
      action.intent !== "answer" ||
      action.action !== "fill" ||
      action.value == null
    ) {
      continue;
    }

    const valueCell = findElementDeep(action.selector);
    if (!valueCell || !isSpreadsheetFillCell(valueCell)) continue;

    const labelCell = findPairedLabelCell(valueCell);
    if (!labelCell || !isDropdownLike(labelCell)) continue;

    const actionLabel = findActionLabelForValueCell(actions, valueCell);
    const label =
      actionLabel ||
      (hasSpecificWorksheetAnswerLabels(answer)
        ? findAnswerLabelForValue(answer, action.value, usedLabels)
        : null);
    if (!label || dropdownSelectionMatches(labelCell, label)) continue;

    debugLog("worksheet_label_repair_select", {
      valueAction: action,
      labelCell,
      label,
      pairedValue: action.value,
    });
    setAutomationDiagnostic(
      `repair:select:${buildStableSelector(
        labelCell,
        ensureAutomationId(labelCell)
      )}:${label}`
    );
    await selectElementValue(labelCell, label);
    usedLabels.add(normalizeComparable(label));
  }

  debugLog("worksheet_label_repair_complete", {
    repairedCount: usedLabels.size,
    repairedLabels: Array.from(usedLabels),
  });
}

function hasSpecificWorksheetAnswerLabels(answer) {
  return Object.keys(answer || {}).some((key) => {
    const normalized = normalizeComparable(key);
    return (
      normalized &&
      ![
        "answer",
        "debit",
        "debits",
        "credit",
        "credits",
        "explanation",
        "journal entry",
        "entry",
      ].includes(normalized)
    );
  });
}

function findActionLabelForValueCell(actions, valueCell) {
  const match = actions.find((action) => {
    if (action.action !== "select" || action.value == null) return false;
    const labelCell = findElementDeep(action.selector);
    return labelCell && findPairedAmountCell(labelCell) === valueCell;
  });
  return match?.value || null;
}

function findPairedLabelCell(valueCell) {
  const row = valueCell.closest("tr");
  if (!row) return null;

  const cells = Array.from(row.children);
  const valueIndex = cells.indexOf(valueCell);
  for (let index = valueIndex - 1; index >= 0; index--) {
    const cell = cells[index];
    if (isAnswerCell(cell) && isElementVisibleEnough(cell)) {
      return cell;
    }
  }
  return null;
}

function findAnswerLabelForValue(answer, value, usedLabels) {
  const targetNumber = normalizeNumberText(value);
  const targetText = normalizeComparable(value);

  const entries = Object.entries(answer).filter(([key]) => {
    const normalizedKey = normalizeComparable(key);
    return normalizedKey && !usedLabels.has(normalizedKey);
  });

  const match = entries.find(([, answerValue]) => {
    const answerNumber = normalizeNumberText(answerValue);
    if (targetNumber || answerNumber) {
      return Boolean(targetNumber && answerNumber && targetNumber === answerNumber);
    }
    return normalizeComparable(answerValue) === targetText;
  });

  return match ? match[0] : null;
}

function isAnswerAction(action) {
  return (
    action.intent === "answer" &&
    ["click", "fill", "select"].includes(action.action) &&
    (action.action === "click" ||
      (action.value != null && String(action.value).trim() !== ""))
  );
}

function isMovementAction(action) {
  if (["next", "submit"].includes(action.intent)) return true;

  const control = findLastControlForAction(action);
  const text = `${control?.label || ""} ${control?.text || ""} ${
    control?.nearbyText || ""
  }`;
  return /\b(next|submit|check my work|hand in|finish)\b/i.test(text);
}

function buildActionsFromAnswer(answer) {
  if (!lastQuestionData || !Array.isArray(lastQuestionData.controls)) return [];

  const controls = lastQuestionData.controls;
  const actions = [];

  if (answer && typeof answer === "object" && !Array.isArray(answer)) {
    Object.entries(answer).forEach(([key, value]) => {
      const control = findControlForAnswerKey(controls, key);
      if (!control) return;

      actions.push({
        selector: control.selector,
        action: control.options.length || control.type === "combobox" ? "select" : "fill",
        value,
        intent: "answer",
      });
    });
  } else if (typeof answer === "string" && controls.length === 1) {
    const control = controls[0];
    actions.push({
      selector: control.selector,
      action: control.options.length || control.type === "combobox" ? "select" : "fill",
      value: answer,
      intent: "answer",
    });
  }

  return actions;
}

function findControlForAnswerKey(controls, key) {
  const normalizedKey = normalizeWhitespace(String(key))
    .replace(/[.)]$/, "")
    .toLowerCase();
  const keyPattern = new RegExp(`(^|\\s)${escapeRegExp(normalizedKey)}[.)]\\s`, "i");

  return (
    controls.find(
      (control) => getLeadingAnswerKey(control.nearbyText) === normalizedKey
    ) ||
    controls.find(
      (control) => getLeadingAnswerKey(control.label) === normalizedKey
    ) ||
    controls.find((control) => keyPattern.test(control.nearbyText || "")) ||
    controls.find((control) => keyPattern.test(control.label || ""))
  );
}

function getLeadingAnswerKey(text) {
  const match = normalizeWhitespace(text || "").match(/^([a-z]|\d+)[.)]\s/i);
  return match ? match[1].toLowerCase() : "";
}

async function executeActions(actions) {
  const completedActions = [];
  debugLog("execute_actions_start", { actionCount: actions.length, actions });

  for (const action of actions) {
    setAutomationDiagnostic(
      `action:${action.intent || ""}:${action.action}:${action.selector}:${
        action.value || ""
      }`
    );
    debugLog("execute_action_start", {
      index: completedActions.length,
      action,
    });
    const target = findElementDeep(action.selector);
    if (!target) {
      const error = new Error(`Action selector not found: ${action.selector}`);
      error.completedActions = completedActions.slice();
      debugLog("execute_action_selector_missing", { action }, "error");
      throw error;
    }
    try {
      debugLog("execute_action_target", { action, target });
      if (action.action === "click") {
        clickElement(target);
      } else if (action.action === "fill") {
        if (isDropdownLike(target)) {
          await selectElementValue(target, action.value);
        } else {
          await fillElement(target, action.value);
        }
      } else if (action.action === "select") {
        await selectElementValue(target, action.value);
      } else {
        console.warn("Unknown action:", action);
        debugLog("execute_action_unknown", { action }, "warn");
      }
    } catch (error) {
      error.completedActions = completedActions.slice();
      debugLog("execute_action_error", { action, target, error }, "error");
      throw error;
    }

    completedActions.push(action);
    if (isAnswerAction(action)) {
      markCurrentQuestionAnswered();
    }
    debugLog("execute_action_complete", {
      action,
      target,
      completedCount: completedActions.length,
    });
    await delay(250);
  }

  setAutomationDiagnostic("actions_complete");
  debugLog("execute_actions_complete", { completedActions });
}

function findElementDeep(selector) {
  for (const frame of getAccessibleDocuments()) {
    const elements = querySelectorAllSafe(frame.doc, selector);
    if (!elements.length) continue;
    const visibleElement = elements.find(
      (element) =>
        !isStaleAccountingClone(element) && isElementVisibleEnough(element)
    );
    const nonStaleElement = elements.find(
      (element) => !isStaleAccountingClone(element)
    );
    return visibleElement || nonStaleElement || elements[0];
  }
  return null;
}

function querySelectorAllSafe(doc, selector) {
  try {
    return Array.from(doc.querySelectorAll(selector));
  } catch (error) {
    debugLog("query_selector_invalid", { selector, error }, "error");
    return [];
  }
}

function clickElement(element) {
  const text = normalizeWhitespace(
    element.innerText ||
      element.textContent ||
      element.value ||
      element.getAttribute("aria-label") ||
      ""
  ).slice(0, 120);
  const frame = element.ownerDocument === document ? "main" : "iframe";
  const isMainNextish =
    frame === "main" && /\b(next|submit|hand in|finish)\b/i.test(text);
  const marker = isMainNextish ? ">>> MAIN-NEXT/SUBMIT CLICK" : "click";
  console.log(
    `[AutoMcGraw][${marker}]`,
    `frame=${frame}`,
    `tag=${element.tagName}`,
    `text="${text}"`,
    `id="${element.id || ""}"`,
    `aria="${element.getAttribute("aria-label") || ""}"`,
    `progress=${getProgress?.()?.current || "?"}/${getProgress?.()?.total || "?"}`,
    `activeTab="${getActiveAssessmentTabLabel?.() || ""}"`,
    element
  );
  debugLog("click_element", { element, text, frame, isMainNextish });
  element.scrollIntoView({ block: "center", inline: "center" });
  element.focus?.();
  dispatchMouseSequence(element, { includeClick: false });
  element.click();
}

async function fillElement(element, value) {
  const text = value == null ? "" : String(value);
  debugLog("fill_element_start", { element, value: text });
  element.scrollIntoView({ block: "center", inline: "center" });
  element.focus?.();

  if (isSpreadsheetFillCell(element)) {
    await fillSpreadsheetCell(element, text);
    return;
  }

  if ("value" in element) {
    element.value = text;
  } else if (element.isContentEditable) {
    element.textContent = text;
  } else {
    throw new Error("Cannot fill a non-editable element directly");
  }

  dispatchInputEvents(element);
  debugLog("fill_element_complete", { element, value: text });
}

async function fillSpreadsheetCell(element, text) {
  const doc = element.ownerDocument;
  debugLog("spreadsheet_fill_start", { element, value: text });
  activateSpreadsheetCell(element);
  await delay(220);

  let editor = getSpreadsheetEditor(doc, element);
  if (!editor) {
    activateSpreadsheetCell(element);
    await delay(350);
    editor = getSpreadsheetEditor(doc, element);
  }
  if (!editor) {
    dispatchEnterKey(element);
    await delay(180);
    editor = getSpreadsheetEditor(doc, element);
  }

  if (editor) {
    debugLog("spreadsheet_fill_editor_found", { element, editor, value: text });
    normalizeSpreadsheetCellClasses(element);
    editor.focus?.();
    if ("value" in editor) {
      editor.value = "";
    } else {
      editor.textContent = "";
    }
    dispatchInputChangeEvents(editor);

    const inserted =
      typeof doc.execCommand === "function" &&
      doc.execCommand("insertText", false, text);
    if (!inserted || getElementValue(editor) !== text) {
      setElementTextValue(editor, text);
    }

    dispatchInputChangeEvents(editor);
    dispatchEnterKey(editor);
    await delay(220);
    normalizeSpreadsheetCellClasses(element);

    if (spreadsheetCellHasValue(element, text)) {
      dispatchInputEvents(element);
      debugLog("spreadsheet_fill_editor_success", { element, value: text });
      return;
    }
  }

  debugLog("spreadsheet_fill_verify_failed", {
    element,
    expected: text,
    actual: element.innerText || element.textContent || "",
    editorFound: Boolean(editor),
  }, "error");
  throw new Error(`Spreadsheet cell did not keep value: ${text}`);
}

function isSpreadsheetFillCell(element) {
  return (
    element.tagName?.toLowerCase() === "td" &&
    (element.classList.contains("responseCell") ||
      element.classList.contains("groupResponse")) &&
    !isDropdownLike(element)
  );
}

function activateSpreadsheetCell(element) {
  normalizeSpreadsheetCellClasses(element);
  element.scrollIntoView({ block: "center", inline: "center" });
  element.focus?.();
  element.click();
  normalizeSpreadsheetCellClasses(element);
}

function getSpreadsheetEditor(doc, targetCell = null) {
  const explicitEditor = [
    ".jSheetControls_formula",
    ".jSheetControls_editor textarea",
    ".jSheetControls_editor input",
  ]
    .map((selector) => doc.querySelector(selector))
    .find((editor) => editor && isUsableSpreadsheetInputEditor(editor));
  if (explicitEditor) return explicitEditor;

  const activeElement = doc.activeElement;
  if (
    activeElement?.isContentEditable &&
    isElementVisibleEnough(activeElement)
  ) {
    return activeElement;
  }

  const editableCandidates = Array.from(
    doc.querySelectorAll("[contenteditable='true']")
  ).filter((editor) => isUsableSpreadsheetEditor(editor, targetCell));

  if (!editableCandidates.length) return null;
  if (!targetCell) return editableCandidates[0];

  const targetRect = targetCell.getBoundingClientRect();
  return editableCandidates.sort((a, b) => {
    const aRect = a.getBoundingClientRect();
    const bRect = b.getBoundingClientRect();
    return (
      getRectDistanceScore(targetRect, aRect) -
      getRectDistanceScore(targetRect, bRect)
    );
  })[0];
}

function isUsableSpreadsheetEditor(editor, targetCell) {
  if (!isElementVisibleEnough(editor)) return false;
  if (editor === targetCell) return false;
  if (targetCell?.contains(editor)) return true;

  const tagName = editor.tagName?.toLowerCase();
  if (tagName === "body" || tagName === "html") return false;
  if (editor.closest(".header__automcgraw")) return false;

  const rect = editor.getBoundingClientRect();
  if (rect.width > 1200 || rect.height > 300) return false;

  return true;
}

function isUsableSpreadsheetInputEditor(editor) {
  if (!editor) return false;
  const tagName = editor.tagName?.toLowerCase();
  if (!["input", "textarea"].includes(tagName)) return false;
  if (editor.disabled || editor.readOnly) return false;
  if (editor.closest(".header__automcgraw")) return false;

  const style = editor.ownerDocument.defaultView?.getComputedStyle(editor);
  if (style && (style.display === "none" || style.visibility === "hidden")) {
    return false;
  }

  return true;
}

function normalizeSpreadsheetCellClasses(element) {
  if (!element?.classList || !isAnswerCell(element)) return;

  const uniqueClasses = uniqueStrings(
    String(element.className || "")
      .split(/\s+/)
      .filter(Boolean)
  );
  element.className = uniqueClasses.join(" ");
}

function getRectDistanceScore(a, b) {
  const ax = a.left + a.width / 2;
  const ay = a.top + a.height / 2;
  const bx = b.left + b.width / 2;
  const by = b.top + b.height / 2;
  return Math.abs(ax - bx) + Math.abs(ay - by);
}

function setElementTextValue(element, text) {
  if ("value" in element) {
    element.value = text;
  } else if (element.isContentEditable) {
    element.textContent = text;
  } else {
    throw new Error("Refusing to replace non-editable element contents");
  }
}

function spreadsheetCellHasValue(element, expectedText) {
  const actualText = normalizeWhitespace(element.innerText || element.textContent || "");
  const expected = normalizeWhitespace(expectedText);
  const actualNumber = normalizeNumberText(actualText);
  const expectedNumber = normalizeNumberText(expected);
  if (actualNumber || expectedNumber) {
    return Boolean(actualNumber && expectedNumber && actualNumber === expectedNumber);
  }

  return normalizeComparable(actualText) === normalizeComparable(expected);
}

function normalizeNumberText(value) {
  const text = normalizeWhitespace(value);
  if (!/\d/.test(text)) return "";

  const isParentheticalNegative = /^\(.*\)$/.test(text);
  const numeric = text.replace(/[^\d.-]/g, "");
  if (!numeric) return "";

  const stripped = numeric.replace(/(?!^)-/g, "");
  const signed =
    isParentheticalNegative && !stripped.startsWith("-")
      ? `-${stripped}`
      : stripped;

  // Canonicalize through Number so different surface forms of the same value
  // compare equal: "-4976", "-4976.00", "(4,976.00)", and "(4976)" all
  // collapse to "-4976". Without this, McGraw's spreadsheet cells often
  // re-format AI input (e.g. add ".00" or commas) and our verifier rejects
  // a fill that actually succeeded.
  const number = parseFloat(signed);
  if (Number.isFinite(number)) return String(number);
  return signed;
}

function dispatchMouseSequence(element, options = {}) {
  const { includeClick = true } = options;
  const win = element.ownerDocument.defaultView || window;
  const rect = element.getBoundingClientRect();
  const clientX = rect.left + Math.max(1, rect.width / 2);
  const clientY = rect.top + Math.max(1, rect.height / 2);

  ["mouseover", "mousemove", "mousedown", "mouseup"].forEach((type) => {
    element.dispatchEvent(
      new win.MouseEvent(type, {
        bubbles: true,
        cancelable: true,
        view: win,
        button: 0,
        buttons: type === "mouseup" || type === "click" ? 0 : 1,
        clientX,
        clientY,
      })
    );
  });

  if (!includeClick) return;

  element.dispatchEvent(
    new win.MouseEvent("click", {
      bubbles: true,
      cancelable: true,
      view: win,
      button: 0,
      buttons: 0,
      clientX,
      clientY,
    })
  );
}

function dispatchEnterKey(element) {
  const win = element.ownerDocument.defaultView || window;
  ["keydown", "keypress", "keyup"].forEach((type) => {
    element.dispatchEvent(
      new win.KeyboardEvent(type, {
        key: "Enter",
        code: "Enter",
        keyCode: 13,
        which: 13,
        bubbles: true,
        cancelable: true,
      })
    );
  });
}

async function selectElementValue(element, value) {
  const text = value == null ? "" : String(value);
  debugLog("select_element_start", { element, value: text });
  element.scrollIntoView({ block: "center", inline: "center" });
  element.focus?.();

  if (element.tagName.toLowerCase() === "select") {
    selectNativeOption(element, text);
    debugLog("select_element_native_complete", { element, value: text });
    return;
  }

  await selectCustomDropdownOption(element, text);
  debugLog("select_element_custom_complete", { element, value: text });
}

function selectNativeOption(select, text) {
  const options = Array.from(select.options);
  const match = options.find(
    (option) =>
      normalizeComparable(option.textContent) === normalizeComparable(text) ||
      normalizeComparable(option.value) === normalizeComparable(text)
  );

  if (!match) {
    throw new Error(`Dropdown option not found: ${text}`);
  }

  select.value = match.value;
  dispatchInputEvents(select);
}

async function selectCustomDropdownOption(element, text) {
  const doc = element.ownerDocument;
  debugLog("custom_dropdown_open_start", { element, value: text });
  dispatchMouseSequence(element);
  await delay(200);

  const option = findDropdownOption(doc, text);
  if (!option) {
    debugLog(
      "custom_dropdown_option_missing",
      {
        element,
        value: text,
        availableOptions: getVisibleDropdownOptionTexts(doc),
      },
      "error"
    );
    closeDropdownOverlays(doc);
    throw new Error(`Dropdown option not found: ${text}`);
  }

  debugLog("custom_dropdown_option_found", { element, option, value: text });
  option.scrollIntoView({ block: "nearest", inline: "nearest" });
  dispatchMouseSequence(option.querySelector("a, .list_content") || option);
  await delay(200);
  dispatchInputEvents(element);

  debugLog("custom_dropdown_after_first_click", {
    element,
    expected: text,
    actual: element.innerText || element.textContent || getElementValue(element),
    matches: dropdownSelectionMatches(element, text),
  });

  if (!dropdownSelectionMatches(element, text)) {
    const optionTarget = option.querySelector("a, .list_content") || option;
    debugLog("custom_dropdown_retry_click", {
      element,
      optionTarget,
      expected: text,
    });
    dispatchMouseSequence(element);
    await delay(100);
    dispatchMouseSequence(optionTarget);
    await delay(200);
    dispatchInputEvents(element);
  }

  if (!dropdownSelectionMatches(element, text)) {
    debugLog(
      "custom_dropdown_did_not_stick",
      {
        element,
        expected: text,
        actual: element.innerText || element.textContent || getElementValue(element),
        availableOptions: getVisibleDropdownOptionTexts(doc),
      },
      "error"
    );
    closeDropdownOverlays(doc);
    throw new Error(`Dropdown option did not stick: ${text}`);
  }

  debugLog("custom_dropdown_select_success", {
    element,
    value: text,
    actual: element.innerText || element.textContent || getElementValue(element),
  });
  closeDropdownOverlays(doc);
}

function getVisibleDropdownOptionTexts(doc) {
  return Array.from(
    doc.querySelectorAll(
      ".listContainer [role='option'], [role='listbox'] [role='option'], .listContainer li"
    )
  )
    .filter((option) => isElementVisibleEnough(option))
    .map((option) => normalizeWhitespace(option.innerText || option.textContent || ""))
    .filter(Boolean)
    .slice(0, 80);
}

function findDropdownOption(doc, text) {
  const target = normalizeComparable(text);
  const options = Array.from(
    doc.querySelectorAll(".listContainer [role='option'], [role='listbox'] [role='option'], .listContainer li")
  );

  const exactMatch = options.find((option) => {
    const optionText = normalizeComparable(option.innerText || option.textContent || "");
    return optionText === target;
  });
  if (exactMatch) return exactMatch;

  return options.find((option) => {
    const optionText = normalizeComparable(option.innerText || option.textContent || "");
    return isLikelyDropdownOptionMatch(target, optionText);
  });
}

function isLikelyDropdownOptionMatch(target, optionText) {
  if (!target || !optionText) return false;

  const targetTokens = new Set(target.split(" ").filter(Boolean));
  const optionTokens = optionText.split(" ").filter(Boolean);
  if (optionTokens.length < 2) return false;

  return optionTokens.every((token) => targetTokens.has(token));
}

function dropdownSelectionMatches(element, expectedText) {
  const actualText =
    element.innerText || element.textContent || getElementValue(element)
  const actual = normalizeComparable(actualText);
  const expected = normalizeComparable(expectedText);
  const actualWithoutCode = normalizeDropdownDisplayText(actualText);
  const expectedWithoutCode = normalizeDropdownDisplayText(expectedText);

  return (
    actual === expected ||
    (actualWithoutCode && actualWithoutCode === expectedWithoutCode) ||
    isLikelyDropdownOptionMatch(expected, actual) ||
    isLikelyDropdownOptionMatch(actual, expected) ||
    isLikelyDropdownOptionMatch(expectedWithoutCode, actualWithoutCode) ||
    isLikelyDropdownOptionMatch(actualWithoutCode, expectedWithoutCode)
  );
}

function normalizeDropdownDisplayText(value) {
  return normalizeComparable(
    normalizeWhitespace(value).replace(/^\d+\s*:\s*/, "")
  );
}

function dispatchInputEvents(element) {
  dispatchInputChangeEvents(element);
  const win = element.ownerDocument.defaultView || window;
  element.dispatchEvent(new win.Event("blur", { bubbles: true }));
}

function dispatchInputChangeEvents(element) {
  const win = element.ownerDocument.defaultView || window;
  element.dispatchEvent(new win.Event("input", { bubbles: true }));
  element.dispatchEvent(new win.Event("change", { bubbles: true }));
}

function setAutomationDiagnostic(message) {
  document.documentElement.setAttribute(
    "data-automcgraw-diagnostic",
    `${new Date().toISOString()} ${message}`
  );
}

async function continueAfterResponse(actions) {
  if (!isAutomating) return;
  const shouldHoldMainNextAfterLocalAnswer = heldMainNextAfterLocalAnswer;
  heldMainNextAfterLocalAnswer = false;
  const continueDecisionFlags = {
    held: shouldHoldMainNextAfterLocalAnswer,
    resnapshot: shouldResnapshotAfterActions(actions),
    inToolSubmit: shouldResnapshotAfterInToolSubmit(actions),
    snapshotType: lastQuestionData?.type || "",
  };
  console.log(
    "[AutoMcGraw][POST-ACTIONS]",
    `progress=${getProgress()?.current || "?"}/${getProgress()?.total || "?"}`,
    `activeTab="${getActiveAssessmentTabLabel() || ""}"`,
    "decision=",
    continueDecisionFlags
  );
  debugLog("continue_after_response_start", {
    actionCount: actions.length,
    actions,
    shouldHoldMainNextAfterLocalAnswer,
    shouldResnapshot: continueDecisionFlags.resnapshot,
    shouldContinueAfterInToolSubmit: continueDecisionFlags.inToolSubmit,
  });

  if (lastQuestionData && lastQuestionData.type === "connect_page_snapshot") {
    if (shouldHoldMainNextAfterLocalAnswer) {
      setTimeout(() => {
        if (isAutomating) {
          debugLog("continue_after_response_held_main_next_resnapshot");
          checkForNextStep();
        }
      }, 1200);
      return;
    }

    if (
      shouldResnapshotAfterActions(actions) ||
      shouldResnapshotAfterInToolSubmit(actions)
    ) {
      setTimeout(async () => {
        if (!isAutomating) return;

        if (shouldResnapshotAfterInToolSubmit(actions)) {
          debugLog("continue_after_response_in_tool_submit");
          await continueAfterInToolSubmit();
          return;
        }

        debugLog("continue_after_response_resnapshot");
        checkForNextStep();
      }, 1200);
      return;
    }

    await advanceConnectPageIfNeeded(actions);
    if (actions.some((action) => action.intent === "submit")) {
      debugLog("continue_after_response_submit_complete");
      stopAutomation("Assignment submitted");
      return;
    }

    setTimeout(() => {
      if (isAutomating) {
        debugLog("continue_after_response_next_snapshot");
        checkForNextStep();
      }
    }, 1800);
    return;
  }

  setTimeout(() => {
    const nextButton = document.querySelector(".footer__link--next:not([hidden])");
    if (
      nextButton &&
      !nextButton.disabled &&
      !nextButton.classList.contains("is-disabled")
    ) {
      clickElement(nextButton);
      setTimeout(() => {
        if (checkForQuizEnd()) {
          debugLog("legacy_quiz_complete");
          stopAutomation("Quiz completed - all questions answered");
          return;
        }
        debugLog("legacy_quiz_next_snapshot");
        checkForNextStep();
      }, 1500);
    } else {
      debugLog("legacy_quiz_no_next", {}, "warn");
      stopAutomation("Quiz completed - no next button available");
    }
  }, 2000);
}

function shouldResnapshotAfterActions(actions) {
  const hasMovement = actions.some((action) =>
    ["submit", "next"].includes(action.intent)
  );
  if (hasMovement) return false;

  const hasValueAnswer = actions.some(
    (action) =>
      action.intent === "answer" &&
      ["fill", "select"].includes(action.action) &&
      action.value != null &&
      String(action.value).trim() !== ""
  );
  if (hasValueAnswer) return false;

  return actions.some((action) => {
    if (action.intent === "continue") return true;
    const control = findLastControlForAction(action);
    const text = `${control?.label || ""} ${control?.text || ""} ${
      control?.nearbyText || ""
    }`;
    return /\b(edit|view|open|worksheet|journal entry|transaction list)\b/i.test(
      text
    );
  });
}

function shouldResnapshotAfterInToolSubmit(actions) {
  return actions.some((action) => {
    if (!["submit", "continue"].includes(action.intent)) return false;
    const control = findLastControlForAction(action);
    if (!control) return false;

    const text = `${control.label || ""} ${control.text || ""} ${
      control.nearbyText || ""
    }`;
    return (
      control.frame !== "main" ||
      /\b(record entry|save entry|worksheet|journal entry|transaction)\b/i.test(
        text
      )
    );
  });
}

async function continueAfterInToolSubmit() {
  console.log(
    "[AutoMcGraw][POST-SAVE]",
    `progress=${getProgress()?.current || "?"}/${getProgress()?.total || "?"}`,
    `activeTab="${getActiveAssessmentTabLabel() || ""}"`,
    `visibleTabs=${JSON.stringify(getVisibleAssessmentTabLabels())}`,
    `answeredWorkUnits=${JSON.stringify(
      Array.from(answeredAssessmentWorkUnitIds)
    )}`
  );
  debugLog("continue_after_in_tool_submit_start");
  const saveSettled = await waitForInToolSaveToSettle();
  debugLog("continue_after_in_tool_submit_save_settled", { saveSettled });

  if (!saveSettled && hasVisibleInToolAnswerEditor()) {
    debugLog(
      "continue_after_in_tool_submit_save_not_settled_editor_visible",
      {},
      "warn"
    );
    checkForNextStep();
    return;
  }

  const nextTransaction = findNextUnenteredTransactionButton();
  if (nextTransaction) {
    const targetTransactionNumber = getTransactionButtonNumber(nextTransaction);
    debugLog("continue_after_in_tool_submit_next_transaction", {
      nextTransaction,
      targetTransactionNumber,
    });
    clickElement(nextTransaction);
    await waitForTransactionButtonActive(
      nextTransaction.ownerDocument,
      targetTransactionNumber
    );
    setTimeout(() => {
      if (isAutomating) {
        debugLog("continue_after_in_tool_submit_snapshot_next_transaction", {
          targetTransactionNumber,
          activeTransactionNumber: getActiveTransactionNumber(
            nextTransaction.ownerDocument
          ),
        });
        checkForNextStep();
      }
    }, 600);
    return;
  }

  // Don't proactively click another Required tab here. Our per-tab work-unit
  // tracker marks a tab "answered" the moment ANY single subpart inside it
  // gets an answer action, but McGraw worksheets often have their own
  // internal paginator (e.g. "< 1 [2] >") inside a single tab. Jumping to the
  // next tab in that case skips the remaining internal subparts.
  //
  // Record entry already auto-advances the embedded tool — within the
  // current tab when more subparts remain, and (per McGraw's behavior)
  // typically to the next tab when the current tab is fully done. Just
  // re-snapshot and let the AI / page handle navigation. The AI's prompt
  // tells it to click a tab control itself when no save button is visible.
  setTimeout(() => {
    if (isAutomating) {
      debugLog("continue_after_in_tool_submit_resnapshot_for_decision");
      checkForNextStep();
    }
  }, 1200);
}

async function waitForInToolSaveToSettle(timeout = 5000) {
  const startedAt = Date.now();
  debugLog("wait_in_tool_save_start", { timeout });

  while (Date.now() - startedAt < timeout) {
    if (hasInToolSaveCompleted()) {
      debugLog("wait_in_tool_save_completed", {
        elapsed: Date.now() - startedAt,
      });
      return true;
    }
    await delay(250);
  }

  debugLog("wait_in_tool_save_timeout", { timeout }, "warn");
  return false;
}

function hasInToolSaveCompleted() {
  for (const frame of getAccessibleDocuments()) {
    if (frame.frame === "main") continue;

    const bodyText = frame.doc.body?.innerText || "";
    if (/journal entry recorded successfully|entry recorded successfully/i.test(bodyText)) {
      return true;
    }

    const activeTransaction = frame.doc.querySelector(
      ".transactionButton.active, input.active, button.active"
    );
    const activeText = activeTransaction
      ? getControlText(activeTransaction, { preferAriaLabel: true })
      : "";
    const activeClasses = String(activeTransaction?.className || "");
    if (
      activeTransaction &&
      /\bgraded\b/i.test(activeClasses) &&
      /\bentry entered\b/i.test(activeText)
    ) {
      return true;
    }
  }

  return false;
}

function findNextUnenteredTransactionButton() {
  for (const frame of getAccessibleDocuments()) {
    if (frame.frame === "main") continue;
    prepareDocumentForSnapshot(frame.doc);

    const activeButton = getActiveTransactionButton(frame.doc);
    const activeTransactionNumber = getTransactionButtonNumber(activeButton);
    const buttons = Array.from(
      frame.doc.querySelectorAll("button, input[type='button'], [role='button']")
    );
    const candidates = buttons
      .filter((button) => isUnenteredTransactionButton(button))
      .map((button) => ({
        button,
        transactionNumber: getTransactionButtonNumber(button),
      }))
      .filter((candidate) => candidate.transactionNumber != null)
      .sort((a, b) => a.transactionNumber - b.transactionNumber);
    const earlierMissed = activeTransactionNumber
      ? candidates.find(
          (candidate) => candidate.transactionNumber < activeTransactionNumber
        )
      : null;
    const activeCandidate =
      activeTransactionNumber &&
      candidates.find(
        (candidate) => candidate.transactionNumber === activeTransactionNumber
      );

    if (activeCandidate && !earlierMissed) {
      debugLog("next_unentered_transaction_active_current", {
        frame: frame.frame,
        activeTransactionNumber,
        activeButton,
        candidateNumbers: candidates.map(
          (candidate) => candidate.transactionNumber
        ),
      });
      return null;
    }

    const match =
      earlierMissed ||
      candidates.find(
        (candidate) =>
          !activeTransactionNumber ||
          candidate.transactionNumber > activeTransactionNumber
      ) ||
      candidates[0];

    if (match) {
      const nextArrow =
        activeTransactionNumber &&
        !earlierMissed &&
        match.transactionNumber > activeTransactionNumber + 1
          ? findTransactionNextArrow(frame.doc)
          : null;
      debugLog("next_unentered_transaction_found", {
        frame: frame.frame,
        activeTransactionNumber,
        candidateNumbers: candidates.map(
          (candidate) => candidate.transactionNumber
        ),
        earlierMissedTransactionNumber:
          earlierMissed?.transactionNumber || null,
        match: nextArrow || match.button,
        matchTransactionNumber: match.transactionNumber,
        usedNextArrow: Boolean(nextArrow),
      });
      return nextArrow || match.button;
    }
  }
  debugLog("next_unentered_transaction_missing");
  return null;
}

function findTransactionNextArrow(doc) {
  return Array.from(
    doc.querySelectorAll(
      ".accountingtool_navigationcarousel [aria-label*='Move to next transaction'], .accountingtool_navigationcarousel .next, .accountingtool_navigationcarousel .icon-Nxt"
    )
  ).find((control) => isElementVisibleEnough(control) && !isDisabledControl(control));
}

function isUnenteredTransactionButton(button) {
  if (!isElementVisibleEnough(button)) return false;
  if (isDisabledControl(button)) return false;

  const transactionNumber = getTransactionButtonNumber(button);
  if (!transactionNumber) return false;
  if (button.classList.contains("graded")) return false;
  if (button.classList.contains("active")) return true;

  const text = getControlText(button, { preferAriaLabel: true });
  if (/\bnot yet entered\b/i.test(text)) return true;
  if (/\bentry entered\b/i.test(text)) return false;

  return (
    button.closest(".accountingtool_navigationcarousel") &&
    !button.classList.contains("active") &&
    !button.classList.contains("graded")
  );
}

async function waitForTransactionButtonActive(doc, transactionNumber, timeout = 3000) {
  if (!transactionNumber) return false;

  const startedAt = Date.now();
  let retried = false;
  debugLog("wait_transaction_active_start", {
    transactionNumber,
    activeTransactionNumber: getActiveTransactionNumber(doc),
    timeout,
  });

  while (Date.now() - startedAt < timeout) {
    const activeTransactionNumber = getActiveTransactionNumber(doc);
    if (activeTransactionNumber === transactionNumber) {
      debugLog("wait_transaction_active_done", {
        transactionNumber,
        elapsed: Date.now() - startedAt,
      });
      return true;
    }

    if (!retried && Date.now() - startedAt > 800) {
      const retryButton = findTransactionButtonByNumber(doc, transactionNumber);
      if (retryButton) {
        retried = true;
        debugLog("wait_transaction_active_retry_click", {
          transactionNumber,
          activeTransactionNumber,
          retryButton,
        });
        clickElement(retryButton);
      }
    }

    await delay(150);
  }

  debugLog(
    "wait_transaction_active_timeout",
    {
      transactionNumber,
      activeTransactionNumber: getActiveTransactionNumber(doc),
      timeout,
    },
    "warn"
  );
  return false;
}

function getActiveTransactionNumber(doc) {
  return getTransactionButtonNumber(getActiveTransactionButton(doc));
}

function getActiveTransactionButton(doc) {
  return getTransactionButtons(doc).find(
    (button) =>
      button.classList.contains("active") ||
      button.getAttribute("aria-selected") === "true"
  );
}

function findTransactionButtonByNumber(doc, transactionNumber) {
  return getTransactionButtons(doc).find(
    (button) => getTransactionButtonNumber(button) === transactionNumber
  );
}

function getTransactionButtons(doc) {
  return Array.from(
    doc.querySelectorAll(
      ".accountingtool_navigationcarousel [role='tab'], .accountingtool_navigationcarousel input[type='button'], .accountingtool_navigationcarousel button"
    )
  ).filter((button) => isElementVisibleEnough(button) && !isDisabledControl(button));
}

function getTransactionButtonNumber(button) {
  if (!button) return null;

  const visibleNumber = parseTransactionNumberText(button.value || "");
  if (visibleNumber != null) return visibleNumber;

  const refNumber = parseTransactionNumberText(button.getAttribute("ref") || "");
  if (refNumber != null) return refNumber;

  const labelledNumber = parseTransactionNumberText(
    button.getAttribute("aria-label") ||
      button.innerText ||
      button.textContent ||
      ""
  );
  if (labelledNumber != null) return labelledNumber;

  return null;
}

function parseTransactionNumberText(value) {
  const text = normalizeWhitespace(value || "");
  if (!text) return null;

  const transactionMatch = text.match(/\btransaction\s+number\s+(\d+)\b/i);
  if (transactionMatch) return parseInt(transactionMatch[1], 10);

  const plainMatch = text.match(/^\d+$/);
  if (plainMatch) return parseInt(plainMatch[0], 10);

  return null;
}

function hasVisibleInToolAnswerEditor() {
  for (const frame of getAccessibleDocuments()) {
    if (frame.frame === "main") continue;

    const saveButton = Array.from(
      frame.doc.querySelectorAll("#saveTransation, input, button")
    ).find((element) => {
      const text = getControlText(element);
      return (
        isElementVisibleEnough(element) &&
        !element.disabled &&
        /\brecord entry\b/i.test(text)
      );
    });

    if (saveButton) return true;
  }
  return false;
}

function findInToolSubmitButton() {
  for (const frame of getAccessibleDocuments()) {
    if (frame.frame === "main") continue;

    const controls = Array.from(
      frame.doc.querySelectorAll(
        "#saveTransation, #saveTransaction, input[type='button'], button, [role='button']"
      )
    );
    const match = controls.find((element) => {
      if (!isElementVisibleEnough(element)) return false;
      if (isDisabledControl(element)) return false;

      const text = getControlText(element);
      return /\b(record entry|save entry|record transaction|save transaction)\b/i.test(
        text
      );
    });

    if (match) {
      debugLog("in_tool_submit_found", { frame: frame.frame, match });
      return match;
    }
  }

  debugLog("in_tool_submit_missing");
  return null;
}

function findLastControlForAction(action) {
  if (!lastQuestionData || !Array.isArray(lastQuestionData.controls)) return null;
  return lastQuestionData.controls.find(
    (control) => control.selector === action.selector
  );
}

async function advanceConnectPageIfNeeded(actions) {
  const alreadyAdvanced = actions.some((action) =>
    ["submit", "next", "continue"].includes(action.intent)
  );
  debugLog("advance_connect_start", {
    actionCount: actions.length,
    alreadyAdvanced,
    progress: getProgress(),
    canAutoSubmit: canAutoSubmitAssignment(),
  });
  if (alreadyAdvanced) {
    if (actions.some((action) => action.intent === "submit")) {
      debugLog("advance_connect_confirm_existing_submit");
      await confirmSubmitIfPresent();
    }
    return;
  }

  if (actions.some((action) => isAnswerAction(action))) {
    const inToolSubmitButton = findInToolSubmitButton();
    if (inToolSubmitButton) {
      debugLog("advance_connect_click_in_tool_submit", {
        inToolSubmitButton,
      });
      await delay(300);
      clickElement(inToolSubmitButton);
      await continueAfterInToolSubmit();
      return;
    }
  }

  const progress = getProgress();
  if (progress && progress.current >= progress.total) {
    const inToolNextButton = findInToolNextButton();
    if (inToolNextButton) {
      debugLog("advance_connect_in_tool_next", { inToolNextButton });
      clickElement(inToolNextButton);
      return;
    }

    if (!canAutoSubmitAssignment()) {
      debugLog(
        "advance_connect_final_submit_blocked",
        { progress, submitState: getAutoSubmitDebugState() },
        "warn"
      );
      setAutomationDiagnostic("blocked_final_submit_incomplete_run");
      stopAutomation(
        "Reached the last item, but not every item was answered in this automation run"
      );
      return;
    }

    const submitButton = findButtonByText(/^submit$/i);
    if (submitButton) {
      debugLog("advance_connect_click_submit", { submitButton, progress });
      clickElement(submitButton);
      await confirmSubmitIfPresent();
      return;
    }
    debugLog("advance_connect_submit_missing", { progress }, "warn");
  }

  const nextButton = findButtonByText(/^next$/i);
  if (nextButton) {
    debugLog("advance_connect_click_next", { nextButton, progress });
    clickElement(nextButton);
  } else {
    debugLog("advance_connect_next_missing", { progress }, "warn");
  }
}

async function confirmSubmitIfPresent() {
  await delay(800);

  if (!canAutoSubmitAssignment()) {
    debugLog(
      "confirm_submit_blocked",
      { submitState: getAutoSubmitDebugState() },
      "warn"
    );
    setAutomationDiagnostic("blocked_submit_confirmation");
    return;
  }

  const modalButton = findButtonByText(
    /^(submit|submit assignment|hand in|yes|confirm|continue)$/i,
    "ic-modal[aria-hidden='false'], [role='dialog'][aria-hidden='false'], .modal[aria-hidden='false']"
  );

  if (modalButton) {
    debugLog("confirm_submit_click_modal", { modalButton });
    clickElement(modalButton);
  } else {
    debugLog("confirm_submit_modal_missing");
  }
}

function findInToolNextButton() {
  for (const frame of getAccessibleDocuments()) {
    if (frame.frame === "main") continue;

    const controls = Array.from(
      frame.doc.querySelectorAll("button, input[type='button'], [role='button'], li, a[href]")
    );
    const match = controls.find((control) => {
      if (!isElementVisibleEnough(control)) return false;
      if (isDisabledControl(control)) return false;

      const text = normalizeWhitespace(
        control.value ||
          control.innerText ||
          control.textContent ||
          control.getAttribute("aria-label") ||
          ""
      );
      if (!/^next\b/i.test(text)) return false;

      return Boolean(
        control.closest("[role='tablist'], #tabs, .tabs, .tab-container") ||
          control.id === "nextBtn" ||
          control.classList.contains("controlBtn") ||
          /\btab\b/i.test(text)
      );
    });

    if (match) {
      debugLog("in_tool_next_found", { frame: frame.frame, match });
      return match;
    }
  }
  debugLog("in_tool_next_missing");
  return null;
}

function findButtonByText(pattern, rootSelector = null) {
  for (const frame of getAccessibleDocuments()) {
    const roots = rootSelector
      ? Array.from(frame.doc.querySelectorAll(rootSelector))
      : [frame.doc];
    const buttons = roots.flatMap((root) =>
      Array.from(root.querySelectorAll("button, [role='button'], a[href]"))
    );
    const match = buttons.find((button) => {
      if (!isElementVisibleEnough(button)) return false;
      if (isDisabledControl(button)) return false;
      const text = normalizeWhitespace(
        button.innerText || button.textContent || button.getAttribute("aria-label") || ""
      );
      return pattern.test(text);
    });
    if (match) return match;
  }
  return null;
}

function isDisabledControl(element) {
  return (
    Boolean(element.disabled) ||
    element.getAttribute("aria-disabled") === "true" ||
    element.classList.contains("is-disabled") ||
    element.classList.contains("disabled") ||
    element.classList.contains("disable")
  );
}

function getProgress() {
  const progressInfo = document.querySelector(".footer__progress__heading");
  if (!progressInfo) return null;
  const text = normalizeWhitespace(progressInfo.textContent);
  const match = text.match(/(\d+)\s+of\s+(\d+)/i);
  const totalMatch = text.match(/\bof\s+(\d+)\b/i);
  if (!match && !totalMatch) return null;

  const current = match ? parseInt(match[1], 10) : getCurrentQuestionNumber();
  const total = totalMatch
    ? parseInt(totalMatch[1], 10)
    : parseInt(match[2], 10);
  if (!current || !total) return null;

  return {
    current,
    total,
  };
}

function getCurrentQuestionNumber() {
  const sources = [
    document.title,
    document.querySelector(".question__number-wrap")?.textContent,
    document.querySelector("#question-info-holder")?.textContent,
    document.querySelector(".footer__progress__heading")?.textContent,
  ];

  for (const source of sources) {
    const match = normalizeWhitespace(source || "").match(
      /\b(?:question|item)\s+(\d+)\b/i
    );
    if (match) return parseInt(match[1], 10);
  }

  return null;
}

function markCurrentQuestionAnswered() {
  const questionNumber = getCurrentQuestionNumber() || getProgress()?.current;
  if (!questionNumber) {
    debugLog("mark_question_answered_missing_question_number", {}, "warn");
    return;
  }

  answeredQuestionNumbers.add(questionNumber);
  getCurrentAssessmentWorkUnitIds(questionNumber).forEach((workUnitId) => {
    answeredAssessmentWorkUnitIds.add(workUnitId);
  });
  lastAnswerActionAt = Date.now();
  debugLog("mark_question_answered", {
    questionNumber,
    answeredQuestionNumbers: Array.from(answeredQuestionNumbers),
    answeredAssessmentWorkUnitIds: Array.from(answeredAssessmentWorkUnitIds),
    lastAnswerActionAt,
  });
}

function isCurrentWorkUnitAlreadyAnswered() {
  const questionNumber = getCurrentQuestionNumber() || getProgress()?.current;
  if (!questionNumber) return false;

  const currentWorkUnits = getCurrentAssessmentWorkUnitIds(questionNumber);
  if (currentWorkUnits.length) {
    return currentWorkUnits.every((workUnitId) =>
      answeredAssessmentWorkUnitIds.has(workUnitId)
    );
  }

  return answeredQuestionNumbers.has(questionNumber);
}

function canAutoSubmitAssignment() {
  const progress = getProgress();
  if (!progress) return false;
  if (Date.now() - lastAnswerActionAt > 60000) return false;
  if (hasCurrentSkippedIndicator()) return false;

  const expectedWorkUnits = getExpectedAssessmentWorkUnitIds(progress.current);
  if (expectedWorkUnits.length) {
    return expectedWorkUnits.every((workUnitId) =>
      answeredAssessmentWorkUnitIds.has(workUnitId)
    );
  }

  return answeredQuestionNumbers.size >= progress.total;
}

function getAutoSubmitDebugState() {
  const progress = getProgress();
  const expectedWorkUnits = progress
    ? getExpectedAssessmentWorkUnitIds(progress.current)
    : [];
  return {
    progress,
    lastAnswerAgeMs: lastAnswerActionAt ? Date.now() - lastAnswerActionAt : null,
    hasCurrentSkippedIndicator: hasCurrentSkippedIndicator(),
    answeredQuestionNumbers: Array.from(answeredQuestionNumbers),
    answeredAssessmentWorkUnitIds: Array.from(answeredAssessmentWorkUnitIds),
    expectedWorkUnits,
    missingWorkUnits: expectedWorkUnits.filter(
      (workUnitId) => !answeredAssessmentWorkUnitIds.has(workUnitId)
    ),
  };
}

function getCurrentAssessmentWorkUnitIds(questionNumber) {
  const activeTab = getActiveAssessmentTabLabel();
  return activeTab ? [buildAssessmentWorkUnitId(questionNumber, activeTab)] : [];
}

function getExpectedAssessmentWorkUnitIds(questionNumber) {
  return getVisibleAssessmentTabLabels().map((label) =>
    buildAssessmentWorkUnitId(questionNumber, label)
  );
}

function buildAssessmentWorkUnitId(questionNumber, label) {
  return `q${questionNumber}:tab:${normalizeComparable(label)}`;
}

function getActiveAssessmentTabLabel() {
  const tabs = getVisibleAssessmentTabs();
  const activeTab =
    tabs.find(
      (tab) =>
        tab.getAttribute("aria-selected") === "true" ||
        tab.classList.contains("active") ||
        tab.classList.contains("selected")
    ) || null;
  return activeTab ? getAssessmentTabLabel(activeTab) : "";
}

function getVisibleAssessmentTabLabels() {
  return uniqueStrings(getVisibleAssessmentTabs().map(getAssessmentTabLabel));
}

function getVisibleAssessmentTabs() {
  const tabs = [];
  for (const frame of getAccessibleDocuments()) {
    if (frame.frame === "main") continue;

    frame.doc
      .querySelectorAll("[role='tab'], .tab")
      .forEach((tab) => {
        if (!isElementVisibleEnough(tab)) return;
        if (tab.closest(".accountingtool_navigationcarousel")) return;

        const label = getAssessmentTabLabel(tab);
        if (!label) return;
        if (/^(home|accessibility|preview)$/i.test(label)) return;

        tabs.push(tab);
      });
  }
  return tabs;
}

function getAssessmentTabLabel(tab) {
  return normalizeWhitespace(
    tab.innerText ||
      tab.textContent ||
      tab.getAttribute("aria-label") ||
      tab.getAttribute("title") ||
      ""
  );
}

function hasCurrentSkippedIndicator() {
  return /you skipped this question/i.test(document.body?.innerText || "");
}

function isPreviouslyCorrectQuestion() {
  return /you got this question right in the previous attempt/i.test(
    document.body?.innerText || ""
  );
}

function handleMultipleChoiceAnswer(answer) {
  const radioButtons = document.querySelectorAll('.answers--mc input[type="radio"]');
  const labels = document.querySelectorAll(".answers--mc .answer__label--mc");
  const answerText = getPrimaryAnswerText(answer);
  const normalizedAnswer = normalizeComparable(answerText);

  for (let i = 0; i < labels.length; i++) {
    const labelText = labels[i].textContent.trim().replace(/^[a-z]\s+/, "");
    const normalizedLabel = normalizeComparable(labelText);

    if (
      normalizedLabel === normalizedAnswer ||
      (normalizedLabel &&
        normalizedAnswer &&
        (normalizedLabel.includes(normalizedAnswer) ||
          normalizedAnswer.includes(normalizedLabel)))
    ) {
      if (!radioButtons[i]) {
        debugLog("multiple_choice_radio_missing", { answer, labelText }, "error");
        return false;
      }
      clickElement(radioButtons[i]);
      return true;
    }
  }

  debugLog("multiple_choice_no_match", { answer, answerText }, "error");
  return false;
}

function handleTrueFalseAnswer(answer) {
  const buttons = document.querySelectorAll(".answer--boolean");
  const normalizedAnswer = normalizeComparable(getPrimaryAnswerText(answer));
  const expected =
    answer === true || normalizedAnswer === "true"
      ? "true"
      : answer === false || normalizedAnswer === "false"
      ? "false"
      : "";
  if (!expected) {
    debugLog("true_false_invalid_answer", { answer }, "error");
    return false;
  }

  for (const button of buttons) {
    const buttonSpan = button.querySelector(".answer__button--boolean");
    if (!buttonSpan) {
      continue;
    }

    const fullText = buttonSpan.textContent;
    const buttonText = fullText.trim().split(",")[0].trim();

    if (
      (buttonText === "True" && expected === "true") ||
      (buttonText === "False" && expected === "false")
    ) {
      clickElement(button);
      return true;
    }
  }

  debugLog("true_false_no_match", { answer }, "error");
  return false;
}

async function handleFillInTheBlankAnswer(answer) {
  const inputField = document.querySelector(".answer--input__input");

  if (inputField) {
    await fillElement(inputField, getPrimaryAnswerText(answer));
    return true;
  }

  debugLog("fill_blank_input_missing", { answer }, "error");
  return false;
}

function getPrimaryAnswerText(answer) {
  if (Array.isArray(answer)) return answer[0] == null ? "" : String(answer[0]);
  if (answer == null) return "";
  if (typeof answer === "object" && "answer" in answer) {
    return getPrimaryAnswerText(answer.answer);
  }
  return String(answer);
}

function addAssistantButton() {
  const helpLink = document.querySelector(".header__help");
  const headerExits = document.querySelector(".header__exits");
  const insertionTarget = helpLink || headerExits || document.body;
  if (!insertionTarget) return;

  const buttonContainer = document.createElement("div");
  buttonContainer.className = "header__automcgraw";
  buttonContainer.style.cssText = `
    display: inline-flex;
    margin-right: 20px;
    align-items: center;
  `;

  const btn = document.createElement("button");
  btn.textContent = "Ask AI";
  btn.type = "button";
  btn.className = "header__automcgraw--main";
  btn.style.cssText = `
    background: #fff;
    border: 1px solid #ccc;
    color: #333;
    padding: 8px 12px;
    font-size: 14px;
    font-family: inherit;
    cursor: pointer;
    border-radius: 4px 0 0 4px;
    border-right: none;
    height: 32px;
    line-height: 1;
    text-decoration: none;
    display: inline-flex;
    align-items: center;
    transition: background-color 0.2s ease;
  `;

  btn.addEventListener("mouseenter", () => {
    btn.style.backgroundColor = "#f5f5f5";
  });

  btn.addEventListener("mouseleave", () => {
    btn.style.backgroundColor = "#fff";
  });

  btn.addEventListener("click", () => {
    if (isAutomating) {
      stopAutomation("Manual stop");
    } else {
      const proceed = confirm(
        "Start automation with your selected AI assistant? It will answer the current item and continue forward when possible.\n\nClick OK to begin, or Cancel to stop."
      );
      if (proceed) {
        isAutomating = true;
        answeredQuestionNumbers = new Set();
        answeredAssessmentWorkUnitIds = new Set();
        lastAnswerActionAt = 0;
        awaitingAiResponse = false;
        processingAiResponse = false;
        btn.textContent = "Stop Automation";
        checkForNextStep();
      }
    }
  });

  const settingsBtn = document.createElement("button");
  settingsBtn.type = "button";
  settingsBtn.className = "header__automcgraw--settings";
  settingsBtn.title = "Auto-McGraw Settings";
  settingsBtn.setAttribute("aria-label", "Auto-McGraw Settings");
  settingsBtn.style.cssText = `
    background: #fff;
    border: 1px solid #ccc;
    color: #333;
    padding: 8px 10px;
    font-size: 14px;
    cursor: pointer;
    border-radius: 0 4px 4px 0;
    height: 32px;
    line-height: 1;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    transition: background-color 0.2s ease;
  `;

  settingsBtn.addEventListener("mouseenter", () => {
    settingsBtn.style.backgroundColor = "#f5f5f5";
  });

  settingsBtn.addEventListener("mouseleave", () => {
    settingsBtn.style.backgroundColor = "#fff";
  });

  settingsBtn.innerHTML = `
    <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <circle cx="12" cy="12" r="3"></circle>
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06-.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"></path>
    </svg>
  `;

  settingsBtn.addEventListener("click", () => {
    chrome.runtime.sendMessage({ type: "openSettings" });
  });

  buttonContainer.appendChild(btn);
  buttonContainer.appendChild(settingsBtn);

  if (helpLink && helpLink.parentNode) {
    helpLink.parentNode.insertBefore(buttonContainer, helpLink);
  } else if (headerExits) {
    headerExits.insertBefore(buttonContainer, headerExits.firstChild);
  } else {
    document.body.appendChild(buttonContainer);
  }
}

function getElementLabel(element) {
  const doc = element.ownerDocument;
  const id = element.id;
  const explicitLabel = id
    ? doc.querySelector(attributeSelector("for", id))
    : null;

  return normalizeWhitespace(
    element.getAttribute("aria-label") ||
      element.getAttribute("title") ||
      element.getAttribute("placeholder") ||
      explicitLabel?.textContent ||
      element.getAttribute("alt") ||
      element.value ||
      element.innerText ||
      element.textContent ||
      ""
  );
}

function getNearbyText(element) {
  const container =
    element.closest("tr") ||
    element.closest("fieldset") ||
    element.closest("li") ||
    element.closest(".question-wrap") ||
    element.parentElement;

  if (!container) return "";

  const clone = container.cloneNode(true);
  clone.querySelectorAll(".header__automcgraw, script, style, svg").forEach((node) => node.remove());
  return limitText(normalizeWhitespace(clone.innerText || clone.textContent || ""), 700);
}

function getElementValue(element) {
  if ("value" in element) return element.value || "";
  return normalizeWhitespace(element.textContent || "");
}

function extractVisibleText(doc) {
  const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const parent = node.parentElement;
      if (!parent) return NodeFilter.FILTER_REJECT;
      if (parent.closest(".header__automcgraw")) return NodeFilter.FILTER_REJECT;
      if (parent.closest("script, style, noscript, svg")) return NodeFilter.FILTER_REJECT;
      if (parent.closest("[hidden], [aria-hidden='true']")) return NodeFilter.FILTER_REJECT;
      if (isAccountingNavigationText(parent)) return NodeFilter.FILTER_REJECT;
      if (!isElementVisibleEnough(parent)) return NodeFilter.FILTER_REJECT;
      if (!normalizeWhitespace(node.textContent)) return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    },
  });

  const parts = [];
  let node = walker.nextNode();
  while (node) {
    parts.push(node.textContent);
    node = walker.nextNode();
  }

  return limitText(normalizeWhitespace(parts.join(" ")), MAX_TEXT_LENGTH);
}

function isAccountingNavigationText(element) {
  return Boolean(
    element.closest(
      ".accountingtool_navigationcarousel .control_buttons, .accountingtool_navigationcarousel .prev, .accountingtool_navigationcarousel .next, .accountingtool_navigationcarousel .icon-Prv, .accountingtool_navigationcarousel .icon-Next"
    )
  );
}

function isElementVisibleEnough(element) {
  const doc = element.ownerDocument;
  const view = doc.defaultView;
  if (!view) return true;

  if (
    element.closest(
      "[hidden], [aria-hidden='true'], [data-automcgraw-hidden-duplicate='true']"
    )
  ) {
    return false;
  }

  const style = view.getComputedStyle(element);
  if (
    style.display === "none" ||
    style.visibility === "hidden" ||
    style.opacity === "0"
  ) {
    return false;
  }

  if (element.hasAttribute("hidden")) return false;
  const rect = element.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0;
}

function isStaleAccountingClone(element) {
  if (!element?.closest) return false;
  if (element.closest("[data-automcgraw-hidden-duplicate='true']")) return true;

  const table = element.closest("table");
  if (
    table?.id === "holisticTable" &&
    !isElementVisibleEnough(table)
  ) {
    return true;
  }

  const sheet = element.closest("#holisticSheet");
  return Boolean(sheet && !isElementVisibleEnough(sheet));
}

function normalizeWhitespace(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function normalizeComparable(value) {
  return normalizeWhitespace(value)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

function uniqueStrings(values) {
  const seen = new Set();
  const result = [];
  values.forEach((value) => {
    const text = normalizeWhitespace(value);
    const key = normalizeComparable(text);
    if (!text || seen.has(key)) return;
    seen.add(key);
    result.push(text);
  });
  return result;
}

function limitText(text, maxLength) {
  const value = normalizeWhitespace(text);
  if (value.length <= maxLength) return value;
  return value.slice(0, maxLength) + "...";
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function attributeSelector(name, value) {
  return `[${name}='${String(value).replace(/\\/g, "\\\\").replace(/'/g, "\\'")}']`;
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

setupMessageListener();
startPageObserver();

if (isAutomating) {
  setTimeout(() => {
    checkForNextStep();
  }, 1000);
}
