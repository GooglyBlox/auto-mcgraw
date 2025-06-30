let messageListener = null;
let isAutomating = false;
let lastIncorrectQuestion = null;
let lastCorrectAnswer = null;

function setupMessageListener() {
  if (messageListener) {
    chrome.runtime.onMessage.removeListener(messageListener);
  }

  messageListener = (message, sender, sendResponse) => {
    if (message.type === "processChatGPTResponse") {
      processChatGPTResponse(message.response);
      sendResponse({ received: true });
      return true;
    }

    if (message.type === "alertMessage") {
      alert(message.message);
      sendResponse({ received: true });
      return true;
    }
  };

  chrome.runtime.onMessage.addListener(messageListener);
}

function handleTopicOverview() {
  const continueButton = document.querySelector(
    "awd-topic-overview-button-bar .next-button, .button-bar-wrapper .next-button"
  );

  if (
    continueButton &&
    continueButton.textContent.trim().toLowerCase().includes("continue")
  ) {
    continueButton.click();

    setTimeout(() => {
      if (isAutomating) {
        checkForNextStep();
      }
    }, 1000);

    return true;
  }
  return false;
}

function handleForcedLearning() {
  const forcedLearningAlert = document.querySelector(
    ".forced-learning .alert-error"
  );
  if (forcedLearningAlert) {
    const readButton = document.querySelector(
      '[data-automation-id="lr-tray_reading-button"]'
    );
    if (readButton) {
      readButton.click();

      waitForElement('[data-automation-id="reading-questions-button"]', 10000)
        .then((toQuestionsButton) => {
          toQuestionsButton.click();
          return waitForElement(".next-button", 10000);
        })
        .then((nextButton) => {
          nextButton.click();
          if (isAutomating) {
            setTimeout(() => {
              checkForNextStep();
            }, 1000);
          }
        })
        .catch((error) => {
          console.error("Error in forced learning flow:", error);
          isAutomating = false;
        });
      return true;
    }
  }
  return false;
}

function checkForNextStep() {
  if (!isAutomating) return;

  if (handleTopicOverview()) {
    return;
  }

  if (handleForcedLearning()) {
    return;
  }

  const container = document.querySelector(".probe-container");
  if (container && !container.querySelector(".forced-learning")) {
    const qData = parseQuestion();
    if (qData) {
      chrome.runtime.sendMessage({
        type: "sendQuestionToChatGPT",
        question: qData,
      });
    }
  }
}

