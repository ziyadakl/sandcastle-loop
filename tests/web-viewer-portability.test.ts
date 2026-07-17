/**
 * Source-level portability guards for the Sandcastle lite WEB viewer.
 *
 * The page is served over a tailnet with NO guaranteed internet, so it must be
 * fully self-contained: no CDN scripts/styles/fonts, no `http(s)://` resource
 * links. These assertions run against the checked-in files (not a rendered
 * DOM) so a regression that reintroduces an external dependency fails here even
 * though it would "work" on a dev machine that happens to have internet.
 *
 * Sibling of tests/watch-viewer-portability.test.ts (the terminal viewer).
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const webDir = path.join(repoRoot, ".sandcastle/web");

const html = readFileSync(path.join(webDir, "index.html"), "utf8");
const css = readFileSync(path.join(webDir, "viewer.css"), "utf8");

describe("sandcastle lite web viewer portability", () => {
  it("has no external http(s) resource references in the HTML", () => {
    expect(html).not.toMatch(/https?:\/\//);
  });

  it("has no external http(s) references in the CSS (data: URIs are fine)", () => {
    // Inline data: URIs are self-contained; an embedded SVG legitimately carries
    // the `http://www.w3.org/2000/svg` XML NAMESPACE (an identifier, never
    // fetched). Strip data: URI bodies before asserting no real network links.
    const withoutDataUris = css.replace(/url\(\s*["']?data:[^)]*\)/g, "");
    expect(withoutDataUris).not.toMatch(/https?:\/\//);
  });

  it("references only same-dir viewer.js and viewer.css", () => {
    expect(html).toMatch(/<link[^>]+href=["']\.\/viewer\.css["']/);
    expect(html).toMatch(
      /<script[^>]+type=["']module["'][^>]+src=["']\.\/viewer\.js["']/,
    );
  });

  it("exposes the stable slot ids viewer.js populates", () => {
    const ids = [
      "run-title",
      "banner",
      "banner-dot",
      "banner-text",
      "banner-activity",
      "hosts-strip",
      "meta-iterations",
      "meta-branch",
      "pills",
      "active-list",
      "active-empty",
      "recent-list",
      "recent-empty",
      "recent-overflow",
      "recent-overflow-count",
    ];
    for (const id of ids) {
      expect(html, `missing #${id}`).toMatch(new RegExp(`id=["']${id}["']`));
    }
  });

  it("ships the render templates viewer.js clones", () => {
    for (const id of ["tpl-issue-row", "tpl-pill", "tpl-host-badge", "tpl-host-dot"]) {
      expect(html, `missing <template id=${id}>`).toMatch(
        new RegExp(`<template[^>]+id=["']${id}["']`),
      );
    }
  });

  it("is dark-first: sets viewport + dark theme-color meta", () => {
    expect(html).toMatch(/name=["']viewport["']/);
    expect(html).toMatch(/name=["']theme-color["'][^>]+content=["']#0b0b0b["']/);
  });
});
