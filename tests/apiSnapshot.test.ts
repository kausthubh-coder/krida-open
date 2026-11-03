/// <reference types="vite/client" />
import { expect, test } from "vitest";
import snapshot from "./api-snapshot.json";

/*
 * The live frontend calls Convex functions by name with the arguments it was built with. This lists every public
 * query, mutation and action with its argument validator, and fails when one disappears, changes kind, loses or
 * changes an argument, or gains a required one. New functions and new optional arguments are fine.
 *
 * After adding something on purpose, record it: UPDATE_API_SNAPSHOT=1 npx vitest run tests/apiSnapshot.test.ts -u
 */

type Entry = { kind: "query" | "mutation" | "action"; args: Record<string, unknown> | "any" };
type Field = { fieldType: unknown; optional: boolean };

const modules = import.meta.glob(["../convex/**/*.ts", "!../convex/**/*.d.ts", "!../convex/_generated/**"]);

async function publicApi() {
  const api: Record<string, Entry> = {};
  for (const [path, load] of Object.entries(modules)) {
    const name = path.replace(/^\.\.\/convex\//, "").replace(/\.ts$/, "");
    const mod = (await load()) as Record<string, any>;
    for (const [exported, fn] of Object.entries(mod)) {
      if (typeof fn !== "function" || !fn.isPublic || typeof fn.exportArgs !== "function") continue;
      if (!(fn.isQuery || fn.isMutation || fn.isAction)) continue;
      const args = JSON.parse(fn.exportArgs());
      api[`${name}:${exported}`] = {
        kind: fn.isQuery ? "query" : fn.isMutation ? "mutation" : "action",
        args: args.type === "object" ? args.value : "any",
      };
    }
  }
  return Object.fromEntries(Object.entries(api).sort(([a], [b]) => a.localeCompare(b)));
}

const known = snapshot as Record<string, Entry>;

test("every public function validates its arguments", async () => {
  const api = await publicApi();
  expect(Object.keys(api).length).toBeGreaterThan(50);
  expect(Object.entries(api).filter(([, e]) => e.args === "any").map(([name]) => name)).toEqual([]);
});

test("public functions stay compatible with the live frontend", async () => {
  const api = await publicApi();
  const problems: string[] = [];
  for (const [name, was] of Object.entries(known)) {
    const now = api[name];
    if (!now) {
      problems.push(`${name} was removed`);
      continue;
    }
    if (now.kind !== was.kind) problems.push(`${name} changed from a ${was.kind} to a ${now.kind}`);
    if (now.args === "any" || was.args === "any") continue;
    const before = was.args as Record<string, Field>;
    const after = now.args as Record<string, Field>;
    for (const [arg, field] of Object.entries(before)) {
      if (!after[arg]) problems.push(`${name} lost its ${arg} argument`);
      else if (JSON.stringify(after[arg]) !== JSON.stringify(field)) problems.push(`${name} changed its ${arg} argument`);
    }
    for (const [arg, field] of Object.entries(after))
      if (!before[arg] && !field.optional) problems.push(`${name} gained a required ${arg} argument`);
  }
  expect(problems).toEqual([]);
  if (process.env.UPDATE_API_SNAPSHOT) await expect(`${JSON.stringify(api, null, 2)}\n`).toMatchFileSnapshot("./api-snapshot.json");
});

test("no cron calls Simkl", async () => {
  const { default: crons } = (await import("../convex/crons")) as { default: { crons: Record<string, { name: string }> } };
  const targets = Object.values(crons.crons).map((c) => c.name);
  expect(targets.length).toBeGreaterThan(0);
  expect(targets.filter((name) => /^simkl[:/.]/.test(name))).toEqual([]);
});
