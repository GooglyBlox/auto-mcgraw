function buildPrompt(questionData) {
  if (questionData.type === "connect_slot_graph") {
    return buildSlotGraphPrompt(questionData);
  }

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
        previousCorrection.correctAnswer,
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
      "\n\nPlease match each prompt with the correct choice. Set \"answer\" to an array of strings using the exact format 'Prompt -> Choice'. Include one entry per prompt, use exact prompt and choice text, and use each choice at most once.";
  } else if (type === "fill_in_the_blank") {
    text +=
      "\n\nThis is a fill in the blank question. If there are multiple blanks, provide answers as an array in order of appearance. For a single blank, you can provide a string.";
  } else if (options && options.length > 0) {
    text +=
      "\nOptions:\n" + options.map((opt, i) => `${i + 1}. ${opt}`).join("\n");
    text +=
      "\n\nIMPORTANT: Your answer must EXACTLY match one of the above options. Do not include numbers in your answer. If there are periods, include them.";
  }

  text +=
    '\n\nPlease provide your answer in JSON format with keys "answer" and "explanation". Explanations should be no more than one sentence. DO NOT acknowledge the correction in your response, only answer the new question.';

  return text;
}

function buildSlotGraphPrompt(questionData) {
  const { prompt, context, slots } = questionData;
  const slotList = Array.isArray(slots) ? slots : [];

  let text = `Question / page prompt:\n${prompt || ""}`;

  if (context && context !== prompt) {
    text += `\n\nFull page context:\n${context}`;
  }

  text += `\n\nFillable slots (you must return a value for each slot you can answer):\n${JSON.stringify(
    slotList,
    null,
    2,
  )}`;

  text += `\n\nReturn JSON of the form: {"slots": {"<slot id>": <value>, ...}, "explanation": "<one sentence>"}`;
  text += `\n\nReturn only the raw JSON object - no markdown fences, no acknowledgements, no prose outside the JSON.`;
  text += `\n\nRules:`;
  text += `\n- Use the exact slot ids from the slots list as the keys.`;
  text += `\n- For dropdown slots, the value must be EXACTLY one of the option strings shown in that slot's "options".`;
  text += `\n- For choice / boolean slots (single selection), the value is the exact option string you want to pick.`;
  text += `\n- For multi_choice slots, the value is an array of exact option strings.`;
  text += `\n- For number slots, write the number as you would type it. For NEGATIVE numbers in McGraw's accounting cells, use parentheses, e.g. "(4,976)" - McGraw stores negatives that way.`;
  text += `\n- For text slots, write the natural-language answer as a string.`;
  text += `\n- If a slot has no answer (truly blank cell), omit it or set its value to null. Do not invent values.`;
  text += `\n- Use slot "hint", "group", and "groupRole" to keep paired cells (label/amount, debit/credit, row 1/row 2) consistent.`;
  text += `\n- Do NOT emit any other keys (no "actions", no selectors). The page knows how to apply each slot.`;

  return text;
}

function sanitizeResponseText(text) {
  return String(text || "")
    .replace(/[\u200B-\u200D\uFEFF]/g, "")
    .trim();
}

function looksLikeJsonResponse(text) {
  return (
    text.startsWith("{") && text.endsWith("}") && /"answer"|"slots"/.test(text)
  );
}

function findJsonObject(text) {
  const value = sanitizeResponseText(text);
  if (looksLikeJsonResponse(value)) return value;

  const firstBrace = value.indexOf("{");
  const lastBrace = value.lastIndexOf("}");
  if (firstBrace === -1 || lastBrace === -1 || lastBrace <= firstBrace) {
    return "";
  }

  return value.slice(firstBrace, lastBrace + 1);
}
