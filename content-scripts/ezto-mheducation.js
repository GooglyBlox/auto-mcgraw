// ============================================================================
// Auto-McGraw — Connect / EZTo content script
//
// Architecture: slot-graph.
//
// The page-side owns all DOM knowledge. It snapshots the active subunit as a
// graph of fillable slots — each slot describes WHAT to fill (kind, label,
// options, hint) but never exposes a selector. The AI receives only the slot
// graph and replies with {slots: {id: value}}. The page-side then applies
// each value through its private slot map and runs a deterministic navigator
// to advance: in-tool save → next transaction → next required tab → main
// Next → final Submit.
//
// This keeps the AI's job to "know the answer." Action sanitization, premature
// Submit guards, and worksheet label/amount pairing all disappear because the
// AI never gets to drive the DOM.
// ============================================================================

let messageListener = null;
let isAutomating = false;
let buttonAdded = false;
let slotIdCounter = 1;
let lastSlotMap = new Map();
let lastSnapshot = null;
let awaitingAiResponse = false;
let processingAiResponse = false;
let consecutiveSetupClicks = 0;
let consecutiveEmptySnapshots = 0;
let lastVisitedQuestionNumber = null;
let answeredTabsForCurrentQuestion = new Set();
const dropdownOptionsCache = new WeakMap();

const SLOT_ATTR = "data-automcgraw-slot";
const MAX_TEXT_LENGTH = 18000;
const MAX_SLOTS = 120;
const MAX_SETUP_CLICKS = 4;
const MAX_EMPTY_SNAPSHOTS = 3;
const DEBUG_LOG_KEY = "automcgraw.debugLogs.v1";
const DEBUG_MAX_LOGS = 600;
const DEFAULT_AI_MODEL = "chatgpt";

document.documentElement.setAttribute("data-automcgraw-ezto-loaded", "true");
window.__automcgrawDebugLogs = window.__automcgrawDebugLogs || [];

// ============================================================================
// Debug logging
// ============================================================================

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
    button:
      document.querySelector(".header__automcgraw--main")?.textContent?.trim() ||
      "",
    progress:
      document.querySelector(".footer__progress__heading")?.innerText?.trim() ||
      "",
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
    slot: element.getAttribute(SLOT_ATTR) || "",
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

// ============================================================================
// Message listener + debug bridge
// ============================================================================

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
      handleAiResponse(message.response)
        .then(() => {
          debugLog("process_response_message_complete");
          sendResponse({ received: true });
        })
        .catch((error) => {
          debugLog("process_response_message_error", { error }, "error");
          console.error("Error processing AI response:", error);
          stopAutomation("Error processing AI response: " + error.message);
          sendResponse({ received: false, error: error.message });
        });
      return true;
    }

    if (message.type === "stopAutomation") {
      debugLog("stop_message", {
        reason: message.reason || "Automation stopped",
      });
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
      chrome.runtime.sendMessage(
        chrome.runtime.id,
        { type: "getBackgroundDebugLogs" },
        (response) => {
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
        }
      );
    } catch (error) {
      payload.backgroundError = error.message;
      window.postMessage(payload, "*");
    }
  });
}

setupDebugBridge();

// ============================================================================
// Page detection + button injection
// ============================================================================

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
    const match = progressInfo.textContent.match(/(\d+)\s+of\s+(\d+)/);
    if (match) {
      const current = parseInt(match[1], 10);
      const total = parseInt(match[2], 10);
      if (current > total) return true;
    }
  }
  return false;
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

function getDisableAutoSubmit() {
  return new Promise((resolve) => {
    try {
      chrome.storage.sync.get("disableAutoSubmit", (data) => {
        resolve(Boolean(data?.disableAutoSubmit));
      });
    } catch (error) {
      debugLog("disable_auto_submit_fallback", { error }, "warn");
      resolve(false);
    }
  });
}

// ============================================================================
// Top-level flow
// ============================================================================

function stopAutomation(reason = "Quiz completed") {
  debugLog("automation_stop", { reason });
  isAutomating = false;
  awaitingAiResponse = false;
  processingAiResponse = false;
  consecutiveSetupClicks = 0;
  consecutiveEmptySnapshots = 0;
  lastSlotMap = new Map();
  lastSnapshot = null;

  const btn = document.querySelector(".header__automcgraw--main");
  if (btn) btn.textContent = "Ask AI";

  if (reason) alert(`Automation stopped: ${reason}`);
}

async function checkForNextStep() {
  if (!isAutomating) return;
  if (awaitingAiResponse || processingAiResponse) {
    debugLog("next_step_waiting", { awaitingAiResponse, processingAiResponse });
    return;
  }

  if (isAssignmentSubmittedPage()) {
    stopAutomation("Assignment already submitted");
    return;
  }

  await waitForConnectContentReady();

  // Reset per-question scratch when the question number rolls over.
  const questionNumber = getCurrentQuestionNumber() || getProgress()?.current;
  if (questionNumber && questionNumber !== lastVisitedQuestionNumber) {
    lastVisitedQuestionNumber = questionNumber;
    answeredTabsForCurrentQuestion = new Set();
  }

  // SmartBook quiz path (legacy, simple).
  if (isQuizPage()) {
    const questionData = parseQuestion();
    if (!questionData) {
      stopAutomation("No question found");
      return;
    }
    sendToAi(questionData);
    return;
  }

  // Connect path: build slot graph snapshot.
  await delay(800); // settle buffer for embedded tools
  const snapshot = await buildSlotGraphSnapshot();

  if (!snapshot || !snapshot.slots.length) {
    consecutiveEmptySnapshots++;
    debugLog("snapshot_empty", {
      consecutiveEmptySnapshots,
      pageTextLength: snapshot?.pageText?.length || 0,
    });

    // 1. Re-snapshot first — embedded tools sometimes briefly render no
    //    controls between sub-problems or right after Record entry.
    if (consecutiveEmptySnapshots < MAX_EMPTY_SNAPSHOTS) {
      setTimeout(() => checkForNextStep(), 1500);
      return;
    }

    // 2. Persistent empty: try clicking a setup-reveal button (Edit
    //    worksheet, Add transaction, etc.).
    const setupButton = findSetupRevealButton();
    if (setupButton && consecutiveSetupClicks < MAX_SETUP_CLICKS) {
      consecutiveSetupClicks++;
      debugLog("setup_button_click", { setupButton, consecutiveSetupClicks });
      clickElement(setupButton);
      consecutiveEmptySnapshots = 0;
      setTimeout(() => checkForNextStep(), 1500);
      return;
    }

    // 3. Try to navigate forward (next tab → main Next → submit).
    const advanced = await navigateForward({ filledSlots: false });
    if (advanced) {
      consecutiveEmptySnapshots = 0;
      setTimeout(() => checkForNextStep(), 1500);
      return;
    }

    stopAutomation("No answerable fields and no way to advance");
    return;
  }

  consecutiveSetupClicks = 0;
  consecutiveEmptySnapshots = 0;
  lastSnapshot = snapshot;

  debugLog("snapshot_ready", {
    slotCount: snapshot.slots.length,
    slotKinds: snapshot.slots.map((s) => s.kind),
    pageTextLength: snapshot.pageText.length,
    activeAssessmentTab: getActiveAssessmentTabLabel(),
    visibleAssessmentTabs: getVisibleAssessmentTabLabels(),
  });

  sendToAi(snapshot.question);
}

