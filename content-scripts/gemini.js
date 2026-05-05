let hasResponded = false;
let messageCountAtQuestion = 0;
let observationStartTime = 0;
let observationTimeout = null;
let observer = null;

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "cancelResponseObservation") {
    resetObservation();
    sendResponse({ received: true });
    return true;
  }

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
      notifyAiResponseTimeout();
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

    responseText = sanitizeResponseText(responseText);

    try {
      const parsed = JSON.parse(responseText);
      if ((parsed.answer !== undefined || parsed.slots) && !hasResponded) {
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
          if (!jsonText || hasResponded) return;
          const parsed = JSON.parse(jsonText);
          if (parsed.answer === undefined && !parsed.slots) return;
          hasResponded = true;
          chrome.runtime.sendMessage({
            type: "geminiResponse",
            response: jsonText,
          });
          resetObservation();
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

function notifyAiResponseTimeout() {
  try {
    chrome.runtime.sendMessage({
      type: "aiResponseTimeout",
      aiModel: "gemini",
      reason: "Gemini did not produce a response within 180 seconds.",
    });
  } catch (error) {
    console.error("Error notifying timeout:", error);
  }
}

