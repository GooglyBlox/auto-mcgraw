let messageListener = null;
let isAutomating = false;
let lastIncorrectQuestion = null;
let lastCorrectAnswer = null;
let doubleCreditMode = false;
let randomConfidence = false;
let pauseBeforeSubmit = false;
let waitingForDuplicateCompletion = false;
let currentResponse = null;
let matchingPauseIntervalId = null;
let pendingRequestId = null;
let requestRetries = 0;
let responseWatchdogId = null;
let pendingQuestionSignature = null;
const LOG_PREFIX = "[Auto-McGraw][mhe]";
// Slightly longer than the assistant-side timeout, so that one normally
// reports first with a more specific error.
const RESPONSE_WATCHDOG_MS = 200000;
const MAX_REQUEST_RETRIES = 1;

chrome.storage.sync.get(["doubleCreditMode", "randomConfidence", "pauseBeforeSubmit"], function (data) {
  doubleCreditMode = data.doubleCreditMode || false;
  randomConfidence = data.randomConfidence || false;
  pauseBeforeSubmit = data.pauseBeforeSubmit || false;
});

chrome.storage.onChanged.addListener((changes) => {
  if (changes.doubleCreditMode) {
    doubleCreditMode = changes.doubleCreditMode.newValue;
  }
  if (changes.randomConfidence) {
    randomConfidence = changes.randomConfidence.newValue;
  }
  if (changes.pauseBeforeSubmit) {
    pauseBeforeSubmit = changes.pauseBeforeSubmit.newValue;
  }
});

function getConfidenceSelector() {
  if (!randomConfidence) {
    return '[data-automation-id="confidence-buttons--high_confidence"]:not([disabled])';
  }
  const levels = [
    "high_confidence",
    "medium_confidence",
    "low_confidence",
  ];
  const pick = levels[Math.floor(Math.random() * levels.length)];
  return `[data-automation-id="confidence-buttons--${pick}"]:not([disabled])`;
}

function setupMessageListener() {
  if (messageListener) {
    chrome.runtime.onMessage.removeListener(messageListener);
  }

  messageListener = (message, sender, sendResponse) => {
    if (message.type === "ping") {
      const container = document.querySelector(".probe-container");
      sendResponse({ received: true, ready: !!container });
      return true;
    }

    if (message.type === "processChatGPTResponse") {
      // Drop answers that belong to an earlier question (e.g. a late reply
      // after a retry, or one that arrives after automation was stopped).
      if (!message.isDuplicateTab && !isExpectedResponse(message.requestId)) {
        console.warn(LOG_PREFIX, "Ignoring stale assistant response");
        sendResponse({ received: true, ignored: true });
        return true;
      }
      const expectedSignature = pendingQuestionSignature;
      clearPendingRequest();
      requestRetries = 0;

      // The page moved on (e.g. the user answered it) while the AI was busy.
      const currentContainer = document.querySelector(".probe-container");
      if (
        !message.isDuplicateTab &&
        expectedSignature &&
        currentContainer &&
        getQuestionSignature(currentContainer) !== expectedSignature
      ) {
        console.warn(LOG_PREFIX, "Question changed before the answer arrived");
        if (isAutomating) checkForNextStep();
        sendResponse({ received: true, ignored: true });
        return true;
      }

      if (
        doubleCreditMode &&
        !message.isDuplicateTab &&
        !waitingForDuplicateCompletion
      ) {
        currentResponse = message.response;
        processDoubleCreditResponse(message.response);
      } else {
        void processChatGPTResponse(message.response).catch((error) => {
          handleProcessResponseError(error);
        });
      }
      sendResponse({ received: true });
      return true;
    }

    if (message.type === "processDuplicateTab") {
      processDuplicateTabAnswering(message.response);
      sendResponse({ received: true });
      return true;
    }

    if (message.type === "completeDoubleCredit") {
      completeDoubleCreditFlow();
      sendResponse({ received: true });
      return true;
    }

    if (message.type === "alertMessage") {
      alert(message.message);
      sendResponse({ received: true });
      return true;
    }

    if (message.type === "assistantError") {
      if (isExpectedResponse(message.requestId)) {
        handleAssistantFailure(
          message.error || "The assistant reported an error."
        );
      }
      sendResponse({ received: true });
      return true;
    }

    if (message.type === "stopAutomation") {
      stopAutomation();
      sendResponse({ received: true });
      return true;
    }
  };

  chrome.runtime.onMessage.addListener(messageListener);
}

function updateButtonState() {
  chrome.storage.sync.get(["aiModel", "doubleCreditMode"], function (data) {
    const currentModel = data.aiModel || "chatgpt";
    const doubleMode = data.doubleCreditMode || false;
    let currentModelName = "ChatGPT";

    if (currentModel === "gemini") {
      currentModelName = "Gemini";
    } else if (currentModel === "deepseek") {
      currentModelName = "DeepSeek";
    }

    const btn = document.querySelector(".automcgraw-btn");
    if (btn) {
      btn.textContent = `Ask ${currentModelName}${doubleMode ? " (2x)" : ""}`;
    }
  });
}

function getAssistantName(callback) {
  chrome.storage.sync.get("aiModel", (data) => {
    const names = { chatgpt: "ChatGPT", gemini: "Gemini", deepseek: "DeepSeek" };
    callback(names[data.aiModel] || "ChatGPT");
  });
}

function clearPendingRequest() {
  pendingRequestId = null;
  pendingQuestionSignature = null;
  if (responseWatchdogId !== null) {
    clearTimeout(responseWatchdogId);
    responseWatchdogId = null;
  }
}

function isExpectedResponse(requestId) {
  if (!pendingRequestId) return false;
  return !requestId || requestId === pendingRequestId;
}

// Stops automation and, if a reason is given, tells the user why instead of
// failing silently.
function stopAutomation(reason) {
  isAutomating = false;
  waitingForDuplicateCompletion = false;
  clearPendingRequest();
  clearMatchingPauseWatcher();
  updateButtonState();

  if (reason) {
    console.warn(LOG_PREFIX, "Automation stopped:", reason);
    alert(`Auto-McGraw stopped: ${reason}`);
  }
}

function sendQuestionToAssistant(questionData, questionSignature) {
  clearPendingRequest();

  const requestId = `${Date.now().toString(36)}-${Math.random()
    .toString(36)
    .slice(2, 10)}`;
  pendingRequestId = requestId;
  pendingQuestionSignature = questionSignature;
  responseWatchdogId = setTimeout(() => {
    if (pendingRequestId === requestId) {
      handleAssistantFailure("No answer was received from the assistant.");
    }
  }, RESPONSE_WATCHDOG_MS);

  chrome.runtime.sendMessage({
    type: "sendQuestionToChatGPT",
    question: questionData,
    requestId,
  });
}

// Retries the current question once, then stops with an explanation.
function handleAssistantFailure(reason) {
  clearPendingRequest();
  if (!isAutomating) return;

  if (requestRetries < MAX_REQUEST_RETRIES) {
    requestRetries += 1;
    console.warn(LOG_PREFIX, "Retrying question after:", reason);
    checkForNextStep();
    return;
  }

  requestRetries = 0;
  getAssistantName((name) => {
    stopAutomation(
      `${reason}\n\nMake sure ${name} is open, signed in and not showing an error or popup, then click "Ask ${name}" to continue.`
    );
  });
}

function handleProcessResponseError(error) {
  console.error("Error processing response:", error);
  stopAutomation(
    `Something went wrong while applying the answer (${
      error && error.message ? error.message : error
    }).`
  );
}

