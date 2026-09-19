(() => {
  const { dom, assistantBridge } = AutoMcGraw;

  const STOP_SELECTORS = [
    '[data-testid="stop-button"]',
    'button[aria-label="Stop streaming"]',
    'button[aria-label="Stop generating"]',
    'button[aria-label="Stop"]',
  ];
  const RESPONSE_SELECTOR =
    '[data-message-author-role="assistant"], li[data-message-role="assistant"]';

  const isStreaming = () => Boolean(dom.queryFirst(STOP_SELECTORS));

  assistantBridge.register("chatgpt", {
    inputSelectors: [
      "#prompt-textarea",
      'textarea[name="prompt"]',
      "#mobile-composer-prompt",
      'div[contenteditable="true"][role="textbox"]',
    ],
    sendSelectors: [
      '[data-testid="send-button"]',
      'button[aria-label="Send message"]',
      'button[aria-label="Send prompt"]',
    ],
    userMessageSelector:
      '[data-message-author-role="user"], li[data-message-role="user"]',
    getResponses: () =>
      Array.from(document.querySelectorAll(RESPONSE_SELECTOR)),
    getMessageId: (node) =>
      node.getAttribute("data-message-id") || node.id || null,
    isBusy: isStreaming,
    isGenerating(node) {
      if (node.hasAttribute("data-message-role")) {
        return !node.hasAttribute("data-message-complete");
      }
      return isStreaming() || Boolean(node.querySelector(".result-streaming"));
    },
  });
})();
