import { describe, expect, test } from "vitest";
import { scrollKey } from "../src/app/scroll";

describe("scrollKey", () => {
  test("pages opened by loading them are kept apart by address", () => {
    // Home scrolled down, then a title opened from a pasted link: both have React Router's key "default".
    expect(scrollKey({ key: "default", pathname: "/", search: "" })).toBe("default /");
    expect(scrollKey({ key: "default", pathname: "/title/movie/tt1254207", search: "" })).toBe("default /title/movie/tt1254207");
    expect(scrollKey({ key: "default", pathname: "/search", search: "?q=dune" })).toBe("default /search?q=dune");
  });

  test("pages reached inside the app are kept by their history entry", () => {
    expect(scrollKey({ key: "x7k2p1", pathname: "/title/movie/tt1254207", search: "" })).toBe("x7k2p1");
  });
});
