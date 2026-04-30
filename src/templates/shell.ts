export function renderShell(
  title: string,
  nonce: string,
  parentUrl: string,
): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${escapeHtml(title)}</title>
  <link
    rel="stylesheet"
    href="https://cdn.jsdelivr.net/npm/github-markdown-css@5/github-markdown-dark.min.css"
    crossorigin="anonymous"
  />
  <link
    rel="stylesheet"
    href="https://cdn.jsdelivr.net/npm/highlight.js@11/styles/github-dark.min.css"
    crossorigin="anonymous"
  />
  <style nonce="${nonce}">
    * { box-sizing: border-box; margin: 0; padding: 0; }

    body {
      background: #0d1117;
      color: #e6edf3;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif;
      line-height: 1.6;
    }

    .container {
      max-width: 900px;
      margin: 0 auto;
      padding: 2rem 1.5rem;
    }

    .back-link {
      display: inline-block;
      color: #58a6ff;
      text-decoration: none;
      margin-bottom: 1rem;
      font-size: 0.875rem;
    }
    .back-link:hover { text-decoration: underline; }

    .page-title {
      font-size: 1.75rem;
      font-weight: 600;
      margin-bottom: 1.5rem;
      padding-bottom: 0.75rem;
      border-bottom: 1px solid #30363d;
    }

    .markdown-body {
      background: transparent;
    }

    .status-banner {
      position: fixed;
      top: 0;
      left: 0;
      right: 0;
      background: #1f6feb;
      color: #fff;
      text-align: center;
      padding: 0.25rem;
      font-size: 0.75rem;
      transform: translateY(-100%);
      transition: transform 0.3s ease;
      z-index: 1000;
    }
    .status-banner.visible { transform: translateY(0); }
  </style>
</head>
<body>
  <div class="status-banner" id="status"></div>
  <div class="container">
    <a class="back-link" href="${escapeHtml(parentUrl)}">&larr; Back</a>
    <h1 class="page-title">${escapeHtml(title)}</h1>
    <div class="markdown-body" id="content">
      <p style="color:#8b949e;">Loading&hellip;</p>
    </div>
  </div>

  <script nonce="${nonce}" type="module">
    import { marked } from 'https://cdn.jsdelivr.net/npm/marked@15/lib/marked.esm.js';
    import mermaid from 'https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.esm.min.mjs';
    import hljs from 'https://cdn.jsdelivr.net/npm/highlight.js@11/+esm';
    import DOMPurify from 'https://cdn.jsdelivr.net/npm/dompurify@3/+esm';

    mermaid.initialize({ startOnLoad: false, theme: 'dark' });

    const renderer = new marked.Renderer();
    renderer.code = function ({ text, lang }) {
      if (lang === 'mermaid') {
        return '<pre class="mermaid">' + escapeForHtml(text) + '</pre>';
      }
      const highlighted = lang && hljs.getLanguage(lang)
        ? hljs.highlight(text, { language: lang }).value
        : hljs.highlightAuto(text).value;
      return '<pre><code class="hljs">' + highlighted + '</code></pre>';
    };

    marked.setOptions({ renderer });

    function escapeForHtml(str) {
      return str
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
    }

    const contentEl = document.getElementById('content');
    const statusEl = document.getElementById('status');

    // Derive API and SSE URLs: /plans/foo → /api/plans/foo.md
    // (works for any source-prefix depth, e.g. /claude/plans/foo → /api/claude/plans/foo.md)
    const pagePath = window.location.pathname;
    const apiUrl = '/api' + pagePath + '.md';
    const sseUrl = '/events' + pagePath + '.md';

    function showStatus(message) {
      statusEl.textContent = message;
      statusEl.classList.add('visible');
      setTimeout(() => statusEl.classList.remove('visible'), 2000);
    }

    async function renderMarkdown() {
      try {
        const res = await fetch(apiUrl);
        if (!res.ok) throw new Error('Failed to fetch: ' + res.status);
        const md = await res.text();
        const html = await marked.parse(md);
        const clean = DOMPurify.sanitize(html, {
          ADD_TAGS: ['pre'],
          ADD_ATTR: ['class'],
        });
        contentEl.innerHTML = clean;

        // Render mermaid diagrams and collect errors
        const errors = [];
        const mermaidEls = contentEl.querySelectorAll('.mermaid');
        for (const el of mermaidEls) {
          try {
            await mermaid.run({ nodes: [el] });
          } catch (err) {
            errors.push(String(err.message || err));
          }
        }

        if (errors.length > 0) {
          contentEl.setAttribute('data-render-status', 'error');
          contentEl.setAttribute('data-render-errors', JSON.stringify(errors));
        } else {
          contentEl.setAttribute('data-render-status', 'ok');
          contentEl.removeAttribute('data-render-errors');
        }
      } catch (err) {
        contentEl.innerHTML = '<p style="color:#f85149;">Error loading content: '
          + escapeForHtml(String(err.message)) + '</p>';
        contentEl.setAttribute('data-render-status', 'error');
        contentEl.setAttribute('data-render-errors', JSON.stringify([String(err.message)]));
      }
    }

    // Initial render
    await renderMarkdown();

    // SSE live reload
    const source = new EventSource(sseUrl);
    source.onmessage = async () => {
      showStatus('Updating...');
      await renderMarkdown();
    };
    source.onerror = () => {
      showStatus('Connection lost. Reconnecting...');
    };
  </script>
</body>
</html>`;
}

function escapeHtml(text: string) {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}