function sendToAi(question) {
  awaitingAiResponse = true;
  setAutomationDiagnostic(`sending_to_ai:${question.type}`);
  getSelectedAiModel().then((aiModel) => {
    debugLog("send_to_ai", {
      type: question.type,
      slotCount: question.slots?.length || 0,
      aiModel,
    });
    chrome.runtime.sendMessage(
      {
        type: "sendQuestionToChatGPT",
        question,
        aiModel,
      },
      (response) => {
        if (chrome.runtime.lastError || !response?.received) {
          awaitingAiResponse = false;
          debugLog(
            "send_to_ai_failed",
            { error: chrome.runtime.lastError?.message || "", response },
            "error"
          );
          stopAutomation("Could not send question to the selected AI assistant");
        }
      }
    );
  });
}

async function handleAiResponse(responseText) {
  if (!isAutomating) {
    debugLog("response_ignored_not_automating");
    return;
  }

  awaitingAiResponse = false;
  processingAiResponse = true;
  setAutomationDiagnostic("processing_response");

  try {
    const parsed = parseJsonResponse(responseText);
    if (!parsed || typeof parsed !== "object") {
      throw new Error("AI response was not a JSON object");
    }

    debugLog("response_parsed", {
      hasSlots: Boolean(parsed.slots),
      slotCount: parsed.slots ? Object.keys(parsed.slots).length : 0,
      hasAnswer: parsed.answer !== undefined,
      hasActions: Array.isArray(parsed.actions),
      page: isQuizPage() ? "smartbook" : "connect",
    });

    // SmartBook legacy path (multiple_choice, true_false, fill_in_the_blank).
    if (isQuizPage()) {
      await applyLegacySmartBookAnswer(parsed.answer);
      await continueSmartBookAfterAnswer();
      return;
    }

    // Connect slot-graph path.
    const slotAnswers = extractSlotAnswers(parsed);
    const filledAny = await applySlots(slotAnswers);

    debugLog("response_slots_applied", {
      slotAnswerCount: Object.keys(slotAnswers).length,
      filledAny,
    });

    // Hand off to the navigator. The navigator decides when a tab is fully
    // answered (after the last carousel sub-problem, or after a single
    // fill+save when there is no carousel).
    await navigateForward({ filledSlots: filledAny });
    setTimeout(() => {
      if (isAutomating) checkForNextStep();
    }, 1500);
  } finally {
    processingAiResponse = false;
  }
}

// ============================================================================
// JSON response parsing
// ============================================================================

function parseJsonResponse(responseText) {
  if (typeof responseText !== "string") return responseText;
  try {
    return JSON.parse(responseText);
  } catch (error) {
    const match = responseText.match(/\{[\s\S]*\}/);
    if (match) return JSON.parse(match[0]);
    throw error;
  }
}

function extractSlotAnswers(parsed) {
  if (parsed.slots && typeof parsed.slots === "object") {
    return parsed.slots;
  }
  // Tolerate older response shapes: {answer: {label1: value1, ...}}.
  if (parsed.answer && typeof parsed.answer === "object" && !Array.isArray(parsed.answer)) {
    return parsed.answer;
  }
  // Tolerate {answer: "single value"} when there is exactly one slot.
  if (
    typeof parsed.answer === "string" &&
    lastSlotMap.size === 1
  ) {
    const onlyId = lastSlotMap.keys().next().value;
    return { [onlyId]: parsed.answer };
  }
  return {};
}

// ============================================================================
// Slot graph builder
// ============================================================================

async function buildSlotGraphSnapshot() {
  // Reset slot state for this snapshot.
  lastSlotMap = new Map();
  slotIdCounter = 1;
  clearStaleSlotAttributes();

  const frames = getAccessibleDocuments();
  frames.forEach((frame) => prepareDocumentForSnapshot(frame.doc));

  const pageSections = [];
  for (const frame of frames) {
    const text = extractVisibleText(frame.doc);
    if (text) pageSections.push(`${frame.label}:\n${text}`);
  }
  const pageText = limitText(pageSections.join("\n\n"), MAX_TEXT_LENGTH);

  const promptText = extractQuestionPrompt(frames) || pageText.slice(0, 4000);

  // Collect candidate elements first; group radios/checkboxes by name; then
  // describe each unique slot.
  const radioGroups = new Map(); // key: `${frame}|${name}` -> {kind, name, radios[], frame}
  const candidates = [];

  for (const frame of frames) {
    const elements = getInteractiveElements(frame.doc);
    for (const element of elements) {
      if (candidates.length + radioGroups.size >= MAX_SLOTS) break;
      if (isNavigationChrome(element)) continue;

      const tag = element.tagName.toLowerCase();
      const type = (element.getAttribute("type") || "").toLowerCase();
      const role = (element.getAttribute("role") || "").toLowerCase();
      const name = element.getAttribute("name") || "";

      if (
        (tag === "input" && (type === "radio" || type === "checkbox")) ||
        role === "radio" ||
        role === "checkbox"
      ) {
        const groupKind =
          type === "checkbox" || role === "checkbox" ? "checkbox" : "radio";
        const groupKey = `${frame.frame}|${groupKind}|${name || `solo-${candidates.length}-${radioGroups.size}`}`;
        let group = radioGroups.get(groupKey);
        if (!group) {
          group = { kind: groupKind, name, frame, items: [] };
          radioGroups.set(groupKey, group);
        }
        group.items.push(element);
        continue;
      }

      candidates.push({ element, frame });
    }
  }

  const slots = [];

  // Emit one slot per radio/checkbox group.
  for (const [, group] of radioGroups) {
    const slot = describeChoiceGroup(group);
    if (slot) {
      lastSlotMap.set(slot.id, slot);
      slots.push(toAiSlot(slot));
    }
  }

  // Emit slots for the remaining candidates.
  for (const { element, frame } of candidates) {
    if (slots.length >= MAX_SLOTS) break;
    const slot = await describeSingleSlot(element, frame);
    if (!slot) continue;
    lastSlotMap.set(slot.id, slot);
    slots.push(toAiSlot(slot));
  }

  return {
    slots,
    pageText,
    question: {
      type: "connect_slot_graph",
      prompt: promptText,
      context: pageText,
      slots,
      previousCorrection: null,
    },
  };
}

