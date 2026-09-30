(() => {
  const { text, wait, dom } = AutoMcGraw;
  const { KEYS, pressKey } = dom;

  const ALL_CHOICES =
    '.choice-item-wrapper:not(.-placeholder)[id^="choices:"], .choice-item-wrapper:not(.-placeholder)[id^="response:"]';
  const POOL_CHOICES =
    '.choices-container .choice-item-wrapper:not(.-placeholder)[id^="choices:"]';
  const ROW_CHOICE =
    '.match-single-response-wrapper .choice-item-wrapper:not(.-placeholder)[id^="choices:"], .match-single-response-wrapper .choice-item-wrapper:not(.-placeholder)[id^="response:"]';
  const DRAG_HANDLE = "[data-react-beautiful-dnd-drag-handle]";
  const MAX_PASSES = 4;
  const LOG_PREFIX = "[Auto-McGraw]";

  const LIFT_KEYS = [KEYS.space, KEYS.enter];

  function component(container) {
    return container?.querySelector(".matching-component") || null;
  }

  function rows(container) {
    const root = component(container);
    return root
      ? Array.from(root.querySelectorAll(".responses-container .match-row"))
      : [];
  }

  function choiceItems(container, selector) {
    const root = component(container);
    return root ? Array.from(root.querySelectorAll(selector)) : [];
  }

  function promptText(row) {
    const content =
      row.querySelector(".match-prompt .content") ||
      row.querySelector(".match-prompt");
    return text.normalizeChoiceText(content?.textContent || "");
  }

  function choiceText(item) {
    if (!item) return "";
    const content = item.querySelector(".content") || item.querySelector("p");
    return text.normalizeChoiceText((content || item).textContent || "");
  }

  function rowChoice(row) {
    return row.querySelector(ROW_CHOICE);
  }

  function dragHandle(item) {
    if (item.matches(DRAG_HANDLE)) return item;
    return item.querySelector(DRAG_HANDLE) || item;
  }

  function locateChoice(container, target) {
    const matchRows = rows(container);
    for (let rowIndex = 0; rowIndex < matchRows.length; rowIndex += 1) {
      const item = rowChoice(matchRows[rowIndex]);
      if (item && text.isAnswerMatch(choiceText(item), target)) {
        return { area: "row", rowIndex, poolIndex: -1, item };
      }
    }

    const pool = choiceItems(container, POOL_CHOICES);
    for (let poolIndex = 0; poolIndex < pool.length; poolIndex += 1) {
      if (text.isAnswerMatch(choiceText(pool[poolIndex]), target)) {
        return { area: "pool", rowIndex: -1, poolIndex, item: pool[poolIndex] };
      }
    }

    return null;
  }

  function readPrompts(container) {
    return rows(container).map((row) => promptText(row));
  }

  function readChoices(container) {
    return text.dedupeAnswers(
      choiceItems(container, ALL_CHOICES)
        .map((item) => choiceText(item))
        .filter(Boolean)
    );
  }

  function readOptions(container) {
    return {
      prompts: readPrompts(container).filter(Boolean),
      choices: readChoices(container),
    };
  }

  function numericReference(value, candidates) {
    const match = value.match(/^#?(\d+)$/);
    if (!match) return "";
    const index = Number(match[1]) - 1;
    return index >= 0 && index < candidates.length ? candidates[index] : "";
  }

  function resolveReference(reference, candidates, kind) {
    if (!candidates.length) return "";

    const normalized = text.normalizeChoiceText(String(reference || ""));
    if (!normalized) return "";

    const numbered = numericReference(normalized, candidates);
    if (numbered) return numbered;

    const prefix =
      kind === "prompt"
        ? /^(?:prompt|row|left)\s*#?\s*/i
        : /^(?:choice|option|item|right|match)\s*#?\s*/i;
    const stripped = normalized.replace(prefix, "").trim();

    const strippedNumbered = numericReference(stripped, candidates);
    if (strippedNumbered) return strippedNumbered;

    const variants = text
      .dedupeAnswers([stripped, text.stripWrappingQuotes(stripped)])
      .filter(Boolean);

    for (const variant of variants) {
      const exact = candidates.find((candidate) =>
        text.isAnswerMatch(candidate, variant)
      );
      if (exact) return exact;
    }

    for (const variant of variants) {
      const target = text.normalizeChoiceText(variant).toLowerCase();
      if (!target) continue;

      const lowered = candidates.map((candidate) =>
        text.normalizeChoiceText(candidate).toLowerCase()
      );

      const sameIndex = lowered.indexOf(target);
      if (sameIndex !== -1) return candidates[sameIndex];

      const partialIndex = lowered.findIndex(
        (candidate) =>
          candidate &&
          (candidate.includes(target) || target.includes(candidate))
      );
      if (partialIndex !== -1) return candidates[partialIndex];
    }

    return "";
  }

  function splitSegments(answerText) {
    const segments = [];

    answerText
      .split(/\n|;/)
      .map((segment) => segment.trim().replace(text.LIST_MARKER, "").trim())
      .filter(Boolean)
      .forEach((segment) => {
        const delimiters = (segment.match(/->|=>|:/g) || []).length;
        if (segment.includes(",") && delimiters > 1) {
          segment
            .split(",")
            .map((part) => part.trim())
            .filter(Boolean)
            .forEach((part) => segments.push(part));
        } else {
          segments.push(segment);
        }
      });

    return segments;
  }

  function parsePair(segment) {
    let cleaned = segment.trim().replace(text.LIST_MARKER, "").trim();
    if (!/(?:->|=>|:)/.test(cleaned)) {
      cleaned = cleaned.replace(/^\d+[.)]\s+/, "").trim();
    }
    if (!cleaned) return null;

    const match =
      cleaned.match(/^(.*?)\s*(?:->|=>)\s*(.+)$/) ||
      cleaned.match(/^(.*?)\s*:\s*(.+)$/);
    return match
      ? { promptRef: match[1].trim(), choiceRef: match[2].trim() }
      : null;
  }

  function addLoose(output, value) {
    const cleaned = text.normalizeChoiceText(value);
    if (cleaned) output.loose.push(cleaned);
  }

  function collectEntries(raw, output) {
    if (raw === null || raw === undefined) return;

    if (Array.isArray(raw)) {
      raw.forEach((entry) => collectEntries(entry, output));
      return;
    }

    if (typeof raw === "object") {
      const promptRef =
        raw.prompt ?? raw.left ?? raw.source ?? raw.from ?? raw.key;
      const choiceRef =
        raw.choice ??
        raw.match ??
        raw.right ??
        raw.target ??
        raw.to ??
        raw.answer ??
        raw.value;

      if (promptRef !== undefined && choiceRef !== undefined) {
        output.pairs.push({
          promptRef: String(promptRef),
          choiceRef: String(choiceRef),
        });
        return;
      }

      Object.entries(raw).forEach(([key, value]) => {
        output.pairs.push({ promptRef: String(key), choiceRef: String(value) });
      });
      return;
    }

    if (typeof raw === "string") {
      const parsed = text.parseArrayString(raw);
      if (parsed) {
        collectEntries(parsed, output);
        return;
      }

      const segments = splitSegments(raw);
      if (!segments.length) {
        addLoose(output, raw);
        return;
      }

      segments.forEach((segment) => {
        const pair = parsePair(segment);
        if (pair) {
          output.pairs.push(pair);
        } else {
          addLoose(output, segment);
        }
      });
      return;
    }

    addLoose(output, String(raw));
  }

  function collect(raw) {
    const output = { pairs: [], loose: [] };
    collectEntries(raw, output);
    return output;
  }

  function resolveTargets(container, raw) {
    const prompts = readPrompts(container);
    const choices = readChoices(container);
    if (!prompts.length || !choices.length) return [];

    const { pairs, loose } = collect(raw);
    const targets = new Map();

    pairs.forEach(({ promptRef, choiceRef }) => {
      const prompt = resolveReference(promptRef, prompts, "prompt");
      const choice = resolveReference(choiceRef, choices, "choice");
      if (!prompt || !choice) return;

      const rowIndex = prompts.findIndex((candidate) =>
        text.isAnswerMatch(candidate, prompt)
      );
      if (rowIndex < 0 || targets.has(rowIndex)) return;
      targets.set(rowIndex, choice);
    });

    if (targets.size === 0 && loose.length === prompts.length) {
      const ordered = loose
        .map((reference) => resolveReference(reference, choices, "choice"))
        .filter(Boolean);
      if (ordered.length === prompts.length) {
        ordered.forEach((choice, rowIndex) => targets.set(rowIndex, choice));
      }
    }

    return prompts.map((prompt, rowIndex) => ({
      rowIndex,
      promptText: prompt,
      choiceText: targets.get(rowIndex) || "",
    }));
  }

  function describe(container, raw) {
    const resolved = resolveTargets(container, raw)
      .filter((target) => target.choiceText)
      .map((target) => `${target.promptText} -> ${target.choiceText}`);
    if (resolved.length) return resolved;

    const { pairs, loose } = collect(raw);
    const pairLines = pairs
      .map(({ promptRef, choiceRef }) => {
        const prompt = text.normalizeChoiceText(promptRef);
        const choice = text.normalizeChoiceText(choiceRef);
        return prompt && choice ? `${prompt} -> ${choice}` : "";
      })
      .filter(Boolean);

    return text.dedupeAnswers([...pairLines, ...loose]);
  }

  function snapshot(container) {
    return rows(container).map(
      (row) => `${promptText(row)} -> ${choiceText(rowChoice(row))}`
    );
  }

  function isAligned(container, targets) {
    const matchRows = rows(container);
    if (!targets.length || matchRows.length !== targets.length) return false;

    return targets.every(
      (target, rowIndex) =>
        Boolean(target.choiceText) &&
        text.isAnswerMatch(
          choiceText(rowChoice(matchRows[rowIndex])),
          target.choiceText
        )
    );
  }

  async function moveChoice(container, target, targetRow, liftKey) {
    const origin = locateChoice(container, target);
    if (!origin) return false;
    if (origin.rowIndex === targetRow) return true;

    const rowCount = rows(container).length;
    const handle = dragHandle(origin.item);
    try {
      handle.focus({ preventScroll: true });
    } catch {
      handle.focus();
    }
    await wait.delay(40);

    pressKey(handle, liftKey);
    await wait.delay(80);

    // The DOM doesn't update mid-drag, so arrow presses are counted up front.
    let direction = KEYS.up;
    let steps;
    if (origin.area === "row") {
      const delta = targetRow - origin.rowIndex;
      steps = Math.abs(delta);
      if (delta > 0) direction = KEYS.down;
    } else {
      steps = origin.poolIndex + (rowCount - targetRow);
    }

    for (let step = 0; step < steps; step += 1) {
      pressKey(handle, direction);
      await wait.delay(70);
    }

    pressKey(handle, liftKey);
    await wait.delay(120);

    return locateChoice(container, target)?.rowIndex === targetRow;
  }

  async function placeTarget(container, target) {
    for (const liftKey of LIFT_KEYS) {
      const location = locateChoice(container, target.choiceText);
      if (!location) return false;
      if (location.rowIndex === target.rowIndex) return true;

      if (
        await moveChoice(container, target.choiceText, target.rowIndex, liftKey)
      ) {
        return true;
      }
    }
    return false;
  }

  async function apply(container, raw) {
    const targets = resolveTargets(container, raw);
    if (!targets.length || targets.some((target) => !target.choiceText)) {
      console.warn(LOG_PREFIX, "Matching answer was incomplete", targets);
      return false;
    }

    for (let pass = 0; pass < MAX_PASSES; pass += 1) {
      if (isAligned(container, targets)) return true;

      for (const target of targets) {
        if (!locateChoice(container, target.choiceText)) {
          console.warn(
            LOG_PREFIX,
            "Could not find matching choice:",
            target.choiceText,
            snapshot(container)
          );
          continue;
        }

        if (!(await placeTarget(container, target))) {
          console.warn(
            LOG_PREFIX,
            "Matching move may not have completed:",
            `${target.promptText} -> ${target.choiceText}`,
            snapshot(container)
          );
        }
      }
    }

    return isAligned(container, targets);
  }

  AutoMcGraw.matching = { readOptions, describe, apply };
})();
