"use strict";
const { contextBridge, ipcRenderer } = require("electron");
contextBridge.exposeInMainWorld(
  "aipet",
  Object.freeze({
    getSnapshot: () => ipcRenderer.invoke("aipet:snapshot"),
    getSpriteUsage: () => ipcRenderer.invoke("aipet:sprite-usage"),
    resetSpriteUsage: () => ipcRenderer.invoke("aipet:sprite-usage-reset"),
    reportSpriteUsage: (items) => ipcRenderer.invoke("aipet:sprite-usage-report", items),
    getSetup: (provider) => ipcRenderer.invoke("aipet:setup", provider),
    updateSettings: (patch) => ipcRenderer.invoke("aipet:settings", patch),
    setStartup: (enabled) => ipcRenderer.invoke("aipet:startup", enabled),
    openStudio: () => ipcRenderer.send("aipet:studio"),
    showPet: () => ipcRenderer.send("aipet:show"),
    bringHome: () => ipcRenderer.send("aipet:home"),
    hidePet: () => ipcRenderer.send("aipet:hide"),
    resumeAutomatic: () => ipcRenderer.send("aipet:auto"),
    menu: (provider) => ipcRenderer.send("aipet:menu", provider),
    interact: (action, provider) =>
      ipcRenderer.send("aipet:interact", action, provider),
    setHit: (hit) => ipcRenderer.send("aipet:hit", hit),
    drag: (phase) => ipcRenderer.send("aipet:drag", phase),
    preview: (state) => ipcRenderer.invoke("aipet:preview", state),
    onSnapshot: (callback) => {
      const listener = (_event, snapshot) => callback(snapshot);
      ipcRenderer.on("aipet:changed", listener);
      return () => ipcRenderer.removeListener("aipet:changed", listener);
    },
    onInteraction: (callback) => {
      const listener = (_event, action) => callback(action);
      ipcRenderer.on("aipet:interaction", listener);
      return () => ipcRenderer.removeListener("aipet:interaction", listener);
    },
  }),
);