function clearStaleSlotAttributes() {
  for (const frame of getAccessibleDocuments()) {
    frame.doc.querySelectorAll(`[${SLOT_ATTR}]`).forEach((el) => {
      el.removeAttribute(SLOT_ATTR);
    });
  }
}

function extractQuestionPrompt(frames) {
  // Prefer the main page's `.question-wrap` text; fall back to the first
  // visible iframe's intro text.
  const mainFrame = frames.find((f) => f.frame === "main");
  if (mainFrame) {
    const wrap = mainFrame.doc.querySelector(".question-wrap, .question");
    if (wrap) {
      return limitText(
        normalizeWhitespace(wrap.innerText || wrap.textContent || ""),
        4000
      );
    }
  }
  const embedded = frames.find((f) => f.frame !== "main");
  if (embedded) {
    return limitText(
      normalizeWhitespace(
        embedded.doc.body?.innerText || embedded.doc.body?.textContent || ""
      ),
      4000
    );
  }
  return "";
}

async function describeSingleSlot(element, frame) {
  const id = assignSlotId(element);
  const tag = element.tagName.toLowerCase();
  const dropdownLike = isDropdownLike(element);
  const cellContext = isAnswerCell(element)
    ? getSpreadsheetCellContext(element)
    : null;

  let kind;
  let options = [];

  if (dropdownLike || tag === "select") {
    kind = "dropdown";
    options = await getOptionsForControl(element, frame.doc);
  } else if (isSpreadsheetFillCell(element)) {
    // Numeric vs text — we don't always know, so report "number" if the
    // column header looks numeric, else "text".
    const headerText = cellContext?.headerText || "";
    const looksNumeric = /\b(amount|debit|credit|balance|total|price|cost|quantity|qty|value)\b/i.test(
      headerText
    );
    kind = looksNumeric ? "number" : "text";
  } else if (tag === "textarea") {
    kind = "text";
  } else if (tag === "input") {
    const type = (element.getAttribute("type") || "text").toLowerCase();
    kind = type === "number" ? "number" : "text";
  } else if (element.isContentEditable) {
    kind = "text";
  } else {
    // Plain button / link with no options — treat as a click-only "action"
    // slot only if it looks like an answer choice button (rare). Otherwise
    // skip; the navigator handles plain buttons.
    return null;
  }

  const text = normalizeWhitespace(
    element.innerText || element.textContent || element.value || ""
  );
  const label = getElementLabel(element);
  const nearbyText = getNearbyText(element);
  const groupHint = buildSlotHint(element, cellContext);

  if (!label && !text && !nearbyText && !options.length && !cellContext) {
    return null;
  }

  return {
    id,
    kind,
    element,
    frame: frame.frame,
    options,
    label: label || cellContext?.label || "",
    text,
    nearbyText,
    hint: groupHint,
    group: cellContext ? `row${cellContext.rowIndex}` : "",
    groupRole: cellContext ? roleForCell(cellContext) : "",
    cellContext,
  };
}

function describeChoiceGroup(group) {
  const items = group.items.filter((el) => isElementVisibleEnough(el));
  if (!items.length) return null;

  const id = `g${slotIdCounter++}`;
  const choices = items.map((el) => {
    const label = getRadioOptionLabel(el);
    el.setAttribute(SLOT_ATTR, id);
    return { value: label, element: el };
  });
  const options = choices.map((c) => c.value).filter(Boolean);
  if (!options.length) return null;

  // Build a label / hint from the surrounding fieldset or first ancestor
  // that contains a question-ish text.
  const sample = items[0];
  const fieldset = sample.closest("fieldset, [role='radiogroup'], .question, .question-wrap");
  const label = fieldset
    ? normalizeWhitespace(
        fieldset.querySelector("legend, .question-prompt")?.innerText ||
          fieldset.querySelector("legend, .question-prompt")?.textContent ||
          ""
      ) || getElementLabel(sample)
    : getElementLabel(sample);
  const nearbyText = getNearbyText(sample);

  return {
    id,
    kind: group.kind === "checkbox" ? "multi_choice" : "choice",
    element: null, // resolved per-choice via choices[].element
    frame: group.frame.frame,
    options,
    choices, // private: id never sent to AI
    label,
    text: "",
    nearbyText,
    hint: label || nearbyText.slice(0, 120),
    group: "",
    groupRole: "",
    cellContext: null,
  };
}

function getRadioOptionLabel(radio) {
  const doc = radio.ownerDocument;
  const id = radio.id;
  const explicitLabel = id
    ? doc.querySelector(`label[for='${cssEscape(id)}']`)
    : null;
  const wrapping = radio.closest("label");

  const text =
    explicitLabel?.innerText ||
    explicitLabel?.textContent ||
    wrapping?.innerText ||
    wrapping?.textContent ||
    radio.getAttribute("aria-label") ||
    radio.value ||
    "";

  return normalizeWhitespace(text).replace(/^[a-z]\s+/, "");
}

function assignSlotId(element) {
  const id = `s${slotIdCounter++}`;
  element.setAttribute(SLOT_ATTR, id);
  return id;
}

function buildSlotHint(element, cellContext) {
  if (cellContext) {
    const parts = [];
    parts.push(`row ${cellContext.rowIndex + 1}`);
    if (cellContext.headerText) parts.push(cellContext.headerText);
    if (cellContext.leftText) parts.push(`right of "${cellContext.leftText}"`);
    return parts.join(", ");
  }
  return "";
}

function roleForCell(cellContext) {
  const header = (cellContext.headerText || "").toLowerCase();
  if (/debit/.test(header)) return "debit";
  if (/credit/.test(header)) return "credit";
  if (/account|description|item|label|name/.test(header)) return "label";
  if (/amount|balance|total|value/.test(header)) return "amount";
  return "";
}

