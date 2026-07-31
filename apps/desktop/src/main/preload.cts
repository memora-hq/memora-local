import { contextBridge, ipcRenderer, webUtils } from "electron";

contextBridge.exposeInMainWorld("memoraLocal", {
  listSessions: () => ipcRenderer.invoke("local:list"),
  getSession: (sessionId: string) => ipcRenderer.invoke("local:session", sessionId),
  revealEvents: (sessionId: string, eventIds: string[]) => ipcRenderer.invoke("local:reveal", sessionId, eventIds),
  verifySession: (sessionId: string) => ipcRenderer.invoke("local:verify", sessionId),
  exportSession: (sessionId: string, disclose: boolean) => ipcRenderer.invoke("local:export", { sessionId, disclose }),
  exportReceipt: (sessionId: string, bundle?: unknown) => ipcRenderer.invoke("local:exportReceipt", { sessionId, bundle }),
  chooseBundle: () => ipcRenderer.invoke("local:chooseBundle"),
  verifyBundle: (path: string) => ipcRenderer.invoke("local:verifyBundle", path),
  // Electron no longer exposes File.path to the renderer; this is the supported way to turn a
  // dropped file into a path the main process can open.
  pathForFile: (file: File) => webUtils.getPathForFile(file),
  listSigners: () => ipcRenderer.invoke("signers:list"),
  labelSigner: (address: string, label: string) => ipcRenderer.invoke("signers:label", address, label),
  forgetSigner: (address: string) => ipcRenderer.invoke("signers:forget", address),
  installCli: () => ipcRenderer.invoke("cli:install"),
  getIntegrations: () => ipcRenderer.invoke("integrations:get"),
  configureIntegrations: (selected: string[]) => ipcRenderer.invoke("integrations:configure", selected),
  diagnoseIntegration: (provider: "codex" | "claude") => ipcRenderer.invoke("integrations:diagnose", provider),
  setReadingLevel: (level: string) => ipcRenderer.invoke("integrations:set-reading-level", level),
});