function extractCorrectAnswer() {
  const container = document.querySelector(".probe-container");
  if (!container) return null;

  const incorrectMarker = container.querySelector(
    ".awd-probe-correctness.incorrect"
  );
  if (!incorrectMarker) return null;

  let questionType = "";
  if (container.querySelector(".awd-probe-type-multiple_choice")) {
    questionType = "multiple_choice";
  } else if (container.querySelector(".awd-probe-type-true_false")) {
    questionType = "true_false";
  } else if (container.querySelector(".awd-probe-type-multiple_select")) {
    questionType = "multiple_select";
  } else if (container.querySelector(".awd-probe-type-fill_in_the_blank")) {
    questionType = "fill_in_the_blank";
  } else if (container.querySelector(".awd-probe-type-matching")) {
    questionType = "matching";
  }

  let questionText = "";
  const promptEl = container.querySelector(".prompt");

  if (questionType === "fill_in_the_blank" && promptEl) {
    const promptClone = promptEl.cloneNode(true);

    const spans = promptClone.querySelectorAll(
      "span.response-container, span.fitb-span, span.blank-label, span.correctness, span._visuallyHidden"
    );
    spans.forEach((span) => span.remove());

    const inputs = promptClone.querySelectorAll("input.fitb-input");
    inputs.forEach((input) => {
      const blankMarker = document.createTextNode("[BLANK]");
      input.parentNode.replaceChild(blankMarker, input);
    });

    questionText = promptClone.textContent.trim();
  } else {
    questionText = promptEl ? promptEl.textContent.trim() : "";
  }

  let correctAnswer = null;

  if (questionType === "multiple_choice" || questionType === "true_false") {
    try {
      const answerContainer = container.querySelector(
        ".answer-container .choiceText"
      );
      if (answerContainer) {
        correctAnswer = answerContainer.textContent.trim();
      } else {
        const correctAnswerContainer = container.querySelector(
          ".correct-answer-container"
        );
        if (correctAnswerContainer) {
          const answerText =
            correctAnswerContainer.querySelector(".choiceText");
          if (answerText) {
            correctAnswer = answerText.textContent.trim();
          } else {
            const answerDiv = correctAnswerContainer.querySelector(".choice");
            if (answerDiv) {
              correctAnswer = answerDiv.textContent.trim();
            }
          }
        }
      }
    } catch (e) {
      console.error("Error extracting multiple choice answer:", e);
    }
  } else if (questionType === "multiple_select") {
    try {
      const correctAnswersList = container.querySelectorAll(
        ".correct-answer-container .choice"
      );
      if (correctAnswersList && correctAnswersList.length > 0) {
        correctAnswer = Array.from(correctAnswersList).map((el) => {
          const choiceText = el.querySelector(".choiceText");
          return choiceText
            ? choiceText.textContent.trim()
            : el.textContent.trim();
        });
      }
    } catch (e) {
      console.error("Error extracting multiple select answers:", e);
    }
  } else if (questionType === "fill_in_the_blank") {
    try {
      const correctAnswersList = container.querySelectorAll(".correct-answers");

      if (correctAnswersList && correctAnswersList.length > 0) {
        if (correctAnswersList.length === 1) {
          const correctAnswerEl =
            correctAnswersList[0].querySelector(".correct-answer");
          if (correctAnswerEl) {
            correctAnswer = correctAnswerEl.textContent.trim();
          } else {
            const answerText = correctAnswersList[0].textContent.trim();
            if (answerText) {
              const match = answerText.match(/:\s*(.+)$/);
              correctAnswer = match ? match[1].trim() : answerText;
            }
          }
        } else {
          correctAnswer = Array.from(correctAnswersList).map((field) => {
            const correctAnswerEl = field.querySelector(".correct-answer");
            if (correctAnswerEl) {
              return correctAnswerEl.textContent.trim();
            } else {
              const answerText = field.textContent.trim();
              const match = answerText.match(/:\s*(.+)$/);
              return match ? match[1].trim() : answerText;
            }
          });
        }
      }
    } catch (e) {
      console.error("Error extracting fill in the blank answers:", e);
    }
  }

  if (questionType === "matching") {
    return null;
  }

  if (correctAnswer === null) {
    console.error("Failed to extract correct answer for", questionType);
    return null;
  }

  return {
    question: questionText,
    answer: correctAnswer,
    type: questionType,
  };
}

function cleanAnswer(answer) {
  if (!answer) return answer;

  if (Array.isArray(answer)) {
    return answer.map((item) => cleanAnswer(item));
  }

  if (typeof answer === "string") {
    let cleanedAnswer = answer.trim();

    cleanedAnswer = cleanedAnswer.replace(/^Field \d+:\s*/, "");

    if (cleanedAnswer.includes(" or ")) {
      cleanedAnswer = cleanedAnswer.split(" or ")[0].trim();
    }

    return cleanedAnswer;
  }

  return answer;
}