function toAiSlot(slot) {
  // The AI sees only this — no DOM references, no selectors.
  const out = {
    id: slot.id,
    kind: slot.kind,
    label: slot.label || slot.hint || "",
  };
  if (slot.hint && slot.hint !== out.label) out.hint = slot.hint;
  if (slot.group) out.group = slot.group;
  if (slot.groupRole) out.groupRole = slot.groupRole;
  if (slot.options?.length) out.options = slot.options;
  if (slot.nearbyText && !out.label.includes(slot.nearbyText.slice(0, 30))) {
    out.context = limitText(slot.nearbyText, 240);
  }
  return out;
}

// ============================================================================
// Navigation chrome filter (don't expose Next/Submit/Save/tabs as slots)
// ============================================================================

function isNavigationChrome(element) {
  if (isCheckMyWorkControl(element)) return true;
  if (isAccountingNavigationControl(element)) return true;
  if (isStaleAccountingClone(element)) return true;
  if (element.closest(".header__automcgraw")) return true;

  const tag = element.tagName.toLowerCase();
  const role = element.getAttribute("role") || "";
  const isTabRole = role === "tab" || element.closest("[role='tablist']");
  if (isTabRole) return true;

  // Top-level Next/Submit/Hand-in.
  if (element.closest(".footer__navigation--wrap")) return true;
  if (element.closest(".header__exits")) return true;

  // In-tool save/record buttons (the navigator clicks these directly).
  const text = getControlText(element).toLowerCase();
  if (
    /\b(record entry|save entry|save transaction|record transaction|save & next|next part|save and next)\b/i.test(
      text
    )
  ) {
    return true;
  }

  // Generic "click to navigate" buttons we don't want the AI to drive.
  if (
    (tag === "button" || tag === "a" || role === "button") &&
    /^(next|submit|continue|finish|done|hand in|save|cancel|close)$/i.test(
      text.trim()
    )
  ) {
    return true;
  }

  return false;
}

// ============================================================================
// Slot executor
// ============================================================================

async function applySlots(slotAnswers) {
  let filledAny = false;
  const entries = Object.entries(slotAnswers || {});
  debugLog("apply_slots_start", {
    answerCount: entries.length,
    slotMapSize: lastSlotMap.size,
  });

  for (const [slotId, value] of entries) {
    const slot = lastSlotMap.get(slotId);
    if (!slot) {
      debugLog("apply_slot_unknown_id", { slotId, value }, "warn");
      continue;
    }
    if (value == null || (typeof value === "string" && value.trim() === "")) {
      debugLog("apply_slot_blank", { slotId });
      continue;
    }

    try {
      setAutomationDiagnostic(`apply:${slotId}:${slot.kind}`);
      await applySlot(slot, value);
      filledAny = true;
    } catch (error) {
      debugLog(
        "apply_slot_error",
        { slotId, kind: slot.kind, value, error },
        "error"
      );
    }
    await delay(200);
  }

  debugLog("apply_slots_complete", { filledAny });
  return filledAny;
}

async function applySlot(slot, value) {
  if (slot.kind === "choice" || slot.kind === "multi_choice") {
    await applyChoiceSlot(slot, value);
    return;
  }

  // Resolve the element through the slot attribute (robust to DOM rebuilds).
  const element = resolveSlotElement(slot);
  if (!element) {
    throw new Error(`Slot element not found: ${slot.id}`);
  }

  if (slot.kind === "dropdown") {
    await selectElementValue(element, String(value));
    return;
  }

  if (slot.kind === "number") {
    await fillElement(element, formatNumberForCell(value));
    return;
  }

  await fillElement(element, String(value));
}

async function applyChoiceSlot(slot, value) {
  const wanted = Array.isArray(value) ? value : [value];
  const wantedNorm = wanted.map((v) => normalizeComparable(String(v)));

  for (const choice of slot.choices) {
    const choiceNorm = normalizeComparable(choice.value);
    const matched = wantedNorm.some(
      (w) =>
        choiceNorm === w ||
        (choiceNorm && w && (choiceNorm.includes(w) || w.includes(choiceNorm)))
    );
    if (!matched) continue;
    const target = resolveAnyElement(choice.element);
    if (!target) {
      debugLog("apply_choice_element_missing", { slot, choice }, "warn");
      continue;
    }
    clickElement(target);
    if (slot.kind === "choice") return;
  }
}

function resolveSlotElement(slot) {
  if (slot.element && slot.element.isConnected) return slot.element;
  for (const frame of getAccessibleDocuments()) {
    const found = frame.doc.querySelector(`[${SLOT_ATTR}='${slot.id}']`);
    if (found) return found;
  }
  return null;
}

function resolveAnyElement(element) {
  if (element?.isConnected) return element;
  const slotId = element?.getAttribute?.(SLOT_ATTR);
  if (!slotId) return null;
  for (const frame of getAccessibleDocuments()) {
    const found = frame.doc.querySelector(`[${SLOT_ATTR}='${slotId}']`);
    if (found) return found;
  }
  return null;
}

function formatNumberForCell(value) {
  // Pass through strings unchanged — AI is instructed to use parentheses for
  // negatives. Convert numbers to strings.
  if (typeof value === "number") {
    if (value < 0) return `(${Math.abs(value)})`;
    return String(value);
  }
  return String(value);
}

// ============================================================================
// Navigator (deterministic post-apply)
// ============================================================================

