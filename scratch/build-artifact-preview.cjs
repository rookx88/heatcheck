const fs = require('fs');

const ARTIFACT_PATH = 'C:/Users/sammy/AppData/Local/Temp/claude/c--Users-sammy-Downloads-SportsHeatCheck/59e4c7ff-1756-4fbf-a772-c5c4c53826c4/scratchpad/newsletter-email-preview.html';

let emailHtml = fs.readFileSync('scratch/newsletter-preview.html', 'utf8');

// Inline the logo as a data URI so it actually renders inside the artifact sandbox
// (which blocks all external image requests) instead of showing broken.
const logoB64 = fs.readFileSync('public/assets/images/heatchecks-logo-email.png').toString('base64');
emailHtml = emailHtml.split('https://heatchecks.io/assets/images/heatchecks-logo-email.png')
    .join('data:image/png;base64,' + logoB64);

// The unsubscribe placeholder isn't a real link in preview context.
emailHtml = emailHtml.split('{{{RESEND_UNSUBSCRIBE_URL}}}').join('#');

const chrome = `<title>Newsletter Preview</title>
<style>
  :root {
    --bg: #eef0f3;
    --surface: #ffffff;
    --surface-2: #f6f7f9;
    --border: #d8dce2;
    --text: #16181d;
    --text-muted: #6b7280;
    --text-faint: #9aa0aa;
    --accent: #ff5a2c;
    --accent-soft: #fff1ea;
    --accent-text: #b7371a;
    --shadow: 0 1px 2px rgba(16,18,22,0.04), 0 12px 32px rgba(16,18,22,0.10);
  }

  @media (prefers-color-scheme: dark) {
    :root:not([data-theme="light"]) {
      --bg: #0b0c0f;
      --surface: #17181d;
      --surface-2: #1d1f25;
      --border: #2b2d34;
      --text: #e9eaed;
      --text-muted: #9aa0aa;
      --text-faint: #6b7280;
      --accent: #ff7a45;
      --accent-soft: rgba(255,122,69,0.14);
      --accent-text: #ff9d6e;
      --shadow: 0 1px 2px rgba(0,0,0,0.3), 0 12px 32px rgba(0,0,0,0.45);
    }
  }
  :root[data-theme="dark"] {
    --bg: #0b0c0f;
    --surface: #17181d;
    --surface-2: #1d1f25;
    --border: #2b2d34;
    --text: #e9eaed;
    --text-muted: #9aa0aa;
    --text-faint: #6b7280;
    --accent: #ff7a45;
    --accent-soft: rgba(255,122,69,0.14);
    --accent-text: #ff9d6e;
    --shadow: 0 1px 2px rgba(0,0,0,0.3), 0 12px 32px rgba(0,0,0,0.45);
  }

  * { box-sizing: border-box; }

  body {
    background: var(--bg);
    color: var(--text);
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif;
    margin: 0;
    padding: 40px 20px 64px;
    min-height: 100vh;
  }

  .page {
    max-width: 700px;
    margin: 0 auto;
    display: flex;
    flex-direction: column;
    gap: 18px;
  }

  .masthead {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 12px;
    flex-wrap: wrap;
  }

  .masthead h1 {
    font-size: 15px;
    font-weight: 600;
    margin: 0;
    letter-spacing: -0.01em;
  }

  .masthead .path {
    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    font-size: 12px;
    color: var(--text-faint);
  }

  .banner {
    display: flex;
    align-items: center;
    gap: 10px;
    background: var(--accent-soft);
    border: 1px solid color-mix(in srgb, var(--accent) 35%, transparent);
    color: var(--accent-text);
    border-radius: 10px;
    padding: 10px 14px;
    font-size: 13px;
    line-height: 1.5;
  }

  .banner .dot {
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: var(--accent);
    flex: none;
  }

  .banner strong { font-weight: 600; }

  .client {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 14px;
    box-shadow: var(--shadow);
    overflow: hidden;
  }

  .client-header {
    padding: 16px 20px;
    border-bottom: 1px solid var(--border);
    display: flex;
    flex-direction: column;
    gap: 9px;
  }

  .meta-row {
    display: grid;
    grid-template-columns: 56px 1fr;
    gap: 10px;
    align-items: baseline;
    font-size: 13px;
  }

  .meta-label {
    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    font-size: 11px;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    color: var(--text-faint);
  }

  .meta-value { color: var(--text); }
  .meta-value.muted { color: var(--text-muted); }

  .subject-row .meta-value {
    font-size: 15px;
    font-weight: 600;
    letter-spacing: -0.01em;
    text-wrap: balance;
  }

  .frame-wrap {
    background: var(--surface-2);
  }

  iframe {
    display: block;
    width: 100%;
    height: 1100px;
    border: 0;
    background: transparent;
  }

  .footnote {
    font-size: 12px;
    color: var(--text-faint);
    text-align: center;
    padding: 4px 8px;
  }

  .footnote code {
    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    background: var(--surface-2);
    border: 1px solid var(--border);
    border-radius: 4px;
    padding: 1px 5px;
    font-size: 11px;
    color: var(--text-muted);
  }
</style>

<div class="page">
  <div class="masthead">
    <h1>Newsletter preview</h1>
    <span class="path">emails/NewsletterIssue.tsx</span>
  </div>

  <div class="banner">
    <span class="dot"></span>
    <span><strong>Sample data</strong> &mdash; no issue has been published yet. This is what the layout looks like, not a real send.</span>
  </div>

  <div class="client">
    <div class="client-header">
      <div class="meta-row">
        <span class="meta-label">From</span>
        <span class="meta-value muted">Heatchecks &lt;hello@heatchecks.io&gt;</span>
      </div>
      <div class="meta-row subject-row">
        <span class="meta-label">Subject</span>
        <span class="meta-value">He said he&rsquo;d never play a Game 7 in this building again. Tonight he has to.</span>
      </div>
      <div class="meta-row">
        <span class="meta-label">Design</span>
        <span class="meta-value muted">v4 &mdash; correct logo, inlined for preview</span>
      </div>
    </div>
    <div class="frame-wrap">
      <iframe title="Rendered email HTML" id="email-frame"></iframe>
    </div>
  </div>

  <p class="footnote">Rendered via <code>npm run email:preview</code> &middot; real sends use <code>npx tsx scripts/send-newsletter-issue.ts --week=&lt;key&gt; --dry-run</code></p>
</div>

<script>
  var emailHtml = ${JSON.stringify(emailHtml)};

  var frame = document.getElementById('email-frame');
  frame.srcdoc = emailHtml;
  frame.addEventListener('load', function () {
    try {
      var doc = frame.contentDocument;
      var h = doc.documentElement.scrollHeight;
      if (h && h > 0) frame.style.height = (h + 24) + 'px';
    } catch (e) {}
  });
</script>
`;

fs.writeFileSync(ARTIFACT_PATH, chrome);
console.log('Wrote artifact preview file, size:', chrome.length, 'bytes');
