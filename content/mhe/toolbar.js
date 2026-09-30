(() => {
  const { MessageType, messaging, assistants } = AutoMcGraw;

  const STYLE_ID = "automcgraw-toolbar-style";
  const SETTINGS_ICON = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="3"></circle><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"></path></svg>`;

  const STYLES = `
    .automcgraw-toolbar {
      display: inline-flex;
      align-items: center;
    }

    .automcgraw-toolbar svg {
      display: block;
      width: 16px;
      height: 16px;
    }

    .automcgraw-toolbar.automcgraw-toolbar--smartbook {
      display: flex;
      margin-left: 10px;
    }

    .automcgraw-toolbar.automcgraw-toolbar--smartbook > .btn.automcgraw-toolbar__main {
      border-top-right-radius: 0;
      border-bottom-right-radius: 0;
    }

    .automcgraw-toolbar.automcgraw-toolbar--smartbook > .btn.automcgraw-toolbar__settings {
      border-top-left-radius: 0;
      border-bottom-left-radius: 0;
      border-left: 1px solid rgba(0, 0, 0, 0.2);
      padding: 6px 10px;
    }

    .automcgraw-toolbar.automcgraw-toolbar--ezto {
      margin-right: 20px;
    }

    .automcgraw-toolbar.automcgraw-toolbar--ezto > button {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      height: 32px;
      background: #fff;
      border: 1px solid #ccc;
      color: #333;
      font-family: inherit;
      font-size: 14px;
      line-height: 1;
      cursor: pointer;
      transition: background-color 0.2s ease;
    }

    .automcgraw-toolbar.automcgraw-toolbar--ezto > button:hover {
      background: #f5f5f5;
    }

    .automcgraw-toolbar.automcgraw-toolbar--ezto > .automcgraw-toolbar__main {
      padding: 8px 12px;
      border-right: none;
      border-radius: 4px 0 0 4px;
    }

    .automcgraw-toolbar.automcgraw-toolbar--ezto > .automcgraw-toolbar__settings {
      padding: 8px 10px;
      border-radius: 0 4px 4px 0;
    }

    .automcgraw-toolbar.automcgraw-toolbar--ezto svg {
      width: 14px;
      height: 14px;
    }
  `;

  function injectStyles() {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = STYLES;
    (document.head || document.documentElement).appendChild(style);
  }

  function openSettings() {
    messaging
      .send({ type: MessageType.OPEN_SETTINGS })
      .catch(() =>
        alert(
          "Auto-McGraw was updated or reloaded. Refresh this page to keep using it."
        )
      );
  }

  function create({ variant, onToggle }) {
    injectStyles();

    const element = document.createElement("div");
    element.className = `automcgraw-toolbar automcgraw-toolbar--${variant}`;

    const mainButton = document.createElement("button");
    mainButton.type = "button";
    mainButton.className = "automcgraw-toolbar__main";
    mainButton.addEventListener("click", onToggle);

    const settingsButton = document.createElement("button");
    settingsButton.type = "button";
    settingsButton.className = "automcgraw-toolbar__settings";
    settingsButton.title = "Auto-McGraw Settings";
    settingsButton.setAttribute("aria-label", "Auto-McGraw Settings");
    settingsButton.innerHTML = SETTINGS_ICON;
    settingsButton.addEventListener("click", openSettings);

    if (variant === "smartbook") {
      mainButton.classList.add("btn", "btn-secondary");
      settingsButton.classList.add("btn", "btn-secondary");
    }

    element.append(mainButton, settingsButton);

    function render({ running, assistantId, doubleCredit }) {
      mainButton.textContent = running
        ? "Stop Automation"
        : `Ask ${assistants.get(assistantId).name}${doubleCredit ? " (2x)" : ""}`;
    }

    return { element, render };
  }

  function keepMounted(element, mount) {
    const ensureMounted = () => {
      if (!element.isConnected) mount(element);
    };
    new MutationObserver(ensureMounted).observe(document.documentElement, {
      childList: true,
      subtree: true,
    });
    ensureMounted();
  }

  AutoMcGraw.toolbar = { create, keepMounted };
})();
