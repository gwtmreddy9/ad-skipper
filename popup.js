const $ = (id) => document.getElementById(id);

chrome.storage.sync.get({ enabled: true, debug: false }, (s) => {
  $('enabled').checked = s.enabled;
  $('debug').checked = s.debug;
});

chrome.declarativeNetRequest.getEnabledRulesets((ids) => {
  $('network').checked = ids.includes('ad_domains');
});

chrome.storage.local.get({ breaks: 0, adSeconds: 0 }, (s) => {
  $('breaks').textContent = s.breaks;
  $('saved').textContent = Math.round(s.adSeconds / 60);
});

$('enabled').onchange = (e) => chrome.storage.sync.set({ enabled: e.target.checked });
$('debug').onchange = (e) => chrome.storage.sync.set({ debug: e.target.checked });
$('network').onchange = (e) =>
  chrome.declarativeNetRequest.updateEnabledRulesets(
    e.target.checked ? { enableRulesetIds: ['ad_domains'] } : { disableRulesetIds: ['ad_domains'] }
  );
