const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright");

const repoRoot = path.resolve(__dirname, "..");
const artifactsDir = path.join(repoRoot, "playwright-artifacts");
const port = Number(process.env.PW_DEBUG_PORT || 9222);
const pageDebugKey = "automcgraw.debugLogs.v1";
const backgroundDebugKey = "automcgraw.backgroundDebugLogs.v1";

async function readPageLogs(page) {
  const bridged = await readPageLogsViaBridge(page);
  if (bridged) return bridged;

  try {
    const logs = await page.evaluate((key) => {
      const logs = JSON.parse(localStorage.getItem(key) || "[]");
      return Array.isArray(logs) ? logs : [];
    }, pageDebugKey);
    return {
      side: "",
      logs,
      backgroundLogs: [],
      backgroundError: "",
      backgroundResponse: null,
    };
  } catch (error) {
    return {
      side: "",
      logs: [],
      backgroundLogs: [],
      backgroundError: error.message,
      backgroundResponse: null,
    };
  }
}

async function readPageLogsViaBridge(page) {
  try {
    return await page.evaluate(
      () =>
        new Promise((resolve) => {
          const requestId = `${Date.now()}-${Math.random()}`;
          const timeout = setTimeout(() => {
            window.removeEventListener("message", onMessage);
            resolve(null);
          }, 2000);

          function onMessage(event) {
            if (event.source !== window) return;
            const data = event.data || {};
            if (
              data.source !== "automcgraw-debug" ||
              data.type !== "logs" ||
              data.requestId !== requestId
            ) {
              return;
            }

            clearTimeout(timeout);
            window.removeEventListener("message", onMessage);
            resolve({
              side: data.side || "",
              logs: Array.isArray(data.logs) ? data.logs : [],
              backgroundLogs: Array.isArray(data.backgroundLogs)
                ? data.backgroundLogs
                : [],
              backgroundError: data.backgroundError || "",
              backgroundResponse: data.backgroundResponse || null,
            });
          }

          window.addEventListener("message", onMessage);
          window.postMessage(
            {
              source: "automcgraw-debug",
              type: "collect",
              requestId,
            },
            "*"
          );
        })
    );
  } catch (error) {
    return null;
  }
}

async function readBackgroundLogs(context) {
  const workers = context
    .serviceWorkers()
    .filter((worker) => worker.url().startsWith("chrome-extension://"));

  for (const worker of workers) {
    try {
      const result = await worker.evaluate(
        (key) =>
          new Promise((resolve) => {
            chrome.storage.local.get(key, (data) => {
              resolve(data && Array.isArray(data[key]) ? data[key] : []);
            });
          }),
        backgroundDebugKey
      );
      return {
        workerUrl: worker.url(),
        logs: result,
      };
    } catch (error) {
      return {
        workerUrl: worker.url(),
        logs: [],
        error: error.message,
      };
    }
  }

  return {
    workerUrl: "",
    logs: [],
    error: "No extension service worker found",
  };
}

async function getPageSummary(page) {
  const [title, logResult] = await Promise.all([
    page.title().catch(() => ""),
    readPageLogs(page),
  ]);

  let diagnostic = "";
  let lastDebugAttribute = "";
  try {
    ({ diagnostic, lastDebugAttribute } = await page.evaluate(() => ({
      diagnostic:
        document.documentElement.getAttribute("data-automcgraw-diagnostic") ||
        "",
      lastDebugAttribute:
        document.documentElement.getAttribute("data-automcgraw-last-debug") ||
        "",
    })));
  } catch (error) {}

  return {
    title,
    url: page.url(),
    diagnostic,
    lastDebugAttribute,
    debugSide: logResult.side,
    logCount: logResult.logs.length,
    logs: logResult.logs,
    backgroundLogCountFromBridge: logResult.backgroundLogs.length,
    backgroundLogsFromBridge: logResult.backgroundLogs,
    backgroundErrorFromBridge: logResult.backgroundError,
    backgroundResponseFromBridge: logResult.backgroundResponse,
  };
}

async function main() {
  fs.mkdirSync(artifactsDir, { recursive: true });

  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  const contexts = browser.contexts();
  const context = contexts[0];
  const pages = context ? context.pages() : [];

  const pageSummaries = [];
  for (const page of pages) {
    pageSummaries.push(await getPageSummary(page));
  }

  const bridgedBackgroundLogs = pageSummaries.find(
    (page) => page.backgroundLogsFromBridge.length
  )?.backgroundLogsFromBridge;
  const bridgedBackgroundError = pageSummaries.find(
    (page) => page.backgroundErrorFromBridge
  )?.backgroundErrorFromBridge;
  const background = bridgedBackgroundLogs
    ? {
        workerUrl: "content-script bridge",
        logs: bridgedBackgroundLogs,
        error: bridgedBackgroundError || "",
      }
    : context
    ? await readBackgroundLogs(context)
    : { workerUrl: "", logs: [], error: "No browser context found" };

  const output = {
    collectedAt: new Date().toISOString(),
    port,
    pages: pageSummaries,
    background,
  };

  const outPath = path.join(artifactsDir, "automcgraw-debug-logs.json");
  fs.writeFileSync(outPath, JSON.stringify(output, null, 2));

  console.log(`Wrote ${outPath}`);
  for (const page of pageSummaries) {
    console.log(`${page.logCount} logs :: ${page.title} :: ${page.url}`);
  }
  console.log(
    `${background.logs.length} background logs :: ${
      background.workerUrl || background.error
    }`
  );

  await browser.close();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
