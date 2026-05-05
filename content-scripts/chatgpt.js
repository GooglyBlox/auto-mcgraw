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

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "ping") {
    sendResponse({ received: true });
    return true;
  }

  if (message.type === "cancelResponseObservation") {
    resetObservation();
    sendResponse({ received: true });
    return true;
  }

  if (message.type === "receiveQuestion") {
    resetObservation();

    const messages = document.querySelectorAll(
      '[data-message-author-role="assistant"]'
    );
    messageCountAtQuestion = messages.length;
    assistantTextAtQuestion = getLatestAssistantResponseText();
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
  const inputArea = await waitForChatInput();

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
  sendButton.click();
  startObserving();
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
    (element) =>
      !element.disabled && element.getAttribute("aria-disabled") !== "true"
  );
}

function waitForElement(selectors, timeout, predicate = () => true) {
  const startedAt = Date.now();

  return new Promise((resolve, reject) => {
    const interval = setInterval(() => {
      for (const selector of selectors) {
        const element = document.querySelector(selector);
        if (element && predicate(element)) {
          clearInterval(interval);
          resolve(element);
          return;
        }
      }

      if (Date.now() - startedAt > timeout) {
        clearInterval(interval);
        reject(new Error(`Element not found: ${selectors.join(", ")}`));
      }
    }, 150);
  });
}

function startObserving() {
  observationStartTime = Date.now();
  observationTimeout = setTimeout(() => {
    if (!hasResponded) {
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

  const responseText = extractJsonText(latestMessage);
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
    if (parsed.answer !== undefined || parsed.slots) {
      responseInFlight = true;
      hasResponded = true;
      chrome.runtime
        .sendMessage({
          type: "chatGPTResponse",
          response: responseText,
        })
        .then(() => {
          lastSentResponseText = responseText;
          resetObservation();
        })
        .catch((error) => {
          responseInFlight = false;
          hasResponded = false;
          console.error("Error sending response:", error);
        });
    }
  } catch (error) {
    if (Date.now() - observationStartTime > 30000) {
      const fallback = findJsonObject(latestMessage.textContent.trim());
      if (
        !fallback ||
        fallback === lastSentResponseText ||
        fallback === assistantTextAtQuestion
      ) {
        return;
      }
      let fallbackParsed;
      try {
        fallbackParsed = JSON.parse(fallback);
      } catch (_) {
        return;
      }
      if (fallbackParsed.answer === undefined && !fallbackParsed.slots) {
        return;
      }
      responseInFlight = true;
      hasResponded = true;
      chrome.runtime
        .sendMessage({
          type: "chatGPTResponse",
          response: fallback,
        })
        .then(() => {
          lastSentResponseText = fallback;
          resetObservation();
        })
        .catch((sendError) => {
          responseInFlight = false;
          hasResponded = false;
          console.error("Error sending fallback response:", sendError);
        });
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
    console.error("Error notifying timeout:", error);
  }
}

function isResponseStillGenerating(message) {
  return Boolean(
    document.querySelector('[data-testid="stop-button"]') ||
      message.querySelector(".result-streaming") ||
      message
        .closest('[data-message-author-role="assistant"]')
        ?.querySelector('[aria-label*="Stop"], [data-testid*="stop"]')
  );
}

function getLatestAssistantResponseText() {
  const messages = document.querySelectorAll(
    '[data-message-author-role="assistant"]'
  );
  if (!messages.length) return "";

  const latestMessage = messages[messages.length - 1];
  return extractJsonText(latestMessage);
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

