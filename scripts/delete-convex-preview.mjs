import { pathToFileURL } from "node:url";

// Convex keeps a preview for 5 days on the free plan, and every one counts toward the team's 40 deployments
// (shared with its other projects). Deleting a branch's preview when its PR closes keeps room for open PRs.
// Usage: CONVEX_TEAM_TOKEN=… node scripts/delete-convex-preview.mjs <branch>

const API = "https://api.convex.dev/v1";
// Krida's Convex project.
const PROJECT_ID = 3162579;

/** The preview deployments built from `branch`. Never production or dev, whatever the list says. */
export function previewsFor(deployments, branch) {
  return deployments.filter((d) => d.deploymentType === "preview" && d.previewIdentifier === branch);
}

async function api(token, path, init) {
  const res = await fetch(`${API}${path}`, { ...init, headers: { Authorization: `Bearer ${token}` } });
  const body = await res.text();
  if (!res.ok) throw new Error(`${init?.method ?? "GET"} ${path}: ${res.status} ${body}`);
  // Deleting answers 200 with an empty body.
  return body ? JSON.parse(body) : null;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const branch = process.argv[2];
  const token = process.env.CONVEX_TEAM_TOKEN;
  if (!branch) throw new Error("Usage: delete-convex-preview.mjs <branch>");
  if (!token) {
    console.log("No CONVEX_TEAM_TOKEN; Convex deletes the preview itself after 5 days.");
    process.exit(0);
  }
  const previews = previewsFor(await api(token, `/projects/${PROJECT_ID}/list_deployments`), branch);
  if (previews.length === 0) console.log(`No Convex preview for ${branch}.`);
  for (const { name } of previews) {
    await api(token, `/deployments/${name}/delete`, { method: "POST" });
    console.log(`Deleted ${name}, the Convex preview for ${branch}.`);
  }
}
