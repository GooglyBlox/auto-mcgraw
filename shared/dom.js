(() => {
  const KEYS = Object.freeze({
    space: { key: " ", code: "Space", keyCode: 32 },
    enter: { key: "Enter", code: "Enter", keyCode: 13 },
    up: { key: "ArrowUp", code: "ArrowUp", keyCode: 38 },
    down: { key: "ArrowDown", code: "ArrowDown", keyCode: 40 },
  });

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

  function keyboardEvent(type, { key, code, keyCode }) {
    const event = new KeyboardEvent(type, {
      key,
      code,
      keyCode,
      which: keyCode,
      charCode: keyCode,
      bubbles: true,
      cancelable: true,
      composed: true,
    });

    try {
      Object.defineProperty(event, "keyCode", { get: () => keyCode });
      Object.defineProperty(event, "which", { get: () => keyCode });
    } catch {
      return event;
    }
    return event;
  }

  function pressKey(target, definition) {
    target.dispatchEvent(keyboardEvent("keydown", definition));
    target.dispatchEvent(keyboardEvent("keyup", definition));
  }

  AutoMcGraw.dom = {
    KEYS,
    queryFirst,
    isEnabled,
    dispatchInputEvents,
    setInputValue,
    pressKey,
  };
})();
