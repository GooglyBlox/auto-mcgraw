// Shared helpers for the ChatGPT, Gemini and DeepSeek content scripts.
// Loaded before each assistant script (see manifest.json), so everything here
// is available as a global in those scripts.

var AI_RESPONSE_TIMEOUT_MS = 180000;

function buildQuestionPrompt(questionData) {
  const { type, question, options, previousCorrection } = questionData;
  let text = `Type: ${type}\nQuestion: ${question}`;

  if (
    previousCorrection &&
    previousCorrection.question &&
    previousCorrection.correctAnswer
  ) {
    text =
      `CORRECTION FROM PREVIOUS ANSWER: For the question "${
        previousCorrection.question
      }", your answer was incorrect. The correct answer was: ${JSON.stringify(
        previousCorrection.correctAnswer
      )}\n\nNow answer this new question:\n\n` + text;
  }

  if (type === "matching") {
    text +=
      "\nPrompts:\n" +
      options.prompts.map((prompt, i) => `${i + 1}. ${prompt}`).join("\n");
    text +=
      "\nChoices:\n" +
      options.choices.map((choice, i) => `${i + 1}. ${choice}`).join("\n");
    text +=
      '\n\nPlease match each prompt with the correct choice. Set "answer" to an array of strings using the exact format \'Prompt -> Choice\'. Include one entry per prompt, use exact prompt and choice text, and use each choice at most once.';
  } else if (type === "fill_in_the_blank") {
    text +=
      "\n\nThis is a fill in the blank question. If there are multiple blanks, provide answers as an array in order of appearance. For a single blank, you can provide a string.";
  } else if (options && options.length > 0) {
    text +=
      "\nOptions:\n" + options.map((opt, i) => `${i + 1}. ${opt}`).join("\n");

    if (type === "multiple_select") {
      text +=
        '\n\nIMPORTANT: This is a "select all that apply" question. Set "answer" to an array containing EVERY correct option. Each entry must EXACTLY match one of the options above. Do not include option numbers.';
    } else {
      text +=
        "\n\nIMPORTANT: Your answer must EXACTLY match one of the above options. Do not include numbers in your answer. If there are periods, include them.";
      if (type !== "multiple_choice" && type !== "true_false") {
        text +=
          ' If more than one option is correct, set "answer" to an array of all of them.';
      }
    }
  }

  text +=
    "\n\nIMPORTANT: Your answer should be in a JSON code block." +
    '\n\nPlease provide your answer in JSON format with keys "answer" and "explanation". Explanations should be no more than one sentence. DO NOT acknowledge the correction in your response, only answer the new question.';

  return text;
}

function escapeHtml(text) {
  return String(text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// Rich-text composers (ProseMirror, Quill) expect one <p> per line. The text is
// escaped so question content like "<", "&" or quotes arrives as plain text.
function textToParagraphHtml(text) {
  return String(text)
    .split("\n")
    .map((line) => (line ? `<p>${escapeHtml(line)}</p>` : "<p><br></p>"))
    .join("");
}

function setComposerText(input, text) {
  if (!input) return false;
  input.focus();

  if (
    input instanceof HTMLTextAreaElement ||
    input instanceof HTMLInputElement
  ) {
    // React/Octane track the value through the native setter.
    const valueSetter = Object.getOwnPropertyDescriptor(
      Object.getPrototypeOf(input),
      "value"
    )?.set;
    if (valueSetter) {
      valueSetter.call(input, text);
    } else {
      input.value = text;
    }
  } else if (input.isContentEditable) {
    input.innerHTML = textToParagraphHtml(text);
  } else {
    return false;
  }

  input.dispatchEvent(new Event("input", { bubbles: true }));
  input.dispatchEvent(new Event("change", { bubbles: true }));
  return true;
}

function getComposerText(input) {
  if (!input) return "";
  if ("value" in input && typeof input.value === "string") return input.value;
  return input.textContent || "";
}

function queryFirst(selectors, root = document) {
  for (const selector of selectors) {
    try {
      const el = root.querySelector(selector);
      if (el) return el;
    } catch (e) {
      // Ignore selectors the current browser can't parse.
    }
  }
  return null;
}

function isButtonUsable(button) {
  if (!button) return false;
  if (button.disabled) return false;
  if (button.getAttribute("aria-disabled") === "true") return false;
  return true;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Polls `getter` until it returns something truthy. Resolves null on timeout.
async function waitForValue(getter, timeout = 10000, interval = 200) {
  const start = Date.now();
  while (true) {
    const value = getter();
    if (value) return value;
    if (Date.now() - start > timeout) return null;
    await sleep(interval);
  }
}

function tryParseJsonObject(candidate) {
  const attempts = [candidate, candidate.replace(/\n\s*/g, " ")];
  for (const attempt of attempts) {
    try {
      const parsed = JSON.parse(attempt);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed;
      }
    } catch (e) {
      // Try the next variant.
    }
  }
  return null;
}

function findClosingBrace(text, start) {
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < text.length; i += 1) {
    const char = text[i];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }

    if (char === '"') {
      inString = true;
    } else if (char === "{") {
      depth += 1;
    } else if (char === "}") {
      depth -= 1;
      if (depth === 0) return i;
    }
  }

  return -1;
}

function hasUsableAnswer(parsed) {
  if (!parsed || !("answer" in parsed)) return false;
  const { answer } = parsed;
  if (answer === null || answer === undefined) return false;
  if (typeof answer === "string" && !answer.trim()) return false;
  if (Array.isArray(answer) && answer.length === 0) return false;
  return true;
}

