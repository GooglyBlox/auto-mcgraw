(() => {
  const { dom, assistantBridge } = AutoMcGraw;

  const RESPONSE_SELECTORS = [
    "[data-testid='chat-message-assistant']",
    "[data-testid='message-content']",
    "model-response",
    ".ds-markdown",
    ".f9bf7997",
  ];

  assistantBridge.register("deepseek", {
    inputSelectors: [
      "#chat-input",
      'textarea[data-testid="chat_input_input"]',
      "textarea",
      '[role="textbox"][contenteditable="true"]',
    ],
    sendSelectors: [
      '[data-testid="submit-button"]',
      '[data-testid="send-button"]',
      '[data-testid="chat_input_send_button"]',
      '[role="button"].f6d670',
      ".f6d670",
      'button[type="submit"]',
      '[aria-label="Send message"]',
      '[aria-label*="Send"]',
      ".bf38813a button",
    ],
    getResponses() {
      for (const selector of RESPONSE_SELECTORS) {
        const nodes = document.querySelectorAll(selector);
        if (nodes.length > 0) return Array.from(nodes);
      }
      return [];
    },
    getMessageId: (node) =>
      node
        .closest("[data-virtual-list-item-key]")
        ?.getAttribute("data-virtual-list-item-key") || null,
    findFallbackSendButton() {
      const composer = document.querySelector(".bf38813a");
      if (!composer) return null;
      const buttons = Array.from(
        composer.querySelectorAll("button, [role='button']")
      );
      return buttons.reverse().find((button) => dom.isEnabled(button)) || null;
    },
  });
})();
