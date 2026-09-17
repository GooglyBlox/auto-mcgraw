// ChatGPT ships two different UIs: the ProseMirror composer with
// [data-message-author-role] turns, and a newer one with a plain
// <textarea name="prompt"> and <li data-message-role> turns. Support both.
var CHATGPT_INPUT_SELECTORS = [
  "#prompt-textarea",
  'textarea[name="prompt"]',
  "#mobile-composer-prompt",
  'div[contenteditable="true"][role="textbox"]',
];
var CHATGPT_SEND_SELECTORS = [
  '[data-testid="send-button"]',
  'button[aria-label="Send message"]',
  'button[aria-label="Send prompt"]',
];
var CHATGPT_STOP_SELECTORS = [
  '[data-testid="stop-button"]',
  'button[aria-label="Stop streaming"]',
  'button[aria-label="Stop generating"]',
  'button[aria-label="Stop"]',
];
var CHATGPT_RESPONSE_SELECTOR =
  '[data-message-author-role="assistant"], li[data-message-role="assistant"]';
var CHATGPT_USER_SELECTOR =
  '[data-message-author-role="user"], li[data-message-role="user"]';

function getChatGPTResponses() {
  return Array.from(document.querySelectorAll(CHATGPT_RESPONSE_SELECTOR));
}

function getChatGPTMessageId(node) {
  return node.getAttribute("data-message-id") || node.id || null;
}

function isChatGPTGenerating(node) {
  if (node && node.hasAttribute("data-message-role")) {
    return !node.hasAttribute("data-message-complete");
  }
  return (
    !!queryFirst(CHATGPT_STOP_SELECTORS) ||
    !!(node && node.querySelector(".result-streaming"))
  );
}

function findChatGPTSendButton() {
  for (const selector of CHATGPT_SEND_SELECTORS) {
    const button = document.querySelector(selector);
    if (isButtonUsable(button)) return button;
  }
  return null;
}

async function askChatGPT(text) {
  const input = await waitForValue(
    () => queryFirst(CHATGPT_INPUT_SELECTORS),
    10000
  );
  if (!input) {
    throw new Error("Could not find the ChatGPT message box.");
  }

  // Don't send while a previous answer is still streaming; the send button is
  // replaced by a stop button until it finishes.
  await waitForValue(() => !queryFirst(CHATGPT_STOP_SELECTORS), 90000, 500);

  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const userCountBefore = document.querySelectorAll(
      CHATGPT_USER_SELECTOR
    ).length;
    const snapshot = snapshotResponses(
      getChatGPTResponses(),
      getChatGPTMessageId
    );

    if (!setComposerText(input, text)) {
      throw new Error("Could not type into the ChatGPT message box.");
    }

    const sendButton = await waitForValue(findChatGPTSendButton, 10000);
    if (sendButton) {
      sendButton.click();
    } else if (input.form && typeof input.form.requestSubmit === "function") {
      input.form.requestSubmit();
    } else {
      throw new Error("Could not find the ChatGPT send button.");
    }

    const sent = await waitForValue(
      () =>
        !getComposerText(input).trim() ||
        !!queryFirst(CHATGPT_STOP_SELECTORS) ||
        document.querySelectorAll(CHATGPT_USER_SELECTOR).length >
          userCountBefore,
      5000
    );

    if (sent) {
      return {
        snapshot,
        getResponseNodes: getChatGPTResponses,
        getNodeId: getChatGPTMessageId,
        isGenerating: isChatGPTGenerating,
      };
    }
  }

  throw new Error("ChatGPT did not accept the message.");
}

registerAssistant({
  responseType: "chatGPTResponse",
  askAssistant: askChatGPT,
});
