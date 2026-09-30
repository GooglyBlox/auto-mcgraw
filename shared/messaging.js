(() => {
  const MessageType = Object.freeze({
    PING: "ping",
    ASK_QUESTION: "askQuestion",
    PROMPT_ASSISTANT: "promptAssistant",
    ASSISTANT_ANSWER: "assistantAnswer",
    ASSISTANT_ERROR: "assistantError",
    OPEN_SETTINGS: "openSettings",
    OPEN_DUPLICATE: "openDuplicate",
    CLAIM_DUPLICATE: "claimDuplicate",
    DUPLICATE_FINISHED: "duplicateFinished",
    DUPLICATE_COMPLETE: "duplicateComplete",
    CANCEL_DUPLICATE: "cancelDuplicate",
  });

  const handlers = new Map();

  function errorMessage(error) {
    return error instanceof Error ? error.message : String(error);
  }

  function dispatch(message, sender, sendResponse) {
    const handler = handlers.get(message?.type);
    if (!handler) return false;

    Promise.resolve()
      .then(() => handler(message, sender))
      .then(
        (result) => sendResponse(result === undefined ? { ok: true } : result),
        (error) => {
          console.error("[Auto-McGraw]", error);
          sendResponse({ ok: false, error: errorMessage(error) });
        }
      );
    return true;
  }

  function handle(type, handler) {
    if (handlers.size === 0) {
      chrome.runtime.onMessage.addListener(dispatch);
    }
    handlers.set(type, handler);
  }

  async function send(message) {
    return chrome.runtime.sendMessage(message);
  }

  function isAvailable() {
    return Boolean(globalThis.chrome?.runtime?.id);
  }

  AutoMcGraw.MessageType = MessageType;
  AutoMcGraw.messaging = { handle, send, isAvailable, errorMessage };
})();
