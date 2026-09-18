(() => {
  function queryFirst(selectors, root = document) {
    for (const selector of selectors) {
      let element = null;
      try {
        element = root.querySelector(selector);
      } catch {
        continue;
      }
      if (element) return element;
    }
    return null;
  }

  function isEnabled(element) {
    return (
      Boolean(element) &&
      !element.disabled &&
      element.getAttribute("aria-disabled") !== "true"
    );
  }

  function dispatchInputEvents(element) {
    element.dispatchEvent(new Event("input", { bubbles: true }));
    element.dispatchEvent(new Event("change", { bubbles: true }));
  }

  function setInputValue(input, value) {
    const setter = Object.getOwnPropertyDescriptor(
      Object.getPrototypeOf(input),
      "value"
    )?.set;
    if (setter) {
      setter.call(input, value);
    } else {
      input.value = value;
    }
    dispatchInputEvents(input);
  }

  AutoMcGraw.dom = {
    queryFirst,
    isEnabled,
    dispatchInputEvents,
    setInputValue,
  };
})();
