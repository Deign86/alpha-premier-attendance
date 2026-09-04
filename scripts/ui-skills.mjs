#!/usr/bin/env node
// Minimal repo-wide ui-skills CLI (stdlib only, no dependencies).
// Mirrors `npx ui-skills` against https://www.ui-skills.com so every agent and
// dev in this repo can fetch UI design skills without installing anything.
// The official CLI is flaky under npx on some Windows PCs (silent exit 1 when
// its tsx loader fails to resolve); this script uses only global fetch.
const SITE_URL = process.env.UI_SKILLS_SITE_URL ?? "https://www.ui-skills.com";

const HELP = `ui-skills (repo shim)

Usage:
  node scripts/ui-skills.mjs start
  node scripts/ui-skills.mjs categories
  node scripts/ui-skills.mjs list [--category <topic>]
  node scripts/ui-skills.mjs get <slug|pathSlug>

Examples:
  node scripts/ui-skills.mjs list --category visual
  node scripts/ui-skills.mjs get baseline-ui
`;

async function fetchJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`GET ${url} -> ${res.status}`);
  return res.json();
}

async function fetchText(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`GET ${url} -> ${res.status}`);
  return res.text();
}

async function loadRegistry() {
  const data = await fetchJson(new URL("/skills/registry.json", SITE_URL).href);
  return { registry: data.registry ?? [], topics: data.topics ?? [] };
}

function resolveSkill(registry, input) {
  const norm = input.trim().toLowerCase();
  const exact = registry.find((e) => (e.pathSlug ?? "").toLowerCase() === norm);
  if (exact) return [exact];
  return registry.filter((e) => (e.slug ?? "").toLowerCase() === norm);
}

async function printSkill(pathSlug) {
  const url = `/skills/${pathSlug.split("/").map(encodeURIComponent).join("/")}/llms.txt`;
  process.stdout.write(await fetchText(new URL(url, SITE_URL).href));
}

async function main() {
  const [command = "", ...rest] = process.argv.slice(2);
  if (!command || command === "--help" || command === "-h" || command === "help") {
    process.stdout.write(HELP);
    return;
  }
  if (command === "start") {
    if (rest.length > 0) throw new Error("Too many arguments for start");
    const { registry } = await loadRegistry();
    const root = resolveSkill(registry, "ibelick/ui-skills-root")[0];
    if (!root) throw new Error("Skill not found: ui-skills-root");
    await printSkill(root.pathSlug);
    return;
  }
  if (command === "categories") {
    if (rest.length > 0) throw new Error("Too many arguments for categories");
    const { topics } = await loadRegistry();
    const slugs = topics.map((t) => (typeof t === "string" ? t : t.slug));
    process.stdout.write(`${slugs.join("\n")}\n`);
    return;
  }
  if (command === "list") {
    let category;
    if (rest.length === 2 && rest[0] === "--category") category = rest[1].toLowerCase();
    else if (rest.length > 0) throw new Error("Usage: list [--category <topic>]");
    const { registry, topics } = await loadRegistry();
    if (category && !topics.map((t) => (typeof t === "string" ? t : t.slug)).includes(category)) {
      throw new Error(`Unknown category: ${category}`);
    }
    const items = category
      ? registry.filter((s) => (s.topics ?? []).includes(category))
      : registry;
    if (category && items.length === 0) throw new Error(`No skills for category: ${category}`);
    const lines = items.map(
      (s) => `${s.pathSlug} — ${(s.topics ?? []).join(", ")} — ${(s.description ?? "").replace(/\s+/g, " ").trim()}`,
    );
    process.stdout.write(`${lines.join("\n")}\n`);
    return;
  }
  if (command === "get") {
    if (rest.length !== 1 || !rest[0]) throw new Error("Usage: get <slug|pathSlug>");
    const { registry } = await loadRegistry();
    const matches = resolveSkill(registry, rest[0]);
    if (matches.length === 0) throw new Error(`Skill not found: ${rest[0]}`);
    if (matches.length > 1) {
      process.stderr.write(`Ambiguous skill slug: ${rest[0]}\nCandidates:\n`);
      for (const m of matches) process.stderr.write(`- ${m.pathSlug}\n`);
      process.exitCode = 3;
      return;
    }
    await printSkill(matches[0].pathSlug);
    return;
  }
  throw new Error(`Unknown command: ${command}`);
}

main().catch((err) => {
  process.stderr.write(`ui-skills: ${err instanceof Error ? err.message : String(err)}\n`);
  if (process.exitCode === 0 || process.exitCode === undefined) process.exitCode = 1;
});
