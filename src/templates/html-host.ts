/**
 * Response-time wrapping for hosted `.html` pages. The file on disk is never
 * modified; the `/api/` raw route serves it untouched.
 */

/**
 * A page "has a doctype" when, after an optional BOM, whitespace and
 * comments, its first token is `<!doctype`. Anything else is a fragment.
 */
const DOCTYPE = /^﻿?(?:\s|<!--[\s\S]*?-->)*<!doctype/i;

/**
 * What claude.ai wraps a fragment Artifact page in at publish time. No
 * explicit `<html>`/`<head>`/`<body>`: the parser builds the tree, and the
 * fragment's own `<title>`, `<style>` and `<link>` still land in `<head>`.
 */
const SKELETON =
  '<!doctype html>\n<meta charset="utf-8">\n<meta name="viewport" content="width=device-width, initial-scale=1">\n';

/**
 * Reloads the page when anything in its directory changes. The SSE route
 * mirrors the viewer URL under `/events`.
 */
export const RELOAD_SCRIPT =
  "<script>new EventSource('/events' + location.pathname).onmessage = () => location.reload();</script>\n";

/**
 * Serve a fragment in standards mode, and append live reload to every page.
 * A page that already has a doctype keeps its bytes unchanged ahead of the
 * script.
 */
export function hostHtml(content: string): string {
  const page = DOCTYPE.test(content)
    ? content
    : SKELETON + content.replace(/^﻿/, "");
  return page + RELOAD_SCRIPT;
}
