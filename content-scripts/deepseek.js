var DEEPSEEK_MESSAGE_SELECTORS = [
  "[data-testid='chat-message-assistant']",
  "[data-testid='message-content']",
  "model-response",
  ".ds-markdown",
  ".f9bf7997",
];
var DEEPSEEK_INPUT_SELECTORS = [
  "#chat-input",
  'textarea[data-testid="chat_input_input"]',
  "textarea",
  '[role="textbox"][contenteditable="true"]',
];
var DEEPSEEK_SEND_SELECTORS = [
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

function getDeepSeekResponses() {
  for (const selector of DEEPSEEK_MESSAGE_SELECTORS) {
    const nodes = document.querySelectorAll(selector);
    if (nodes.length > 0) {
      return Array.from(nodes);
    }
  }

  return [];
}

function getDeepSeekMessageId(node) {
  const item = node.closest("[data-virtual-list-item-key]");
  return item ? item.getAttribute("data-virtual-list-item-key") : null;
}

function findDeepSeekSendButton() {
  for (const selector of DEEPSEEK_SEND_SELECTORS) {
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
    const lastEnabled = candidates
      .reverse()
      .find((button) => isButtonUsable(button));
    if (lastEnabled) {
      return lastEnabled;
    }
  }

  return null;
}

async function askDeepSeek(text) {
  const chatInput = await waitForValue(
    () => queryFirst(DEEPSEEK_INPUT_SELECTORS),
    10000
  );
  if (!chatInput) {
    throw new Error("Could not find the DeepSeek message box.");
  }

  const snapshot = snapshotResponses(
    getDeepSeekResponses(),
    getDeepSeekMessageId
  );
  if (!setComposerText(chatInput, text)) {
    throw new Error("Could not type into the DeepSeek message box.");
  }

  const sendButton = await waitForValue(findDeepSeekSendButton, 10000);
  if (!sendButton) {
    throw new Error("Could not find the DeepSeek send button.");
  }
  sendButton.click();

  return {
    snapshot,
    getResponseNodes: getDeepSeekResponses,
    getNodeId: getDeepSeekMessageId,
  };
}

registerAssistant({
  responseType: "deepseekResponse",
  askAssistant: askDeepSeek,
});
