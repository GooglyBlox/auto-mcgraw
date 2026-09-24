(() => {
  const RESPONSE_FORMAT =
    "\n\nIMPORTANT: Your answer should be in a JSON code block." +
    '\n\nPlease provide your answer in JSON format with keys "answer" and "explanation". Explanations should be no more than one sentence. DO NOT acknowledge the correction in your response, only answer the new question.';

  function numbered(items) {
    return items.map((item, index) => `${index + 1}. ${item}`).join("\n");
  }

  function correctionPreamble({ question, correctAnswer }) {
    return `CORRECTION FROM PREVIOUS ANSWER: For the question "${question}", your answer was incorrect. The correct answer was: ${JSON.stringify(
      correctAnswer
    )}\n\nNow answer this new question:\n\n`;
  }

  function build({ type, question, options, previousCorrection }) {
    let prompt = `Type: ${type}\nQuestion: ${question}`;

    if (previousCorrection?.question && previousCorrection?.correctAnswer) {
      prompt = correctionPreamble(previousCorrection) + prompt;
    }

    if (type === "matching") {
      prompt += `\nPrompts:\n${numbered(options.prompts)}`;
      prompt += `\nChoices:\n${numbered(options.choices)}`;
      prompt +=
        "\n\nPlease match each prompt with the correct choice. Set \"answer\" to an array of strings using the exact format 'Prompt -> Choice'. Include one entry per prompt, use exact prompt and choice text, and use each choice at most once.";
    } else if (type === "fill_in_the_blank") {
      prompt +=
        "\n\nThis is a fill in the blank question. If there are multiple blanks, provide answers as an array in order of appearance. For a single blank, you can provide a string.";
    } else if (options?.length > 0) {
      prompt += `\nOptions:\n${numbered(options)}`;

      if (type === "multiple_select") {
        prompt +=
          '\n\nIMPORTANT: This is a "select all that apply" question. Set "answer" to an array containing EVERY correct option. Each entry must EXACTLY match one of the options above. Do not include option numbers.';
      } else {
        prompt +=
          "\n\nIMPORTANT: Your answer must EXACTLY match one of the above options. Do not include numbers in your answer. If there are periods, include them.";
        if (type !== "multiple_choice" && type !== "true_false") {
          prompt +=
            ' If more than one option is correct, set "answer" to an array of all of them.';
        }
      }
    }

    return prompt + RESPONSE_FORMAT;
  }

  AutoMcGraw.prompt = { build };
})();
