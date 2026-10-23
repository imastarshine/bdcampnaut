const TOKEN = 'REPLACE_WITH_A_RANDOM_STRING';

function doGet(e) {
  const p = (e && e.parameter) || {};
  if (p.t !== TOKEN) return out({ error: 'forbidden' });

  const since = Number(p.since) || (Date.now() - 3 * 24 * 3600 * 1000);
  const threads = GmailApp.search('(from:bandcamp.com OR subject:"Your download from") after:' + Math.floor(since / 1000), 0, 50);

  const seen = {};
  const links = [];
  const re = /https:\/\/bandcamp\.com\/download\?[^\s"'<>\)\]]+/g;

  threads.forEach(function (th) {
    th.getMessages().forEach(function (m) {
      const d = m.getDate().getTime();
      if (d < since) return;
      const body = (m.getBody() || '') + ' ' + (m.getPlainBody() || '');
      (body.match(re) || []).forEach(function (raw) {
        const url = raw.replace(/&amp;/g, '&').replace(/[.,;]+$/, '');
        if (seen[url]) return;
        seen[url] = 1;
        links.push({ url: url, date: d, subject: m.getSubject() });
      });
    });
  });
  return out({ links: links });
}

function out(o) {
  return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON);
}

function authorize() {
  GmailApp.getInboxThreads(0, 1);
}
