(() => {
  const LIST_MARKER = /^[-*\u2022]\s*/;

  function normalizeChoiceText(value) {
    if (typeof value !== "string") return "";

    return value
      .replace(/\u00A0/g, " ")
      .replace(/&amp;/gi, "&")
      .replace(/[\u2018\u2019]/g, "'")
      .replace(/[\u201C\u201D]/g, '"')
      .replace(/\s+/g, " ")
      .trim()
      .replace(/\.$/, "");
  }

  function stripWrappingQuotes(value) {
    if (typeof value !== "string") return "";

    const trimmed = value.trim();
    if (trimmed.length < 2) return trimmed;

    const first = trimmed[0];
    if (first !== trimmed[trimmed.length - 1] || !/["'`]/.test(first)) {
      return trimmed;
    }
    return trimmed.slice(1, -1).trim();
  }

  function isAnswerMatch(choiceText, answerText) {
    if (!choiceText || answerText === null || answerText === undefined) {
      return false;
    }

    const choice = String(choiceText).trim();
    const answer = String(answerText).trim();
    if (!choice || !answer) return false;

    if (
      choice === answer ||
      choice === `${answer}.` ||
      choice.replace(/\.$/, "") === answer.replace(/\.$/, "")
    ) {
      return true;
    }

    return (
      normalizeChoiceText(choice) === normalizeChoiceText(answer) ||
      normalizeChoiceText(stripWrappingQuotes(choice)) ===
        normalizeChoiceText(stripWrappingQuotes(answer))
    );
  }

  function normalizeForMatch(value) {
    return normalizeChoiceText(stripWrappingQuotes(String(value ?? "")))
      .toLowerCase()
      .replace(/["'`]/g, "")
      .replace(/[.;:,!?]+$/, "")
      .trim();
  }

  function findChoiceIndex(choiceTexts, answer) {
    const choices = choiceTexts.map(normalizeForMatch);
    const target = normalizeForMatch(answer);
    if (!target) return -1;

    const exactIndex = choices.indexOf(target);
    if (exactIndex !== -1) return exactIndex;

    const labelOnly = target.match(/^(?:option\s+)?\(?([a-z]|\d{1,2})\)?$/i);
    if (labelOnly) {
      const label = labelOnly[1];
      const labelIndex = /\d/.test(label)
        ? Number(label) - 1
        : label.charCodeAt(0) - 97;
      if (labelIndex >= 0 && labelIndex < choiceTexts.length) return labelIndex;
    }

    const withoutLabel = target
      .replace(/^(?:option\s+)?\(?(?:[a-z]|\d{1,2})[.):]\s+/i, "")
      .trim();
    if (withoutLabel !== target) {
      const unlabeledIndex = choices.indexOf(withoutLabel);
      if (unlabeledIndex !== -1) return unlabeledIndex;
    }

    const toWords = (text) => ` ${text.replace(/[^a-z0-9]+/g, " ").trim()} `;
    const answerWords = [target, withoutLabel].map(toWords);

    let bestIndex = -1;
    let bestScore = 0;
    let candidateCount = 0;
    choices.forEach((choice, index) => {
      const choiceWords = toWords(choice);
      if (!choiceWords.trim()) return;

      let score = 0;
      for (const words of answerWords) {
        if (!words.trim()) continue;
        if (choiceWords.includes(words) || words.includes(choiceWords)) {
          score = Math.max(
            score,
            Math.min(choiceWords.length, words.length) /
              Math.max(choiceWords.length, words.length)
          );
        }
      }

      if (score > 0) {
        candidateCount += 1;
        if (score > bestScore) {
          bestScore = score;
          bestIndex = index;
        }
      }
    });

    return candidateCount === 1 || bestScore >= 0.5 ? bestIndex : -1;
  }

  function resolveChoiceIndices(choiceTexts, answers, allowMultiple) {
    const indices = [];
    for (const answer of answers) {
      const index = findChoiceIndex(choiceTexts, answer);
      if (index !== -1 && !indices.includes(index)) {
        indices.push(index);
        if (!allowMultiple) break;
      }
    }
    return indices;
  }

  function parseArrayString(value) {
    if (typeof value !== "string") return null;

    const trimmed = value.trim();
    if (!trimmed.startsWith("[") || !trimmed.endsWith("]")) return null;

    try {
      const parsed = JSON.parse(trimmed);
      return Array.isArray(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }

  function flattenAnswerValues(value, output = []) {
    if (value === null || value === undefined) return output;

    if (Array.isArray(value)) {
      value.forEach((item) => flattenAnswerValues(item, output));
      return output;
    }

    if (typeof value === "string") {
      const parsed = parseArrayString(value);
      if (parsed) return flattenAnswerValues(parsed, output);

      const trimmed = value.trim();
      if (trimmed) output.push(trimmed);
      return output;
    }

    output.push(String(value));
    return output;
  }

  function cleanListItem(part) {
    return part
      .trim()
      .replace(LIST_MARKER, "")
      .replace(/^\d+[).\-\s]+/, "")
      .replace(/^["'`]|["'`]$/g, "")
      .trim();
  }

  function splitCompoundAnswer(answerText) {
    if (typeof answerText !== "string") return [];

    const trimmed = answerText.trim();
    if (!trimmed) return [];

    const parts = trimmed
      .split(/\n|;|,/)
      .map(cleanListItem)
      .filter(Boolean);
    if (parts.length > 1 || !/\band\b/i.test(trimmed)) return parts;

    return trimmed
      .split(/\band\b/i)
      .map(cleanListItem)
      .filter(Boolean);
  }

  function dedupeAnswers(answers) {
    const seen = new Set();
    return answers.filter((answer) => {
      const key = normalizeChoiceText(answer).toLowerCase();
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  function extractChoicesFromCombined(answerText, choices) {
    if (typeof answerText !== "string" || choices.length === 0) return [];

    const answer = normalizeChoiceText(answerText).toLowerCase();
    if (!answer) return [];

    return choices.filter((choice) => {
      const normalized = normalizeChoiceText(choice).toLowerCase();
      return normalized && answer.includes(normalized);
    });
  }

  function collapseWhitespace(value) {
    return (value || "").replace(/\s+/g, " ").trim();
  }

  function readableText(element) {
    if (!element) return "";

    const clone = element.cloneNode(true);

    clone.querySelectorAll("span._visuallyHidden").forEach((span) => {
      if (/^\s*blank\s*$/i.test(span.textContent)) span.remove();
    });

    clone.querySelectorAll("table").forEach((table) => {
      const lines = [];
      const caption = collapseWhitespace(
        table.querySelector("caption")?.textContent
      );
      if (caption) lines.push(caption);

      table.querySelectorAll("tr").forEach((row) => {
        const cells = Array.from(row.querySelectorAll("th, td")).map((cell) =>
          collapseWhitespace(cell.textContent)
        );
        if (cells.some(Boolean)) lines.push(cells.join(" | "));
      });

      table.replaceWith(`\n${lines.join("\n")}\n`);
    });

    clone.querySelectorAll("img").forEach((image) => {
      const alt = (image.getAttribute("alt") || "").trim();
      image.replaceWith(alt ? ` [Image: ${alt}] ` : " ");
    });

    clone.querySelectorAll("br").forEach((br) => br.replaceWith("\n"));
    clone.querySelectorAll("p, li, div").forEach((block) => block.append("\n"));

    return clone.textContent
      .replace(/[ \t\u00A0]+/g, " ")
      .replace(/ *\n\s*/g, "\n")
      .trim();
  }

  AutoMcGraw.text = {
    LIST_MARKER,
    normalizeChoiceText,
    stripWrappingQuotes,
    isAnswerMatch,
    findChoiceIndex,
    resolveChoiceIndices,
    parseArrayString,
    flattenAnswerValues,
    splitCompoundAnswer,
    dedupeAnswers,
    extractChoicesFromCombined,
    readableText,
  };
})();
