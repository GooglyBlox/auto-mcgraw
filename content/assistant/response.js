(() => {
  const RESPONSE_TIMEOUT_MS = 180000;
  const SETTLE_MS = 5000;

  function parseObject(candidate) {
    for (const attempt of [candidate, candidate.replace(/\n\s*/g, " ")]) {
      try {
        const parsed = JSON.parse(attempt);
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          return parsed;
        }
      } catch {
        continue;
      }
    }
    return null;
  }

  function findClosingBrace(text, start) {
    let depth = 0;
    let inString = false;
    let escaped = false;

    for (let index = start; index < text.length; index += 1) {
      const char = text[index];
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
        if (depth === 0) return index;
      }
    }

    return -1;
  }

  function hasUsableAnswer(parsed) {
    if (!parsed || !("answer" in parsed)) return false;
    const { answer } = parsed;
    if (answer === null || answer === undefined) return false;
    if (typeof answer === "string") return answer.trim() !== "";
    if (Array.isArray(answer)) return answer.length > 0;
    return true;
  }

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

      const parsed = parseObject(cleaned.slice(start, end + 1));
      if (hasUsableAnswer(parsed)) return JSON.stringify(parsed);
    }

    return null;
  }

  function extractAnswer(node) {
    const blocks = Array.from(node.querySelectorAll("pre code, pre"));
    const isJsonBlock = (block) => /json/i.test(block.className);
    blocks.sort((a, b) => Number(isJsonBlock(b)) - Number(isJsonBlock(a)));

    for (const block of blocks) {
      const answer = findAnswerJson(block.textContent);
      if (answer) return answer;
    }

    return findAnswerJson(node.textContent);
  }

  function snapshot(nodes, getNodeId) {
    const last = nodes[nodes.length - 1] || null;
    return {
      nodes: new WeakSet(nodes),
      ids: new Set(nodes.map((node) => getNodeId(node)).filter(Boolean)),
      lastText: last ? last.textContent : null,
    };
  }

  function isNewResponse(taken, node, getNodeId) {
    const id = getNodeId(node);
    if (id) return !taken.ids.has(id);
    if (taken.nodes.has(node)) return false;
    return taken.lastText === null || node.textContent !== taken.lastText;
  }

  function watch({
    snapshot: taken,
    getResponses,
    getNodeId,
    isGenerating,
    onAnswer,
    onTimeout,
  }) {
    const startedAt = Date.now();
    let finished = false;
    let candidate = null;
    let candidateSince = 0;

    const observer = new MutationObserver(check);
    const intervalId = setInterval(check, 1000);

    function stop() {
      finished = true;
      observer.disconnect();
      clearInterval(intervalId);
    }

    function check() {
      if (finished) return;

      const nodes = getResponses();
      const latest = nodes[nodes.length - 1];
      if (latest && isNewResponse(taken, latest, getNodeId)) {
        const answer = extractAnswer(latest);
        if (answer) {
          if (answer !== candidate) {
            candidate = answer;
            candidateSince = Date.now();
          }
          if (
            !isGenerating(latest) ||
            Date.now() - candidateSince > SETTLE_MS
          ) {
            stop();
            onAnswer(JSON.parse(answer));
            return;
          }
        }
      }

      if (Date.now() - startedAt > RESPONSE_TIMEOUT_MS) {
        stop();
        onTimeout();
      }
    }

    observer.observe(document.body, {
      childList: true,
      subtree: true,
      characterData: true,
    });
    check();

    return { stop };
  }

  AutoMcGraw.assistantResponse = { snapshot, watch };
})();