// Finds the first complete JSON object with an "answer" key in `text` and
// returns it re-serialized, or null. Falsy answers such as `false` or `0` are
// valid (true/false questions), so this checks for presence, not truthiness.
function findAnswerJson(text) {
  if (typeof text !== "string" || !text.includes("{")) return null;

  const cleaned = text.replace(/[\u200B-\u200D\uFEFF]/g, "");
  for (
    let start = cleaned.indexOf("{");
    start !== -1;
    start = cleaned.indexOf("{", start + 1)
  ) {
    const end = findClosingBrace(cleaned, start);
    if (end === -1) continue;

    const parsed = tryParseJsonObject(cleaned.slice(start, end + 1));
    if (hasUsableAnswer(parsed)) {
      return JSON.stringify(parsed);
    }
  }

  return null;
}

// Prefers JSON inside code blocks, then falls back to the message's full text.
function extractAnswerFromNode(node) {
  if (!node) return null;

  const blocks = Array.from(node.querySelectorAll("pre code, pre"));
  blocks.sort((a, b) => {
    const aJson = /json/i.test(a.className) ? 0 : 1;
    const bJson = /json/i.test(b.className) ? 0 : 1;
    return aJson - bJson;
  });

  for (const block of blocks) {
    const answer = findAnswerJson(block.textContent);
    if (answer) return answer;
  }

  return findAnswerJson(node.textContent);
}

// Records which response nodes exist before a question is sent. Chat UIs
// unmount and remount older turns as the conversation grows, so counting nodes
// is unreliable; instead a response is "new" when it is the last one on the
// page and was not part of this snapshot (by id when the UI provides one).
function snapshotResponses(nodes, getNodeId) {
  const last = nodes[nodes.length - 1] || null;
  return {
    nodes: new WeakSet(nodes),
    ids: new Set(nodes.map((node) => getNodeId(node)).filter(Boolean)),
    lastText: last ? last.textContent : null,
  };
}

function isNewResponse(snapshot, node, getNodeId) {
  if (!node) return false;

  const id = getNodeId(node);
  if (id) return !snapshot.ids.has(id);

  if (snapshot.nodes.has(node)) return false;
  return snapshot.lastText === null || node.textContent !== snapshot.lastText;
}

// Watches for the assistant's reply to the question that was just sent.
// `isGenerating(node)` lets a script wait until streaming finishes; if an
// answer stays unchanged for a few seconds it is accepted anyway, so a stale
// "generating" signal can't stall automation.
function watchForResponse({
  snapshot,
  getResponseNodes,
  getNodeId = () => null,
  isGenerating = () => false,
  onResponse,
  onTimeout,
  timeoutMs = AI_RESPONSE_TIMEOUT_MS,
}) {
  const startedAt = Date.now();
  let finished = false;
  let observer = null;
  let intervalId = null;
  let pendingAnswer = null;
  let pendingSince = 0;

  function stop() {
    finished = true;
    if (observer) observer.disconnect();
    if (intervalId) clearInterval(intervalId);
  }

  function check() {
    if (finished) return;

    const nodes = getResponseNodes();
    const latest = nodes[nodes.length - 1];
    if (latest && isNewResponse(snapshot, latest, getNodeId)) {
      const answer = extractAnswerFromNode(latest);
      if (answer) {
        if (answer !== pendingAnswer) {
          pendingAnswer = answer;
          pendingSince = Date.now();
        }
        if (!isGenerating(latest) || Date.now() - pendingSince > 5000) {
          stop();
          onResponse(answer);
          return;
        }
      }
    }

    if (Date.now() - startedAt > timeoutMs) {
      stop();
      if (onTimeout) onTimeout();
    }
  }

  observer = new MutationObserver(check);
  observer.observe(document.body, {
    childList: true,
    subtree: true,
    characterData: true,
  });
  intervalId = setInterval(check, 1000);
  check();

  return { stop };
}

function sendAssistantMessage(message) {
  try {
    chrome.runtime.sendMessage(message, () => {
      // Reading lastError keeps Chrome from logging "Unchecked runtime.lastError".
      void chrome.runtime.lastError;
    });
  } catch (error) {
    console.error("[Auto-McGraw] Could not reach the extension:", error);
  }
}

// Registers the "receiveQuestion" handler shared by all assistant scripts.
// `askAssistant(text, questionMeta)` must type and send the prompt and resolve
// with a watcher config (see watchForResponse) once the prompt is sent.
function registerAssistant({ responseType, askAssistant }) {
  let activeWatcher = null;

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type === "ping") {
      sendResponse({ received: true });
      return true;
    }

    if (message.type !== "receiveQuestion") return false;

    if (activeWatcher) {
      activeWatcher.stop();
      activeWatcher = null;
    }

    const meta = {
      requestId: message.requestId || null,
      replyTo: message.replyTo || null,
    };
    const text = buildQuestionPrompt(message.question);

    askAssistant(text)
      .then((watchConfig) => {
        activeWatcher = watchForResponse({
          ...watchConfig,
          onResponse: (response) => {
            activeWatcher = null;
            sendAssistantMessage({ type: responseType, response, ...meta });
          },
          onTimeout: () => {
            activeWatcher = null;
            sendAssistantMessage({
              type: "assistantError",
              error:
                "No answer was detected from the assistant within 3 minutes.",
              ...meta,
            });
          },
        });
      })
      .catch((error) => {
        console.error("[Auto-McGraw] Failed to send question:", error);
        sendAssistantMessage({
          type: "assistantError",
          error: error && error.message ? error.message : String(error),
          ...meta,
        });
      });

    sendResponse({ received: true, status: "processing" });
    return true;
  });
}
