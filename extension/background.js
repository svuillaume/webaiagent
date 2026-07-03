'use strict';

// Open the side panel when the toolbar icon is clicked
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });

// CVE text-selection relay: content script → background → panel
chrome.runtime.onMessage.addListener((msg, sender) => {
  if (msg.type !== 'CVE_SELECTED' || !msg.cveId) return;
  const windowId = sender.tab?.windowId;
  if (!windowId) return;

  // Always store — panel reads this on open if it wasn't already open
  chrome.storage.session.set({ pendingCve: msg.cveId }, () => {
    // Try to forward to an already-open panel; if none is open, open one
    // (the panel's storage.session.get on load will pick up pendingCve)
    chrome.runtime.sendMessage({ type: 'CVE_SELECTED', cveId: msg.cveId }, () => {
      // sendMessage throws if no listener answered — that just means the panel
      // wasn't open yet; suppress the error and open it
      void chrome.runtime.lastError;
      chrome.sidePanel.open({ windowId });
    });
  });
});

// "Ask AI about selection" — right-click context menu, works on any selectable text
// including Chrome's built-in PDF viewer (contexts:['selection'] fires there too,
// unlike a content script, which can't attach inside the PDF renderer).
chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id:       'ask-ai-selection',
    title:    'Ask AI about selection',
    contexts: ['selection'],
  });
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId !== 'ask-ai-selection' || !info.selectionText) return;
  const windowId = tab?.windowId;
  if (!windowId) return;

  chrome.storage.session.set({ pendingSelection: info.selectionText }, () => {
    chrome.runtime.sendMessage({ type: 'TEXT_SELECTED', text: info.selectionText }, () => {
      void chrome.runtime.lastError; // panel not open yet — pendingSelection covers that
      chrome.sidePanel.open({ windowId });
    });
  });
});
