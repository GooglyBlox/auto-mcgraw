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
  if (message.type === "cancelResponseObservation") {
    resetObservation();
    sendResponse({ received: true });
    return true;
  }

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

function processResponse(responseText) {
  const cleanedText = sanitizeResponseText(responseText);

  try {
    const parsed = JSON.parse(cleanedText);

    if (parsed && (parsed.answer !== undefined || parsed.slots) && !hasResponded) {
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
                responseText.includes('"slots"'))
            ) {
              if (processResponse(responseText)) return;
            }
          }
        }
      }
    }

    const messageText = message.textContent.trim();
    const jsonText = findJsonObject(messageText);
    if (jsonText && /"answer"|"slots"/.test(jsonText)) {
      const responseText = jsonText;
      if (processResponse(responseText)) return;
    }

    if (Date.now() - observationStartTime > 30000) {
      try {
        const jsonText = findJsonObject(messageText);
        if (!jsonText || hasResponded) continue;
        const parsed = JSON.parse(jsonText);
        if (parsed.answer === undefined && !parsed.slots) continue;
        hasResponded = true;
        chrome.runtime.sendMessage({
          type: "deepseekResponse",
          response: jsonText,
        });
        resetObservation();
        return true;
      } catch (e) {}
    }
  }
}

function startObserving() {
  observationStartTime = Date.now();
  observationTimeout = setTimeout(() => {
    if (!hasResponded) {
      notifyAiResponseTimeout();
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

function notifyAiResponseTimeout() {
  try {
    chrome.runtime.sendMessage({
      type: "aiResponseTimeout",
      aiModel: "deepseek",
      reason: "DeepSeek did not produce a response within 180 seconds.",
    });
  } catch (error) {
    console.error("Error notifying timeout:", error);
  }
}

