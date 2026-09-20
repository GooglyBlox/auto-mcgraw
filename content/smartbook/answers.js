(() => {
  const { text, dom, matching, questions } = AutoMcGraw;

  const UNMATCHED_HEADING =
    "Couldn't match the AI's answer to this question's choices.";

  function choiceInputs(container) {
    return Array.from(
      container.querySelectorAll('input[type="radio"], input[type="checkbox"]')
    )
      .map((input) => {
        const label = input.closest("label")?.querySelector(".choiceText");
        return { input, text: label ? text.readableText(label) : "" };
      })
      .filter((choice) => choice.text);
  }

  function fillBlanks(container, values) {
    const inputs = Array.from(container.querySelectorAll("input.fitb-input"));

    let entries = values;
    if (entries.length === 1 && inputs.length > 1) {
      const parts = entries[0].split(/\s*[;,]\s*/).filter(Boolean);
      if (parts.length === inputs.length) entries = parts;
    }

    let filled = 0;
    inputs.forEach((input, index) => {
      if (entries[index] === undefined) return;
      dom.setInputValue(input, entries[index]);
      filled += 1;
    });
    return filled > 0;
  }

  function selectChoices(container, values) {
    const choices = choiceInputs(container);
    const allowMultiple = choices.some(
      (choice) => choice.input.type === "checkbox"
    );
    const indices = text.resolveChoiceIndices(
      choices.map((choice) => choice.text),
      values,
      allowMultiple
    );

    indices.forEach((index) => {
      const { input } = choices[index];
      if (!input.checked) input.click();
    });
    return indices.length > 0;
  }

  function selectText(container, values) {
    const choices = questions.selectTextChoices(container);
    const indices = text.resolveChoiceIndices(
      choices.map((choice) => choice.textContent.trim()),
      values,
      true
    );

    indices.forEach((index) => choices[index].click());
    return indices.length > 0;
  }

  function normalizeAnswers(raw, type, container) {
    if (type === "matching") return matching.describe(container, raw);

    const values = text.flattenAnswerValues(raw);
    if (!values.length) return [];

    const isMultiAnswer = type === "multiple_select" || type === "select_text";
    if (isMultiAnswer && values.length === 1) {
      const named = text.extractChoicesFromCombined(
        values[0],
        questions.readChoices(container, type)
      );
      if (named.length) return text.dedupeAnswers(named);

      const split = text.splitCompoundAnswer(values[0]);
      if (split.length > 1) return text.dedupeAnswers(split);
    }

    return text.dedupeAnswers(values);
  }

  async function apply(container, raw) {
    const type = questions.detectType(container);
    const lines = normalizeAnswers(raw, type, container);

    if (type === "matching") {
      return {
        applied: await matching.apply(container, raw),
        lines,
        heading:
          "Matching question: the matches couldn't be placed automatically.",
      };
    }

    if (!type) {
      return {
        applied: false,
        lines,
        heading: "This question type isn't supported yet.",
      };
    }

    let applied;
    if (type === "fill_in_the_blank") {
      applied = fillBlanks(container, lines);
    } else if (type === "select_text") {
      applied = selectText(container, lines);
    } else {
      applied = selectChoices(container, lines);
    }

    return { applied, lines, heading: UNMATCHED_HEADING };
  }

  AutoMcGraw.answers = { apply };
})();
