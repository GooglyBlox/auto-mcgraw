importScripts(
  "../shared/namespace.js",
  "../shared/assistants.js",
  "../shared/settings.js",
  "../shared/messaging.js",
  "../shared/wait.js",
  "tabs.js",
  "prompt.js",
  "relay.js",
  "double-credit.js"
);

(() => {
  const { MessageType, messaging, relay, doubleCredit } = AutoMcGraw;

  const SETTINGS_WINDOW = { width: 440, height: 720 };

  function logError(error) {
    console.error("[Auto-McGraw]", error);
  }

  function inBackground(task) {
    task.catch(logError);
  }

  messaging.handle(MessageType.ASK_QUESTION, (message, sender) => {
    if (!sender.tab) {
      return { ok: false, error: "Questions must come from a tab." };
    }
    inBackground(relay.enqueueQuestion(message, sender.tab));
  });

  messaging.handle(MessageType.ASSISTANT_ANSWER, (message, sender) => {
    inBackground(relay.forwardAnswer(message, sender.tab));
  });

  messaging.handle(MessageType.ASSISTANT_ERROR, (message, sender) => {
    inBackground(relay.forwardError(message, sender.tab));
  });

  messaging.handle(MessageType.OPEN_SETTINGS, async () => {
    await chrome.windows.create({
      url: chrome.runtime.getURL("popup/settings.html"),
      type: "popup",
      ...SETTINGS_WINDOW,
    });
  });

  messaging.handle(MessageType.OPEN_DUPLICATE, (message, sender) =>
    doubleCredit.open(message, sender.tab)
  );

  messaging.handle(MessageType.CLAIM_DUPLICATE, (message, sender) =>
    doubleCredit.claim(sender.tab)
  );

  messaging.handle(MessageType.DUPLICATE_FINISHED, (message, sender) => {
    inBackground(doubleCredit.finish(message, sender.tab));
  });

  messaging.handle(MessageType.CANCEL_DUPLICATE, () => doubleCredit.cancel());

  chrome.tabs.onRemoved.addListener((tabId) => {
    inBackground(doubleCredit.handleTabRemoved(tabId));
  });
})();
