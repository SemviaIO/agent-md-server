// `page.evaluate` callbacks run in the Playwright browser context where
// `document` is defined. Scope DOM types to this file so tsc is happy.
/// <reference lib="dom" />

import { stat } from "node:fs/promises";
import { chromium, type Browser } from "playwright";

export interface RenderSuccess {
  status: "ok";
  html: string;
  mtimeMs: number;
}

export interface RenderError {
  status: "error";
  errors: string[];
  mtimeMs: number;
}

export type RenderResult = RenderSuccess | RenderError;

/**
 * Manages a warm Playwright browser instance for server-side rendering.
 * Renders pages via the server's own viewer URL, extracts the rendered HTML
 * and any Mermaid errors, and caches results by file mtime.
 */
export class Renderer {
  private browser: Browser | undefined;
  private cache = new Map<string, RenderResult>();
  private baseUrl: string;

  constructor(baseUrl: string) {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
  }

  private async ensureBrowser(): Promise<Browser> {
    if (!this.browser || !this.browser.isConnected()) {
      this.browser = await chromium.launch({ headless: true });
    }
    return this.browser;
  }

  /**
   * Render and validate a file. Returns cached result if mtime hasn't changed.
   * @param sourceName - The source name (e.g. "plans", "temp")
   * @param fileName - The file name without .md extension (e.g. "foo")
   * @param filePath - Absolute path to the .md file on disk
   */
  async render(
    sourceName: string,
    fileName: string,
    filePath: string,
  ): Promise<RenderResult> {
    const fileStat = await stat(filePath);
    const mtimeMs = fileStat.mtimeMs;

    const cached = this.cache.get(filePath);
    if (cached && cached.mtimeMs === mtimeMs) {
      return cached;
    }

    const browser = await this.ensureBrowser();
    const page = await browser.newPage();

    try {
      const viewerUrl = `${this.baseUrl}/${sourceName}/${fileName}`;
      await page.goto(viewerUrl, { waitUntil: "domcontentloaded" });

      // Wait for the render-status signal set by the viewer template
      await page.waitForSelector(
        '[data-render-status]',
        { timeout: 30_000 },
      );

      const renderStatus = await page.getAttribute(
        "#content",
        "data-render-status",
      );

      if (renderStatus === "error") {
        const errorText = await page.getAttribute(
          "#content",
          "data-render-errors",
        ) ?? "Unknown rendering error";

        const errors = JSON.parse(errorText) as string[];
        const result: RenderError = { status: "error", errors, mtimeMs };
        this.cache.set(filePath, result);
        return result;
      }

      const html = await page.evaluate(() => {
        return document.querySelector("#content")?.innerHTML ?? "";
      });

      const result: RenderSuccess = { status: "ok", html, mtimeMs };
      this.cache.set(filePath, result);
      return result;
    } finally {
      await page.close();
    }
  }

  /** Get a cached render result without re-rendering. */
  getCached(filePath: string): RenderResult | undefined {
    return this.cache.get(filePath);
  }

  /** Invalidate cache for a specific file. */
  invalidate(filePath: string): void {
    this.cache.delete(filePath);
  }

  async close(): Promise<void> {
    await this.browser?.close();
    this.browser = undefined;
  }
}