async function navigateForward({ filledSlots }) {
  setAutomationDiagnostic(`navigate:filled=${filledSlots}`);
  debugLog("navigate_start", { filledSlots });

  // 1. If we just filled slots, save in-tool first. Then decide whether the
  //    save left us with more sub-problems in the same Required tab (the
  //    accounting-tool transaction carousel) or whether the tab is finished.
  if (filledSlots) {
    const saveButton = findInToolSaveButton();
    if (saveButton) {
      const beforeActiveNumber = getActiveTransactionNumberAcrossFrames();
      const beforeActiveTab = getActiveAssessmentTabLabel();
      debugLog("navigate_in_tool_save", {
        saveButton,
        beforeActiveNumber,
        beforeActiveTab,
      });
      clickElement(saveButton);
      await waitForInToolSaveToSettle();

      const stillInCarousel = await advanceWithinCarouselAfterSave(
        beforeActiveNumber
      );
      if (stillInCarousel) {
        debugLog("navigate_carousel_continue", {
          beforeActiveNumber,
          afterActiveNumber: getActiveTransactionNumberAcrossFrames(),
        });
        return true;
      }

      // Carousel exhausted (or no carousel at all) — this tab's work is done.
      markActiveTabAnswered();
    } else {
      // No in-tool save button on this tab — McGraw auto-saves on tab switch
      // (and the embedded tool's "Next" button does the same). Mark the
      // active tab answered so findNextRequiredTab doesn't loop back to it
      // when we land on the following tab.
      debugLog("navigate_no_in_tool_save_mark_answered");
      markActiveTabAnswered();
    }
  }

  // 2. Move to the next un-visited Required tab on the current question.
  const nextTab = findNextRequiredTab();
  if (nextTab) {
    debugLog("navigate_next_required_tab", { nextTab });
    clickElement(nextTab);
    return true;
  }

  // 3. Click main-page Next.
  const mainNext = findMainNextButton();
  if (mainNext) {
    debugLog("navigate_main_next", { mainNext });
    clickElement(mainNext);
    if (checkForQuizEnd()) {
      stopAutomation("Quiz completed - all questions answered");
      return true;
    }
    return true;
  }

  // 4. Final assignment Submit.
  const submit = findMainSubmitButton();
  if (submit && canAutoSubmitAssignment()) {
    if (await getDisableAutoSubmit()) {
      debugLog("navigate_submit_disabled_by_setting", { submit });
      setAutomationDiagnostic("auto_submit_disabled");
      stopAutomation(
        "Auto-submit is disabled in settings. Review your answers and submit manually."
      );
      return true;
    }
    debugLog("navigate_submit", { submit });
    clickElement(submit);
    await delay(800);
    await confirmSubmitIfPresent();
    stopAutomation("Assignment submitted");
    return true;
  }

  if (submit) {
    debugLog("navigate_submit_blocked", {}, "warn");
  }

  return false;
}

// After clicking Record entry, decide whether to stay inside the current
// Required tab's carousel or treat it as done. Returns true if there's more
// work to do here (caller should not advance to a new tab).
async function advanceWithinCarouselAfterSave(beforeActiveNumber) {
  // No carousel on this tab — nothing to wait for.
  if (beforeActiveNumber == null) return false;

  // McGraw usually auto-advances after Record entry. Poll briefly for the
  // active transaction number to change.
  for (let i = 0; i < 10; i++) {
    const currentActive = getActiveTransactionNumberAcrossFrames();
    if (currentActive != null && currentActive !== beforeActiveNumber) {
      // Only treat the carousel as "still ongoing" when active moved STRICTLY
      // FORWARD and the new active is un-entered. A backwards jump (McGraw
      // bouncing to a recorded transaction after the last save) means we are
      // done with this tab's sub-problems.
      if (
        currentActive > beforeActiveNumber &&
        activeTransactionIsUnentered()
      ) {
        return true;
      }
      return false;
    }
    await delay(150);
  }

  // No auto-advance. If the "Move to next transaction" arrow is enabled,
  // there's another transaction in this tab's carousel — click it.
  for (const frame of getAccessibleDocuments()) {
    if (frame.frame === "main") continue;
    const arrow = findTransactionNextArrow(frame.doc);
    if (arrow) {
      debugLog("navigate_carousel_next_arrow_click", { arrow });
      clickElement(arrow);
      await delay(400);
      return true;
    }
  }

  // Arrow disabled or absent — carousel is done.
  return false;
}

function getActiveTransactionNumberAcrossFrames() {
  for (const frame of getAccessibleDocuments()) {
    if (frame.frame === "main") continue;
    const n = getActiveTransactionNumber(frame.doc);
    if (n != null) return n;
  }
  return null;
}

function activeTransactionIsUnentered() {
  for (const frame of getAccessibleDocuments()) {
    if (frame.frame === "main") continue;
    const active = getActiveTransactionButton(frame.doc);
    if (!active) continue;
    const text = getControlText(active, { preferAriaLabel: true });
    if (/\bnot yet entered\b/i.test(text)) return true;
    if (/\bentry entered\b/i.test(text)) return false;
    // Active button with no annotation: assume un-entered (we just got here).
    return true;
  }
  return false;
}

function markActiveTabAnswered() {
  const tab = getActiveAssessmentTabLabel();
  if (tab) {
    const key = normalizeComparable(tab);
    answeredTabsForCurrentQuestion.add(key);
    debugLog("mark_active_tab_answered", { tab, key });
  }
}

function findInToolSaveButton() {
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
      return /\b(record entry|save entry|record transaction|save transaction|save & next)\b/i.test(
        text
      );
    });
    if (match) return match;
  }
  return null;
}

function findSetupRevealButton() {
  // Buttons that reveal the actual answer editor — clicking them is
  // deterministic when the snapshot turns up zero slots.
  //
  // We deliberately exclude "View transaction list" / "View general journal":
  // those toggle view modes inside the accounting tool and would hide the
  // active answer editor rather than reveal one.
  for (const frame of getAccessibleDocuments()) {
    const controls = Array.from(
      frame.doc.querySelectorAll(
        "button, input[type='button'], a[href], [role='button']"
      )
    );
    const match = controls.find((element) => {
      if (!isElementVisibleEnough(element)) return false;
      if (isDisabledControl(element)) return false;
      if (isNavigationChrome(element)) return false;
      const text = getControlText(element);
      return (
        /\bedit\b.*\bworksheet\b/i.test(text) ||
        /\bview\b.*\bjournal entry worksheet\b/i.test(text) ||
        /\bopen\b.*\bworksheet\b/i.test(text) ||
        /\badd\b.*\b(transaction|entry|row|requirement)\b/i.test(text)
      );
    });
    if (match) return match;
  }
  return null;
}

async function waitForInToolSaveToSettle(timeout = 5000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeout) {
    if (hasInToolSaveCompleted()) return true;
    await delay(250);
  }
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

