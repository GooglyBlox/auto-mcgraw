(() => {
  const { assistantBridge } = AutoMcGraw;

  assistantBridge.register("gemini", {
    inputSelectors: [
      "rich-textarea .ql-editor",
      ".ql-editor",
      'div[contenteditable="true"][role="textbox"]',
    ],
    sendSelectors: [
      ".send-button:not(.stop)",
      'button[aria-label="Send message"]',
    ],
    getResponses: () => Array.from(document.querySelectorAll("model-response")),
    getMessageId(node) {
      const container = node.closest(".conversation-container");
      return container?.id || node.id || null;
    },
    isBusy: () => Boolean(document.querySelector(".send-button.stop")),
  });
})();
