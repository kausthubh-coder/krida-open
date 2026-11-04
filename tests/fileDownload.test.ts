import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, expect, test, vi } from "vitest";
import { ExternalPlayersFor } from "../src/features/play/externalPlayers";

afterEach(() => vi.unstubAllGlobals());

test("a resolved file link offers a download anchor beside copy link", () => {
  vi.stubGlobal("navigator", { userAgent: "Windows", maxTouchPoints: 0 });
  const markup = renderToStaticMarkup(createElement(ExternalPlayersFor, {
    title: "Film", link: { url: "https://cdn.example/file.mp4", loading: false, load: () => {} },
  }));
  expect(markup).toContain('href="https://cdn.example/file.mp4" download=""');
  expect(markup).toContain("Download file");
  expect(markup.indexOf("Copy link")).toBeLessThan(markup.indexOf("Download file"));
});

test("no file link offers no download action", () => {
  expect(renderToStaticMarkup(createElement(ExternalPlayersFor, {
    title: "Film", link: { loading: false, load: () => {} },
  }))).toBe("");
});
