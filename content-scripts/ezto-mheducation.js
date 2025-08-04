let messageListener = null;
let isAutomating = false;
let lastIncorrectQuestion = null;
let lastCorrectAnswer = null;
let buttonAdded = false;

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

function isQuizPage() {
  return (
    document.querySelector(".question") &&
    (document.querySelector(".answers-wrap.multiple-choice") ||
      document.querySelector(".answers-wrap.boolean") ||
      document.querySelector(".answers-wrap.input-response"))
  );
}

function checkForQuizAndAddButton() {
  if (buttonAdded) return;

  const helpLink = document.querySelector(".header__help");
  if (helpLink && isQuizPage()) {
    addAssistantButton();
    buttonAdded = true;
  }
}

function startPageObserver() {
  const observer = new MutationObserver(() => {
    if (!buttonAdded) {
      checkForQuizAndAddButton();
    }
  });

  observer.observe(document.body, {
    childList: true,
    subtree: true,
  });

  checkForQuizAndAddButton();
}

function checkForQuizEnd() {
  const progressInfo = document.querySelector(".footer__progress__heading");

  if (progressInfo) {
    const progressText = progressInfo.textContent;
    const match = progressText.match(/(\d+)\s+of\s+(\d+)/);
    if (match) {
      const current = parseInt(match[1]);
      const total = parseInt(match[2]);
      if (current > total) {
        return true;
      }
    }
  }

  return false;
}

function stopAutomation(reason = "Quiz completed") {
  isAutomating = false;

  chrome.storage.sync.get("aiModel", function (data) {
    const currentModel = data.aiModel || "chatgpt";
    let currentModelName = "ChatGPT";

    if (currentModel === "gemini") {
      currentModelName = "Gemini";
    } else if (currentModel === "deepseek") {
      currentModelName = "DeepSeek";
    }

    const btn = document.querySelector(".header__automcgraw--main");
    if (btn) {
      btn.textContent = `Ask ${currentModelName}`;
    }
  });

  alert(`Automation stopped: ${reason}`);
  console.log(`Automation stopped: ${reason}`);
}

function checkForNextStep() {
  if (!isAutomating) return;

  const questionData = parseQuestion();
  if (questionData) {
    chrome.runtime.sendMessage({
      type: "sendQuestionToChatGPT",
      question: questionData,
    });
  } else {
    stopAutomation("No question found or question type not supported");
  }
}

