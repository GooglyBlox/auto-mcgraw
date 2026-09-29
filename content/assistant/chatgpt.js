(() => {
  const { dom, assistantBridge } = AutoMcGraw;

  const COMPOSER = "form[data-chatgpt-composer]";
  const STOP_SELECTORS = [
    `${COMPOSER} button[aria-label^="Stop" i]:not([aria-label*="voice" i]):not([aria-label*="dictat" i])`,
    '[data-testid="stop-button"]',
    'button[aria-label="Stop streaming"]',
    'button[aria-label="Stop generating"]',
    'button[aria-label="Stop"]',
  ];
  const LEGACY_RESPONSE_SELECTOR =
    '[data-message-author-role="assistant"], li[data-message-role="assistant"]';
  const MESSAGE_ID_ATTRIBUTE = "data-chatgpt-selection-message-id";

  const isStreaming = () => Boolean(dom.queryFirst(STOP_SELECTORS));

  function getResponses() {
    const legacy = document.querySelectorAll(LEGACY_RESPONSE_SELECTOR);
    if (legacy.length > 0) return Array.from(legacy);

    return Array.from(
      document.querySelectorAll('[data-conversation-role="assistant"]')
    ).map(
      (heading) =>
        heading.closest("[data-chatgpt-search-unit-key]") ||
        heading.parentElement
    );
  }

  function getMessageId(node) {
    return (
      node.getAttribute("data-message-id") ||
      node
        .querySelector(`[${MESSAGE_ID_ATTRIBUTE}]`)
        ?.getAttribute(MESSAGE_ID_ATTRIBUTE) ||
      node.id ||
      null
    );
  }

  assistantBridge.register("chatgpt", {
    inputSelectors: [
      `${COMPOSER} [contenteditable="true"]`,
      "#prompt-textarea",
      'textarea[name="prompt"]',
      "#mobile-composer-prompt",
      'div[contenteditable="true"][role="textbox"]',
    ],
    sendSelectors: [
      `${COMPOSER} button[type="submit"]`,
      `${COMPOSER} button[aria-label="Send"]`,
      '[data-testid="send-button"]',
      "#composer-submit-button",
      'button[aria-label="Send prompt"]',
      'button[aria-label="Send message"]',
    ],
    userMessageSelector:
      '[data-message-author-role="user"], li[data-message-role="user"], [data-user-message-bubble]',
    getResponses,
    getMessageId,
    isBusy: isStreaming,
    isGenerating(node) {
      if (node.hasAttribute("data-message-role")) {
        return !node.hasAttribute("data-message-complete");
      }
      return isStreaming() || Boolean(node.querySelector(".result-streaming"));
    },
  });
})();