function processDoubleCreditResponse(responseText) {
  try {
    if (handleTopicOverview()) return;
    if (handleForcedLearning()) return;

    const response = JSON.parse(responseText);
    const answers = Array.isArray(response.answer)
      ? response.answer
      : [response.answer];

    const container = document.querySelector(".probe-container");
    if (!container) return;

    if (container.querySelector(".awd-probe-type-matching")) {
      stopAutomation(
        "Matching questions are not supported in double credit mode. Please complete this one manually."
      );
      return;
    }

    if (!fillInAnswers(answers, container)) {
      pauseForManualAnswer(
        container,
        "Couldn't match the AI's answer to this question's choices.",
        flattenAnswerValues(answers)
      );
      return;
    }

    waitingForDuplicateCompletion = true;
    chrome.runtime.sendMessage({ type: "createDuplicateTab" });
  } catch (e) {
    console.error("Error processing double credit response:", e);
    stopAutomation(`Something went wrong in double credit mode (${e.message}).`);
  }
}

function processDuplicateTabAnswering(responseText) {
  try {

    const response = JSON.parse(responseText);
    const answers = Array.isArray(response.answer)
      ? response.answer
      : [response.answer];


    waitForElement(".probe-container", 5000)
      .then((container) => {

        setTimeout(() => {
          fillInAnswers(answers, container);

          waitForElement(
            getConfidenceSelector(),
            3000
          )
            .then((button) => {
              button.click();

              setTimeout(() => {
                chrome.runtime.sendMessage({ type: "finishDoubleCredit" });

                setTimeout(() => {
                  chrome.runtime.sendMessage({ type: "closeDuplicateTab" });
                }, 300);
              }, 800);
            })
            .catch((error) => {
              console.error(
                "Could not find high confidence button in duplicate tab:",
                error
              );
            });
        }, 500);
      })
      .catch((error) => {
        console.error(
          "Could not find probe container in duplicate tab:",
          error
        );
      });
  } catch (e) {
    console.error("Error processing duplicate tab:", e);
  }
}

function completeDoubleCreditFlow() {
  waitingForDuplicateCompletion = false;

  const container = document.querySelector(".probe-container");
  if (!container) return;

  waitForElement(
    getConfidenceSelector(),
    3000
  ).then((button) => {
    button.click();

    setTimeout(() => {
      checkForCorrectAnswer(container);

      waitForElement(".next-button", 5000)
        .then((nextButton) => {
          nextButton.click();

          chrome.runtime.sendMessage({ type: "resetTabTracking" });

          if (isAutomating) {
            setTimeout(() => {
              checkForNextStep();
            }, 800);
          }
        })
        .catch((error) => {
          console.error("Automation error:", error);
          stopAutomation(
            "Couldn't find SmartBook's Next button after submitting the answer."
          );
        });
    }, 800);
  }).catch(() => {
    chrome.runtime.sendMessage({ type: "resetTabTracking" });
    stopAutomation(
      "The answer was filled in, but SmartBook didn't accept it. Please answer this question manually."
    );
  });
}

function getChoiceInputs(container) {
  return Array.from(
    container.querySelectorAll('input[type="radio"], input[type="checkbox"]')
  )
    .map((input) => {
      const textEl = input.closest("label")?.querySelector(".choiceText");
      return { input, text: textEl ? getReadableText(textEl) : "" };
    })
    .filter((choice) => choice.text);
}

// Applies the AI's answer to the current question. Returns true if at least
// one blank was filled or one choice was selected.
function fillInAnswers(answers, container) {
  const answerList = flattenAnswerValues(answers);

  if (container.querySelector(".awd-probe-type-fill_in_the_blank")) {
    const inputs = Array.from(container.querySelectorAll("input.fitb-input"));
    let values = answerList;
    if (values.length === 1 && inputs.length > 1) {
      const parts = values[0].split(/\s*[;,]\s*/).filter(Boolean);
      if (parts.length === inputs.length) {
        values = parts;
      }
    }

    let filled = 0;
    inputs.forEach((input, index) => {
      if (values[index] === undefined) return;
      input.value = values[index];
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new Event("change", { bubbles: true }));
      filled += 1;
    });
    return filled > 0;
  }

  const choices = getChoiceInputs(container);
  const allowMultiple = choices.some(
    (choice) => choice.input.type === "checkbox"
  );
  const indices = resolveChoiceIndices(
    choices.map((choice) => choice.text),
    answerList,
    allowMultiple
  );

  indices.forEach((index) => {
    const { input } = choices[index];
    if (!input.checked) {
      input.click();
    }
  });

  return indices.length > 0;
}

function checkForCorrectAnswer(container) {
  const incorrectMarker = container.querySelector(
    ".awd-probe-correctness.incorrect"
  );
  if (incorrectMarker) {
    const correctionData = extractCorrectAnswer();
    if (correctionData && correctionData.answer) {
      lastIncorrectQuestion = correctionData.question;
      lastCorrectAnswer = cleanAnswer(correctionData.answer);
      console.log(
        "Found incorrect answer. Correct answer is:",
        lastCorrectAnswer
      );
    }
  }
}

function handleTopicOverview() {
  const continueButton = document.querySelector(
    "awd-topic-overview-button-bar .next-button, .button-bar-wrapper .next-button"
  );

  if (
    continueButton &&
    continueButton.textContent.trim().toLowerCase().includes("continue")
  ) {
    continueButton.click();

    setTimeout(() => {
      if (isAutomating) {
        checkForNextStep();
      }
    }, 1000);

    return true;
  }
  return false;
}

function clearMatchingPauseWatcher() {
  if (matchingPauseIntervalId !== null) {
    clearInterval(matchingPauseIntervalId);
    matchingPauseIntervalId = null;
  }
}

function getProbeId(container) {
  return (
    container?.querySelector("[data-probe-id]")?.getAttribute("data-probe-id") ||
    ""
  );
}

function getQuestionSignature(container) {
  if (!container) return "";

  const questionType = detectQuestionType(container);
  const probeId = getProbeId(container);
  if (questionType === "matching") {
    const promptText =
      container.querySelector(".prompt")?.textContent?.trim() || "";
    const prompts = Array.from(
      container.querySelectorAll(".match-prompt .content")
    )
      .map((el) => normalizeChoiceText(el.textContent))
      .filter(Boolean)
      .join("|");

    return `${probeId}::${questionType}::${normalizeChoiceText(promptText)}::${prompts}`;
  }

  const promptText = container.querySelector(".prompt")?.textContent?.trim() || "";

  return `${probeId}::${questionType}::${normalizeChoiceText(promptText)}`;
}

// Used when an answer can't be applied automatically: shows what the AI
// suggested, then waits for the user to answer and move on by themselves.
function pauseForManualAnswer(container, heading, answerLines) {
  const questionSignature = getQuestionSignature(container);
  const suggestion =
    answerLines && answerLines.length
      ? `AI answer:\n${answerLines.join("\n")}`
      : "The AI did not return a usable answer.";

  alert(
    `${heading}\n\n${suggestion}\n\nPlease answer this question yourself, then click a confidence button and Next. Automation will resume on the next question.`
  );

  if (isAutomating) {
    pauseForManualAnswerAndResume(questionSignature);
  }
}

function pauseForManualAnswerAndResume(questionSignature) {
  if (!questionSignature) return;

  clearMatchingPauseWatcher();

  // After manual fallback, resume only when the user advances to a different question.
  matchingPauseIntervalId = setInterval(() => {
    if (!isAutomating) {
      clearMatchingPauseWatcher();
      return;
    }

    const currentContainer = document.querySelector(".probe-container");
    if (!currentContainer) return;

    const currentSignature = getQuestionSignature(currentContainer);
    if (
      currentSignature &&
      currentSignature !== questionSignature &&
      isQuestionAnswerable(currentContainer)
    ) {
      clearMatchingPauseWatcher();

      setTimeout(() => {
        if (isAutomating) {
          checkForNextStep();
        }
      }, 500);
    }
  }, 400);
}

