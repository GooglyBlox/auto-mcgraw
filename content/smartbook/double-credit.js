(() => {
  const { MessageType, messaging, wait, questions, answers } = AutoMcGraw;

  const DUPLICATE_TIMEOUT_MS = 60000;
  const DUPLICATE_LOAD_TIMEOUT_MS = 20000;
  const CONFIDENCE_TIMEOUT_MS = 5000;
  const LOG_PREFIX = "[Auto-McGraw]";

  let resolveCompletion = null;

  messaging.handle(MessageType.DUPLICATE_COMPLETE, (result) => {
    resolveCompletion?.(result);
    resolveCompletion = null;
  });

  async function submitInDuplicate(run, answer, questionKey) {
    const completion = new Promise((resolve) => {
      resolveCompletion = resolve;
    });

    let result = null;
    try {
      const opened = await messaging.send({
        type: MessageType.OPEN_DUPLICATE,
        answer,
        questionKey,
      });
      if (!opened?.ok) {
        throw new Error(
          opened?.error || "The duplicate tab couldn't be opened."
        );
      }

      result = await run.withTimeout(completion, DUPLICATE_TIMEOUT_MS);
      if (!result) throw new Error("The duplicate tab didn't finish in time.");
      if (!result.ok) {
        throw new Error(
          result.error || "The duplicate tab couldn't answer the question."
        );
      }
    } catch (error) {
      if (run.signal.aborted) throw error;
      console.warn(
        LOG_PREFIX,
        "Double credit skipped for this question:",
        messaging.errorMessage(error)
      );
    } finally {
      resolveCompletion = null;
      if (!result) {
        messaging
          .send({ type: MessageType.CANCEL_DUPLICATE })
          .catch(() => null);
      }
    }
  }

  async function claim() {
    try {
      return await messaging.send({ type: MessageType.CLAIM_DUPLICATE });
    } catch {
      return null;
    }
  }

  function findAnswerableContainer() {
    const container = questions.findContainer();
    return container && questions.isAnswerable(container) ? container : null;
  }

  async function submitAnswer(job, confidenceSelector) {
    const loaded = await wait.waitFor(findAnswerableContainer, {
      timeout: DUPLICATE_LOAD_TIMEOUT_MS,
    });
    if (!loaded) {
      throw new Error("The question didn't load in the duplicate tab.");
    }
    if (questions.questionKey(loaded) !== job.questionKey) {
      throw new Error("The duplicate tab is showing a different question.");
    }

    await wait.delay(500);
    const container = findAnswerableContainer();
    if (!container) {
      throw new Error("The question changed in the duplicate tab.");
    }

    const { applied } = await answers.apply(container, job.answer);
    if (!applied) throw new Error("The answer couldn't be filled in.");

    const confidenceButton = await wait.waitFor(
      () => document.querySelector(confidenceSelector),
      { timeout: CONFIDENCE_TIMEOUT_MS }
    );
    if (!confidenceButton) {
      throw new Error("SmartBook didn't accept the answer.");
    }

    confidenceButton.click();
    await wait.delay(800);
  }

  async function answerAsDuplicate(job, confidenceSelector) {
    let error = null;
    try {
      await submitAnswer(job, confidenceSelector);
    } catch (caught) {
      error = messaging.errorMessage(caught);
    }

    await messaging
      .send({ type: MessageType.DUPLICATE_FINISHED, ok: !error, error })
      .catch(() => null);
  }

  AutoMcGraw.doubleCredit = { submitInDuplicate, claim, answerAsDuplicate };
})();
