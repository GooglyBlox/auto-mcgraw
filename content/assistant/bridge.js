(() => {
  const { MessageType, messaging, wait, dom, assistants, assistantResponse } =
    AutoMcGraw;

  const IDLE_TIMEOUT_MS = 120000;
  const INPUT_TIMEOUT_MS = 10000;
  const SEND_BUTTON_TIMEOUT_MS = 3000;
  const SEND_CONFIRM_MS = 5000;
  const SEND_ATTEMPTS = 2;
  const UNSAFE_BUTTON_LABEL = /voice|dictat|speech|microphone|stop|cancel/i;
  const LOG_PREFIX = "[Auto-McGraw]";

  function isSendButton(button) {
    if (!dom.isEnabled(button)) return false;
    const label = [
      button.getAttribute("aria-label"),
      button.getAttribute("title"),
      button.textContent,
    ].join(" ");
    return !UNSAFE_BUTTON_LABEL.test(label);
  }

  function escapeHtml(value) {
    return String(value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function toParagraphHtml(value) {
    return String(value)
      .split("\n")
      .map((line) => (line ? `<p>${escapeHtml(line)}</p>` : "<p><br></p>"))
      .join("");
  }

  function setComposerText(input, value) {
    input.focus();

    if (
      input instanceof HTMLTextAreaElement ||
      input instanceof HTMLInputElement
    ) {
      dom.setInputValue(input, value);
      return true;
    }

    if (input.isContentEditable) {
      input.innerHTML = toParagraphHtml(value);
      dom.dispatchInputEvents(input);
      return true;
    }

    return false;
  }

  function getComposerText(input) {
    return typeof input.value === "string"
      ? input.value
      : input.textContent || "";
  }

  function register(id, adapter) {
    const { name } = assistants.get(id);
    const getMessageId = adapter.getMessageId || (() => null);
    const isBusy = adapter.isBusy || (() => false);
    const isGenerating = adapter.isGenerating || (() => isBusy());

    let generation = 0;
    let activeWatcher = null;

    function findSendButton() {
      for (const selector of adapter.sendSelectors) {
        let matches = [];
        try {
          matches = Array.from(document.querySelectorAll(selector));
        } catch {
          continue;
        }
        const button = matches.find(isSendButton);
        if (button) return button;
      }

      const fallback = adapter.findFallbackSendButton?.();
      return isSendButton(fallback) ? fallback : null;
    }

    function countUserMessages() {
      if (!adapter.userMessageSelector) return 0;
      return document.querySelectorAll(adapter.userMessageSelector).length;
    }

    function waitUntilSent(input, userMessages) {
      return wait.waitFor(
        () =>
          !getComposerText(input).trim() ||
          isBusy() ||
          countUserMessages() > userMessages,
        { timeout: SEND_CONFIRM_MS }
      );
    }

    async function sendPrompt(prompt) {
      const idle = await wait.waitFor(() => !isBusy(), {
        timeout: IDLE_TIMEOUT_MS,
        interval: 500,
      });
      if (!idle) {
        console.warn(LOG_PREFIX, `${name} still looks busy, sending anyway.`);
      }

      for (let attempt = 1; attempt <= SEND_ATTEMPTS; attempt += 1) {
        const input = await wait.waitFor(
          () => dom.queryFirst(adapter.inputSelectors),
          { timeout: INPUT_TIMEOUT_MS }
        );
        if (!input) {
          throw new Error(`Could not find the ${name} message box.`);
        }

        const userMessages = countUserMessages();
        const taken = assistantResponse.snapshot(
          adapter.getResponses(),
          getMessageId
        );

        if (!setComposerText(input, prompt)) {
          throw new Error(`Could not type into the ${name} message box.`);
        }

        const sendButton = await wait.waitFor(findSendButton, {
          timeout: SEND_BUTTON_TIMEOUT_MS,
        });
        if (sendButton) {
          sendButton.click();
        } else {
          dom.pressKey(input, dom.KEYS.enter);
        }

        let sent = await waitUntilSent(input, userMessages);
        if (!sent && sendButton) {
          dom.pressKey(input, dom.KEYS.enter);
          sent = await waitUntilSent(input, userMessages);
        }
        if (sent) return taken;
      }

      throw new Error(`${name} did not accept the message.`);
    }

    messaging.handle(MessageType.PING, () => ({ ok: true }));

    messaging.handle(
      MessageType.PROMPT_ASSISTANT,
      ({ prompt, requestId, replyTo }) => {
        generation += 1;
        const current = generation;
        activeWatcher?.stop();
        activeWatcher = null;

        const reply = (message) =>
          messaging
            .send({ ...message, requestId, replyTo })
            .catch((error) =>
              console.error(LOG_PREFIX, "Could not reach the extension:", error)
            );

        sendPrompt(prompt)
          .then((taken) => {
            if (current !== generation) return;
            activeWatcher = assistantResponse.watch({
              snapshot: taken,
              getResponses: adapter.getResponses,
              getNodeId: getMessageId,
              isGenerating,
              onAnswer: (answer) => {
                activeWatcher = null;
                reply({ type: MessageType.ASSISTANT_ANSWER, answer });
              },
              onTimeout: () => {
                activeWatcher = null;
                reply({
                  type: MessageType.ASSISTANT_ERROR,
                  error: `No answer was detected from ${name} within 3 minutes.`,
                });
              },
            });
          })
          .catch((error) => {
            console.error(LOG_PREFIX, "Failed to send question:", error);
            reply({
              type: MessageType.ASSISTANT_ERROR,
              error: messaging.errorMessage(error),
            });
          });
      }
    );
  }

  AutoMcGraw.assistantBridge = { register };
})();