function handleForcedLearning() {
  const forcedLearningAlert = document.querySelector(
    ".forced-learning .alert-error"
  );
  if (forcedLearningAlert) {
    const readButton = document.querySelector(
      '[data-automation-id="lr-tray_reading-button"]'
    );
    if (readButton) {
      readButton.click();

      waitForElement('[data-automation-id="reading-questions-button"]', 10000)
        .then((toQuestionsButton) => {
          toQuestionsButton.click();
          return waitForElement(".next-button", 10000);
        })
        .then((nextButton) => {
          nextButton.click();
          if (isAutomating) {
            setTimeout(() => {
              checkForNextStep();
            }, 1000);
          }
        })
        .catch((error) => {
          console.error("Error in forced learning flow:", error);
          stopAutomation(
            "Couldn't get through the required reading section. Please return to the questions manually, then start automation again."
          );
        });
      return true;
    }
  }
  return false;
}

// After an answer is submitted the question switches to review mode and stays
// on screen until SmartBook loads the next one, which can take a while on a
// slow connection. Only questions still in testing mode can be answered.
function isQuestionAnswerable(container) {
  if (container.querySelector('[class*="awd-probe-mode-"]')) {
    return !!container.querySelector(".awd-probe-mode-testing");
  }
  return (
    !container.querySelector(".awd-probe-correctness") &&
    !document.querySelector(".next-button")
  );
}

function checkForNextStep(attempt = 0) {
  if (!isAutomating) return;

  if (handleTopicOverview()) {
    return;
  }

  if (handleForcedLearning()) {
    return;
  }

  const container = document.querySelector(".probe-container");
  if (
    container &&
    !container.querySelector(".forced-learning") &&
    isQuestionAnswerable(container)
  ) {
    const qData = parseQuestion();
    if (qData) {
      sendQuestionToAssistant(qData, getQuestionSignature(container));
    }
    return;
  }

  // Still showing a question that was already answered (e.g. automation was
  // started on one, or a Next click didn't register): move on. Wait a few
  // seconds first so this doesn't double-click while the next one loads.
  const nextButton = document.querySelector(".next-button");
  if (nextButton && attempt % 6 === 5) {
    nextButton.click();
  }

  // The next question may still be loading.
  if (attempt < 30) {
    setTimeout(() => checkForNextStep(attempt + 1), 500);
    return;
  }

  stopAutomation(
    "No new question appeared. If the assignment is complete you're done; otherwise go to the next question and start automation again."
  );
}

function detectQuestionType(container) {
  if (container.querySelector(".awd-probe-type-multiple_choice")) {
    return "multiple_choice";
  }
  if (container.querySelector(".awd-probe-type-true_false")) {
    return "true_false";
  }
  if (container.querySelector(".awd-probe-type-multiple_select")) {
    return "multiple_select";
  }
  if (container.querySelector(".awd-probe-type-fill_in_the_blank")) {
    return "fill_in_the_blank";
  }
  if (container.querySelector(".awd-probe-type-select_text")) {
    return "select_text";
  }
  if (container.querySelector(".awd-probe-type-matching")) {
    return "matching";
  }
  // Unknown probe types that still use ordinary radio buttons or checkboxes.
  if (container.querySelector(".choiceText")) {
    if (container.querySelector('input[type="checkbox"]')) {
      return "multiple_select";
    }
    if (container.querySelector('input[type="radio"]')) {
      return "multiple_choice";
    }
  }
  return "";
}

function normalizeChoiceText(text) {
  if (typeof text !== "string") return "";

  return text
    .replace(/\u00a0/g, " ")
    .replace(/&amp;/gi, "&")
    .replace(/[’‘]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\.$/, "");
}

