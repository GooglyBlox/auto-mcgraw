let hasResponded = false;
let messageCountAtQuestion = 0;
let observationStartTime = 0;
let observationTimeout = null;
let observer = null;

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "receiveQuestion") {
    resetObservation();

    const messages = document.querySelectorAll("model-response");
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
  if (observer) {
    observer.disconnect();
    observer = null;
  }
}

function waitForIdle(timeout = 120000) {
  return new Promise((resolve, reject) => {
    const startTime = Date.now();
    const interval = setInterval(() => {
      const sendButton = document.querySelector(".send-button");
      if (!sendButton || !sendButton.classList.contains("stop")) {
        clearInterval(interval);
        resolve();
      } else if (Date.now() - startTime > timeout) {
        clearInterval(interval);
        reject(new Error("Timed out waiting for Gemini to finish responding"));
      }
    }, 500);
  });
}

async function insertQuestion(questionData) {
  const text = buildPrompt(questionData);

  return new Promise((resolve, reject) => {
    waitForIdle()
      .then(() => {
        const inputArea = document.querySelector(".ql-editor");
        if (inputArea) {
          setTimeout(() => {
            inputArea.focus();
            inputArea.innerHTML = `<p>${escapeHtml(text)}</p>`;
            inputArea.dispatchEvent(new Event("input", { bubbles: true }));

            setTimeout(() => {
              const sendButton = document.querySelector(".send-button");
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
      })
      .catch(reject);
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
       "\n\nIMPORTANT: Your answer must EXACTLY match the above options. Do not include numbers in your answer. If there are periods, include them. If there are multiple selections, include all of the correct selections.";
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

function escapeHtml(text) {
  return String(text || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function startObserving() {
  observationStartTime = Date.now();
  observationTimeout = setTimeout(() => {
    if (!hasResponded) {
      resetObservation();
    }
  }, 180000);

  observer = new MutationObserver((mutations) => {
    if (hasResponded) return;

    const messages = document.querySelectorAll("model-response");
    if (!messages.length) return;

    if (messages.length <= messageCountAtQuestion) return;

    const latestMessage = messages[messages.length - 1];

    const codeBlocks = latestMessage.querySelectorAll("pre code");
    let responseText = "";

    for (const block of codeBlocks) {
      if (block.className.includes("hljs-") || block.closest(".code-block")) {
        responseText = block.textContent.trim();
        break;
      }
    }

    if (!responseText) {
      responseText = latestMessage.textContent.trim();
      const jsonMatch = responseText.match(/\{[\s\S]*\}/);
      if (jsonMatch) responseText = jsonMatch[0];
    }

    responseText = repairJsonResponseText(
      responseText
        .replace(/[\u200B-\u200D\uFEFF]/g, "")
        .trim()
    );

    try {
      const parsed = JSON.parse(responseText);
      if ((parsed.answer !== undefined || parsed.actions) && !hasResponded) {
        hasResponded = true;
        chrome.runtime
          .sendMessage({
            type: "geminiResponse",
            response: responseText,
          })
          .then(() => {
            resetObservation();
          })
          .catch((error) => {
            console.error("Error sending response:", error);
          });
      }
    } catch (e) {
      const isGenerating =
        latestMessage.querySelector(".cursor") ||
        latestMessage.classList.contains("generating");

      if (!isGenerating && Date.now() - observationStartTime > 30000) {
        const responseText = latestMessage.textContent.trim();
        try {
          const jsonText = findJsonObject(responseText);

          if (jsonText && !hasResponded) {
            hasResponded = true;
            chrome.runtime.sendMessage({
              type: "geminiResponse",
              response: repairJsonResponseText(jsonText),
            });
            resetObservation();
          }
        } catch (e) {}
      }
    }
  });

  observer.observe(document.body, {
    childList: true,
    subtree: true,
    characterData: true,
  });
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
