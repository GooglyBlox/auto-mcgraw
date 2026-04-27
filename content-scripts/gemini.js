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

  if (type === "connect_slot_graph") {
    return buildSlotGraphPrompt(questionData);
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
      if ((parsed.answer !== undefined || parsed.actions || parsed.slots) && !hasResponded) {
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
