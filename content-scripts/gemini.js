var GEMINI_INPUT_SELECTORS = [
  "rich-textarea .ql-editor",
  ".ql-editor",
  'div[contenteditable="true"][role="textbox"]',
];
var GEMINI_SEND_SELECTORS = [
  ".send-button:not(.stop)",
  'button[aria-label="Send message"]',
];

function getGeminiResponses() {
  return Array.from(document.querySelectorAll("model-response"));
}

function getGeminiMessageId(node) {
  const container = node.closest(".conversation-container");
  return (container && container.id) || node.id || null;
}

function isGeminiBusy() {
  return !!document.querySelector(".send-button.stop");
}

function findGeminiSendButton() {
  for (const selector of GEMINI_SEND_SELECTORS) {
    const button = document.querySelector(selector);
    if (isButtonUsable(button)) return button;
  }
  return null;
}

async function askGemini(text) {
  const idle = await waitForValue(() => !isGeminiBusy(), 120000, 500);
  if (!idle) {
    throw new Error("Timed out waiting for Gemini to finish responding.");
  }

  const input = await waitForValue(
    () => queryFirst(GEMINI_INPUT_SELECTORS),
    10000
  );
  if (!input) {
    throw new Error("Could not find the Gemini message box.");
  }

  const snapshot = snapshotResponses(getGeminiResponses(), getGeminiMessageId);
  if (!setComposerText(input, text)) {
    throw new Error("Could not type into the Gemini message box.");
  }

  const sendButton = await waitForValue(findGeminiSendButton, 10000);
  if (!sendButton) {
    throw new Error("Could not find the Gemini send button.");
  }
  sendButton.click();

  return {
    snapshot,
    getResponseNodes: getGeminiResponses,
    getNodeId: getGeminiMessageId,
    isGenerating: isGeminiBusy,
  };
}

registerAssistant({
  responseType: "geminiResponse",
  askAssistant: askGemini,
});
