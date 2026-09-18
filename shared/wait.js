(() => {
  function delay(ms, signal) {
    return new Promise((resolve) => {
      if (signal?.aborted) {
        resolve();
        return;
      }

      const finish = () => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", finish);
        resolve();
      };
      const timer = setTimeout(finish, ms);
      signal?.addEventListener("abort", finish, { once: true });
    });
  }

  function waitFor(getter, { timeout = 10000, interval = 200, signal } = {}) {
    return new Promise((resolve) => {
      if (signal?.aborted) {
        resolve(null);
        return;
      }

      const initial = getter();
      if (initial) {
        resolve(initial);
        return;
      }

      let settled = false;
      let observer = null;
      let timeoutId = null;

      const finish = (value) => {
        if (settled) return;
        settled = true;
        clearInterval(intervalId);
        clearTimeout(timeoutId);
        observer?.disconnect();
        signal?.removeEventListener("abort", abort);
        resolve(value || null);
      };
      const check = () => {
        if (settled) return;
        const value = getter();
        if (value) finish(value);
      };
      const abort = () => finish(null);

      const intervalId = setInterval(check, interval);
      if (Number.isFinite(timeout)) {
        timeoutId = setTimeout(
          () => finish(settled ? null : getter()),
          timeout
        );
      }
      if (
        typeof MutationObserver === "function" &&
        globalThis.document?.documentElement
      ) {
        observer = new MutationObserver(check);
        observer.observe(document.documentElement, {
          childList: true,
          subtree: true,
          attributes: true,
        });
      }
      signal?.addEventListener("abort", abort, { once: true });
    });
  }

  function withTimeout(promise, { timeout = Infinity, signal } = {}) {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) {
        resolve(null);
        return;
      }

      let timeoutId = null;
      const finish = (callback, value) => {
        clearTimeout(timeoutId);
        signal?.removeEventListener("abort", abort);
        callback(value);
      };
      const abort = () => finish(resolve, null);

      if (Number.isFinite(timeout)) {
        timeoutId = setTimeout(() => finish(resolve, null), timeout);
      }
      signal?.addEventListener("abort", abort, { once: true });
      promise.then(
        (value) => finish(resolve, value),
        (error) => finish(reject, error)
      );
    });
  }

  AutoMcGraw.wait = { delay, waitFor, withTimeout };
})();
