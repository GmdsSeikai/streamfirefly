export function createPreview(api, candidateFor) {
const previewRules = { nextId: 2147000000, byTab: new Map() };
const tabQueues = new Map();
const tabEpochs = new Map();

function enqueueTab(tabId, task) {
  const previous = tabQueues.get(tabId) || Promise.resolve();
  const run = previous.then(task, task);
  const guard = run.then(() => {}, () => {});
  tabQueues.set(tabId, guard);
  guard.then(() => { if (tabQueues.get(tabId) === guard) tabQueues.delete(tabId); });
  return run;
}

async function clearPreviewHeadersForTab(tabId) {
  // Bump the tab epoch immediately so an install already in flight cannot publish after this cleanup.
  tabEpochs.set(tabId, (tabEpochs.get(tabId) || 0) + 1);
  await enqueueTab(tabId, async () => {
    const sessions = previewRules.byTab.get(tabId);
    if (sessions?.size && api.declarativeNetRequest?.updateSessionRules) {
      await api.declarativeNetRequest.updateSessionRules({ removeRuleIds: [...sessions.values()] });
    }
    previewRules.byTab.delete(tabId);
    tabEpochs.delete(tabId);
  });
}

function updatePreviewHeaders(payload = {}, sender = {}) {
  const tabId = sender.tab?.id;
  return enqueueTab(Number.isInteger(tabId) ? tabId : -1, () => updatePreviewHeadersNow(payload, sender));
}

async function updatePreviewHeadersNow(payload = {}, sender = {}) {
  if (!api.declarativeNetRequest?.updateSessionRules) return { ok: false, error: "preview_headers_unavailable" };
  const tabId = sender.tab?.id;
  if (!Number.isInteger(tabId)) return { ok: false, error: "preview_source_tab_required" };
  const previewSessionId = typeof payload.previewSessionId === "string" ? payload.previewSessionId.trim().slice(0, 200) : "";
  if (!previewSessionId) return { ok: false, error: "preview_session_required" };
  const epoch = tabEpochs.get(tabId) || 0;
  const sessions = previewRules.byTab.get(tabId) || new Map();
  const previousRuleId = sessions.get(previewSessionId);
  const headers = Object.fromEntries(Object.entries(payload.headers || {}).filter(([key, value]) => ["referer", "origin", "authorization", "cookie", "user-agent"].includes(key.toLowerCase()) && typeof value === "string" && value));
  if (payload.action === "clear" || !payload.url || !Object.keys(headers).length) {
    if (previousRuleId) await api.declarativeNetRequest.updateSessionRules({ removeRuleIds: [previousRuleId] });
    const nextSessions = new Map(sessions);
    nextSessions.delete(previewSessionId);
    if (nextSessions.size) previewRules.byTab.set(tabId, nextSessions); else previewRules.byTab.delete(tabId);
    return { ok: true };
  }
  let origin; try { origin = new URL(payload.url).origin; } catch (_) { return { ok: false, error: "preview_url_invalid" }; }
  const candidate = await candidateFor(tabId, payload.candidateId);
  let candidateOrigin;
  try { candidateOrigin = new URL(candidate?.url || "").origin; } catch (_) {}
  if (!candidate || candidateOrigin !== origin) return { ok: false, error: "preview_candidate_mismatch" };
  const regexFilter = `^${origin.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:/|$)`;
  const requestHeaders = Object.entries(headers).map(([header, value]) => ({ header: header.replace(/^(.)/, match => match.toUpperCase()), operation: "set", value }));
  const ruleId = previewRules.nextId++;
  await api.declarativeNetRequest.updateSessionRules({ removeRuleIds: previousRuleId ? [previousRuleId] : [], addRules: [{ id: ruleId, priority: 1, action: { type: "modifyHeaders", requestHeaders }, condition: { regexFilter, resourceTypes: ["media", "xmlhttprequest", "image"], tabIds: [tabId] } }] });
  if ((tabEpochs.get(tabId) || 0) !== epoch) {
    await api.declarativeNetRequest.updateSessionRules({ removeRuleIds: [ruleId] });
    return { ok: false, error: "preview_tab_cleared" };
  }
  const nextSessions = new Map(sessions);
  nextSessions.set(previewSessionId, ruleId);
  previewRules.byTab.set(tabId, nextSessions);
  return { ok: true };
}

return { clearPreviewHeadersForTab, updatePreviewHeaders };
}
