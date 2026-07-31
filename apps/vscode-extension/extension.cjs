const childProcess = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vscode = require("vscode");

function providerForAppName(appName) {
  return appName.toLowerCase().includes("cursor") ? "cursor" : "vscode";
}

function workspaceRoot() {
  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || os.homedir();
}

function createEmitter(provider, sessionId) {
  const cli = path.join(os.homedir(), ".local", "bin", "memora");
  let dataRoot;
  try {
    dataRoot = fs.readFileSync(path.join(os.homedir(), ".config", "memora", "data-root"), "utf8").trim();
  } catch {
    dataRoot = undefined;
  }
  return (hookEventName, detail = {}) => {
    const cwd = workspaceRoot();
    const child = childProcess.spawn(cli, ["local", "hook", "--provider", provider], {
      cwd,
      env: { ...process.env, ...(dataRoot ? { MEMORA_LOCAL_DATA_DIR: dataRoot } : {}) },
      stdio: ["pipe", "ignore", "ignore"],
    });
    child.on("error", () => undefined);
    child.stdin.end(JSON.stringify({
      session_id: sessionId,
      hook_event_name: hookEventName,
      cwd,
      editor: vscode.env.appName,
      ...detail,
    }));
  };
}

function activate(context) {
  const provider = providerForAppName(vscode.env.appName);
  const sessionId = `${provider}:${crypto.randomUUID()}`;
  const emit = createEmitter(provider, sessionId);

  emit("workspace_opened", {
    workspace_folders: (vscode.workspace.workspaceFolders || []).map((folder) => folder.name),
  });

  context.subscriptions.push(
    vscode.workspace.onDidSaveTextDocument((document) => emit("document_saved", {
      path: vscode.workspace.asRelativePath(document.uri, false),
      language_id: document.languageId,
      dirty: document.isDirty,
    })),
    vscode.window.onDidOpenTerminal((terminal) => emit("terminal_opened", { terminal_name: terminal.name })),
    vscode.window.onDidCloseTerminal((terminal) => emit("terminal_closed", { terminal_name: terminal.name })),
    vscode.workspace.onDidChangeWorkspaceFolders((event) => emit("workspace_folders_changed", {
      added: event.added.map((folder) => folder.name),
      removed: event.removed.map((folder) => folder.name),
    })),
    vscode.commands.registerCommand("memoraLocal.status", () => {
      void vscode.window.showInformationMessage(`Memora Local is recording ${provider} workspace evidence.`);
    }),
  );

  return { provider, sessionId };
}

function deactivate() {}

module.exports = { activate, deactivate, providerForAppName };