function parseQuestion() {
  const questionElement = document.querySelector(".question");
  if (!questionElement) {
    return null;
  }

  let questionType = "";
  let options = [];

  if (document.querySelector(".answers-wrap.multiple-choice")) {
    questionType = "multiple_choice";
    const optionElements = document.querySelectorAll(
      ".answers--mc .answer__label--mc"
    );
    options = Array.from(optionElements).map((el) => {
      const textContent = el.textContent.trim();
      return textContent.replace(/^[a-z]\s+/, "");
    });
  } else if (document.querySelector(".answers-wrap.boolean")) {
    questionType = "true_false";
    options = ["True", "False"];
  } else if (document.querySelector(".answers-wrap.input-response")) {
    questionType = "fill_in_the_blank";
    options = [];
  } else {
    console.log("Unknown question type");
    return null;
  }

  let questionText = "";
  if (questionType === "fill_in_the_blank") {
    const questionClone = questionElement.cloneNode(true);

    const blankSpans = questionClone.querySelectorAll(
      'span[aria-hidden="true"]'
    );
    blankSpans.forEach((span) => {
      if (span.textContent.includes("_")) {
        span.textContent = "[BLANK]";
      }
    });

    const hiddenSpans = questionClone.querySelectorAll(
      'span[style*="position: absolute"]'
    );
    hiddenSpans.forEach((span) => span.remove());

    questionText = questionClone.textContent.trim();
  } else {
    questionText = questionElement.textContent.trim();
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

function processChatGPTResponse(responseText) {
  try {
    console.log("Quiz response received:", responseText);

    const response = JSON.parse(responseText);
    const answer = response.answer;

    if (document.querySelector(".answers-wrap.multiple-choice")) {
      handleMultipleChoiceAnswer(answer);
    } else if (document.querySelector(".answers-wrap.boolean")) {
      handleTrueFalseAnswer(answer);
    } else if (document.querySelector(".answers-wrap.input-response")) {
      handleFillInTheBlankAnswer(answer);
    }

    if (isAutomating) {
      setTimeout(() => {
        const nextButton = document.querySelector(
          ".footer__link--next:not([hidden])"
        );
        if (
          nextButton &&
          !nextButton.disabled &&
          !nextButton.classList.contains("is-disabled")
        ) {
          nextButton.click();
          setTimeout(() => {
            if (checkForQuizEnd()) {
              stopAutomation("Quiz completed - all questions answered");
              return;
            }
            checkForNextStep();
          }, 1500);
        } else {
          stopAutomation("Quiz completed - no next button available");
        }
      }, 2000);
    }
  } catch (e) {
    console.error("Error processing response:", e);
    stopAutomation("Error processing AI response: " + e.message);
  }
}

function handleMultipleChoiceAnswer(answer) {
  const radioButtons = document.querySelectorAll(
    '.answers--mc input[type="radio"]'
  );
  const labels = document.querySelectorAll(".answers--mc .answer__label--mc");

  for (let i = 0; i < labels.length; i++) {
    const labelText = labels[i].textContent.trim().replace(/^[a-z]\s+/, "");

    if (
      labelText === answer ||
      labelText.replace(/\.$/, "") === answer.replace(/\.$/, "") ||
      labelText.includes(answer) ||
      answer.includes(labelText)
    ) {
      radioButtons[i].click();
      console.log("Selected option:", labelText);
      break;
    }
  }
}

function handleTrueFalseAnswer(answer) {
  console.log("Handling true/false answer:", answer);
  const buttons = document.querySelectorAll(".answer--boolean");
  console.log("Found buttons:", buttons.length);

  for (const button of buttons) {
    const buttonSpan = button.querySelector(".answer__button--boolean");
    if (!buttonSpan) {
      console.log("No .answer__button--boolean found in button");
      continue;
    }
    
    const fullText = buttonSpan.textContent;
    console.log("Button full text:", JSON.stringify(fullText));
    
    const buttonText = fullText.trim().split(",")[0].trim();
    console.log("Parsed button text:", JSON.stringify(buttonText));

    if (
      (buttonText === "True" && (answer === "True" || answer === true)) ||
      (buttonText === "False" && (answer === "False" || answer === false))
    ) {
      console.log("Clicking button with text:", buttonText);
      button.click();
      return;
    }
  }
  
  console.error("No matching button found for answer:", answer);
}

function handleFillInTheBlankAnswer(answer) {
  const inputField = document.querySelector(".answer--input__input");

  if (inputField) {
    let answerText = "";

    if (Array.isArray(answer)) {
      answerText = answer[0];
    } else {
      answerText = answer;
    }

    inputField.value = answerText;
    inputField.dispatchEvent(new Event("input", { bubbles: true }));
    inputField.dispatchEvent(new Event("change", { bubbles: true }));

    console.log("Filled in blank with:", answerText);
  } else {
    console.error("Could not find input field for fill in the blank");
  }
}

function addAssistantButton() {
  const helpLink = document.querySelector(".header__help");
  if (!helpLink) return;

  const buttonContainer = document.createElement("div");
  buttonContainer.className = "header__automcgraw";
  buttonContainer.style.cssText = `
    display: inline-flex;
    margin-right: 20px;
    align-items: center;
  `;

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
    btn.type = "button";
    btn.className = "header__automcgraw--main";
    btn.style.cssText = `
      background: #fff;
      border: 1px solid #ccc;
      color: #333;
      padding: 8px 12px;
      font-size: 14px;
      font-family: inherit;
      cursor: pointer;
      border-radius: 4px 0 0 4px;
      border-right: none;
      height: 32px;
      line-height: 1;
      text-decoration: none;
      display: inline-flex;
      align-items: center;
      transition: background-color 0.2s ease;
    `;

    btn.addEventListener("mouseenter", () => {
      btn.style.backgroundColor = "#f5f5f5";
    });

    btn.addEventListener("mouseleave", () => {
      btn.style.backgroundColor = "#fff";
    });

    btn.addEventListener("click", () => {
      if (isAutomating) {
        stopAutomation("Manual stop");
      } else {
        const proceed = confirm(
          "Start quiz automation? The automation will stop automatically when the quiz ends.\n\nClick OK to begin, or Cancel to stop."
        );
        if (proceed) {
          isAutomating = true;
          btn.textContent = "Stop Automation";
          checkForNextStep();
        }
      }
    });

    const settingsBtn = document.createElement("button");
    settingsBtn.type = "button";
    settingsBtn.className = "header__automcgraw--settings";
    settingsBtn.title = "Auto-McGraw Settings";
    settingsBtn.setAttribute("aria-label", "Auto-McGraw Settings");
    settingsBtn.style.cssText = `
      background: #fff;
      border: 1px solid #ccc;
      color: #333;
      padding: 8px 10px;
      font-size: 14px;
      cursor: pointer;
      border-radius: 0 4px 4px 0;
      height: 32px;
      line-height: 1;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      transition: background-color 0.2s ease;
    `;

    settingsBtn.addEventListener("mouseenter", () => {
      settingsBtn.style.backgroundColor = "#f5f5f5";
    });

    settingsBtn.addEventListener("mouseleave", () => {
      settingsBtn.style.backgroundColor = "#fff";
    });

    settingsBtn.innerHTML = `
      <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <circle cx="12" cy="12" r="3"></circle>
        <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06-.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"></path>
      </svg>
    `;

    settingsBtn.addEventListener("click", () => {
      chrome.runtime.sendMessage({ type: "openSettings" });
    });

    buttonContainer.appendChild(btn);
    buttonContainer.appendChild(settingsBtn);
    helpLink.parentNode.insertBefore(buttonContainer, helpLink);

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
startPageObserver();

if (isAutomating) {
  setTimeout(() => {
    checkForNextStep();
  }, 1000);
}
