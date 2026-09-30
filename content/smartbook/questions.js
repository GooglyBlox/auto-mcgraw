(() => {
  const { text, matching } = AutoMcGraw;

  const PROBE_TYPES = [
    ["multiple_choice", ".awd-probe-type-multiple_choice"],
    ["true_false", ".awd-probe-type-true_false"],
    ["multiple_select", ".awd-probe-type-multiple_select"],
    ["fill_in_the_blank", ".awd-probe-type-fill_in_the_blank"],
    ["select_text", ".awd-probe-type-select_text"],
    ["matching", ".awd-probe-type-matching"],
  ];
  const SELECT_TEXT_CHOICE = ".select-text-component .choice.-interactive";
  const BLANK_UI_SPANS =
    "span.fitb-span, span.blank-label, span.correctness, span._visuallyHidden";
  const PROBE_CONTENT = '[class*="awd-probe-type-"], .prompt, .choiceText';

  function hasContent(container) {
    return Boolean(container.querySelector(PROBE_CONTENT));
  }

  function findContainer() {
    const containers = Array.from(
      document.querySelectorAll(".probe-container")
    );
    return containers.find(hasContent) || containers[0] || null;
  }

  function detectType(container) {
    for (const [type, selector] of PROBE_TYPES) {
      if (container.querySelector(selector)) return type;
    }

    if (container.querySelector(".choiceText")) {
      if (container.querySelector('input[type="checkbox"]')) {
        return "multiple_select";
      }
      if (container.querySelector('input[type="radio"]')) {
        return "multiple_choice";
      }
    }

    return "";
  }

  function isAnswerable(container) {
    if (!hasContent(container)) return false;
    if (container.querySelector('[class*="awd-probe-mode-"]')) {
      return Boolean(container.querySelector(".awd-probe-mode-testing"));
    }
    return (
      !container.querySelector(".awd-probe-correctness") &&
      !document.querySelector(".next-button")
    );
  }

  function readPrompt(container, type, { reviewMode = false } = {}) {
    const prompt = container.querySelector(".prompt");
    if (!prompt) return "";
    if (type !== "fill_in_the_blank") return text.readableText(prompt);

    const clone = prompt.cloneNode(true);
    const uiSpans = reviewMode
      ? `span.response-container, ${BLANK_UI_SPANS}`
      : BLANK_UI_SPANS;
    clone.querySelectorAll(uiSpans).forEach((span) => span.remove());
    clone
      .querySelectorAll("input.fitb-input")
      .forEach((input) => input.replaceWith("[BLANK]"));

    return text.readableText(clone);
  }

  function selectTextChoices(container) {
    return Array.from(container.querySelectorAll(SELECT_TEXT_CHOICE));
  }

  function readChoices(container, type) {
    if (type === "select_text") {
      return selectTextChoices(container)
        .map((choice) => choice.textContent.trim())
        .filter(Boolean);
    }

    return Array.from(container.querySelectorAll(".choiceText"))
      .map((choice) => text.readableText(choice))
      .filter(Boolean);
  }

  function parse(container, previousCorrection) {
    const type = detectType(container);

    let options = [];
    if (type === "matching") {
      options = matching.readOptions(container);
    } else if (type !== "fill_in_the_blank") {
      options = readChoices(container, type);
    }

    return {
      type,
      question: readPrompt(container, type),
      options,
      previousCorrection,
    };
  }

  function questionKey(container) {
    const type = detectType(container);
    const prompt = text.normalizeChoiceText(
      container.querySelector(".prompt")?.textContent?.trim() || ""
    );
    if (type !== "matching") return `${type}::${prompt}`;

    const matchPrompts = Array.from(
      container.querySelectorAll(".match-prompt .content")
    )
      .map((element) => text.normalizeChoiceText(element.textContent))
      .filter(Boolean)
      .join("|");
    return `${type}::${prompt}::${matchPrompts}`;
  }

  function signature(container) {
    const probeId =
      container
        .querySelector("[data-probe-id]")
        ?.getAttribute("data-probe-id") || "";
    return `${probeId}::${questionKey(container)}`;
  }

  function fieldAnswer(field) {
    const correctAnswer = field.querySelector(".correct-answer");
    if (correctAnswer) return correctAnswer.textContent.trim();

    const fieldText = field.textContent.trim();
    const match = fieldText.match(/:\s*(.+)$/);
    return match ? match[1].trim() : fieldText;
  }

  function readCorrectAnswer(container, type) {
    if (type === "multiple_choice" || type === "true_false") {
      const choice =
        container.querySelector(".answer-container .choiceText") ||
        container.querySelector(".correct-answer-container .choiceText") ||
        container.querySelector(".correct-answer-container .choice");
      return choice ? choice.textContent.trim() : null;
    }

    if (type === "multiple_select") {
      const choices = Array.from(
        container.querySelectorAll(".correct-answer-container .choice")
      ).map((choice) =>
        (choice.querySelector(".choiceText") || choice).textContent.trim()
      );
      return choices.length ? choices : null;
    }

    if (type === "fill_in_the_blank") {
      const fields = Array.from(container.querySelectorAll(".correct-answers"));
      if (!fields.length) return null;
      if (fields.length === 1) return fieldAnswer(fields[0]) || null;
      return fields.map(fieldAnswer);
    }

    if (type === "select_text") {
      const choices = Array.from(
        container.querySelectorAll(
          ".correct-answer-container .choice.-interactive, .correct-answer-container .choiceText, .correct-answer-container .choice"
        )
      )
        .map((choice) => choice.textContent.trim())
        .filter(Boolean);
      if (!choices.length) return null;
      return choices.length === 1 ? choices[0] : choices;
    }

    return null;
  }

  function cleanAnswer(answer) {
    if (Array.isArray(answer)) return answer.map(cleanAnswer);
    if (typeof answer !== "string") return answer;

    const cleaned = answer.trim().replace(/^Field \d+:\s*/, "");
    return cleaned.includes(" or ") ? cleaned.split(" or ")[0].trim() : cleaned;
  }

  function extractCorrection(container) {
    if (!container?.querySelector(".awd-probe-correctness.incorrect")) {
      return null;
    }

    const type = detectType(container);
    const answer = readCorrectAnswer(container, type);
    if (answer === null) {
      if (type !== "matching") {
        console.warn(
          "[Auto-McGraw] Couldn't read the correct answer for",
          type
        );
      }
      return null;
    }

    return {
      question: readPrompt(container, type, { reviewMode: true }),
      correctAnswer: cleanAnswer(answer),
    };
  }

  AutoMcGraw.questions = {
    findContainer,
    detectType,
    isAnswerable,
    readChoices,
    selectTextChoices,
    parse,
    questionKey,
    signature,
    extractCorrection,
  };
})();
