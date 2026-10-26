const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');
const assert = require('node:assert/strict');

module.exports = function runBrowser(body, scripts, testCode) {
  const candidates = [
    process.env.CHROME_BIN,
    ...[process.env.PROGRAMFILES, process.env['PROGRAMFILES(X86)'], process.env.LOCALAPPDATA]
      .filter(Boolean).map(base => path.join(base, 'Google/Chrome/Application/chrome.exe')),
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium', '/usr/bin/chromium-browser',
  ];
  const chrome = candidates.filter(Boolean).find(file => fs.existsSync(file));
  assert.ok(chrome, 'Chrome/Chromium is required; set CHROME_BIN to its executable path');
  const tempRoot = process.env.TMPDIR || os.tmpdir();
  fs.mkdirSync(tempRoot, { recursive: true });
  const dir = fs.mkdtempSync(path.join(tempRoot, 'auto-mcgraw-browser-'));
  const file = path.join(dir, 'test.html');
  const escapeScript = script => script.replace(/<\/script/gi, '<\\/script');
  fs.writeFileSync(file, '<!doctype html><body>' + body + '<pre id="test-output">PENDING</pre>' +
    scripts.map(script => '<script>' + escapeScript(script) + '</script>').join('\n') +
    '<script>(async()=>{try{' + escapeScript(testCode) +
    ';document.getElementById("test-output").textContent="PASS";}catch(error){document.getElementById("test-output").textContent="FAIL "+error.stack;}})();</script>');
  const output = execFileSync(chrome, ['--headless=new', '--disable-gpu', '--no-first-run', '--disable-extensions',
    '--no-default-browser-check', '--user-data-dir=' + path.join(dir, 'profile'), '--virtual-time-budget=20000',
    '--dump-dom', require('node:url').pathToFileURL(file).href], { encoding: 'utf8', timeout: 45000,
    stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 8 * 1024 * 1024 });
  const result = output.match(/<pre id="test-output">([\s\S]*?)<\/pre>/)?.[1];
  assert.equal(result, 'PASS', (result || 'No browser result') + '\nFixture artifacts: ' + dir);
};
