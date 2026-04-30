export type ListingMode =
  | { kind: "rootIndex"; sources: string[] }
  | { kind: "sourceRoot" }
  | { kind: "subDir"; parentUrl: string };

export function renderListingPage(
  title: string,
  nonce: string,
  mode: ListingMode,
): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${escapeHtml(title)}</title>
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

    /* Source cards (root index) */
    .source-grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(250px, 1fr));
      gap: 1rem;
    }

    .source-card {
      display: block;
      padding: 1.25rem;
      background: #161b22;
      border: 1px solid #30363d;
      border-radius: 6px;
      color: #e6edf3;
      text-decoration: none;
      transition: border-color 0.15s ease, background 0.15s ease;
    }
    .source-card:hover {
      border-color: #58a6ff;
      background: #1c2331;
    }
    .source-card-name {
      font-size: 1.125rem;
      font-weight: 600;
      color: #58a6ff;
    }
    .source-card-path {
      font-size: 0.8125rem;
      color: #8b949e;
      margin-top: 0.25rem;
    }

    /* File listing table */
    .file-table {
      width: 100%;
      border-collapse: collapse;
    }
    .file-table th {
      text-align: left;
      padding: 0.5rem 0.75rem;
      border-bottom: 1px solid #30363d;
      color: #8b949e;
      font-size: 0.8125rem;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.05em;
    }
    .file-table td {
      padding: 0.625rem 0.75rem;
      border-bottom: 1px solid #21262d;
      font-size: 0.9375rem;
    }
    .file-table tr:hover td {
      background: #161b22;
    }
    .file-table a {
      color: #58a6ff;
      text-decoration: none;
    }
    .file-table a:hover { text-decoration: underline; }
    .file-table .meta {
      color: #8b949e;
      font-size: 0.8125rem;
    }

    .empty-state {
      text-align: center;
      padding: 3rem 1rem;
      color: #8b949e;
    }
  </style>
</head>
<body>
  <div class="container">
    ${renderBackLink(mode)}
    <h1 class="page-title">${escapeHtml(title)}</h1>
    <div id="listing">
      <p style="color:#8b949e;">Loading&hellip;</p>
    </div>
  </div>

  <script nonce="${nonce}">
    (function () {
      var listingEl = document.getElementById('listing');

      function escapeForHtml(str) {
        return str
          .replace(/&/g, '&amp;')
          .replace(/</g, '&lt;')
          .replace(/>/g, '&gt;')
          .replace(/"/g, '&quot;');
      }

      ${mode.kind === "rootIndex" ? renderRootIndexScript(mode.sources) : renderFileListingScript()}
    })();
  </script>
</body>
</html>`;
}

function renderRootIndexScript(sources: string[]) {
  const sourcesJson = JSON.stringify(sources);
  return `
      var sources = ${sourcesJson};
      var html = '<div class="source-grid">';
      for (var i = 0; i < sources.length; i++) {
        html += '<a class="source-card" href="/' + sources[i] + '/">'
          + '<div class="source-card-name">' + escapeForHtml(sources[i]) + '</div>'
          + '</a>';
      }
      html += '</div>';
      if (sources.length === 0) {
        html = '<div class="empty-state">No sources configured.</div>';
      }
      listingEl.innerHTML = html;
  `;
}

function renderFileListingScript() {
  return `
      function formatRelativeTime(dateStr) {
        var date = new Date(dateStr);
        var now = Date.now();
        var diffMs = now - date.getTime();
        var diffSec = Math.floor(diffMs / 1000);
        var diffMin = Math.floor(diffSec / 60);
        var diffHr = Math.floor(diffMin / 60);
        var diffDay = Math.floor(diffHr / 24);

        if (diffSec < 60) return 'just now';
        if (diffMin < 60) return diffMin + (diffMin === 1 ? ' minute ago' : ' minutes ago');
        if (diffHr < 24) return diffHr + (diffHr === 1 ? ' hour ago' : ' hours ago');
        if (diffDay < 30) return diffDay + (diffDay === 1 ? ' day ago' : ' days ago');
        return date.toLocaleDateString();
      }

      function formatSize(bytes) {
        if (bytes < 1024) return bytes + ' B';
        if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
        return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
      }

      // Trim a trailing slash from the current pathname so it can be
      // composed with the API prefix uniformly. Sub-listing pages live
      // at e.g. '/plans/sub/' but the API expects '/api/plans/sub'.
      var pathnameNoTrail = window.location.pathname.replace(/\\/+$/, '');
      var apiUrl = '/api' + pathnameNoTrail + '/';

      fetch(apiUrl)
        .then(function (res) {
          if (!res.ok) throw new Error('Failed to fetch: ' + res.status);
          return res.json();
        })
        .then(function (entries) {
          if (!entries || entries.length === 0) {
            listingEl.innerHTML = '<div class="empty-state">No files found.</div>';
            return;
          }
          var html = '<table class="file-table">'
            + '<thead><tr><th>Name</th><th>Modified</th><th>Size</th></tr></thead>'
            + '<tbody>';
          for (var i = 0; i < entries.length; i++) {
            var e = entries[i];
            // The server supplies entry.path as an absolute URL path
            // anchored at the source prefix, e.g. '/plans/sub/foo.md'.
            // For dirs we add a trailing slash and skip the .md strip;
            // for files we strip the .md suffix to get the clean URL.
            var href, displayName, sizeCell;
            if (e.kind === 'dir') {
              href = e.path + '/';
              displayName = e.name + '/';
              sizeCell = '';
            } else {
              href = e.path.endsWith('.md') ? e.path.slice(0, -3) : e.path;
              displayName = e.name;
              sizeCell = escapeForHtml(formatSize(e.size));
            }
            html += '<tr>'
              + '<td><a href="' + escapeForHtml(href) + '">' + escapeForHtml(displayName) + '</a></td>'
              + '<td class="meta">' + escapeForHtml(formatRelativeTime(e.modified)) + '</td>'
              + '<td class="meta">' + sizeCell + '</td>'
              + '</tr>';
          }
          html += '</tbody></table>';
          listingEl.innerHTML = html;
        })
        .catch(function (err) {
          listingEl.innerHTML = '<div class="empty-state" style="color:#f85149;">'
            + 'Error loading files: ' + escapeForHtml(String(err.message))
            + '</div>';
        });
  `;
}

function renderBackLink(mode: ListingMode): string {
  switch (mode.kind) {
    case "rootIndex":
      return "";
    case "subDir":
      return `<a class="back-link" href="${escapeHtml(mode.parentUrl)}">&larr; Parent directory</a>`;
    case "sourceRoot":
      return '<a class="back-link" href="/">&larr; All sources</a>';
  }
}

function escapeHtml(text: string) {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}
