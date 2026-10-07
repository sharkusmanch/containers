import { createApi } from "./api.js";
import { startApp } from "./main.js";

startApp({
  doc: document,
  api: createApi(),
  storage: window.localStorage,
  nav: navigator,
  win: window,
});
