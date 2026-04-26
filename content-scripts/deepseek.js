let hasResponded = false;
let messageCountAtQuestion = 0;
let observationStartTime = 0;
let observationTimeout = null;
let checkIntervalId = null;
let observer = null;
const MESSAGE_SELECTORS = [
  "[data-testid='chat-message-assistant']",
  "[data-testid='message-content']",
  "model-response",
  ".ds-markdown",
  ".f9bf7997",
];
const CHAT_INPUT_SELECTORS = [
  "#chat-input",
  'textarea[data-testid="chat_input_input"]',
  "textarea",
  '[role="textbox"][contenteditable="true"]',
];
const SEND_BUTTON_SELECTORS = [
  '[data-testid="submit-button"]',
  '[data-testid="send-button"]',
  '[data-testid="chat_input_send_button"]',
  '[role="button"].f6d670',
  ".f6d670",
  'button[type="submit"]',
  '[aria-label="Send message"]',
  '[aria-label*="Send"]',
  ".bf38813a button",
];

function getMessageNodes() {
  for (const selector of MESSAGE_SELECTORS) {
    const nodes = document.querySelectorAll(selector);
    if (nodes.length > 0) {
      return Array.from(nodes);
    }
  }

  return [];
}

function findChatInput() {
  for (const selector of CHAT_INPUT_SELECTORS) {
    const input = document.querySelector(selector);
    if (input) {
      return input;
    }
  }

  return null;
}

function isButtonUsable(button) {
  if (!button) return false;
  if (button.disabled) return false;
  if (button.getAttribute("aria-disabled") === "true") return false;
  return true;
}

function findSendButton() {
  for (const selector of SEND_BUTTON_SELECTORS) {
    try {
      const button = document.querySelector(selector);
      if (isButtonUsable(button)) {
        return button;
      }
    } catch (e) {
      continue;
    }
  }

  const composerContainer = document.querySelector(".bf38813a");
  if (composerContainer) {
    const candidates = Array.from(
      composerContainer.querySelectorAll("button, [role='button']")
    );
    const lastEnabled = candidates.reverse().find((button) => isButtonUsable(button));
    if (lastEnabled) {
      return lastEnabled;
    }
  }

  return null;
}

function updateChatInputValue(chatInput, text) {
  chatInput.focus();

  if (
    chatInput instanceof HTMLTextAreaElement ||
    chatInput instanceof HTMLInputElement
  ) {
    const prototype = Object.getPrototypeOf(chatInput);
    const valueSetter = Object.getOwnPropertyDescriptor(
      prototype,
      "value"
    )?.set;

    if (valueSetter) {
      valueSetter.call(chatInput, text);
    } else {
      chatInput.value = text;
    }
  } else if (chatInput.isContentEditable) {
    chatInput.textContent = text;
  } else {
    return false;
  }

  chatInput.dispatchEvent(new Event("input", { bubbles: true }));
  chatInput.dispatchEvent(new Event("change", { bubbles: true }));
  return true;
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "receiveQuestion") {
    resetObservation();

    const messages = getMessageNodes();
    messageCountAtQuestion = messages.length;
    hasResponded = false;

    insertQuestion(message.question)
      .then(() => {
        sendResponse({ received: true, status: "processing" });
      })
      .catch((error) => {
        sendResponse({ received: false, error: error.message });
      });

    return true;
  }
});

function resetObservation() {
  hasResponded = false;
  if (observationTimeout) {
    clearTimeout(observationTimeout);
    observationTimeout = null;
  }
  if (checkIntervalId) {
    clearInterval(checkIntervalId);
    checkIntervalId = null;
  }
  if (observer) {
    observer.disconnect();
    observer = null;
  }
}

