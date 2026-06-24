const assert = require("assert");
const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const cliSource = fs.readFileSync(path.join(root, "index.js"), "utf8");

for (const expected of [
  'id: "prism-api"',
  'name: "Prism API"',
  'baseUrl: "https://sub2api.558686.xyz/v1"',
  'model: "gpt-5.5"',
  'envKey: "PRISM_API_KEY"',
  'wireApi: "responses"',
]) {
  assert(cliSource.includes(expected), `CLI presets missing ${expected}`);
}

const desktopSource = fs.readFileSync(path.join(root, "src", "main.js"), "utf8");
for (const expected of [
  'id: "prism-api"',
  'name: "Prism API"',
  'baseUrl: "https://sub2api.558686.xyz/v1"',
  'model: "gpt-5.5"',
  'envKey: "PRISM_API_KEY"',
  'wireApi: "responses"',
]) {
  assert(desktopSource.includes(expected), `Desktop Codex presets missing ${expected}`);
}

const readme = fs.readFileSync(path.join(root, "README.md"), "utf8");
assert(readme.includes("| Prism API | `https://sub2api.558686.xyz/v1` | `responses` | `PRISM_API_KEY` |"));

console.log("preset tests passed");
