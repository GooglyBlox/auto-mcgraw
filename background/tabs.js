(() => {
  const { wait } = AutoMcGraw;

  async function send(
    tabId,
    message,
    { attempts = 3, retryDelay = 1000 } = {}
  ) {
    for (let attempt = 1; ; attempt += 1) {
      try {
        return await chrome.tabs.sendMessage(tabId, message);
      } catch (error) {
        if (attempt >= attempts) throw error;
        await wait.delay(retryDelay);
      }
    }
  }

  async function get(tabId) {
    if (typeof tabId !== "number") return null;
    try {
      return await chrome.tabs.get(tabId);
    } catch {
      return null;
    }
  }

  async function activate(tabId) {
    try {
      await chrome.tabs.update(tabId, { active: true });
      return true;
    } catch {
      return false;
    }
  }

  async function close(tabId) {
    try {
      await chrome.tabs.remove(tabId);
    } catch {
      return;
    }
  }

  async function findByMatch(match) {
    const found = await chrome.tabs.query({ url: match });
    found.sort((a, b) => (b.lastAccessed || 0) - (a.lastAccessed || 0));
    return found[0] || null;
  }

  AutoMcGraw.tabs = { send, get, activate, close, findByMatch };
})();
