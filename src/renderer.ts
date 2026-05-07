// `page.evaluate` callbacks run in the Playwright browser context where
// `document` is defined. Scope DOM types to this file so tsc is happy.
/// <reference lib="dom" />

import { stat } from "node:fs/promises";
import { chromium, type Browser, type BrowserContext } from "playwright";

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
  // Shared in-flight launch promise so concurrent ensureBrowser() callers
  // converge on a single chromium.launch(). Each launch registers a Mach
  // service on macOS; without this, a launch race leaks registrations the
  // parent never releases (issue #22).
  private launchPromise: Promise<Browser> | undefined;
  private cache = new Map<string, RenderResult>();
  private baseUrl: string;

  constructor(baseUrl: string) {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
  }

  private async ensureBrowser(): Promise<Browser> {
    if (this.browser?.isConnected()) {
      return this.browser;
    }
    if (!this.launchPromise) {
      console.log("[renderer] launching chromium");
      // Self-referential token: the promise compares itself against
      // `this.launchPromise` so disconnect / launch-failure handlers can
      // tell whether a *later* launch has already replaced them before
      // clearing the slot.
      const launching: Promise<Browser> = chromium.launch({ headless: true })
        .then((browser) => {
          browser.on("disconnected", () => {
            console.log("[renderer] browser disconnected");
            if (this.browser === browser) {
              this.browser = undefined;
            }
            if (this.launchPromise === launching) {
              this.launchPromise = undefined;
            }
          });
          this.browser = browser;
          return browser;
        })
        .catch((error: unknown) => {
          // A failed launch must not leave a rejected promise that future
          // callers re-await.
          if (this.launchPromise === launching) {
            this.launchPromise = undefined;
          }
          throw error;
        });
      this.launchPromise = launching;
    }
    return this.launchPromise;
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
    // Per-render context releases Playwright-internal context state
    // deterministically when closed, even though the browser process is
    // shared across renders.
    const context: BrowserContext = await browser.newContext();
    const page = await context.newPage();

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
      // Closing the context closes its pages — no separate page.close().
      // Swallow close-time errors so a try-block throw isn't masked by a
      // disconnect-during-close.
      try {
        await context.close();
      } catch (closeError: unknown) {
        console.warn("[renderer] context close failed:", String(closeError));
      }
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
    // If a launch is mid-flight, await it (swallowing rejection) before
    // clearing the slot — otherwise the .then handler runs after we've
    // released our reference and assigns this.browser to a Browser we
    // never close, defeating the dispose contract.
    const pending = this.launchPromise;
    const browser =
      this.browser ??
      (pending
        ? await pending.catch(() => undefined as Browser | undefined)
        : undefined);
    this.browser = undefined;
    this.launchPromise = undefined;
    await browser?.close();
  }
}
