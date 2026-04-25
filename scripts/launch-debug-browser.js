const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright");

const repoRoot = path.resolve(__dirname, "..");
const userDataDir = path.join(repoRoot, ".playwright-profile");
const logPath = path.join(repoRoot, "playwright-debug.log");
const port = Number(process.env.PW_DEBUG_PORT || 9222);
const startUrl =
  process.env.PW_START_URL || "https://newconnect.mheducation.com/student/todo";
const browserCandidates = [
  process.env.PW_BROWSER_EXECUTABLE,
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
].filter(Boolean);

function findBrowserExecutable() {
  return browserCandidates.find((candidate) => fs.existsSync(candidate)) || null;
}

function log(...parts) {
  const line = `[${new Date().toISOString()}] ${parts.join(" ")}\n`;
  process.stdout.write(line);
  fs.appendFileSync(logPath, line);
}

async function main() {
  fs.mkdirSync(userDataDir, { recursive: true });
  fs.writeFileSync(logPath, "");

  log("Launching Playwright Chromium with extension:", repoRoot);
  log("Remote debugging:", `http://127.0.0.1:${port}`);

  const executablePath = findBrowserExecutable();
  if (executablePath) {
    log("Browser executable:", executablePath);
  } else {
    log("Browser executable: Playwright bundled Chromium");
  }

  const context = await chromium.launchPersistentContext(userDataDir, {
    headless: false,
    viewport: null,
    executablePath: executablePath || undefined,
    ignoreDefaultArgs: ["--enable-automation"],
    args: [
      `--disable-extensions-except=${repoRoot}`,
      `--load-extension=${repoRoot}`,
      `--remote-debugging-port=${port}`,
      "--remote-allow-origins=*",
      "--disable-blink-features=AutomationControlled",
      "--start-maximized",
    ],
  });

  await context.addInitScript(() => {
    Object.defineProperty(navigator, "webdriver", {
      get: () => undefined,
    });
  });

  context.on("page", (page) => {
    log("PAGE", page.url());
    page.on("console", (message) => {
      log("CONSOLE", message.type(), page.url(), message.text());
    });
    page.on("pageerror", (error) => {
      log("PAGEERROR", page.url(), error.message);
    });
  });

  context.on("serviceworker", (worker) => {
    log("SERVICE_WORKER", worker.url());
  });

  let page = context.pages()[0];
  if (!page) {
    page = await context.newPage();
  }
  await page.goto(startUrl);

  const chatgpt = await context.newPage();
  await chatgpt.goto("https://chatgpt.com/");

  log("Ready. Log into McGraw/ChatGPT in the visible browser window.");
  log("Leave this process running while debugging.");

  process.on("SIGINT", async () => {
    log("Closing browser...");
    await context.close();
    process.exit(0);
  });

  await new Promise(() => {});
}

main().catch((error) => {
  log("FATAL", error.stack || error.message);
  process.exit(1);
});