async function insertQuestion(questionData) {
  const text = buildPrompt(questionData);

  return new Promise((resolve, reject) => {
    const chatInput = findChatInput();
    if (chatInput) {
      setTimeout(() => {
        if (!updateChatInputValue(chatInput, text)) {
          reject(new Error("Unable to fill input area"));
          return;
        }

        setTimeout(() => {
          const sendButton = findSendButton();

          if (sendButton) {
            sendButton.click();
            startObserving();
            resolve();
          } else {
            reject(new Error("Send button not found"));
          }
        }, 300);
      }, 300);
    } else {
      reject(new Error("Input area not found"));
    }
  });
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

  if (type === "connect_page_snapshot") {
    return buildConnectSnapshotPrompt(questionData, text);
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

function normalizeWhitespace(text) {
  return String(text || "").replace(/\s+/g, " ").trim();
}

function processResponse(responseText) {
  const cleanedText = repairJsonResponseText(
    responseText
      .replace(/[\u200B-\u200D\uFEFF]/g, "")
      .trim()
  );

  try {
    const parsed = JSON.parse(cleanedText);

    if (parsed && (parsed.answer !== undefined || parsed.actions) && !hasResponded) {
      hasResponded = true;
      chrome.runtime
        .sendMessage({
          type: "deepseekResponse",
          response: cleanedText,
        })
        .then(() => {
          resetObservation();
          return true;
        })
        .catch((error) => {
          return false;
        });

      return true;
    }
  } catch (e) {
    return false;
  }

  return false;
}

function checkForResponse() {
  if (hasResponded) {
    return;
  }

  const messages = getMessageNodes();

  if (messages.length <= messageCountAtQuestion) {
    return;
  }

  const newMessages = Array.from(messages).slice(messageCountAtQuestion);

  for (const message of newMessages) {
    const codeBlockSelectors = [
      ".md-code-block pre",
      "pre code",
      "pre",
      ".code-block pre",
      ".ds-markdown pre",
    ];

    for (const selector of codeBlockSelectors) {
      const codeBlocks = message.querySelectorAll(selector);

      for (const block of codeBlocks) {
        const parent = block.closest(
          ".md-code-block, .code-block, .ds-markdown"
        );

        if (parent) {
          const infoElements = parent.querySelectorAll(
            '.d813de27, .md-code-block-infostring, [class*="json"], [class*="language"]'
          );
          const hasJsonInfo = Array.from(infoElements).some((el) =>
            el.textContent.toLowerCase().includes("json")
          );

          if (hasJsonInfo || !infoElements.length) {
            const responseText = block.textContent.trim();
            if (
              responseText.includes("{") &&
              (responseText.includes('"answer"') ||
                responseText.includes('"actions"'))
            ) {
              if (processResponse(responseText)) return;
            }
          }
        }
      }
    }

    const messageText = message.textContent.trim();
    const jsonText = findJsonObject(messageText);
    if (jsonText && /"answer"|"actions"/.test(jsonText)) {
      const responseText = jsonText;
      if (processResponse(responseText)) return;
    }

    if (Date.now() - observationStartTime > 30000) {
      try {
        const jsonText = findJsonObject(messageText);

        if (jsonText && !hasResponded) {
          hasResponded = true;
          chrome.runtime.sendMessage({
            type: "deepseekResponse",
            response: repairJsonResponseText(jsonText),
          });
          resetObservation();
          return true;
        }
      } catch (e) {}
    }
  }
}

function startObserving() {
  observationStartTime = Date.now();
  observationTimeout = setTimeout(() => {
    if (!hasResponded) {
      resetObservation();
    }
  }, 180000);

  observer = new MutationObserver(() => {
    checkForResponse();
  });

  observer.observe(document.body, {
    childList: true,
    subtree: true,
    characterData: true,
    attributes: true,
  });

  checkIntervalId = setInterval(checkForResponse, 1000);
}

function repairJsonResponseText(text) {
  return String(text || "")
    .replace(
      /\[data-automcgraw-id="([^"]+)"\]/g,
      "[data-automcgraw-id='$1']"
    )
    .replace(/\[id="([^"]+)"\]/g, "[id='$1']");
}

function findJsonObject(text) {
  const value = String(text || "").replace(/[\u200B-\u200D\uFEFF]/g, "").trim();
  const firstBrace = value.indexOf("{");
  const lastBrace = value.lastIndexOf("}");
  if (firstBrace === -1 || lastBrace === -1 || lastBrace <= firstBrace) {
    return "";
  }
  return value.slice(firstBrace, lastBrace + 1);
}