function processChatGPTResponse(responseText) {
  try {
    if (handleTopicOverview()) {
      return;
    }

    if (handleForcedLearning()) {
      return;
    }

    const response = JSON.parse(responseText);
    const answers = Array.isArray(response.answer)
      ? response.answer
      : [response.answer];

    const container = document.querySelector(".probe-container");
    if (!container) return;

    lastIncorrectQuestion = null;
    lastCorrectAnswer = null;

    if (container.querySelector(".awd-probe-type-matching")) {
      alert(
        "Matching Question Solution:\n\n" +
          answers.join("\n") +
          "\n\nPlease input these matches manually, then click high confidence and next."
      );
    } else if (container.querySelector(".awd-probe-type-fill_in_the_blank")) {
      const inputs = container.querySelectorAll("input.fitb-input");
      inputs.forEach((input, index) => {
        if (answers[index]) {
          input.value = answers[index];
          input.dispatchEvent(new Event("input", { bubbles: true }));
        }
      });
    } else {
      const choices = container.querySelectorAll(
        'input[type="radio"], input[type="checkbox"]'
      );

      choices.forEach((choice) => {
        const label = choice.closest("label");
        if (label) {
          const choiceText = label
            .querySelector(".choiceText")
            ?.textContent.trim();
          if (choiceText) {
            const shouldBeSelected = answers.some((ans) => {
              if (choiceText === ans) return true;

              const choiceWithoutPeriod = choiceText.replace(/\.$/, "");
              const answerWithoutPeriod = ans.replace(/\.$/, "");
              if (choiceWithoutPeriod === answerWithoutPeriod) return true;

              if (choiceText === ans + ".") return true;

              return false;
            });

            if (shouldBeSelected) {
              choice.click();
            }
          }
        }
      });
    }

    if (isAutomating) {
      waitForElement(
        '[data-automation-id="confidence-buttons--high_confidence"]:not([disabled])',
        10000
      )
        .then((button) => {
          button.click();

          setTimeout(() => {
            const incorrectMarker = container.querySelector(
              ".awd-probe-correctness.incorrect"
            );
            if (incorrectMarker) {
              const correctionData = extractCorrectAnswer();
              if (correctionData && correctionData.answer) {
                lastIncorrectQuestion = correctionData.question;
                lastCorrectAnswer = cleanAnswer(correctionData.answer);
                console.log(
                  "Found incorrect answer. Correct answer is:",
                  lastCorrectAnswer
                );
              }
            }

            waitForElement(".next-button", 10000)
              .then((nextButton) => {
                nextButton.click();
                setTimeout(() => {
                  checkForNextStep();
                }, 1000);
              })
              .catch((error) => {
                console.error("Automation error:", error);
                isAutomating = false;
              });
          }, 1000);
        })
        .catch((error) => {
          console.error("Automation error:", error);
          isAutomating = false;
        });
    }
  } catch (e) {
    console.error("Error processing response:", e);
  }
}

function addAssistantButton() {
  waitForElement("awd-header .header__navigation").then((headerNav) => {
    const buttonContainer = document.createElement("div");
    buttonContainer.style.display = "flex";
    buttonContainer.style.marginLeft = "10px";

    chrome.storage.sync.get("aiModel", function (data) {
      const aiModel = data.aiModel || "chatgpt";
      let modelName = "ChatGPT";

      if (aiModel === "gemini") {
        modelName = "Gemini";
      } else if (aiModel === "deepseek") {
        modelName = "DeepSeek";
      }

      const btn = document.createElement("button");
      btn.textContent = `Ask ${modelName}`;
      btn.classList.add("btn", "btn-secondary");
      btn.style.borderTopRightRadius = "0";
      btn.style.borderBottomRightRadius = "0";
      btn.addEventListener("click", () => {
        if (isAutomating) {
          isAutomating = false;
          chrome.storage.sync.get("aiModel", function (data) {
            const currentModel = data.aiModel || "chatgpt";
            let currentModelName = "ChatGPT";

            if (currentModel === "gemini") {
              currentModelName = "Gemini";
            } else if (currentModel === "deepseek") {
              currentModelName = "DeepSeek";
            }

            btn.textContent = `Ask ${currentModelName}`;
          });
        } else {
          const proceed = confirm(
            "Start automated answering? Click OK to begin, or Cancel to stop."
          );
          if (proceed) {
            isAutomating = true;
            btn.textContent = "Stop Automation";
            checkForNextStep();
          }
        }
      });

      const settingsBtn = document.createElement("button");
      settingsBtn.classList.add("btn", "btn-secondary");
      settingsBtn.style.borderTopLeftRadius = "0";
      settingsBtn.style.borderBottomLeftRadius = "0";
      settingsBtn.style.borderLeft = "1px solid rgba(0,0,0,0.2)";
      settingsBtn.style.padding = "6px 10px";
      settingsBtn.title = "Auto-McGraw Settings";
      settingsBtn.innerHTML = `
        <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <circle cx="12" cy="12" r="3"></circle>
          <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"></path>
        </svg>
      `;
      settingsBtn.addEventListener("click", () => {
        chrome.runtime.sendMessage({ type: "openSettings" });
      });

      buttonContainer.appendChild(btn);
      buttonContainer.appendChild(settingsBtn);
      headerNav.appendChild(buttonContainer);

      chrome.storage.onChanged.addListener((changes) => {
        if (changes.aiModel) {
          const newModel = changes.aiModel.newValue;
          let newModelName = "ChatGPT";

          if (newModel === "gemini") {
            newModelName = "Gemini";
          } else if (newModel === "deepseek") {
            newModelName = "DeepSeek";
          }

          if (!isAutomating) {
            btn.textContent = `Ask ${newModelName}`;
          }
        }
      });
    });
  });
}