function findTransactionNextArrow(doc) {
  return Array.from(
    doc.querySelectorAll(
      ".accountingtool_navigationcarousel [aria-label*='Move to next transaction'], .accountingtool_navigationcarousel .next, .accountingtool_navigationcarousel .icon-Nxt"
    )
  ).find((control) => isElementVisibleEnough(control) && !isDisabledControl(control));
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
  return parseTransactionNumberText(
    button.getAttribute("aria-label") ||
      button.innerText ||
      button.textContent ||
      ""
  );
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

function findNextRequiredTab() {
  const tabs = getVisibleAssessmentTabs();
  if (!tabs.length) return null;

  for (const tab of tabs) {
    const label = normalizeComparable(getAssessmentTabLabel(tab));
    if (!label) continue;
    if (answeredTabsForCurrentQuestion.has(label)) continue;
    const isActive =
      tab.getAttribute("aria-selected") === "true" ||
      tab.classList.contains("active") ||
      tab.classList.contains("selected");
    if (isActive) continue;
    return tab;
  }
  return null;
}

function findMainNextButton() {
  const candidates = [
    document.querySelector(".footer__link--next:not([hidden])"),
    findButtonByText(/^next$/i, ".footer__navigation--wrap"),
  ].filter(Boolean);

  return candidates.find(
    (b) =>
      isElementVisibleEnough(b) && !isDisabledControl(b) && !b.disabled
  );
}

function findMainSubmitButton() {
  return findButtonByText(/^submit$/i, ".header__exits") ||
    findButtonByText(/^submit$/i);
}

function canAutoSubmitAssignment() {
  const progress = getProgress();
  if (!progress) return false;
  if (progress.current < progress.total) return false;

  // Trust DOM indicators: every visible tab on this question is touched OR
  // displays an "answered" indicator.
  const visibleTabs = getVisibleAssessmentTabLabels().map(normalizeComparable);
  if (visibleTabs.length) {
    return visibleTabs.every(
      (label) =>
        answeredTabsForCurrentQuestion.has(label) ||
        tabHasAnsweredIndicator(label)
    );
  }
  return true;
}

function tabHasAnsweredIndicator(label) {
  const tabs = getVisibleAssessmentTabs();
  const tab = tabs.find(
    (t) => normalizeComparable(getAssessmentTabLabel(t)) === label
  );
  if (!tab) return false;
  const text = (tab.innerText || tab.textContent || "").toLowerCase();
  return /completed|answered|saved|done|recorded/.test(text);
}

async function confirmSubmitIfPresent() {
  await delay(600);
  const modalButton = findButtonByText(
    /^(submit|submit assignment|hand in|yes|confirm|continue)$/i,
    "ic-modal[aria-hidden='false'], [role='dialog'][aria-hidden='false'], .modal[aria-hidden='false']"
  );
  if (modalButton) clickElement(modalButton);
}

function findButtonByText(pattern, rootSelector = null) {
  for (const frame of getAccessibleDocuments()) {
    const roots = rootSelector
      ? Array.from(frame.doc.querySelectorAll(rootSelector))
      : [frame.doc];
    const buttons = roots.flatMap((root) =>
      Array.from(root.querySelectorAll("button, [role='button'], a[href], input[type='button']"))
    );
    const match = buttons.find((button) => {
      if (!isElementVisibleEnough(button)) return false;
      if (isDisabledControl(button)) return false;
      const text = normalizeWhitespace(
        button.value ||
          button.innerText ||
          button.textContent ||
          button.getAttribute("aria-label") ||
          ""
      );
      return pattern.test(text);
    });
    if (match) return match;
  }
  return null;
}

// ============================================================================
// SmartBook legacy quiz path
// ============================================================================

function parseQuestion() {
  const questionElement = document.querySelector(".question");
  if (!questionElement) return null;

  let questionType = "";
  let options = [];

  if (document.querySelector(".answers-wrap.multiple-choice")) {
    questionType = "multiple_choice";
    options = Array.from(
      document.querySelectorAll(".answers--mc .answer__label--mc")
    ).map((el) => el.textContent.trim().replace(/^[a-z]\s+/, ""));
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
    const clone = questionElement.cloneNode(true);
    clone.querySelectorAll('span[aria-hidden="true"]').forEach((span) => {
      if (span.textContent.includes("_")) span.textContent = "[BLANK]";
    });
    clone.querySelectorAll('span[style*="position: absolute"]').forEach((s) => s.remove());
    questionText = normalizeWhitespace(clone.textContent);
  } else {
    questionText = normalizeWhitespace(questionElement.textContent);
  }

  return {
    type: questionType,
    question: questionText,
    options,
    previousCorrection: null,
  };
}

async function applyLegacySmartBookAnswer(answer) {
  if (document.querySelector(".answers-wrap.multiple-choice")) {
    if (!handleMultipleChoiceAnswer(answer)) {
      throw new Error("Could not match AI answer to a multiple-choice option");
    }
  } else if (document.querySelector(".answers-wrap.boolean")) {
    if (!handleTrueFalseAnswer(answer)) {
      throw new Error("Could not interpret AI answer as true/false");
    }
  } else if (document.querySelector(".answers-wrap.input-response")) {
    const handled = await handleFillInTheBlankAnswer(answer);
    if (!handled) throw new Error("Could not fill in blank with AI answer");
  } else {
    throw new Error("Unknown SmartBook quiz layout");
  }
}

async function continueSmartBookAfterAnswer() {
  await delay(1500);
  const nextButton = document.querySelector(".footer__link--next:not([hidden])");
  if (
    nextButton &&
    !nextButton.disabled &&
    !nextButton.classList.contains("is-disabled")
  ) {
    clickElement(nextButton);
    setTimeout(() => {
      if (checkForQuizEnd()) {
        stopAutomation("Quiz completed - all questions answered");
        return;
      }
      checkForNextStep();
    }, 1500);
  } else {
    stopAutomation("Quiz completed - no next button available");
  }
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
      if (!radioButtons[i]) return false;
      clickElement(radioButtons[i]);
      return true;
    }
  }
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
  if (!expected) return false;

  for (const button of buttons) {
    const buttonSpan = button.querySelector(".answer__button--boolean");
    if (!buttonSpan) continue;
    const buttonText = buttonSpan.textContent.trim().split(",")[0].trim();
    if (
      (buttonText === "True" && expected === "true") ||
      (buttonText === "False" && expected === "false")
    ) {
      clickElement(button);
      return true;
    }
  }
  return false;
}

async function handleFillInTheBlankAnswer(answer) {
  const inputField = document.querySelector(".answer--input__input");
  if (!inputField) return false;
  await fillElement(inputField, getPrimaryAnswerText(answer));
  return true;
}

function getPrimaryAnswerText(answer) {
  if (Array.isArray(answer)) return answer[0] == null ? "" : String(answer[0]);
  if (answer == null) return "";
  if (typeof answer === "object" && "answer" in answer) {
    return getPrimaryAnswerText(answer.answer);
  }
  return String(answer);
}

