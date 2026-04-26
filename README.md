<div align="center">

# Auto-McGraw (Smartbook)

<img src="assets/icon.png" alt="Auto-McGraw Logo" width="200">

## Fork Notice

This fork expands the original SmartBook-focused extension with broader McGraw Hill Connect support, including non-SmartBook assignments, embedded accounting worksheets, journal-entry style tools, and final submission handling.

Major changes in this fork:

- Connect snapshot automation with selector-based actions for complex page layouts
- Prompt/action parity across ChatGPT, Gemini, and DeepSeek
- Support for dropdowns, spreadsheet-style cells, journal entries, and negative accounting values
- Safer worksheet navigation, including avoiding repeated Record entry / Save clicks on completed sub-questions
- Improved handling for final Next / Submit behavior and assignment completion

[![Release](https://img.shields.io/github/v/release/GooglyBlox/auto-mcgraw?include_prereleases&style=flat-square&cache=1)](https://github.com/GooglyBlox/auto-mcgraw/releases)
[![License](https://img.shields.io/github/license/GooglyBlox/auto-mcgraw?style=flat-square&cache=1)](LICENSE)
[![Downloads](https://img.shields.io/github/downloads/GooglyBlox/auto-mcgraw/total?style=flat-square&cache=1)](https://github.com/GooglyBlox/auto-mcgraw/releases)

*Automate your McGraw Hill Smartbook and Connect homework with AI integration (ChatGPT, Gemini & DeepSeek)*

[Installation](#installation) • [Usage](#usage) • [Settings](#settings) • [Issues](#issues)

</div>

---

## Compatibility Notice

**⚠️ MacOS Users:** This extension may not work properly on MacOS due to platform-specific differences in Chrome extension behavior and system interactions. For the best experience, we recommend using this extension on Windows or Linux systems.

---

## Installation

1. Download the latest zip from the [releases page](https://github.com/GooglyBlox/auto-mcgraw/releases)
2. Extract the zip file to a folder
3. Open Chrome and go to `chrome://extensions/`
4. Enable "Developer mode" in the top right
5. Click "Load unpacked" and select the extracted folder

## Usage

1. Log into your McGraw Hill account and open a Smartbook or Connect assignment
2. Log into one of the supported AI assistants in another tab:
   - [ChatGPT](https://chatgpt.com)
   - [Gemini](https://gemini.google.com)
   - [DeepSeek](https://chat.deepseek.com)
3. Click the "Ask [AI Model]" button that appears in your Smartbook header
4. Click "OK" when prompted to begin automation
5. Watch as the extension:
   - Sends questions to your chosen AI assistant
   - Processes the responses
   - Automatically fills in answers
   - Handles multiple choice, true/false, fill-in-the-blank, and matching questions
      - **Note about matching questions:** Matching questions now attempt full automation. If a strict, reliable match cannot be completed, the extension will show AI-suggested matches in an alert, pause, and let you finish manually before resuming on the next question.
   - Navigates through forced learning sections when needed

Click "Stop Automation" at any time to pause the process.

## Settings

Click the settings icon ( <img src="assets/settings-icon.svg" alt="Settings Icon" style="vertical-align: middle; width: 16px; height: 16px;"> ) next to the main button to access the settings menu, where you can:

- Choose between **ChatGPT**, **Gemini**, or **DeepSeek** for answering questions
- See the status of your AI assistant connections
- Check if your selected AI assistant is ready to use

The extension will automatically use your selected AI model for all future automation sessions.

## Disclaimer

This tool is for educational purposes only. Use it responsibly and be aware of your institution's academic integrity policies.

Auto-McGraw is an independent project and is not affiliated with, endorsed by, sponsored by, or otherwise associated with McGraw Hill or any of its related entities.

Any third-party names, trademarks, logos, assets, or likenesses referenced or displayed by this project remain the property of their respective owners and copyright holders.

## Issues

Found a bug? [Create an issue](https://github.com/GooglyBlox/auto-mcgraw/issues).
