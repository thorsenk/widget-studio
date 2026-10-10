/** Published projects live on this origin in this browser, separate from drafts. */
import {validateDocument} from './document.js';
import {exportBundleFiles} from './export.js';
import {zipFiles} from './zip.js';

const json = (value, status = 200) => new Response(JSON.stringify(value), {status, headers: {'Content-Type': 'application/json'}});
const failure = (message, status = 400) => Object.assign(Error(message), {status});
const result = request => new Promise((resolve, reject) => { request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
export function createBrowserProjectAPI(indexedDB, name = 'widget-studio-published-projects') {
  let opening;
  function database() {
    return opening ??= new Promise((resolve, reject) => {
      if (!indexedDB) { reject(Error('Browser storage is unavailable. Download your project JSON to keep your work.')); return; }
      const request = indexedDB.open(name, 1);
      request.onupgradeneeded = () => { request.result.createObjectStore('projects', {keyPath: 'id'}); request.result.createObjectStore('trash', {keyPath: 'key'}); };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }
  async function transaction(mode, work) {
    const db = await database(), tx = db.transaction(['projects', 'trash'], mode);
    const done = new Promise((resolve, reject) => { tx.oncomplete = resolve; tx.onabort = () => reject(tx.error || Error('Browser save was interrupted. Retry Save or download the project JSON.')); tx.onerror = () => {}; });
    try { const value = await work(tx.objectStore('projects'), tx.objectStore('trash')); await done; return value; }
    catch (error) { try { tx.abort(); } catch {} await done.catch(() => {}); throw error; }
  }
  return async function browserRequest(path, options = {}) {
    try {
      const method = options.method || 'GET';
      if (new TextEncoder().encode(options.body || '').length > 8 * 1024 * 1024) throw failure('Project is too large. Editable contents must fit within 8 MB.');
      const body = options.body ? JSON.parse(options.body) : {};
      if (path === '/api/export' && method === 'POST') return new Response(zipFiles(await exportBundleFiles(validateDocument(body.document))), {headers: {'Content-Type': 'application/zip'}});
      if (path === '/api/projects' && method === 'GET') return json(await transaction('readonly', async projects => ({projects: (await result(projects.getAll())).map(({id, name, createdAt, updatedAt, revision}) => ({id, name, createdAt, updatedAt, revision})).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)), location: 'Saved in this browser. Download project JSON for a portable backup.'})));
      if (path === '/api/trash' && method === 'GET') return json(await transaction('readonly', async (_, trash) => ({projects: (await result(trash.getAll())).map(({key, name, updatedAt}) => ({key, name, updatedAt}))})));
      if (path === '/api/projects' && method === 'POST') {
        const document = validateDocument(body.document);
        return json(await transaction('readwrite', async projects => {
          const previous = await result(projects.get(document.id)), revision = previous?.revision || 0;
          if ((body.revision || 0) !== revision) throw failure('This project changed in another window. Reopen it before saving, or save a copy.', 409);
          const now = new Date().toISOString(), record = {id: document.id, name: document.name, createdAt: previous?.createdAt || now, updatedAt: now, revision: revision + 1, document};
          await result(projects.put(record)); return record;
        }));
      }
      const project = path.match(/^\/api\/projects\/([^/]+)$/);
      if (project && ['GET', 'DELETE'].includes(method)) return json(await transaction(method === 'DELETE' ? 'readwrite' : 'readonly', async (projects, trash) => {
        const id = decodeURIComponent(project[1]), record = await result(projects.get(id));
        if (!record) throw failure('Project not found', 404);
        if (method === 'GET') return record;
        await result(trash.put({...record, key: crypto.randomUUID() + '.widget.json'})); await result(projects.delete(id)); return {removed: true};
      }));
      const restore = path.match(/^\/api\/trash\/([^/]+)\/restore$/);
      if (restore && method === 'POST') return json(await transaction('readwrite', async (projects, trash) => {
        const key = decodeURIComponent(restore[1]), previous = await result(trash.get(key));
        if (!previous) throw failure('Deleted project not found', 404);
        const document = validateDocument(previous.document);
        if (await result(projects.get(document.id))) { document.id = 'project-' + crypto.randomUUID(); document.name = document.name.slice(0, 110) + ' (restored copy)'; }
        const record = {id: document.id, name: document.name, createdAt: previous.createdAt, updatedAt: new Date().toISOString(), revision: previous.revision + 1, document};
        await result(projects.put(record)); await result(trash.delete(key)); return record;
      }));
      return json({error: 'Not found'}, 404);
    } catch (error) { return json({error: error.message || 'Browser storage failed. Retry Save or download project JSON.'}, error.status || 400); }
  };
}
