// ── OAuth 토큰 발급 ──────────────────────────────────────────────────────────
function getAuthToken(interactive = true) {
  return new Promise((resolve, reject) => {
    if (!interactive) {
      chrome.identity.getAuthToken({ interactive: false }, token => {
        if (chrome.runtime.lastError || !token) reject(new Error('no cached token'));
        else resolve(token);
      });
      return;
    }
    // interactive: 캐시 먼저, 없으면 팝업
    chrome.identity.getAuthToken({ interactive: false }, token => {
      if (!chrome.runtime.lastError && token) return resolve(token);
      chrome.identity.getAuthToken({ interactive: true }, token2 => {
        if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
        else resolve(token2);
      });
    });
  });
}


// ── 메시지 리스너 ─────────────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type !== 'GET_AUTH_TOKEN') return false;

  (async () => {
    try {
      const token = await getAuthToken(msg.interactive !== false);
      sendResponse({ token });
    } catch (e) {
      sendResponse({ error: e.message });
    }
  })();

  return true;
});
