<div align="center">

# Auto-McGraw (Smartbook)

<img src="assets/icon.png" alt="Auto-McGraw Logo" width="200">

[![Release](https://img.shields.io/github/v/release/GooglyBlox/auto-mcgraw?include_prereleases&style=flat-square&cache=1)](https://github.com/GooglyBlox/auto-mcgraw/releases)
[![License](https://img.shields.io/github/license/GooglyBlox/auto-mcgraw?style=flat-square&cache=1)](LICENSE)
[![Downloads](https://img.shields.io/github/downloads/GooglyBlox/auto-mcgraw/total?style=flat-square&cache=1)](https://github.com/GooglyBlox/auto-mcgraw/releases)

*Automate McGraw Hill Smartbook questions with browser-based AI assistants or a direct API.*

[Installation](#installation) | [Usage](#usage) | [Settings](#settings) | [Monitoring](#monitoring) | [Issues](#issues)

</div>

---

## Public Service Announcement

**Auto-McGraw is not published on the Chrome Web Store.** Only install it from a repository or release you trust. Unofficial reuploads may be modified and are not affiliated with this project.

## Installation

### Load the extension from source

1. Download or clone this repository.
2. If you downloaded a ZIP, extract it to a permanent folder.
3. Open Chrome and go to `chrome://extensions/`.
4. Enable **Developer mode**.
5. Click **Load unpacked** and select the folder containing `manifest.json`.

Reload the extension from `chrome://extensions/` after pulling updates.

### Install a release ZIP

Download a ZIP from this repository's [releases page](../../releases), extract it, and load the extracted folder using the steps above.

## Usage

1. Sign in to McGraw Hill and open a Smartbook assignment.
2. Open the extension settings using the settings icon in the Smartbook header.
3. Choose an answering method:
   - **ChatGPT** - sends questions to a ChatGPT browser tab.
   - **Gemini** - sends questions to a Gemini browser tab.
   - **DeepSeek** - sends questions to a DeepSeek browser tab.
   - **OpenRouter / API** - sends requests directly from the extension without opening an assistant tab.
4. Click the **Ask [AI Model]** button in Smartbook.
5. Confirm the start prompt when shown.

The extension handles multiple choice, true/false, fill-in-the-blank, and matching questions, and can navigate forced-learning sections when needed. Click **Stop Automation** at any time to pause the process.

## Direct API provider

The OpenRouter / API option supports OpenRouter and compatible OpenAI-style chat-completions APIs.

In the API settings, configure:

- **API base URL** - for example, `https://openrouter.ai/api/v1`. The extension appends `/chat/completions`.
- **API key** - stored in this browser's local extension storage and sent only to the configured endpoint.
- **Model ID** - for example, `openai/gpt-4o-mini` or another model supported by the endpoint.
- **OpenRouter provider** - optionally restrict OpenRouter to a provider such as OpenAI, Anthropic, Google AI Studio, Together, Groq, or another provider slug.
- **Custom provider slug** - optionally overrides the provider dropdown for providers not listed in the menu.

Any OpenAI-compatible HTTPS endpoint can be used. Local HTTP endpoints at `localhost` and `127.0.0.1` are also supported. Remote HTTP endpoints are intentionally not enabled by default.

Direct API mode does not require a ChatGPT, Gemini, or DeepSeek tab to be open or focused.

## Multi-tab concurrency

Each Smartbook source tab has its own request state. Direct API requests are started independently, so several Smartbook tabs can have requests in flight at the same time. One tab waiting for a response does not block the other tabs.

The browser-assistant modes remain available for users who prefer them. Those modes depend on the corresponding provider tab being signed in and available to the extension.

## Monitoring

Open the **Monitoring** link at the bottom of the extension settings page to view the dashboard.

The dashboard shows one row per Smartbook tab, including:

- Current status, such as requesting, waiting, answering, completed, error, or slow.
- Provider/model being used.
- Current or last question preview.
- Correct and incorrect answer counts when the page exposes a correctness marker.
- Consecutive incorrect-answer streak.
- API response latency and active-request age.
- Error count and the latest error message.

The dashboard is intentionally compact and summarizes activity by tab instead of keeping a full per-question transcript. Use **Clear history** to remove stored monitoring data.

## Experimental features

These options are disabled by default and may change as they are tested.

### Include Image Alt Text

When enabled, non-empty alternative text from images in a question is included in the prompt sent to the selected assistant or API. This can help when an image question has useful text metadata.

### Full Auto Matching

When enabled, matching questions try additional automated passes if the normal matching logic cannot confidently apply the answer. This can continue without showing the manual matching alert, but it may submit an incorrect match. Use it only if you accept that tradeoff.

Double-credit matching retains its existing manual safety behavior.

## Other updates in v2.5

- Added official provider logos for ChatGPT, Gemini, DeepSeek, and OpenRouter.
- Added themed scrollbars to the settings and monitoring pages.
- Preserved the original ChatGPT, Gemini, and DeepSeek workflows while adding direct API support.
- Added fallback handling for structured JSON, JSON mode, and plain-text API responses.
- Added per-tab latency, error, and correctness tracking for the monitoring dashboard.

## Troubleshooting

- After updating files, reload the extension from `chrome://extensions/`.
- For browser-assistant modes, verify that the matching provider tab is signed in and not blocked by a login or verification page.
- For API mode, verify the base URL, API key, model ID, and provider slug. Check the monitoring dashboard for the latest error.
- If a matching question pauses, complete the suggested matches manually unless **Full Auto Matching** is enabled.

## Disclaimer

This tool is for educational purposes only. Use it responsibly and follow your institution's academic-integrity policies.

Auto-McGraw is an independent project and is not affiliated with, endorsed by, sponsored by, or otherwise associated with McGraw Hill or its related entities.

Any third-party names, trademarks, logos, assets, or likenesses referenced or displayed by this project remain the property of their respective owners and copyright holders.

## Issues

Found a bug? [Create an issue](https://github.com/GooglyBlox/auto-mcgraw/issues).
