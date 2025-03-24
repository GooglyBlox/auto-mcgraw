let hasResponded = false;
let messageCountAtQuestion = 0;
let observationStartTime = 0;
let observationTimeout = null;
let observer = null;

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "receiveQuestion") {
    resetObservation();

    const messages = document.querySelectorAll(
      '[data-message-author-role="assistant"]'
    );
    messageCountAtQuestion = messages.length;
    hasResponded = false;

    insertQuestion(message.question)
      .then(() => {
        sendResponse({ received: true, status: "processing" });
      })
      .catch((error) => {
        sendResponse({ received: false, error: error.message });
      });

    return true;
  }
});

function resetObservation() {
  hasResponded = false;
  if (observationTimeout) {
    clearTimeout(observationTimeout);
    observationTimeout = null;
  }
  if (observer) {
    observer.disconnect();
    observer = null;
  }
}

async function insertQuestion(questionData) {
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
      "\n\nPlease match each prompt with the correct choice. Format your answer as an array where each element is 'Prompt -> Choice'.";
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

  return new Promise((resolve, reject) => {
    const inputArea = document.getElementById("prompt-textarea");
    if (inputArea) {
      setTimeout(() => {
        inputArea.focus();
        inputArea.innerHTML = `<p>${text}</p>`;
        inputArea.dispatchEvent(new Event("input", { bubbles: true }));

        setTimeout(() => {
          const sendButton = document.querySelector(
            '[data-testid="send-button"]'
          );
          if (sendButton) {
            sendButton.click();
            startObserving();
            resolve();
          } else {
            reject(new Error("Send button not found"));
          }
        }, 300);
      }, 300);
    } else {
      reject(new Error("Input area not found"));
    }
  });
}

function startObserving() {
  observationStartTime = Date.now();
  observationTimeout = setTimeout(() => {
    if (!hasResponded) {
      resetObservation();
    }
  }, 180000);

  observer = new MutationObserver((mutations) => {
    if (hasResponded) return;

    const messages = document.querySelectorAll(
      '[data-message-author-role="assistant"]'
    );
    if (!messages.length) return;

    if (messages.length <= messageCountAtQuestion) return;

    const latestMessage = messages[messages.length - 1];
    const codeBlocks = latestMessage.querySelectorAll("pre code");
    let responseText = "";

    for (const block of codeBlocks) {
      if (block.className.includes("language-json")) {
        responseText = block.textContent.trim();
        break;
      }
    }

    if (!responseText) {
      responseText = latestMessage.textContent.trim();
      const jsonMatch = responseText.match(/\{[\s\S]*\}/);
      if (jsonMatch) responseText = jsonMatch[0];
    }

    responseText = responseText
      .replace(/[\u200B-\u200D\uFEFF]/g, "")
      .replace(/\n\s*/g, " ")
      .trim();

    try {
      const parsed = JSON.parse(responseText);
      if (parsed.answer && !hasResponded) {
        hasResponded = true;
        chrome.runtime
          .sendMessage({
            type: "chatGPTResponse",
            response: responseText,
          })
          .then(() => {
            resetObservation();
          })
          .catch((error) => {
            console.error("Error sending response:", error);
          });
      }
    } catch (e) {
      const isGenerating = latestMessage.querySelector(".result-streaming");
      if (!isGenerating && Date.now() - observationStartTime > 30000) {
        const responseText = latestMessage.textContent.trim();
        try {
          const jsonPattern =
            /\{[\s\S]*?"answer"[\s\S]*?"explanation"[\s\S]*?\}/;
          const jsonMatch = responseText.match(jsonPattern);

          if (jsonMatch && !hasResponded) {
            hasResponded = true;
            chrome.runtime.sendMessage({
              type: "chatGPTResponse",
              response: jsonMatch[0],
            });
            resetObservation();
          }
        } catch (e) {}
      }
    }
  });

  observer.observe(document.body, {
    childList: true,
    subtree: true,
    characterData: true,
  });
}
