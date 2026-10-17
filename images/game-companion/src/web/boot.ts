import { createApi } from "./api.js";
import { captureInstallPrompt, registerServiceWorker } from "./device.js";
import { startApp } from "./main.js";

// Before anything else: the browser's install offer can come at any time after the page loads.
const install = captureInstallPrompt(window);
registerServiceWorker(navigator);

startApp({
  doc: document,
  api: createApi(),
  storage: window.localStorage,
  session: window.sessionStorage,
  nav: navigator,
  win: window,
  install,
});
