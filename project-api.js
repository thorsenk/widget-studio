import {createBrowserProjectAPI} from './browser-project-api.js';
export const browserStorage = typeof document !== 'undefined' && document.body?.dataset.storage === 'browser';
export const savedLocation = browserStorage ? 'Saved in this browser' : 'Saved on this Mac';
const browserAPI = createBrowserProjectAPI(globalThis.indexedDB);
export function projectFetch(path, options) { return browserStorage ? browserAPI(path, options) : fetch(path, options); }
