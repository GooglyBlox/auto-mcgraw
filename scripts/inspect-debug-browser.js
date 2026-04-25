const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright");

const repoRoot = path.resolve(__dirname, "..");
const artifactsDir = path.join(repoRoot, "playwright-artifacts");
const port = Number(process.env.PW_DEBUG_PORT || 9222);

async function main() {
  fs.mkdirSync(artifactsDir, { recursive: true });

  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  const contexts = browser.contexts();
  const pages = contexts.flatMap((context) => context.pages());

  console.log(`Connected. Contexts: ${contexts.length}; pages: ${pages.length}`);
  for (const [index, page] of pages.entries()) {
    console.log(`${index}: ${await page.title()} :: ${page.url()}`);
  }

  const mcgrawPage = pages.find((page) =>
    /mheducation\.com|newconnect\.mheducation\.com/.test(page.url())
  );

  if (mcgrawPage) {
    const snapshot = await mcgrawPage.evaluate(() => {
      const frames = Array.from(document.querySelectorAll("iframe")).map(
        (frame, index) => {
          try {
            const body = frame.contentDocument?.body;
            return {
              index,
              title: frame.title || frame.name || frame.id || "",
              url: frame.src,
              text: body ? body.innerText.slice(0, 15000) : "",
              html: body ? body.innerHTML.slice(0, 30000) : "",
            };
          } catch (error) {
            return {
              index,
              title: frame.title || frame.name || frame.id || "",
              url: frame.src,
              error: error.message,
            };
          }
        }
      );

      return {
        url: location.href,
        title: document.title,
        automcgrawButton: Boolean(
          document.querySelector(".header__automcgraw--main")
        ),
        text: document.body.innerText.slice(0, 15000),
        frames,
      };
    });

    const outPath = path.join(artifactsDir, "mcgraw-snapshot.json");
    fs.writeFileSync(outPath, JSON.stringify(snapshot, null, 2));
    console.log(`Wrote ${outPath}`);
  }

  await browser.close();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
