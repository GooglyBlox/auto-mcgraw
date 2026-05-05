// Auto-McGraw Connect content script.
// The page snapshots fillable slots, the AI returns values by slot id, and the
// page applies those values before navigating forward.

let messageListener = null;
let isAutomating = false;
let buttonAdded = false;
let slotIdCounter = 1;
let lastSlotMap = new Map();
let awaitingAiResponse = false;
let processingAiResponse = false;
let consecutiveSetupClicks = 0;
let consecutiveEmptySnapshots = 0;
let consecutiveApplyErrorCycles = 0;
let lastVisitedQuestionNumber = null;
let answeredTabsForCurrentQuestion = new Set();
const dropdownOptionsCache = new WeakMap();

const SLOT_ATTR = "data-automcgraw-slot";
const MAX_TEXT_LENGTH = 18000;
const MAX_SLOTS = 120;
const MAX_SETUP_CLICKS = 4;
const MAX_EMPTY_SNAPSHOTS = 3;
const DEFAULT_AI_MODEL = "chatgpt";

// Message listener

function setupMessageListener() {
  if (messageListener) {
    chrome.runtime.onMessage.removeListener(messageListener);
  }

  messageListener = (message, sender, sendResponse) => {
    if (message.type === "ping") {
      sendResponse({ received: true });
      return true;
    }

    if (message.type === "processChatGPTResponse") {
      handleAiResponse(message.response)
        .then(() => {
          sendResponse({ received: true });
        })
        .catch((error) => {
          console.error("Error processing AI response:", error);
          stopAutomation("Error processing AI response: " + error.message);
          sendResponse({ received: false, error: error.message });
        });
      return true;
    }

    if (message.type === "stopAutomation") {
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

// Page detection + button injection

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
    document.querySelector(".header__exits"),
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
    document.body?.innerText || "",
  );
}

function getSelectedAiModel() {
  return new Promise((resolve) => {
    try {
      chrome.storage.sync.get("aiModel", (data) => {
        resolve(data?.aiModel || DEFAULT_AI_MODEL);
      });
    } catch (error) {
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
      resolve(false);
    }
  });
}

// Top-level flow

function stopAutomation(reason = "Quiz completed") {
  const hadPendingAiResponse = awaitingAiResponse || processingAiResponse;

  isAutomating = false;
  awaitingAiResponse = false;
  processingAiResponse = false;
  consecutiveSetupClicks = 0;
  consecutiveEmptySnapshots = 0;
  lastSlotMap = new Map();

  const btn = document.querySelector(".header__automcgraw--main");
  if (btn) btn.textContent = "Ask AI";

  if (hadPendingAiResponse) {
    try {
      chrome.runtime.sendMessage({ type: "cancelAiResponseTimeout" });
    } catch (error) {}
  }

  if (reason) alert(`Automation stopped: ${reason}`);
}

async function checkForNextStep() {
  if (!isAutomating) return;
  if (awaitingAiResponse || processingAiResponse) {
    return;
  }

  if (isAssignmentSubmittedPage()) {
    stopAutomation("Assignment already submitted");
    return;
  }

  await waitForConnectContentReady();

  const questionNumber = getCurrentQuestionNumber() || getProgress()?.current;
  if (questionNumber && questionNumber !== lastVisitedQuestionNumber) {
    lastVisitedQuestionNumber = questionNumber;
    answeredTabsForCurrentQuestion = new Set();
  }

  if (isQuizPage()) {
    const questionData = parseQuestion();
    if (!questionData) {
      stopAutomation("No question found");
      return;
    }
    sendToAi(questionData);
    return;
  }

  await delay(800);

  const worksheetButton = findJournalEntryWorksheetButton();
  if (worksheetButton) {
    clickElement(worksheetButton);
    consecutiveEmptySnapshots = 0;
    setTimeout(() => checkForNextStep(), 1500);
    return;
  }

  const snapshot = await buildSlotGraphSnapshot();

  if (!snapshot || !snapshot.slots.length) {
    consecutiveEmptySnapshots++;

    if (consecutiveEmptySnapshots < MAX_EMPTY_SNAPSHOTS) {
      setTimeout(() => checkForNextStep(), 1500);
      return;
    }

    const setupButton = findSetupRevealButton();
    if (setupButton && consecutiveSetupClicks < MAX_SETUP_CLICKS) {
      consecutiveSetupClicks++;
      clickElement(setupButton);
      consecutiveEmptySnapshots = 0;
      setTimeout(() => checkForNextStep(), 1500);
      return;
    }

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

  sendToAi(snapshot.question);
}

function sendToAi(question) {
  awaitingAiResponse = true;
  getSelectedAiModel().then((aiModel) => {
    chrome.runtime.sendMessage(
      {
        type: "sendQuestionToChatGPT",
        question,
        aiModel,
      },
      (response) => {
        if (chrome.runtime.lastError || !response?.received) {
          awaitingAiResponse = false;
          stopAutomation(
            "Could not send question to the selected AI assistant",
          );
        }
      },
    );
  });
}

async function handleAiResponse(responseText) {
  if (!isAutomating) {
    return;
  }

  awaitingAiResponse = false;
  processingAiResponse = true;

  try {
    const parsed = parseJsonResponse(responseText);
    if (!parsed || typeof parsed !== "object") {
      throw new Error("AI response was not a JSON object");
    }

    if (isQuizPage()) {
      await applyLegacySmartBookAnswer(parsed.answer);
      await continueSmartBookAfterAnswer();
      return;
    }

    const slotAnswers = extractSlotAnswers(parsed);
    const { filledAny, errored } = await applySlots(slotAnswers);

    if (!isAutomating) return;

    if (errored && !filledAny) {
      consecutiveApplyErrorCycles++;
      if (consecutiveApplyErrorCycles < 3) {
        setTimeout(() => {
          if (isAutomating) checkForNextStep();
        }, 1500);
        return;
      }
      consecutiveApplyErrorCycles = 0;
    } else {
      consecutiveApplyErrorCycles = 0;
    }

    await navigateForward({ filledSlots: filledAny });
    setTimeout(() => {
      if (isAutomating) checkForNextStep();
    }, 1500);
  } finally {
    processingAiResponse = false;
  }
}

// JSON response parsing

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
  return {};
}

// Slot graph builder

async function buildSlotGraphSnapshot() {
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

  const radioGroups = new Map();
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

  for (const [, group] of radioGroups) {
    const slot = describeChoiceGroup(group);
    if (slot) {
      lastSlotMap.set(slot.id, slot);
      slots.push(toAiSlot(slot));
    }
  }

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
  const mainFrame = frames.find((f) => f.frame === "main");
  if (mainFrame) {
    const wrap = mainFrame.doc.querySelector(".question-wrap, .question");
    if (wrap) {
      return limitText(
        normalizeWhitespace(wrap.innerText || wrap.textContent || ""),
        4000,
      );
    }
  }
  const embedded = frames.find((f) => f.frame !== "main");
  if (embedded) {
    return limitText(
      normalizeWhitespace(
        embedded.doc.body?.innerText || embedded.doc.body?.textContent || "",
      ),
      4000,
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
    const headerText = cellContext?.headerText || "";
    const looksNumeric =
      /\b(amount|debit|credit|balance|total|price|cost|quantity|qty|value)\b/i.test(
        headerText,
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
    return null;
  }

  const text = normalizeWhitespace(
    element.innerText || element.textContent || element.value || "",
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

  const sample = items[0];
  const fieldset = sample.closest(
    "fieldset, [role='radiogroup'], .question, .question-wrap",
  );
  const label = fieldset
    ? normalizeWhitespace(
        fieldset.querySelector("legend, .question-prompt")?.innerText ||
          fieldset.querySelector("legend, .question-prompt")?.textContent ||
          "",
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

// Navigation chrome filter (don't expose Next/Submit/Save/tabs as slots)

function isNavigationChrome(element) {
  if (isCheckMyWorkControl(element)) return true;
  if (isAccountingNavigationControl(element)) return true;
  if (isStaleAccountingClone(element)) return true;
  if (element.closest(".header__automcgraw")) return true;

  const tag = element.tagName.toLowerCase();
  const role = element.getAttribute("role") || "";
  const isTabRole = role === "tab" || element.closest("[role='tablist']");
  if (isTabRole) return true;

  if (element.closest(".footer__navigation--wrap")) return true;
  if (element.closest(".header__exits")) return true;

  const text = getControlText(element).toLowerCase();
  if (
    /\b(record entry|save entry|save transaction|record transaction|save & next|next part|save and next)\b/i.test(
      text,
    )
  ) {
    return true;
  }

  if (
    (tag === "button" || tag === "a" || role === "button") &&
    /^(next|submit|continue|finish|done|hand in|save|cancel|close)$/i.test(
      text.trim(),
    )
  ) {
    return true;
  }

  return false;
}

// Slot executor

async function applySlots(slotAnswers) {
  let filledAny = false;
  let appliedCount = 0;
  let errored = false;
  const entries = Object.entries(slotAnswers || {});

  for (const [slotId, value] of entries) {
    if (!isAutomating) break;
    const slot = lastSlotMap.get(slotId);
    if (!slot) {
      continue;
    }
    if (value == null || (typeof value === "string" && value.trim() === "")) {
      continue;
    }

    try {
      await applySlot(slot, value);
      filledAny = true;
      appliedCount++;
    } catch (error) {
      errored = true;
    }
    await delay(200);
  }

  return { filledAny, errored };
}

async function applySlot(slot, value) {
  if (slot.kind === "choice" || slot.kind === "multi_choice") {
    await applyChoiceSlot(slot, value);
    return;
  }

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
  const matchedWanted = new Set();

  for (const choice of slot.choices) {
    const choiceNorm = normalizeComparable(choice.value);
    const matchedIndex = wantedNorm.findIndex(
      (w) =>
        choiceNorm === w ||
        (choiceNorm && w && (choiceNorm.includes(w) || w.includes(choiceNorm))),
    );
    if (matchedIndex === -1) continue;
    const target = resolveAnyElement(choice.element);
    if (!target) {
      throw new Error(`Choice element not found: ${choice.value}`);
    }
    clickElement(target);
    matchedWanted.add(matchedIndex);
    if (slot.kind === "choice") return;
  }

  const missing = wanted.filter((_, index) => !matchedWanted.has(index));
  if (missing.length) {
    throw new Error(`Choice option not found: ${missing.join(", ")}`);
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
  if (typeof value === "number") {
    if (value < 0) return `(${Math.abs(value)})`;
    return String(value);
  }
  return String(value);
}

// Navigator (deterministic post-apply)

async function navigateForward({ filledSlots }) {
  if (!isAutomating) return false;

  if (filledSlots) {
    const saveButton = findInToolSaveButton();
    if (saveButton) {
      const beforeActiveNumber = getActiveTransactionNumberAcrossFrames();
      clickElement(saveButton);
      await waitForInToolSaveToSettle();
      if (!isAutomating) return false;

      const stillInCarousel =
        await advanceWithinCarouselAfterSave(beforeActiveNumber);
      if (!isAutomating) return false;
      if (stillInCarousel) {
        return true;
      }

      markActiveTabAnswered();
    } else {
      markActiveTabAnswered();
    }
  } else {
    markActiveTabAnswered();
  }

  const nextTab = findNextRequiredTab();
  if (nextTab) {
    clickElement(nextTab);
    return true;
  }

  const mainNext = findMainNextButton();
  if (mainNext) {
    clickElement(mainNext);
    if (checkForQuizEnd()) {
      stopAutomation("Quiz completed - all questions answered");
      return true;
    }
    return true;
  }

  const submit = findMainSubmitButton();
  if (submit && canAutoSubmitAssignment()) {
    if (await getDisableAutoSubmit()) {
      stopAutomation(
        "Auto-submit is disabled in settings. Review your answers and submit manually.",
      );
      return true;
    }
    clickElement(submit);
    await delay(800);
    await confirmSubmitIfPresent();
    stopAutomation("Assignment submitted");
    return true;
  }

  if (submit) {
  }

  return false;
}

async function advanceWithinCarouselAfterSave(beforeActiveNumber) {
  if (beforeActiveNumber == null) return false;

  for (let i = 0; i < 10; i++) {
    if (!isAutomating) return false;
    const currentActive = getActiveTransactionNumberAcrossFrames();
    if (currentActive != null && currentActive > beforeActiveNumber) {
      const unentered = activeTransactionIsUnentered();
      const activeText = getActiveTransactionAnnotationText();
      return true;
    }
    await delay(150);
  }

  if (!isAutomating) return false;
  for (const frame of getAccessibleDocuments()) {
    if (frame.frame === "main") continue;
    const arrow = findTransactionNextArrow(frame.doc);
    if (arrow) {
      clickElement(arrow);
      await delay(400);
      return true;
    }
  }

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

function getActiveTransactionAnnotationText() {
  for (const frame of getAccessibleDocuments()) {
    if (frame.frame === "main") continue;
    const active = getActiveTransactionButton(frame.doc);
    if (!active) continue;
    return getControlText(active, { preferAriaLabel: true });
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
    return true;
  }
  return false;
}

function markActiveTabAnswered() {
  const tab = getActiveAssessmentTabLabel();
  if (tab) {
    const key = normalizeComparable(tab);
    answeredTabsForCurrentQuestion.add(key);
  } else {
  }
}

function findInToolSaveButton() {
  for (const frame of getAccessibleDocuments()) {
    if (frame.frame === "main") continue;

    const controls = Array.from(
      frame.doc.querySelectorAll(
        "#saveTransation, #saveTransaction, input[type='button'], button, [role='button']",
      ),
    );
    const match = controls.find((element) => {
      if (!isElementVisibleEnough(element)) return false;
      if (isDisabledControl(element)) return false;
      const text = getControlText(element);
      return /\b(record entry|save entry|record transaction|save transaction|save & next)\b/i.test(
        text,
      );
    });
    if (match) return match;
  }
  return null;
}

function findJournalEntryWorksheetButton() {
  for (const frame of getAccessibleDocuments()) {
    if (frame.frame === "main") continue;

    const candidates = [
      frame.doc.querySelector("#viewGJ"),
      ...Array.from(
        frame.doc.querySelectorAll(
          "button, input[type='button'], [role='button']",
        ),
      ),
    ].filter(Boolean);

    const match = candidates.find((element) => {
      if (!isElementVisibleEnough(element)) return false;
      if (isDisabledControl(element)) return false;
      const text = normalizeWhitespace(
        element.value || element.innerText || element.textContent || "",
      );
      return /^view\s+journal\s+entry\s+worksheet$/i.test(text);
    });
    if (match) return match;
  }
  return null;
}

function findSetupRevealButton() {
  for (const frame of getAccessibleDocuments()) {
    const controls = Array.from(
      frame.doc.querySelectorAll(
        "button, input[type='button'], a[href], [role='button']",
      ),
    );
    const match = controls.find((element) => {
      if (!isElementVisibleEnough(element)) return false;
      if (isDisabledControl(element)) return false;
      if (isNavigationChrome(element)) return false;
      const text = getControlText(element);
      return (
        /\bedit\b.*\bworksheet\b/i.test(text) ||
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
    if (
      /journal entry recorded successfully|entry recorded successfully/i.test(
        bodyText,
      )
    ) {
      return true;
    }

    const activeTransaction = frame.doc.querySelector(
      ".transactionButton.active, input.active, button.active",
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
      ".accountingtool_navigationcarousel [aria-label*='Move to next transaction'], .accountingtool_navigationcarousel .next, .accountingtool_navigationcarousel .icon-Nxt",
    ),
  ).find(
    (control) => isElementVisibleEnough(control) && !isDisabledControl(control),
  );
}

function getActiveTransactionNumber(doc) {
  return getTransactionButtonNumber(getActiveTransactionButton(doc));
}

function getActiveTransactionButton(doc) {
  return getTransactionButtons(doc).find(
    (button) =>
      button.classList.contains("active") ||
      button.getAttribute("aria-selected") === "true",
  );
}

function getTransactionButtons(doc) {
  return Array.from(
    doc.querySelectorAll(
      ".accountingtool_navigationcarousel [role='tab'], .accountingtool_navigationcarousel input[type='button'], .accountingtool_navigationcarousel button",
    ),
  ).filter(
    (button) => isElementVisibleEnough(button) && !isDisabledControl(button),
  );
}

function getTransactionButtonNumber(button) {
  if (!button) return null;
  const visibleNumber = parseTransactionNumberText(button.value || "");
  if (visibleNumber != null) return visibleNumber;
  const refNumber = parseTransactionNumberText(
    button.getAttribute("ref") || "",
  );
  if (refNumber != null) return refNumber;
  return parseTransactionNumberText(
    button.getAttribute("aria-label") ||
      button.innerText ||
      button.textContent ||
      "",
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
    (b) => isElementVisibleEnough(b) && !isDisabledControl(b) && !b.disabled,
  );
}

function findMainSubmitButton() {
  return (
    findButtonByText(/^submit$/i, ".header__exits") ||
    findButtonByText(/^submit$/i)
  );
}

function canAutoSubmitAssignment() {
  const progress = getProgress();
  if (!progress) return false;
  if (progress.current < progress.total) return false;

  const visibleTabs = getVisibleAssessmentTabLabels().map(normalizeComparable);
  if (visibleTabs.length) {
    return visibleTabs.every(
      (label) =>
        answeredTabsForCurrentQuestion.has(label) ||
        tabHasAnsweredIndicator(label),
    );
  }
  return true;
}

function tabHasAnsweredIndicator(label) {
  const tabs = getVisibleAssessmentTabs();
  const tab = tabs.find(
    (t) => normalizeComparable(getAssessmentTabLabel(t)) === label,
  );
  if (!tab) return false;
  const text = (tab.innerText || tab.textContent || "").toLowerCase();
  return /completed|answered|saved|done|recorded/.test(text);
}

async function confirmSubmitIfPresent() {
  await delay(600);
  const modalButton = findButtonByText(
    /^(submit|submit assignment|hand in|yes|confirm|continue)$/i,
    "ic-modal[aria-hidden='false'], [role='dialog'][aria-hidden='false'], .modal[aria-hidden='false']",
  );
  if (modalButton) clickElement(modalButton);
}

function findButtonByText(pattern, rootSelector = null) {
  for (const frame of getAccessibleDocuments()) {
    const roots = rootSelector
      ? Array.from(frame.doc.querySelectorAll(rootSelector))
      : [frame.doc];
    const buttons = roots.flatMap((root) =>
      Array.from(
        root.querySelectorAll(
          "button, [role='button'], a[href], input[type='button']",
        ),
      ),
    );
    const match = buttons.find((button) => {
      if (!isElementVisibleEnough(button)) return false;
      if (isDisabledControl(button)) return false;
      const text = normalizeWhitespace(
        button.value ||
          button.innerText ||
          button.textContent ||
          button.getAttribute("aria-label") ||
          "",
      );
      return pattern.test(text);
    });
    if (match) return match;
  }
  return null;
}

// SmartBook legacy quiz path

function parseQuestion() {
  const questionElement = document.querySelector(".question");
  if (!questionElement) return null;

  let questionType = "";
  let options = [];

  if (document.querySelector(".answers-wrap.multiple-choice")) {
    questionType = "multiple_choice";
    options = Array.from(
      document.querySelectorAll(".answers--mc .answer__label--mc"),
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
    clone
      .querySelectorAll('span[style*="position: absolute"]')
      .forEach((s) => s.remove());
    questionText = normalizeWhitespace(clone.textContent);
  } else {
    questionText = normalizeWhitespace(questionElement.textContent);
  }

  return {
    type: questionType,
    question: questionText,
    options,
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
  const nextButton = document.querySelector(
    ".footer__link--next:not([hidden])",
  );
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
  const radioButtons = document.querySelectorAll(
    '.answers--mc input[type="radio"]',
  );
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

// Page snapshot prep / DOM normalization

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
          "td.responseCell, .groupResponse, .dropDownList, input:not([type='hidden']), textarea, select",
        ),
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
            (iframe.getAttribute("title") ||
              iframe.name ||
              iframe.id ||
              "iframe"),
          frame: index,
        });
      }
    } catch (error) {}
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
    if (
      element.matches("a[href]") &&
      !normalizeWhitespace(element.textContent)
    ) {
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
    element.matches(
      "[role='tab'], input[type='button'], button, [role='button']",
    ) ||
    /\bmove to (previous|next) transaction\b/i.test(text) ||
    /\btransaction number\b/i.test(text) ||
    /^\d+$/.test(text)
  );
}

function isStaleAccountingClone(element) {
  if (!element?.closest) return false;
  if (element.closest("[data-automcgraw-hidden-duplicate='true']")) return true;

  const table = element.closest("table");
  if (table?.id === "holisticTable" && !isElementVisibleEnough(table))
    return true;

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
          "",
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
      "",
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
    700,
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
    leftCell?.innerText || leftCell?.textContent || "",
  );
  const rightCell = row.children[columnIndex + 1];
  const rightText = normalizeWhitespace(
    rightCell?.innerText || rightCell?.textContent || "",
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
      .join(" "),
  );
}

function prepareDocumentForSnapshot(doc) {
  if (!doc?.body) return;
  closeDropdownOverlays(doc);
  normalizeAllSpreadsheetCellClasses(doc);
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
      .filter(Boolean),
  );
  element.className = uniqueClasses.join(" ");
}

// Dropdown options reading (open dropdown, read overlay, cache)

async function getOptionsForControl(element, doc) {
  if (element.tagName.toLowerCase() === "select") {
    return uniqueStrings(
      Array.from(element.options)
        .map((option) => normalizeWhitespace(option.textContent))
        .filter(Boolean),
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

  return getExactCachedDropdownOptions(doc, cacheKey);
}

function getDropdownOptionCacheKey(element) {
  return [
    element.getAttribute("dropdownid") || "",
    element.getAttribute("dropdowntype") || "",
    element.getAttribute("aria-controls") || "",
    element.closest("table")?.id || "",
  ].join("|");
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
      "[role='option'], li, option, .list_content",
    );
    options.forEach((option) => {
      const text = normalizeWhitespace(
        option.innerText || option.textContent || "",
      );
      if (text) optionTexts.push(text);
    });
  }

  return uniqueStrings(optionTexts);
}

function closeDropdownOverlays(doc) {
  const win = doc.defaultView || window;
  const targets = [
    doc.activeElement,
    doc.body,
    doc.documentElement,
    doc,
  ].filter(Boolean);

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
        }),
      );
    });
  });

  doc.activeElement?.blur?.();
}

