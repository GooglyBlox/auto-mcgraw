(() => {
  const { MessageType, tabs } = AutoMcGraw;

  const JOB_KEY = "duplicateJob";

  async function readJob() {
    const { [JOB_KEY]: job } = await chrome.storage.session.get(JOB_KEY);
    return job || null;
  }

  function writeJob(job) {
    return chrome.storage.session.set({ [JOB_KEY]: job });
  }

  function clearJob() {
    return chrome.storage.session.remove(JOB_KEY);
  }

  async function notifyOriginal(tabId, result) {
    try {
      await tabs.send(tabId, {
        type: MessageType.DUPLICATE_COMPLETE,
        ...result,
      });
    } catch (error) {
      console.error(
        "[Auto-McGraw] Could not reach the original SmartBook tab:",
        error
      );
    }
  }

  async function cancel() {
    const job = await readJob();
    if (!job) return;
    await clearJob();
    await tabs.close(job.duplicateTabId);
  }

  async function open({ answer, questionKey }, originalTab) {
    await cancel();

    const duplicate = await chrome.tabs.duplicate(originalTab.id);
    if (!duplicate) {
      return { ok: false, error: "The duplicate tab couldn't be opened." };
    }

    await writeJob({
      originalTabId: originalTab.id,
      duplicateTabId: duplicate.id,
      answer,
      questionKey,
      claimed: false,
    });
    return { ok: true };
  }

  async function claim(tab) {
    const job = await readJob();
    if (!job || job.claimed || job.duplicateTabId !== tab?.id) return null;

    await writeJob({ ...job, claimed: true });
    return { answer: job.answer, questionKey: job.questionKey };
  }

  async function finish({ ok, error }, tab) {
    const job = await readJob();
    if (!job || job.duplicateTabId !== tab?.id) return;

    await clearJob();
    await tabs.close(job.duplicateTabId);
    await tabs.activate(job.originalTabId);
    await notifyOriginal(job.originalTabId, {
      ok: Boolean(ok),
      error: error || null,
    });
  }

  async function handleTabRemoved(tabId) {
    const job = await readJob();
    if (!job) return;

    if (tabId === job.duplicateTabId) {
      await clearJob();
      await notifyOriginal(job.originalTabId, {
        ok: false,
        error: "The duplicate tab was closed.",
      });
    } else if (tabId === job.originalTabId) {
      await cancel();
    }
  }

  AutoMcGraw.doubleCredit = { open, claim, finish, cancel, handleTabRemoved };
})();