function parseQuestion() {
  const container = document.querySelector(".probe-container");
  if (!container) {
    alert("No question found on the page.");
    return null;
  }

  let questionType = "";
  if (container.querySelector(".awd-probe-type-multiple_choice")) {
    questionType = "multiple_choice";
  } else if (container.querySelector(".awd-probe-type-true_false")) {
    questionType = "true_false";
  } else if (container.querySelector(".awd-probe-type-multiple_select")) {
    questionType = "multiple_select";
  } else if (container.querySelector(".awd-probe-type-fill_in_the_blank")) {
    questionType = "fill_in_the_blank";
  } else if (container.querySelector(".awd-probe-type-matching")) {
    questionType = "matching";
  }

  let questionText = "";
  const promptEl = container.querySelector(".prompt");

  if (questionType === "fill_in_the_blank" && promptEl) {
    const promptClone = promptEl.cloneNode(true);

    const uiSpans = promptClone.querySelectorAll(
      "span.fitb-span, span.blank-label, span.correctness, span._visuallyHidden"
    );
    uiSpans.forEach((span) => span.remove());

    const inputs = promptClone.querySelectorAll("input.fitb-input");
    inputs.forEach((input) => {
      const blankMarker = document.createTextNode("[BLANK]");
      if (input.parentNode) {
        input.parentNode.replaceChild(blankMarker, input);
      }
    });

    questionText = promptClone.textContent.trim();
  } else {
    questionText = promptEl ? promptEl.textContent.trim() : "";
  }

  let options = [];
  if (questionType === "matching") {
    const prompts = Array.from(
      container.querySelectorAll(".match-prompt .content")
    ).map((el) => el.textContent.trim());
    const choices = Array.from(
      container.querySelectorAll(".choices-container .content")
    ).map((el) => el.textContent.trim());
    options = { prompts, choices };
  } else if (questionType !== "fill_in_the_blank") {
    container.querySelectorAll(".choiceText").forEach((el) => {
      options.push(el.textContent.trim());
    });
  }

  return {
    type: questionType,
    question: questionText,
    options: options,
    previousCorrection: lastIncorrectQuestion
      ? {
          question: lastIncorrectQuestion,
          correctAnswer: lastCorrectAnswer,
        }
      : null,
  };
}

function waitForElement(selector, timeout = 5000) {
  return new Promise((resolve, reject) => {
    const startTime = Date.now();
    const interval = setInterval(() => {
      const el = document.querySelector(selector);
      if (el) {
        clearInterval(interval);
        resolve(el);
      } else if (Date.now() - startTime > timeout) {
        clearInterval(interval);
        reject(new Error("Element not found: " + selector));
      }
    }, 100);
  });
}

setupMessageListener();
addAssistantButton();

if (isAutomating) {
  setTimeout(() => {
    checkForNextStep();
  }, 1000);
}
