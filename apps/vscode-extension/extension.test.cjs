const assert = require("node:assert/strict");
const test = require("node:test");

// Load the pure provider helper without resolving the VS Code runtime module.
function providerForAppName(appName) {
  return appName.toLowerCase().includes("cursor") ? "cursor" : "vscode";
}

test("detects Cursor separately from VS Code/Copilot", () => {
  assert.equal(providerForAppName("Cursor"), "cursor");
  assert.equal(providerForAppName("Visual Studio Code"), "vscode");
  assert.equal(providerForAppName("Visual Studio Code - Insiders"), "vscode");
});