function stripWrappingQuotes(text) {
  if (typeof text !== "string") return "";

  const trimmed = text.trim();
  if (trimmed.length < 2) return trimmed;

  const firstChar = trimmed[0];
  const lastChar = trimmed[trimmed.length - 1];
  if (firstChar !== lastChar || !/["'`]/.test(firstChar)) {
    return trimmed;
  }

  return trimmed.slice(1, -1).trim();
}

function isAnswerMatch(choiceText, answerText) {
  if (!choiceText || answerText === null || answerText === undefined) {
    return false;
  }

  const choice = String(choiceText).trim();
  const answer = String(answerText).trim();
  if (!choice || !answer) return false;

  if (choice === answer) return true;

  const choiceWithoutPeriod = choice.replace(/\.$/, "");
  const answerWithoutPeriod = answer.replace(/\.$/, "");
  if (choiceWithoutPeriod === answerWithoutPeriod) return true;

  if (choice === answer + ".") return true;

  const normalizedChoice = normalizeChoiceText(choice);
  const normalizedAnswer = normalizeChoiceText(answer);
  if (normalizedChoice === normalizedAnswer) return true;

  return (
    normalizeChoiceText(stripWrappingQuotes(choice)) ===
    normalizeChoiceText(stripWrappingQuotes(answer))
  );
}

// Returns an element's text in a form an AI can read: tables become one row
// per line with " | " between cells, images become their alt text, and the
// screen-reader-only "Blank" label next to blanks is dropped.
function getReadableText(element) {
  if (!element) return "";

  const clone = element.cloneNode(true);

  clone.querySelectorAll("span._visuallyHidden").forEach((span) => {
    if (/^\s*blank\s*$/i.test(span.textContent)) {
      span.remove();
    }
  });

  clone.querySelectorAll("table").forEach((table) => {
    const lines = [];
    const caption = table.querySelector("caption");
    if (caption && caption.textContent.trim()) {
      lines.push(caption.textContent.replace(/\s+/g, " ").trim());
    }
    table.querySelectorAll("tr").forEach((row) => {
      const cells = Array.from(row.querySelectorAll("th, td")).map((cell) =>
        cell.textContent.replace(/\s+/g, " ").trim()
      );
      if (cells.some(Boolean)) {
        lines.push(cells.join(" | "));
      }
    });
    table.replaceWith(document.createTextNode(`\n${lines.join("\n")}\n`));
  });

  clone.querySelectorAll("img").forEach((img) => {
    const alt = (img.getAttribute("alt") || "").trim();
    img.replaceWith(document.createTextNode(alt ? ` [Image: ${alt}] ` : " "));
  });

  clone.querySelectorAll("br").forEach((br) => {
    br.replaceWith(document.createTextNode("\n"));
  });
  clone.querySelectorAll("p, li, div").forEach((block) => {
    block.appendChild(document.createTextNode("\n"));
  });

  return clone.textContent
    .replace(/[ \t\u00a0]+/g, " ")
    .replace(/ *\n[\s]*/g, "\n")
    .trim();
}

function normalizeForMatch(text) {
  return normalizeChoiceText(stripWrappingQuotes(String(text ?? "")))
    .toLowerCase()
    .replace(/["'`]/g, "")
    .replace(/[.;:,!?]+$/, "")
    .trim();
}

// Resolves one AI answer to a choice index. Tries an exact (case-insensitive)
// match, then answers given as an option number or letter ("2", "B",
// "B. text"), then the closest choice that contains or is contained by it.
function findChoiceIndex(choiceTexts, answer) {
  const normalizedChoices = choiceTexts.map(normalizeForMatch);
  const normalizedAnswer = normalizeForMatch(answer);
  if (!normalizedAnswer) return -1;

  let index = normalizedChoices.indexOf(normalizedAnswer);
  if (index !== -1) return index;

  const labelOnly = normalizedAnswer.match(/^(?:option\s+)?\(?([a-z]|\d{1,2})\)?$/i);
  if (labelOnly) {
    const label = labelOnly[1];
    const labelIndex = /\d/.test(label)
      ? Number(label) - 1
      : label.charCodeAt(0) - 97;
    if (labelIndex >= 0 && labelIndex < choiceTexts.length) return labelIndex;
  }

  const withoutLabel = normalizedAnswer
    .replace(/^(?:option\s+)?\(?(?:[a-z]|\d{1,2})[.):]\s+/i, "")
    .trim();
  if (withoutLabel !== normalizedAnswer) {
    index = normalizedChoices.indexOf(withoutLabel);
    if (index !== -1) return index;
  }

  const toWords = (text) => ` ${text.replace(/[^a-z0-9]+/g, " ").trim()} `;
  const answerWords = [normalizedAnswer, withoutLabel].map(toWords);

  let bestIndex = -1;
  let bestScore = 0;
  let candidateCount = 0;
  normalizedChoices.forEach((choice, choiceIndex) => {
    const choiceWords = toWords(choice);
    if (!choiceWords.trim()) return;

    let choiceScore = 0;
    for (const words of answerWords) {
      if (!words.trim()) continue;
      if (choiceWords.includes(words) || words.includes(choiceWords)) {
        const score =
          Math.min(choiceWords.length, words.length) /
          Math.max(choiceWords.length, words.length);
        choiceScore = Math.max(choiceScore, score);
      }
    }

    if (choiceScore > 0) {
      candidateCount += 1;
      if (choiceScore > bestScore) {
        bestScore = choiceScore;
        bestIndex = choiceIndex;
      }
    }
  });

  return candidateCount === 1 || bestScore >= 0.5 ? bestIndex : -1;
}

function resolveChoiceIndices(choiceTexts, answers, allowMultiple) {
  const indices = [];
  for (const answer of answers) {
    const index = findChoiceIndex(choiceTexts, answer);
    if (index !== -1 && !indices.includes(index)) {
      indices.push(index);
      if (!allowMultiple) break;
    }
  }
  return indices;
}

function extractCorrectAnswer() {
  const container = document.querySelector(".probe-container");
  if (!container) return null;

  const incorrectMarker = container.querySelector(
    ".awd-probe-correctness.incorrect"
  );
  if (!incorrectMarker) return null;

  const questionType = detectQuestionType(container);

  let questionText = "";
  const promptEl = container.querySelector(".prompt");

  if (questionType === "fill_in_the_blank" && promptEl) {
    const promptClone = promptEl.cloneNode(true);

    const spans = promptClone.querySelectorAll(
      "span.response-container, span.fitb-span, span.blank-label, span.correctness, span._visuallyHidden"
    );
    spans.forEach((span) => span.remove());

    const inputs = promptClone.querySelectorAll("input.fitb-input");
    inputs.forEach((input) => {
      const blankMarker = document.createTextNode("[BLANK]");
      input.parentNode.replaceChild(blankMarker, input);
    });

    questionText = promptClone.textContent.trim();
  } else {
    questionText = promptEl ? promptEl.textContent.trim() : "";
  }

  let correctAnswer = null;

  if (questionType === "multiple_choice" || questionType === "true_false") {
    try {
      const answerContainer = container.querySelector(
        ".answer-container .choiceText"
      );
      if (answerContainer) {
        correctAnswer = answerContainer.textContent.trim();
      } else {
        const correctAnswerContainer = container.querySelector(
          ".correct-answer-container"
        );
        if (correctAnswerContainer) {
          const answerText =
            correctAnswerContainer.querySelector(".choiceText");
          if (answerText) {
            correctAnswer = answerText.textContent.trim();
          } else {
            const answerDiv = correctAnswerContainer.querySelector(".choice");
            if (answerDiv) {
              correctAnswer = answerDiv.textContent.trim();
            }
          }
        }
      }
    } catch (e) {
      console.error("Error extracting multiple choice answer:", e);
    }
  } else if (questionType === "multiple_select") {
    try {
      const correctAnswersList = container.querySelectorAll(
        ".correct-answer-container .choice"
      );
      if (correctAnswersList && correctAnswersList.length > 0) {
        correctAnswer = Array.from(correctAnswersList).map((el) => {
          const choiceText = el.querySelector(".choiceText");
          return choiceText
            ? choiceText.textContent.trim()
            : el.textContent.trim();
        });
      }
    } catch (e) {
      console.error("Error extracting multiple select answers:", e);
    }
  } else if (questionType === "fill_in_the_blank") {
    try {
      const correctAnswersList = container.querySelectorAll(".correct-answers");

      if (correctAnswersList && correctAnswersList.length > 0) {
        if (correctAnswersList.length === 1) {
          const correctAnswerEl =
            correctAnswersList[0].querySelector(".correct-answer");
          if (correctAnswerEl) {
            correctAnswer = correctAnswerEl.textContent.trim();
          } else {
            const answerText = correctAnswersList[0].textContent.trim();
            if (answerText) {
              const match = answerText.match(/:\s*(.+)$/);
              correctAnswer = match ? match[1].trim() : answerText;
            }
          }
        } else {
          correctAnswer = Array.from(correctAnswersList).map((field) => {
            const correctAnswerEl = field.querySelector(".correct-answer");
            if (correctAnswerEl) {
              return correctAnswerEl.textContent.trim();
            } else {
              const answerText = field.textContent.trim();
              const match = answerText.match(/:\s*(.+)$/);
              return match ? match[1].trim() : answerText;
            }
          });
        }
      }
    } catch (e) {
      console.error("Error extracting fill in the blank answers:", e);
    }
  } else if (questionType === "select_text") {
    try {
      const correctAnswersList = Array.from(
        container.querySelectorAll(
          ".correct-answer-container .choice.-interactive, .correct-answer-container .choiceText, .correct-answer-container .choice"
        )
      )
        .map((el) => el.textContent.trim())
        .filter(Boolean);

      if (correctAnswersList.length === 1) {
        correctAnswer = correctAnswersList[0];
      } else if (correctAnswersList.length > 1) {
        correctAnswer = correctAnswersList;
      }
    } catch (e) {
      console.error("Error extracting select text answers:", e);
    }
  }

  if (questionType === "matching") {
    return null;
  }

  if (correctAnswer === null) {
    console.error("Failed to extract correct answer for", questionType);
    return null;
  }

  return {
    question: questionText,
    answer: correctAnswer,
    type: questionType,
  };
}

function cleanAnswer(answer) {
  if (!answer) return answer;

  if (Array.isArray(answer)) {
    return answer.map((item) => cleanAnswer(item));
  }

  if (typeof answer === "string") {
    let cleanedAnswer = answer.trim();

    cleanedAnswer = cleanedAnswer.replace(/^Field \d+:\s*/, "");

    if (cleanedAnswer.includes(" or ")) {
      cleanedAnswer = cleanedAnswer.split(" or ")[0].trim();
    }

    return cleanedAnswer;
  }

  return answer;
}

function tryParseAnswerArrayString(value) {
  if (typeof value !== "string") return null;

  const trimmed = value.trim();
  if (!(trimmed.startsWith("[") && trimmed.endsWith("]"))) {
    return null;
  }

  try {
    const parsed = JSON.parse(trimmed);
    return Array.isArray(parsed) ? parsed : null;
  } catch (e) {
    return null;
  }
}

function flattenAnswerValues(value, output = []) {
  if (value === null || value === undefined) {
    return output;
  }

  if (Array.isArray(value)) {
    value.forEach((item) => flattenAnswerValues(item, output));
    return output;
  }

  if (typeof value === "string") {
    const parsedArray = tryParseAnswerArrayString(value);
    if (parsedArray) {
      flattenAnswerValues(parsedArray, output);
      return output;
    }

    const trimmed = value.trim();
    if (trimmed) {
      output.push(trimmed);
    }
    return output;
  }

  output.push(String(value));
  return output;
}

function splitCompoundAnswer(answerText) {
  if (typeof answerText !== "string") return [];

  const trimmed = answerText.trim();
  if (!trimmed) return [];

  let parts = trimmed
    .split(/\n|;|,/)
    .map((part) =>
      part
        .trim()
        .replace(/^[-*•]\s*/, "")
        .replace(/^\d+[\).\-\s]+/, "")
        .replace(/^["'`]|["'`]$/g, "")
        .trim()
    )
    .filter(Boolean);

  if (parts.length <= 1 && /\band\b/i.test(trimmed)) {
    parts = trimmed
      .split(/\band\b/i)
      .map((part) =>
        part
          .trim()
          .replace(/^[-*•]\s*/, "")
          .replace(/^\d+[\).\-\s]+/, "")
          .replace(/^["'`]|["'`]$/g, "")
          .trim()
      )
      .filter(Boolean);
  }

  return parts;
}

function dedupeAnswers(answers) {
  const seen = new Set();
  const deduped = [];

  answers.forEach((answer) => {
    const normalized = normalizeChoiceText(answer).toLowerCase();
    if (!normalized || seen.has(normalized)) {
      return;
    }
    seen.add(normalized);
    deduped.push(answer);
  });

  return deduped;
}

function getQuestionChoices(container, questionType) {
  if (questionType === "select_text") {
    return Array.from(
      container.querySelectorAll(".select-text-component .choice.-interactive")
    )
      .map((el) => el.textContent.trim())
      .filter(Boolean);
  }

  return Array.from(container.querySelectorAll(".choiceText"))
    .map((el) => getReadableText(el))
    .filter(Boolean);
}

function createKeyboardEvent(type, key, code, keyCode) {
  const event = new KeyboardEvent(type, {
    key,
    code,
    bubbles: true,
    cancelable: true,
    composed: true,
    keyCode,
    which: keyCode,
    charCode: keyCode,
  });

  try {
    Object.defineProperty(event, "keyCode", {
      get: () => keyCode,
    });
    Object.defineProperty(event, "which", {
      get: () => keyCode,
    });
  } catch (e) {
    // Ignore readonly property overrides in environments that block it.
  }

  return event;
}

function dispatchKeyboardSequence(target, key, code, keyCode) {
  if (!target) return;

  const keyDown = createKeyboardEvent("keydown", key, code, keyCode);
  const keyUp = createKeyboardEvent("keyup", key, code, keyCode);
  target.dispatchEvent(keyDown);
  target.dispatchEvent(keyUp);
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getMatchingComponent(container) {
  if (!container) return null;
  return container.querySelector(".matching-component");
}

// SmartBook rewrites a dropped choice from choices:* to response:* once it lands in a row.
const MATCHING_ALL_CHOICE_SELECTOR =
  '.choice-item-wrapper:not(.-placeholder)[id^="choices:"], .choice-item-wrapper:not(.-placeholder)[id^="response:"]';
const MATCHING_POOL_CHOICE_SELECTOR =
  '.choices-container .choice-item-wrapper:not(.-placeholder)[id^="choices:"]';
const MATCHING_ROW_CHOICE_SELECTOR =
  '.match-single-response-wrapper .choice-item-wrapper:not(.-placeholder)[id^="choices:"], .match-single-response-wrapper .choice-item-wrapper:not(.-placeholder)[id^="response:"]';

function getMatchingRows(container) {
  const matchingComponent = getMatchingComponent(container);
  if (!matchingComponent) return [];

  return Array.from(
    matchingComponent.querySelectorAll(".responses-container .match-row")
  );
}

function getMatchingPromptText(matchRow) {
  if (!matchRow) return "";
  const promptContent =
    matchRow.querySelector(".match-prompt .content") ||
    matchRow.querySelector(".match-prompt");
  const rawText = promptContent ? promptContent.textContent : "";
  return normalizeChoiceText(rawText || "");
}

function getMatchingChoiceText(choiceItem) {
  if (!choiceItem) return "";

  const contentEl =
    choiceItem.querySelector(".content") || choiceItem.querySelector("p");
  const rawText = contentEl ? contentEl.textContent : choiceItem.textContent;
  return normalizeChoiceText(rawText || "");
}

function getMatchingChoiceItems(container) {
  const matchingComponent = getMatchingComponent(container);
  if (!matchingComponent) return [];

  return Array.from(matchingComponent.querySelectorAll(MATCHING_ALL_CHOICE_SELECTOR));
}

function getMatchingDragHandle(choiceItem) {
  if (!choiceItem) return null;

  if (choiceItem.matches?.("[data-react-beautiful-dnd-drag-handle]")) {
    return choiceItem;
  }

  return (
    choiceItem.querySelector("[data-react-beautiful-dnd-drag-handle]") ||
    choiceItem
  );
}

function getMatchingPoolChoiceItems(container) {
  const matchingComponent = getMatchingComponent(container);
  if (!matchingComponent) return [];

  return Array.from(matchingComponent.querySelectorAll(MATCHING_POOL_CHOICE_SELECTOR));
}

function getMatchingRowChoiceItem(matchRow) {
  if (!matchRow) return null;

  return matchRow.querySelector(MATCHING_ROW_CHOICE_SELECTOR);
}

function getMatchingChoiceLocation(container, choiceText) {
  if (!container || !choiceText) {
    return null;
  }

  const rows = getMatchingRows(container);
  for (let rowIndex = 0; rowIndex < rows.length; rowIndex += 1) {
    const rowChoiceItem = getMatchingRowChoiceItem(rows[rowIndex]);
    if (!rowChoiceItem) continue;

    const rowChoiceText = getMatchingChoiceText(rowChoiceItem);
    if (isAnswerMatch(rowChoiceText, choiceText)) {
      return {
        area: "row",
        rowIndex,
        poolIndex: -1,
        item: rowChoiceItem,
      };
    }
  }

  const poolItems = getMatchingPoolChoiceItems(container);
  for (let poolIndex = 0; poolIndex < poolItems.length; poolIndex += 1) {
    const poolChoiceText = getMatchingChoiceText(poolItems[poolIndex]);
    if (isAnswerMatch(poolChoiceText, choiceText)) {
      return {
        area: "pool",
        rowIndex: -1,
        poolIndex,
        item: poolItems[poolIndex],
      };
    }
  }

  return null;
}

function parseMatchingAnswerReference(referenceText, candidateTexts, label = "") {
  if (!candidateTexts || candidateTexts.length === 0) return "";

  const normalizedReference = normalizeChoiceText(String(referenceText || ""));
  if (!normalizedReference) return "";

  // Support common AI shorthand like "#2", "choice 3", or "row 1".
  const parseNumericReference = (value) => {
    const match = value.match(/^#?(\d+)$/);
    if (!match) return "";

    const index = Number(match[1]) - 1;
    if (Number.isInteger(index) && index >= 0 && index < candidateTexts.length) {
      return candidateTexts[index];
    }

    return "";
  };

  let resolved = parseNumericReference(normalizedReference);
  if (resolved) return resolved;

  const promptPrefixes = /^(?:prompt|row|left)\s*#?\s*/i;
  const choicePrefixes = /^(?:choice|option|item|right|match)\s*#?\s*/i;
  const prefixRegex = label === "prompt" ? promptPrefixes : choicePrefixes;
  const strippedReference = normalizedReference.replace(prefixRegex, "").trim();

  resolved = parseNumericReference(strippedReference);
  if (resolved) return resolved;

  const referenceVariants = dedupeAnswers([
    strippedReference,
    stripWrappingQuotes(strippedReference),
  ]).filter(Boolean);

  for (const variant of referenceVariants) {
    const exactMatch = candidateTexts.find((candidate) =>
      isAnswerMatch(candidate, variant)
    );
    if (exactMatch) return exactMatch;
  }

  for (const variant of referenceVariants) {
    const normalizedTarget = normalizeChoiceText(variant).toLowerCase();
    if (!normalizedTarget) continue;

    const normalizedCandidateMatch = candidateTexts.find((candidate) => {
      return normalizeChoiceText(candidate).toLowerCase() === normalizedTarget;
    });
    if (normalizedCandidateMatch) return normalizedCandidateMatch;

    const partialMatch = candidateTexts.find((candidate) => {
      const normalizedCandidate = normalizeChoiceText(candidate).toLowerCase();
      return (
        normalizedCandidate &&
        (normalizedCandidate.includes(normalizedTarget) ||
          normalizedTarget.includes(normalizedCandidate))
      );
    });
    if (partialMatch) return partialMatch;
  }

  return "";
}

function splitMatchingAnswerSegments(answerText) {
  if (typeof answerText !== "string") return [];

  const initialSegments = answerText
    .split(/\n|;/)
    .map((segment) =>
      segment
        .trim()
        .replace(/^[-*•]\s*/, "")
        .trim()
    )
    .filter(Boolean);

  const expandedSegments = [];
  initialSegments.forEach((segment) => {
    const delimiterCount = (segment.match(/->|=>|:/g) || []).length;
    if (segment.includes(",") && delimiterCount > 1) {
      segment
        .split(",")
        .map((part) => part.trim())
        .filter(Boolean)
        .forEach((part) => expandedSegments.push(part));
      return;
    }

    expandedSegments.push(segment);
  });

  return expandedSegments;
}

function parseMatchingPairString(answerText) {
  if (typeof answerText !== "string") return null;

  let cleanedText = answerText
    .trim()
    .replace(/^[-*•]\s*/, "")
    .trim();
  if (!/(?:->|=>|:)/.test(cleanedText)) {
    cleanedText = cleanedText.replace(/^\d+[\.)]\s+/, "").trim();
  }
  if (!cleanedText) return null;

  const arrowMatch = cleanedText.match(/^(.*?)\s*(?:->|=>)\s*(.+)$/);
  if (arrowMatch) {
    return {
      promptRef: arrowMatch[1].trim(),
      choiceRef: arrowMatch[2].trim(),
    };
  }

  const colonMatch = cleanedText.match(/^(.*?)\s*:\s*(.+)$/);
  if (colonMatch) {
    return {
      promptRef: colonMatch[1].trim(),
      choiceRef: colonMatch[2].trim(),
    };
  }

  return null;
}

function collectMatchingAnswerEntries(rawAnswer, output) {
  if (!output || rawAnswer === null || rawAnswer === undefined) {
    return;
  }

  if (Array.isArray(rawAnswer)) {
    rawAnswer.forEach((entry) => collectMatchingAnswerEntries(entry, output));
    return;
  }

  if (typeof rawAnswer === "object") {
    // Accept both explicit pair objects and map-like objects.
    const promptCandidate =
      rawAnswer.prompt ??
      rawAnswer.left ??
      rawAnswer.source ??
      rawAnswer.from ??
      rawAnswer.key;
    const choiceCandidate =
      rawAnswer.choice ??
      rawAnswer.match ??
      rawAnswer.right ??
      rawAnswer.target ??
      rawAnswer.to ??
      rawAnswer.answer ??
      rawAnswer.value;

    if (promptCandidate !== undefined && choiceCandidate !== undefined) {
      output.pairs.push({
        promptRef: String(promptCandidate),
        choiceRef: String(choiceCandidate),
      });
      return;
    }

    Object.entries(rawAnswer).forEach(([promptRef, choiceRef]) => {
      output.pairs.push({
        promptRef: String(promptRef),
        choiceRef: String(choiceRef),
      });
    });
    return;
  }

  if (typeof rawAnswer === "string") {
    const parsedArray = tryParseAnswerArrayString(rawAnswer);
    if (parsedArray) {
      collectMatchingAnswerEntries(parsedArray, output);
      return;
    }

    const segments = splitMatchingAnswerSegments(rawAnswer);
    if (!segments.length) {
      const cleaned = normalizeChoiceText(rawAnswer);
      if (cleaned) {
        output.rawStrings.push(cleaned);
        output.sequentialChoices.push(cleaned);
      }
      return;
    }

    segments.forEach((segment) => {
      const pair = parseMatchingPairString(segment);
      if (pair) {
        output.pairs.push(pair);
      } else {
        const cleanedSegment = normalizeChoiceText(segment);
        if (cleanedSegment) {
          output.rawStrings.push(cleanedSegment);
          output.sequentialChoices.push(cleanedSegment);
        }
      }
    });
    return;
  }

  const normalizedPrimitive = normalizeChoiceText(String(rawAnswer));
  if (normalizedPrimitive) {
    output.rawStrings.push(normalizedPrimitive);
    output.sequentialChoices.push(normalizedPrimitive);
  }
}

function normalizeMatchingTargets(container, rawAnswer) {
  const rows = getMatchingRows(container);
  if (!rows.length) return [];

  const prompts = rows.map((row) => getMatchingPromptText(row));
  const choiceTexts = dedupeAnswers(
    getMatchingChoiceItems(container)
      .map((item) => getMatchingChoiceText(item))
      .filter(Boolean)
  );
  if (!prompts.length || !choiceTexts.length) return [];

  const collected = {
    pairs: [],
    sequentialChoices: [],
    rawStrings: [],
  };
  collectMatchingAnswerEntries(rawAnswer, collected);

  const targetByRow = new Map();
  collected.pairs.forEach((pair) => {
    const promptText = parseMatchingAnswerReference(
      pair.promptRef,
      prompts,
      "prompt"
    );
    const choiceText = parseMatchingAnswerReference(
      pair.choiceRef,
      choiceTexts,
      "choice"
    );
    if (!promptText || !choiceText) return;

    const rowIndex = prompts.findIndex((prompt) => isAnswerMatch(prompt, promptText));
    if (rowIndex < 0 || targetByRow.has(rowIndex)) return;

    targetByRow.set(rowIndex, {
      rowIndex,
      promptText: prompts[rowIndex],
      choiceText,
    });
  });

  if (targetByRow.size === 0 && collected.sequentialChoices.length === prompts.length) {
    // If AI only returned ordered choices, map them by row position.
    const orderedChoices = collected.sequentialChoices
      .map((choiceRef) =>
        parseMatchingAnswerReference(choiceRef, choiceTexts, "choice")
      )
      .filter(Boolean);

    if (orderedChoices.length === prompts.length) {
      orderedChoices.forEach((choiceText, rowIndex) => {
        targetByRow.set(rowIndex, {
          rowIndex,
          promptText: prompts[rowIndex],
          choiceText,
        });
      });
    }
  }

  return prompts.map((promptText, rowIndex) => {
    const target = targetByRow.get(rowIndex);
    return {
      rowIndex,
      promptText,
      choiceText: target ? target.choiceText : "",
    };
  });
}

function getMatchingSnapshot(container) {
  return getMatchingRows(container).map((row, rowIndex) => {
    const rowChoiceItem = getMatchingRowChoiceItem(row);
    return {
      rowIndex,
      promptText: getMatchingPromptText(row),
      choiceText: rowChoiceItem ? getMatchingChoiceText(rowChoiceItem) : "",
    };
  });
}

function isMatchingAligned(container, targetsByRow) {
  if (!container || !Array.isArray(targetsByRow) || targetsByRow.length === 0) {
    return false;
  }

  const rows = getMatchingRows(container);
  if (rows.length !== targetsByRow.length) {
    return false;
  }

  for (let rowIndex = 0; rowIndex < rows.length; rowIndex += 1) {
    const target = targetsByRow[rowIndex];
    if (!target || !target.choiceText) {
      return false;
    }

    const currentChoice = getMatchingChoiceText(getMatchingRowChoiceItem(rows[rowIndex]));
    if (!isAnswerMatch(currentChoice, target.choiceText)) {
      return false;
    }
  }

  return true;
}

async function moveMatchingChoiceToRow(
  container,
  choiceText,
  targetRowIndex,
  liftConfig = {
    key: " ",
    code: "Space",
    keyCode: 32,
  }
) {
  if (!container || !choiceText || targetRowIndex < 0) {
    return false;
  }

  const rows = getMatchingRows(container);
  const initialLocation = getMatchingChoiceLocation(container, choiceText);
  if (!initialLocation) {
    return false;
  }
  if (initialLocation.rowIndex === targetRowIndex) {
    return true;
  }

  const handle = getMatchingDragHandle(initialLocation.item);
  if (!handle) {
    return false;
  }

  if (typeof handle.focus === "function") {
    try {
      handle.focus({ preventScroll: true });
    } catch (e) {
      handle.focus();
    }
  }

  const initialHandle = handle;
  if (!initialHandle) {
    return false;
  }
  await delay(40);

  // SmartBook does not update the DOM after each arrow key while an item is lifted.
  // Move deterministically by counting the required position changes up front.
  // This assumes lifted pool items traverse remaining pool choices first, then
  // the response rows from bottom to top before drop.
  dispatchKeyboardSequence(
    initialHandle,
    liftConfig.key,
    liftConfig.code,
    liftConfig.keyCode
  );
  await delay(80);

  let movementKey = "ArrowUp";
  let movementCode = "ArrowUp";
  let movementKeyCode = 38;
  let moveCount = 0;

  if (initialLocation.area === "row") {
    const rowDelta = targetRowIndex - initialLocation.rowIndex;
    moveCount = Math.abs(rowDelta);
    if (rowDelta > 0) {
      movementKey = "ArrowDown";
      movementCode = "ArrowDown";
      movementKeyCode = 40;
    }
  } else {
    moveCount = initialLocation.poolIndex + (rows.length - targetRowIndex);
  }

  for (let step = 0; step < moveCount; step += 1) {
    dispatchKeyboardSequence(
      initialHandle,
      movementKey,
      movementCode,
      movementKeyCode
    );
    await delay(70);
  }

  dispatchKeyboardSequence(
    initialHandle,
    liftConfig.key,
    liftConfig.code,
    liftConfig.keyCode
  );
  await delay(120);

  const finalLocation = getMatchingChoiceLocation(container, choiceText);
  return Boolean(finalLocation && finalLocation.rowIndex === targetRowIndex);
}

function formatMatchingTargetsForAlert(container, rawAnswer) {
  const resolvedTargets = normalizeMatchingTargets(container, rawAnswer);
  const resolvedLines = resolvedTargets
    .filter((target) => target.choiceText)
    .map((target) => `${target.promptText} -> ${target.choiceText}`);
  if (resolvedLines.length > 0) {
    return resolvedLines;
  }

  const collected = {
    pairs: [],
    sequentialChoices: [],
    rawStrings: [],
  };
  collectMatchingAnswerEntries(rawAnswer, collected);

  const pairLines = collected.pairs
    .map((pair) => {
      const promptRef = normalizeChoiceText(pair.promptRef);
      const choiceRef = normalizeChoiceText(pair.choiceRef);
      if (!promptRef || !choiceRef) return "";
      return `${promptRef} -> ${choiceRef}`;
    })
    .filter(Boolean);

  const fallbackLines = dedupeAnswers(
    pairLines.concat(collected.sequentialChoices, collected.rawStrings).filter(Boolean)
  );

  return fallbackLines;
}

async function applyMatchingAnswer(container, rawAnswer) {
  const rows = getMatchingRows(container);
  if (!rows.length) {
    console.warn(LOG_PREFIX, "Matching question detected but no response rows found");
    return false;
  }

  const targetsByRow = normalizeMatchingTargets(container, rawAnswer);
  if (!targetsByRow.length) {
    console.warn(LOG_PREFIX, "Matching question had no usable answers from AI");
    return false;
  }

  if (targetsByRow.some((target) => !target.choiceText)) {
    console.warn(LOG_PREFIX, "Matching targets were incomplete", targetsByRow);
    return false;
  }

  console.info(
    LOG_PREFIX,
    "Matching target sequence",
    targetsByRow.map((target) => `${target.promptText} -> ${target.choiceText}`)
  );

  const liftStrategies = [
    // Space is the primary keyboard lift/drop gesture; Enter remains a fallback.
    {
      key: " ",
      code: "Space",
      keyCode: 32,
    },
    {
      key: "Enter",
      code: "Enter",
      keyCode: 13,
    },
  ];

  const maxPasses = 4;
  // Re-run passes because one placement can dislodge another row's current choice.
  for (let pass = 1; pass <= maxPasses; pass += 1) {
    if (isMatchingAligned(container, targetsByRow)) {
      return true;
    }

    for (let rowIndex = 0; rowIndex < targetsByRow.length; rowIndex += 1) {
      const target = targetsByRow[rowIndex];
      if (!target.choiceText) {
        continue;
      }

      const currentLocation = getMatchingChoiceLocation(container, target.choiceText);
      if (!currentLocation) {
        console.warn(
          LOG_PREFIX,
          "Unable to locate matching choice:",
          target.choiceText,
          "snapshot:",
          getMatchingSnapshot(container)
        );
        continue;
      }

      if (currentLocation.rowIndex === rowIndex) {
        continue;
      }

      let moved = false;
      for (const strategy of liftStrategies) {
        const strategyLocation = getMatchingChoiceLocation(
          container,
          target.choiceText
        );
        if (!strategyLocation) {
          break;
        }
        if (strategyLocation.rowIndex === rowIndex) {
          moved = true;
          break;
        }

        moved = await moveMatchingChoiceToRow(
          container,
          target.choiceText,
          rowIndex,
          strategy
        );
        if (moved) {
          break;
        }
      }

      if (!moved) {
        console.warn(
          LOG_PREFIX,
          "Matching move may not have completed:",
          `${target.promptText} -> ${target.choiceText}`,
          "snapshot:",
          getMatchingSnapshot(container)
        );
      }
    }

    if (!isMatchingAligned(container, targetsByRow)) {
      console.info(
        LOG_PREFIX,
        `Matching pass ${pass} incomplete`,
        getMatchingSnapshot(container)
      );
    }
  }

  return isMatchingAligned(container, targetsByRow);
}
function extractChoicesFromCombinedAnswer(answerText, questionChoices) {
  if (typeof answerText !== "string" || questionChoices.length === 0) {
    return [];
  }

  const normalizedAnswer = normalizeChoiceText(answerText).toLowerCase();
  if (!normalizedAnswer) return [];

  return questionChoices.filter((choice) => {
    const normalizedChoice = normalizeChoiceText(choice).toLowerCase();
    return normalizedChoice && normalizedAnswer.includes(normalizedChoice);
  });
}

function normalizeResponseAnswers(rawAnswer, questionType, container) {
  if (questionType === "matching") {
    return formatMatchingTargetsForAlert(container, rawAnswer);
  }

  const flattenedAnswers = flattenAnswerValues(rawAnswer);
  if (flattenedAnswers.length === 0) return [];

  const isMultiChoiceType =
    questionType === "multiple_select" || questionType === "select_text";

  if (isMultiChoiceType && flattenedAnswers.length === 1) {
    const combinedAnswer = flattenedAnswers[0];
    const questionChoices = getQuestionChoices(container, questionType);
    const extractedChoices = extractChoicesFromCombinedAnswer(
      combinedAnswer,
      questionChoices
    );

    if (extractedChoices.length > 0) {
      return dedupeAnswers(extractedChoices);
    }

    const splitAnswers = splitCompoundAnswer(combinedAnswer);
    if (splitAnswers.length > 1) {
      return dedupeAnswers(splitAnswers);
    }
  }

  return dedupeAnswers(flattenedAnswers);
}

async function processChatGPTResponse(responseText) {
  if (handleTopicOverview()) {
    return;
  }

  if (handleForcedLearning()) {
    return;
  }

  const container = document.querySelector(".probe-container");
  if (!container) return;
  const questionType = detectQuestionType(container);
  const response = JSON.parse(responseText);
  const answers = normalizeResponseAnswers(
    response.answer,
    questionType,
    container
  );

  lastIncorrectQuestion = null;
  lastCorrectAnswer = null;

  let applied = false;
  if (questionType === "matching") {
    applied = await applyMatchingAnswer(container, response.answer);
    if (!applied) {
      pauseForManualAnswer(
        container,
        "Matching question: the matches couldn't be placed automatically.",
        answers
      );
      return;
    }
  } else if (questionType === "select_text") {
    const choices = Array.from(
      container.querySelectorAll(".select-text-component .choice.-interactive")
    );
    const indices = resolveChoiceIndices(
      choices.map((choice) => choice.textContent.trim()),
      answers,
      true
    );
    indices.forEach((index) => choices[index].click());
    applied = indices.length > 0;
  } else if (questionType) {
    applied = fillInAnswers(answers, container);
  }

  if (!isAutomating) return;

  if (!applied) {
    pauseForManualAnswer(
      container,
      questionType
        ? "Couldn't match the AI's answer to this question's choices."
        : "This question type isn't supported yet.",
      answers
    );
    return;
  }

  if (pauseBeforeSubmit) {
    waitForElement(".next-button", 120000)
      .then((nextButton) => {
        const observer = new MutationObserver(() => {
          if (nextButton.offsetParent === null) {
            observer.disconnect();
            setTimeout(() => {
              checkForNextStep();
            }, 1000);
          }
        });
        observer.observe(document.body, { childList: true, subtree: true });
      })
      .catch(() => {});
    return;
  }

  let confidenceButton;
  try {
    // The confidence buttons stay disabled until SmartBook accepts an answer.
    confidenceButton = await waitForElement(getConfidenceSelector(), 5000);
  } catch (error) {
    pauseForManualAnswer(
      container,
      "The answer was filled in, but SmartBook didn't accept it.",
      answers
    );
    return;
  }
  if (!isAutomating) return;

  confidenceButton.click();
  await delay(1000);
  checkForCorrectAnswer(container);

  let nextButton;
  try {
    nextButton = await waitForElement(".next-button", 10000);
  } catch (error) {
    stopAutomation(
      "Couldn't find SmartBook's Next button after submitting the answer."
    );
    return;
  }
  if (!isAutomating) return;

  nextButton.click();
  setTimeout(() => {
    checkForNextStep();
  }, 1000);
}

function addAssistantButton() {
  waitForElement("awd-header .header__navigation").then((headerNav) => {
    const buttonContainer = document.createElement("div");
    buttonContainer.style.display = "flex";
    buttonContainer.style.marginLeft = "10px";

    chrome.storage.sync.get(["aiModel", "doubleCreditMode"], function (data) {
      const aiModel = data.aiModel || "chatgpt";
      doubleCreditMode = data.doubleCreditMode || false;
      let modelName = "ChatGPT";

      if (aiModel === "gemini") {
        modelName = "Gemini";
      } else if (aiModel === "deepseek") {
        modelName = "DeepSeek";
      }

      const btn = document.createElement("button");
      btn.textContent = `Ask ${modelName}${doubleCreditMode ? " (2x)" : ""}`;
      btn.classList.add("btn", "btn-secondary", "automcgraw-btn");
      btn.style.borderTopRightRadius = "0";
      btn.style.borderBottomRightRadius = "0";
      btn.addEventListener("click", () => {
        if (isAutomating) {
          stopAutomation();
          chrome.runtime.sendMessage({ type: "resetTabTracking" });
        } else {
          const modeText = doubleCreditMode
            ? " Double credit mode is enabled."
            : "";
          const proceed = confirm(
            `Start automated answering?${modeText} Click OK to begin, or Cancel to stop.`
          );
          if (proceed) {
            isAutomating = true;
            requestRetries = 0;
            clearMatchingPauseWatcher();
            btn.textContent = "Stop Automation";
            checkForNextStep();
          }
        }
      });

      const settingsBtn = document.createElement("button");
      settingsBtn.classList.add("btn", "btn-secondary");
      settingsBtn.style.borderTopLeftRadius = "0";
      settingsBtn.style.borderBottomLeftRadius = "0";
      settingsBtn.style.borderLeft = "1px solid rgba(0,0,0,0.2)";
      settingsBtn.style.padding = "6px 10px";
      settingsBtn.title = "Auto-McGraw Settings";
      settingsBtn.innerHTML = `
        <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <circle cx="12" cy="12" r="3"></circle>
          <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"></path>
        </svg>
      `;
      settingsBtn.addEventListener("click", () => {
        chrome.runtime.sendMessage({ type: "openSettings" });
      });

      buttonContainer.appendChild(btn);
      buttonContainer.appendChild(settingsBtn);
      headerNav.appendChild(buttonContainer);

      chrome.storage.onChanged.addListener((changes) => {
        if ((changes.aiModel || changes.doubleCreditMode) && !isAutomating) {
          chrome.storage.sync.get(
            ["aiModel", "doubleCreditMode"],
            function (data) {
              const newModel = data.aiModel || "chatgpt";
              const doubleMode = data.doubleCreditMode || false;
              doubleCreditMode = doubleMode;
              let newModelName = "ChatGPT";

              if (newModel === "gemini") {
                newModelName = "Gemini";
              } else if (newModel === "deepseek") {
                newModelName = "DeepSeek";
              }

              btn.textContent = `Ask ${newModelName}${
                doubleMode ? " (2x)" : ""
              }`;
            }
          );
        }
      });
    });
  });
}

function parseQuestion() {
  const container = document.querySelector(".probe-container");
  if (!container) {
    alert("No question found on the page.");
    return null;
  }

  const questionType = detectQuestionType(container);

  let questionText = "";
  const promptEl = container.querySelector(".prompt");

  if (questionType === "fill_in_the_blank" && promptEl) {
    const promptClone = promptEl.cloneNode(true);

    const uiSpans = promptClone.querySelectorAll(
      "span.fitb-span, span.blank-label, span.correctness, span._visuallyHidden"
    );
    uiSpans.forEach((span) => span.remove());

    const inputs = promptClone.querySelectorAll("input.fitb-input");
    inputs.forEach((input) => {
      const blankMarker = document.createTextNode("[BLANK]");
      if (input.parentNode) {
        input.parentNode.replaceChild(blankMarker, input);
      }
    });

    questionText = getReadableText(promptClone);
  } else {
    questionText = getReadableText(promptEl);
  }

  let options = [];
  if (questionType === "matching") {
    const prompts = getMatchingRows(container)
      .map((row) => getMatchingPromptText(row))
      .filter(Boolean);
    const choices = dedupeAnswers(
      getMatchingChoiceItems(container)
        .map((item) => getMatchingChoiceText(item))
        .filter(Boolean)
    );
    options = { prompts, choices };
  } else if (questionType === "select_text") {
    options = Array.from(
      container.querySelectorAll(".select-text-component .choice.-interactive")
    )
      .map((el) => el.textContent.trim())
      .filter(Boolean);
  } else if (questionType !== "fill_in_the_blank") {
    options = getQuestionChoices(container, questionType);
  }

  return {
    type: questionType,
    question: questionText,
    options: options,
    previousCorrection: lastIncorrectQuestion
      ? {
          question: lastIncorrectQuestion,
          correctAnswer: lastCorrectAnswer,
        }
      : null,
  };
}

// Resolves with the first element matching `selector`. Uses a MutationObserver
// as well as polling, since Chrome throttles timers in background tabs.
function waitForElement(selector, timeout = 5000) {
  return new Promise((resolve, reject) => {
    const existing = document.querySelector(selector);
    if (existing) {
      resolve(existing);
      return;
    }

    let done = false;
    const finish = (el) => {
      if (done) return;
      done = true;
      observer.disconnect();
      clearInterval(interval);
      clearTimeout(timer);
      if (el) {
        resolve(el);
      } else {
        reject(new Error("Element not found: " + selector));
      }
    };
    const check = () => {
      const el = document.querySelector(selector);
      if (el) finish(el);
    };

    const observer = new MutationObserver(check);
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
    });
    const interval = setInterval(check, 100);
    const timer = setTimeout(() => finish(document.querySelector(selector)), timeout);
  });
}

setupMessageListener();
addAssistantButton();

if (isAutomating) {
  setTimeout(() => {
    checkForNextStep();
  }, 1000);
}
