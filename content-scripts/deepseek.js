let hasResponded = false;
let messageCountAtQuestion = 0;
let observationStartTime = 0;
let observationTimeout = null;
let checkIntervalId = null;
let observer = null;

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "receiveQuestion") {
    resetObservation();

    const messages = document.querySelectorAll(
      "[data-testid='chat-message-assistant'], model-response, .ds-markdown"
    );
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
      "\n\nPlease match each prompt with the correct choice. Format your answer as an array where each element is 'Prompt -> Choice'.";
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

  return new Promise((resolve, reject) => {
    const chatInput = document.getElementById("chat-input");
    if (chatInput) {
      setTimeout(() => {
        chatInput.focus();
        chatInput.value = text;
        chatInput.dispatchEvent(new Event("input", { bubbles: true }));

        setTimeout(() => {
          const sendButtonSelectors = [
            '[role="button"].f6d670',
            ".f6d670",
            '[role="button"]:has(svg path[d^="M7 16c"])',
            'button[type="submit"]',
            '[aria-label="Send message"]',
            ".bf38813a button",
            "button:has(svg)",
            '[data-testid="send-button"]',
          ];

          let sendButton = null;
          for (const selector of sendButtonSelectors) {
            try {
              const button = document.querySelector(selector);
              if (button && !button.disabled) {
                sendButton = button;
                break;
              }
            } catch (e) {
              continue;
            }
          }

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
  const cleanedText = responseText
    .replace(/[\u200B-\u200D\uFEFF]/g, "")
    .replace(/\n\s*/g, " ")
    .trim();

  try {
    const parsed = JSON.parse(cleanedText);

    if (parsed && parsed.answer && !hasResponded) {
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

  const messageSelectors = [
    "[data-testid='chat-message-assistant']",
    "model-response",
    ".ds-markdown",
    ".f9bf7997",
  ];

  let messages = [];
  for (const selector of messageSelectors) {
    const foundMessages = document.querySelectorAll(selector);
    if (foundMessages.length > 0) {
      messages = Array.from(foundMessages);
      break;
    }
  }

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
              responseText.includes('"answer"')
            ) {
              if (processResponse(responseText)) return;
            }
          }
        }
      }
    }

    const messageText = message.textContent.trim();
    const jsonMatch = messageText.match(/\{[\s\S]*?"answer"[\s\S]*?\}/);
    if (jsonMatch) {
      const responseText = jsonMatch[0];
      if (processResponse(responseText)) return;
    }

    if (Date.now() - observationStartTime > 30000) {
      try {
        const jsonPattern = /\{[\s\S]*?"answer"[\s\S]*?"explanation"[\s\S]*?\}/;
        const jsonMatch = messageText.match(jsonPattern);

        if (jsonMatch && !hasResponded) {
          hasResponded = true;
          chrome.runtime.sendMessage({
            type: "deepseekResponse",
            response: jsonMatch[0],
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
