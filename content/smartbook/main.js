(() => {
  const { settings, automation, toolbar, questions, answers, doubleCredit } =
    AutoMcGraw;

  const CONFIDENCE_LEVELS = [
    "high_confidence",
    "medium_confidence",
    "low_confidence",
  ];
  const STATE_POLL_ATTEMPTS = 30;
  const STATE_POLL_MS = 500;
  const NEXT_RETRY_EVERY = 6;
  const MANUAL_ANSWER_HINT =
    "Please answer this question yourself, then click a confidence button and Next. Automation will resume on the next question.";

  let currentSettings = { ...settings.DEFAULTS };
  let pendingCorrection = null;

  function confidenceSelector() {
    const level = currentSettings.randomConfidence
      ? CONFIDENCE_LEVELS[Math.floor(Math.random() * CONFIDENCE_LEVELS.length)]
      : CONFIDENCE_LEVELS[0];
    return `[data-automation-id="confidence-buttons--${level}"]:not([disabled])`;
  }

  function findOverviewContinueButton() {
    const button = document.querySelector(
      "awd-topic-overview-button-bar .next-button, .button-bar-wrapper .next-button"
    );
    return button?.textContent.trim().toLowerCase().includes("continue")
      ? button
      : null;
  }

  function findForcedLearningReadButton() {
    if (!document.querySelector(".forced-learning .alert-error")) return null;
    return document.querySelector(
      '[data-automation-id="lr-tray_reading-button"]'
    );
  }

  function readPageState() {
    const continueButton = findOverviewContinueButton();
    if (continueButton) return { kind: "overview", button: continueButton };

    const readButton = findForcedLearningReadButton();
    if (readButton) return { kind: "forcedLearning", button: readButton };

    const container = questions.findContainer();
    if (
      container &&
      !container.querySelector(".forced-learning") &&
      questions.isAnswerable(container)
    ) {
      return { kind: "question", container };
    }

    const nextButton = document.querySelector(".next-button");
    if (nextButton) return { kind: "answered", button: nextButton };

    return { kind: "loading" };
  }

  async function waitForActionableState(run) {
    for (let attempt = 0; attempt < STATE_POLL_ATTEMPTS; attempt += 1) {
      const state = readPageState();
      if (state.kind !== "answered" && state.kind !== "loading") return state;

      if (
        state.kind === "answered" &&
        attempt % NEXT_RETRY_EVERY === NEXT_RETRY_EVERY - 1
      ) {
        state.button.click();
      }
      await run.delay(STATE_POLL_MS);
    }
    return null;
  }

  function hasMovedOn(signature) {
    let leftQuestion = false;
    return () => {
      const state = readPageState();
      if (state.kind === "overview" || state.kind === "forcedLearning") {
        return true;
      }
      if (state.kind !== "question") {
        leftQuestion = true;
        return false;
      }
      return leftQuestion || questions.signature(state.container) !== signature;
    };
  }

  async function completeForcedLearning(run, readButton) {
    const failure =
      "Couldn't get through the required reading section. Please return to the questions manually, then start automation again.";

    readButton.click();
    const toQuestionsButton = await run.waitFor(
      () =>
        document.querySelector(
          '[data-automation-id="reading-questions-button"]'
        ),
      { timeout: 10000 }
    );
    if (!toQuestionsButton) {
      run.stop(failure);
      return;
    }

    toQuestionsButton.click();
    const nextButton = await run.waitFor(
      () => document.querySelector(".next-button"),
      { timeout: 10000 }
    );
    if (!nextButton) {
      run.stop(failure);
      return;
    }

    nextButton.click();
    await run.delay(1000);
  }

  async function submit(run, lines, isDone) {
    const selector = confidenceSelector();
    const confidenceButton = await run.waitFor(
      () => document.querySelector(selector),
      { timeout: 5000 }
    );
    if (!confidenceButton) {
      await run.pauseForManualAnswer(
        "The answer was filled in, but SmartBook didn't accept it.",
        lines,
        MANUAL_ANSWER_HINT,
        isDone
      );
      return;
    }

    confidenceButton.click();
    await run.delay(1000);
    pendingCorrection = questions.extractCorrection(questions.findContainer());

    const nextButton = await run.waitFor(
      () => document.querySelector(".next-button"),
      { timeout: 10000 }
    );
    if (!nextButton) {
      run.stop(
        "Couldn't find SmartBook's Next button after submitting the answer."
      );
      return;
    }

    nextButton.click();
    await run.delay(1000);
  }

  async function answerQuestion(run, container) {
    const signature = questions.signature(container);
    const reply = await run.ask(questions.parse(container, pendingCorrection));
    pendingCorrection = null;

    const current = questions.findContainer();
    if (
      !current ||
      questions.signature(current) !== signature ||
      !questions.isAnswerable(current)
    ) {
      console.warn(
        "[Auto-McGraw] The question changed before the answer arrived."
      );
      return;
    }

    const result = await answers.apply(current, reply?.answer);
    run.checkpoint();

    const isDone = hasMovedOn(signature);
    if (!result.applied) {
      await run.pauseForManualAnswer(
        result.heading,
        result.lines,
        MANUAL_ANSWER_HINT,
        isDone
      );
      return;
    }

    if (currentSettings.doubleCreditMode) {
      await doubleCredit.submitInDuplicate(
        run,
        reply.answer,
        questions.questionKey(current)
      );
    }

    if (currentSettings.pauseBeforeSubmit) {
      await run.waitForUser(isDone);
      return;
    }

    await submit(run, result.lines, isDone);
  }

  async function step(run) {
    const state = await waitForActionableState(run);
    if (!state) {
      run.stop(
        "No new question appeared. If the assignment is complete you're done; otherwise go to the next question and start automation again."
      );
      return;
    }

    if (state.kind === "overview") {
      state.button.click();
      await run.delay(1000);
      return;
    }

    if (state.kind === "forcedLearning") {
      await completeForcedLearning(run, state.button);
      return;
    }

    await answerQuestion(run, state.container);
  }

  const session = automation.create({ step, onStateChange: render });
  const bar = toolbar.create({ variant: "smartbook", onToggle: toggle });

  function render() {
    bar.render({
      running: session.isRunning(),
      assistantId: currentSettings.aiModel,
      doubleCredit: currentSettings.doubleCreditMode,
    });
  }

  function toggle() {
    if (session.isRunning()) {
      session.stop();
      return;
    }

    const modeText = currentSettings.doubleCreditMode
      ? " Double credit mode is enabled."
      : "";
    if (
      confirm(
        `Start automated answering?${modeText} Click OK to begin, or Cancel to stop.`
      )
    ) {
      session.start();
    }
  }

  async function init() {
    render();
    toolbar.keepMounted(bar.element, (element) => {
      document
        .querySelector("awd-header .header__navigation")
        ?.appendChild(element);
    });

    settings.subscribe((values) => {
      currentSettings = values;
      render();
    });
    currentSettings = await settings.load();
    render();

    const job = await doubleCredit.claim();
    if (job) await doubleCredit.answerAsDuplicate(job, confidenceSelector());
  }

  init().catch((error) => console.error("[Auto-McGraw]", error));
})();
