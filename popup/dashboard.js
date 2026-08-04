const ACTIVE_STATUSES = new Set(["requesting", "waiting-assistant", "answering", "answering-duplicate"]);

const activeCount = document.getElementById("active-count");
const completedCount = document.getElementById("completed-count");
const errorCount = document.getElementById("error-count");
const correctCount = document.getElementById("correct-count");
const wrongCount = document.getElementById("wrong-count");
const activityList = document.getElementById("activity-list");
const lastUpdated = document.getElementById("last-updated");

function escapeHtml(value) {
  return String(value || "").replace(/[&<>'"]/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;",
  }[character]));
}

function formatAge(timestamp) {
  if (!timestamp) return "—";
  const seconds = Math.max(0, Math.floor((Date.now() - timestamp) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s ago`;
}

function formatLatency(latencyMs) {
  if (!Number.isFinite(latencyMs)) return "—";
  return latencyMs < 1000
    ? `${latencyMs}ms`
    : `${(latencyMs / 1000).toFixed(1)}s`;
}

function labelForStatus(status) {
  return {
    requesting: "Requesting",
    "waiting-assistant": "Waiting for assistant",
    answering: "Answering",
    "answering-duplicate": "Double-credit",
    completed: "Completed",
    error: "Error",
  }[status] || "Idle";
}

async function render() {
  const data = await chrome.storage.local.get("monitoringState");
  const entries = Object.values(data.monitoringState || {}).sort(
    (a, b) => (b.updatedAt || 0) - (a.updatedAt || 0)
  );
  const active = entries.filter((entry) => ACTIVE_STATUSES.has(entry.status)).length;
  const completed = entries.filter((entry) => entry.status === "completed").length;
  const errors = entries.reduce((total, entry) => total + (entry.errorCount || 0), 0);
  const correct = entries.reduce((total, entry) => total + (entry.correctCount || 0), 0);
  const wrong = entries.reduce((total, entry) => total + (entry.incorrectCount || 0), 0);
  activeCount.textContent = active;
  completedCount.textContent = completed;
  errorCount.textContent = errors;
  correctCount.textContent = correct;
  wrongCount.textContent = wrong;
  lastUpdated.textContent = entries.length ? `Updated ${formatAge(Math.max(...entries.map((entry) => entry.updatedAt || 0)))}` : "Waiting for activity";

  if (!entries.length) {
    activityList.innerHTML = '<div class="empty">No activity yet. Start automation on an MHEducation tab.</div>';
    return;
  }

  activityList.innerHTML = entries.map((entry) => {
    const isSlow = ACTIVE_STATUSES.has(entry.status) && entry.startedAt && Date.now() - entry.startedAt > 30000;
    const statusClass = isSlow ? "slow" : ACTIVE_STATUSES.has(entry.status) ? "active" : entry.status;
    const model = entry.model === "openrouter" ? "OpenRouter/API" : entry.model || "—";
    const detail = entry.error || entry.questionPreview || "No question preview";
    const statusLabel = isSlow ? `Slow — ${labelForStatus(entry.status)}` : labelForStatus(entry.status);
    const resultSummary = `${entry.correctCount || 0}✓ ${entry.incorrectCount || 0}✕${entry.consecutiveIncorrect > 1 ? ` · ${entry.consecutiveIncorrect} wrong streak` : ""}`;
    return `<div class="activity-row">
      <div class="tab-name" title="${escapeHtml(entry.tabTitle || `Tab ${entry.tabId}`)}">${escapeHtml(entry.tabTitle || `Tab ${entry.tabId}`)}</div>
      <div>${escapeHtml(model)}</div>
      <div><span class="status ${statusClass}">${escapeHtml(statusLabel)}</span></div>
      <div class="question" title="${escapeHtml(detail)}">${escapeHtml(detail)}</div>
      <div>${escapeHtml(resultSummary)}</div>
      <div>${escapeHtml(formatLatency(entry.latencyMs))} · ${escapeHtml(formatAge(entry.updatedAt))}</div>
    </div>`;
  }).join("");
}

document.getElementById("clear-monitoring").addEventListener("click", async () => {
  await chrome.runtime.sendMessage({ type: "clearMonitoring" });
  await render();
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.monitoringState) render();
});

render();
setInterval(render, 1000);