// DOM mechanics: click, fill, select, spreadsheet

function clickElement(element) {
  element.scrollIntoView({ block: "center", inline: "center" });
  element.focus?.();
  dispatchMouseSequence(element, { includeClick: false });
  element.click();
}

async function fillElement(element, value) {
  const text = value == null ? "" : String(value);
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
    doc.querySelectorAll("[contenteditable='true']"),
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
  const actualText = normalizeWhitespace(
    element.innerText || element.textContent || "",
  );
  const expected = normalizeWhitespace(expectedText);
  const actualNumber = normalizeNumberText(actualText);
  const expectedNumber = normalizeNumberText(expected);
  if (actualNumber || expectedNumber) {
    return Boolean(
      actualNumber && expectedNumber && actualNumber === expectedNumber,
    );
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
      }),
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
    }),
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
      }),
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
      normalizeComparable(option.value) === normalizeComparable(text),
  );
  if (!match) throw new Error(`Dropdown option not found: ${text}`);
  select.value = match.value;
  dispatchInputEvents(select);
}

async function selectCustomDropdownOption(element, text) {
  if (dropdownSelectionMatches(element, text)) return;

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
      ".listContainer [role='option'], [role='listbox'] [role='option'], .listContainer li",
    ),
  );

  const exact = options.find(
    (option) =>
      normalizeComparable(option.innerText || option.textContent || "") ===
      target,
  );
  if (exact) return exact;

  return options.find((option) => {
    const optionText = normalizeComparable(
      option.innerText || option.textContent || "",
    );
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
    normalizeWhitespace(value).replace(/^\d+\s*:\s*/, ""),
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

// Visibility / disabled checks

function isElementVisibleEnough(element) {
  const doc = element.ownerDocument;
  const view = doc.defaultView;
  if (!view) return true;

  if (
    element.closest(
      "[hidden], [aria-hidden='true'], [data-automcgraw-hidden-duplicate='true']",
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

// Visible-text extraction

function extractVisibleText(doc) {
  const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const parent = node.parentElement;
      if (!parent) return NodeFilter.FILTER_REJECT;
      if (parent.closest(".header__automcgraw"))
        return NodeFilter.FILTER_REJECT;
      if (parent.closest("script, style, noscript, svg"))
        return NodeFilter.FILTER_REJECT;
      if (parent.closest("[hidden], [aria-hidden='true']"))
        return NodeFilter.FILTER_REJECT;
      if (isAccountingNavigationText(parent)) return NodeFilter.FILTER_REJECT;
      if (!isElementVisibleEnough(parent)) return NodeFilter.FILTER_REJECT;
      if (!normalizeWhitespace(node.textContent))
        return NodeFilter.FILTER_REJECT;
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
      ".accountingtool_navigationcarousel .control_buttons, .accountingtool_navigationcarousel .prev, .accountingtool_navigationcarousel .next, .accountingtool_navigationcarousel .icon-Prv, .accountingtool_navigationcarousel .icon-Next",
    ),
  );
}

// Progress + tab tracking

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
      /\b(?:question|item)\s+(\d+)\b/i,
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
        tab.classList.contains("selected"),
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
      "",
  );
}

// Assistant button

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
  btn.addEventListener(
    "mouseenter",
    () => (btn.style.backgroundColor = "#f5f5f5"),
  );
  btn.addEventListener(
    "mouseleave",
    () => (btn.style.backgroundColor = "#fff"),
  );

  btn.addEventListener("click", () => {
    if (isAutomating) {
      stopAutomation("Manual stop");
    } else {
      const proceed = confirm(
        "Start automation with your selected AI assistant? It will answer the current item and continue forward when possible.\n\nClick OK to begin, or Cancel to stop.",
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
  settingsBtn.addEventListener(
    "mouseenter",
    () => (settingsBtn.style.backgroundColor = "#f5f5f5"),
  );
  settingsBtn.addEventListener(
    "mouseleave",
    () => (settingsBtn.style.backgroundColor = "#fff"),
  );
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

// Utilities

function normalizeWhitespace(value) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim();
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

// Boot

setupMessageListener();
startPageObserver();

if (isAutomating) {
  setTimeout(() => checkForNextStep(), 1000);
}
