(() => {
  const ASSISTANTS = Object.freeze([
    Object.freeze({
      id: "chatgpt",
      name: "ChatGPT",
      match: "https://chatgpt.com/*",
    }),
    Object.freeze({
      id: "gemini",
      name: "Gemini",
      match: "https://gemini.google.com/*",
    }),
    Object.freeze({
      id: "deepseek",
      name: "DeepSeek",
      match: "https://chat.deepseek.com/*",
    }),
  ]);

  const DEFAULT_ID = "chatgpt";

  function get(id) {
    return (
      ASSISTANTS.find((assistant) => assistant.id === id) ||
      ASSISTANTS.find((assistant) => assistant.id === DEFAULT_ID)
    );
  }

  AutoMcGraw.assistants = { DEFAULT_ID, list: ASSISTANTS, get };
})();