// ============================================================================
// Page snapshot prep / DOM normalization
// ============================================================================

async function waitForConnectContentReady(timeout = 5000) {
  if (isQuizPage()) return;

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
    if (!hasAssessmentFrame || hasAnswerControls) return;
    await delay(250);
  }
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
      // cross-origin frame: skip
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
  return Array.from(doc.querySelectorAll(selector)).filter((element) => {
    if (seen.has(element)) return false;
    seen.add(element);
    if (!isElementVisibleEnough(element)) return false;
    if (isDisabledControl(element)) return false;
    if (element.matches("a[href]") && !normalizeWhitespace(element.textContent)) {
      return false;
    }
    return true;
  });
}

function isAnswerCell(element) {
  return (
    element.tagName?.toLowerCase() === "td" &&
    (element.classList.contains("responseCell") ||
      element.classList.contains("groupResponse") ||
      element.classList.contains("dropDownList"))
  );
}

function isSpreadsheetFillCell(element) {
  return (
    element.tagName?.toLowerCase() === "td" &&
    (element.classList.contains("responseCell") ||
      element.classList.contains("groupResponse")) &&
    !isDropdownLike(element)
  );
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

function isStaleAccountingClone(element) {
  if (!element?.closest) return false;
  if (element.closest("[data-automcgraw-hidden-duplicate='true']")) return true;

  const table = element.closest("table");
  if (table?.id === "holisticTable" && !isElementVisibleEnough(table)) return true;

  const sheet = element.closest("#holisticSheet");
  return Boolean(sheet && !isElementVisibleEnough(sheet));
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

function getElementLabel(element) {
  const doc = element.ownerDocument;
  const id = element.id;
  const explicitLabel = id
    ? doc.querySelector(`label[for='${cssEscape(id)}']`)
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
  clone
    .querySelectorAll(".header__automcgraw, script, style, svg")
    .forEach((node) => node.remove());
  return limitText(
    normalizeWhitespace(clone.innerText || clone.textContent || ""),
    700
  );
}

function getElementValue(element) {
  if ("value" in element) return element.value || "";
  return normalizeWhitespace(element.textContent || "");
}

function getSpreadsheetCellContext(element) {
  const row = element.closest("tr");
  if (!row || !element.closest("table")) return null;

  const rowIndex = Array.from(row.parentElement?.children || []).indexOf(row);
  const columnIndex = Array.from(row.children).indexOf(element);
  const headerText = getHeaderTextForCell(element);
  const leftCell = row.children[columnIndex - 1];
  const leftText = normalizeWhitespace(
    leftCell?.innerText || leftCell?.textContent || ""
  );
  const rightCell = row.children[columnIndex + 1];
  const rightText = normalizeWhitespace(
    rightCell?.innerText || rightCell?.textContent || ""
  );
  const rowText = normalizeWhitespace(row.innerText || row.textContent || "");

  return {
    rowIndex,
    columnIndex,
    label: headerText
      ? `Row ${rowIndex + 1} ${headerText}`
      : `Row ${rowIndex + 1} cell ${columnIndex + 1}`,
    rowText,
    headerText,
    leftText,
    rightText,
  };
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

function prepareDocumentForSnapshot(doc) {
  if (!doc?.body) return;
  closeDropdownOverlays(doc);
  normalizeAllSpreadsheetCellClasses(doc);
  repairDuplicatedAccountingChrome(doc);
}

function normalizeAllSpreadsheetCellClasses(doc) {
  doc
    .querySelectorAll("td.responseCell, td.groupResponse, td.dropDownList")
    .forEach((cell) => normalizeSpreadsheetCellClasses(cell));
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

function repairDuplicatedAccountingChrome(doc) {
  const workspace = doc.querySelector("#workspace");
  if (!workspace || !doc.querySelector("#transactionDetails")) return;

  hideDuplicateVisibleElements(
    Array.from(workspace.querySelectorAll("#transactionDetails > .clearfix"))
      .filter((el) => el.querySelector("#transactionHeader")),
    scoreTransactionHeaderBlock
  );
  hideDuplicateVisibleElements(
    Array.from(
      workspace.querySelectorAll(
        "#transactionDetails > .accountingtool_navigationcarousel"
      )
    ),
    scoreTransactionCarousel
  );
  hideDuplicateVisibleElements(
    Array.from(workspace.querySelectorAll("#transactionDetails > div")).filter(
      (el) =>
        /enter debits before credits/i.test(
          el.innerText || el.textContent || ""
        )
    ),
    () => 1
  );
  hideDuplicateVisibleElements(
    Array.from(workspace.querySelectorAll(":scope > #trans_button_wrpr")),
    scoreTransactionButtonWrapper
  );
  hideDuplicateVisibleElements(
    Array.from(workspace.querySelectorAll(":scope > #clearTransactionDialog")),
    () => 1
  );
}

function hideDuplicateVisibleElements(elements, scoreElement) {
  const visible = elements.filter((el) => isElementVisibleEnough(el));
  if (visible.length <= 1) return [];

  const keep = visible
    .map((el, index) => ({ el, index, score: scoreElement(el) }))
    .sort((a, b) => b.score - a.score || a.index - b.index)[0].el;
  const hidden = [];
  visible.forEach((el) => {
    if (el === keep) return;
    el.setAttribute("data-automcgraw-hidden-duplicate", "true");
    el.style.display = "none";
    hidden.push(el);
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

// ============================================================================
// Dropdown options reading (open dropdown, read overlay, cache)
// ============================================================================

async function getOptionsForControl(element, doc) {
  if (element.tagName.toLowerCase() === "select") {
    return uniqueStrings(
      Array.from(element.options)
        .map((option) => normalizeWhitespace(option.textContent))
        .filter(Boolean)
    );
  }

  if (!isDropdownLike(element)) return [];

  const cacheKey = getDropdownOptionCacheKey(element);
  const exact = getExactCachedDropdownOptions(doc, cacheKey);
  if (exact.length) return exact;

  let options = [];
  try {
    element.scrollIntoView({ block: "center", inline: "center" });
    dispatchMouseSequence(element);
    await delay(250);
    options = readDropdownOptions(element, doc);
  } catch (error) {
    debugLog("dropdown_open_error", { error }, "warn");
  } finally {
    closeDropdownOverlays(doc);
  }

  if (options.length) {
    setCachedDropdownOptions(doc, cacheKey, options);
    return options;
  }

  options = readDropdownOptions(element, doc);
  if (options.length) {
    setCachedDropdownOptions(doc, cacheKey, options);
    return options;
  }

  return getCachedDropdownOptions(doc, cacheKey);
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
  const targets = [doc.activeElement, doc.body, doc.documentElement, doc].filter(Boolean);

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

// ============================================================================
// DOM mechanics: click, fill, select, spreadsheet
// ============================================================================

function clickElement(element) {
  const text = normalizeWhitespace(
    element.innerText ||
      element.textContent ||
      element.value ||
      element.getAttribute("aria-label") ||
      ""
  ).slice(0, 120);
  const frame = element.ownerDocument === document ? "main" : "iframe";
  debugLog("click_element", { element, text, frame });
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
}

async function fillSpreadsheetCell(element, text) {
  const doc = element.ownerDocument;
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
      return;
    }
  }

  debugLog(
    "spreadsheet_fill_verify_failed",
    {
      element,
      expected: text,
      actual: element.innerText || element.textContent || "",
      editorFound: Boolean(editor),
    },
    "error"
  );
  throw new Error(`Spreadsheet cell did not keep value: ${text}`);
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
    return getRectDistanceScore(targetRect, aRect) - getRectDistanceScore(targetRect, bRect);
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
  element.scrollIntoView({ block: "center", inline: "center" });
  element.focus?.();

  if (element.tagName.toLowerCase() === "select") {
    selectNativeOption(element, text);
    return;
  }
  await selectCustomDropdownOption(element, text);
}

function selectNativeOption(select, text) {
  const options = Array.from(select.options);
  const match = options.find(
    (option) =>
      normalizeComparable(option.textContent) === normalizeComparable(text) ||
      normalizeComparable(option.value) === normalizeComparable(text)
  );
  if (!match) throw new Error(`Dropdown option not found: ${text}`);
  select.value = match.value;
  dispatchInputEvents(select);
}

async function selectCustomDropdownOption(element, text) {
  const doc = element.ownerDocument;
  dispatchMouseSequence(element);
  await delay(200);

  const option = findDropdownOption(doc, text);
  if (!option) {
    closeDropdownOverlays(doc);
    throw new Error(`Dropdown option not found: ${text}`);
  }

  option.scrollIntoView({ block: "nearest", inline: "nearest" });
  dispatchMouseSequence(option.querySelector("a, .list_content") || option);
  await delay(200);
  dispatchInputEvents(element);

  if (!dropdownSelectionMatches(element, text)) {
    const optionTarget = option.querySelector("a, .list_content") || option;
    dispatchMouseSequence(element);
    await delay(100);
    dispatchMouseSequence(optionTarget);
    await delay(200);
    dispatchInputEvents(element);
  }

  if (!dropdownSelectionMatches(element, text)) {
    closeDropdownOverlays(doc);
    throw new Error(`Dropdown option did not stick: ${text}`);
  }
  closeDropdownOverlays(doc);
}

function findDropdownOption(doc, text) {
  const target = normalizeComparable(text);
  const options = Array.from(
    doc.querySelectorAll(
      ".listContainer [role='option'], [role='listbox'] [role='option'], .listContainer li"
    )
  );

  const exact = options.find(
    (option) =>
      normalizeComparable(option.innerText || option.textContent || "") === target
  );
  if (exact) return exact;

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
    element.innerText || element.textContent || getElementValue(element);
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

// ============================================================================
// Visibility / disabled checks
// ============================================================================

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

function isDisabledControl(element) {
  return (
    Boolean(element.disabled) ||
    element.getAttribute("aria-disabled") === "true" ||
    element.classList.contains("is-disabled") ||
    element.classList.contains("disabled") ||
    element.classList.contains("disable")
  );
}

// ============================================================================
// Visible-text extraction
// ============================================================================

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

// ============================================================================
// Progress + tab tracking
// ============================================================================

function getProgress() {
  const progressInfo = document.querySelector(".footer__progress__heading");
  if (!progressInfo) return null;
  const text = normalizeWhitespace(progressInfo.textContent);
  const match = text.match(/(\d+)\s+of\s+(\d+)/i);
  const totalMatch = text.match(/\bof\s+(\d+)\b/i);
  if (!match && !totalMatch) return null;
  const current = match ? parseInt(match[1], 10) : getCurrentQuestionNumber();
  const total = totalMatch ? parseInt(totalMatch[1], 10) : parseInt(match[2], 10);
  if (!current || !total) return null;
  return { current, total };
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
    frame.doc.querySelectorAll("[role='tab'], .tab").forEach((tab) => {
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

// ============================================================================
// Assistant button
// ============================================================================

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
  btn.addEventListener("mouseenter", () => (btn.style.backgroundColor = "#f5f5f5"));
  btn.addEventListener("mouseleave", () => (btn.style.backgroundColor = "#fff"));

  btn.addEventListener("click", () => {
    if (isAutomating) {
      stopAutomation("Manual stop");
    } else {
      const proceed = confirm(
        "Start automation with your selected AI assistant? It will answer the current item and continue forward when possible.\n\nClick OK to begin, or Cancel to stop."
      );
      if (proceed) {
        isAutomating = true;
        awaitingAiResponse = false;
        processingAiResponse = false;
        consecutiveSetupClicks = 0;
        consecutiveEmptySnapshots = 0;
        answeredTabsForCurrentQuestion = new Set();
        lastVisitedQuestionNumber = null;
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
  settingsBtn.addEventListener("mouseenter", () => (settingsBtn.style.backgroundColor = "#f5f5f5"));
  settingsBtn.addEventListener("mouseleave", () => (settingsBtn.style.backgroundColor = "#fff"));
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

// ============================================================================
// Diagnostic + utilities
// ============================================================================

function setAutomationDiagnostic(message) {
  document.documentElement.setAttribute(
    "data-automcgraw-diagnostic",
    `${new Date().toISOString()} ${message}`
  );
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

function cssEscape(value) {
  if (window.CSS && typeof window.CSS.escape === "function") {
    return window.CSS.escape(value);
  }
  return String(value).replace(/[^a-zA-Z0-9_-]/g, (ch) => `\\${ch}`);
}

// ============================================================================
// Boot
// ============================================================================

setupMessageListener();
startPageObserver();

if (isAutomating) {
  setTimeout(() => checkForNextStep(), 1000);
}
