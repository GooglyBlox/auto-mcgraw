const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

const repoRoot = path.resolve(__dirname, "..");
const userDataDir = path.join(repoRoot, ".manual-chrome-profile");
const logPath = path.join(repoRoot, "manual-debug-browser.log");
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
  return browserCandidates.find((candidate) => fs.existsSync(candidate));
}

function log(...parts) {
  const line = `[${new Date().toISOString()}] ${parts.join(" ")}\n`;
  process.stdout.write(line);
  fs.appendFileSync(logPath, line);
}

fs.mkdirSync(userDataDir, { recursive: true });
fs.writeFileSync(logPath, "");

const executablePath = findBrowserExecutable();
if (!executablePath) {
  throw new Error("Could not find Chrome or Edge. Set PW_BROWSER_EXECUTABLE.");
}

const args = [
  `--user-data-dir=${userDataDir}`,
  `--disable-extensions-except=${repoRoot}`,
  `--load-extension=${repoRoot}`,
  `--remote-debugging-port=${port}`,
  "--remote-allow-origins=*",
  "--no-first-run",
  "--no-default-browser-check",
  "--disable-default-apps",
  "--disable-sync",
  "--disable-features=SigninIntercept,ChromeWhatsNewUI,OptimizationGuideModelDownloading",
  "--start-maximized",
  startUrl,
  "https://chatgpt.com/",
];

log("Launching manual debug browser:", executablePath);
log("Remote debugging:", `http://127.0.0.1:${port}`);
log("Extension:", repoRoot);

const child = spawn(executablePath, args, {
  detached: true,
  stdio: "ignore",
});

child.unref();
log("Browser PID:", child.pid);
