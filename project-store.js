import { validateDocument } from './document.js';

export const STORAGE_KEY = 'custom-widget-studio.projects.v1';
const STORE_SCHEMA_VERSION = 1;
const MAX_PROJECTS = 100;

export class PersistenceError extends Error {
  constructor(message, code, cause) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'PersistenceError';
    this.code = code;
  }
}

function validId(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(value)) throw new TypeError('Project ID is invalid');
  return value;
}

function validDate(value) {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) {
    throw new TypeError('Project timestamp is invalid');
  }
  return value;
}

function plainObject(value, keys, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype
    || Reflect.ownKeys(value).some(key => !keys.includes(key) || !Object.hasOwn(Object.getOwnPropertyDescriptor(value, key), 'value'))) {
    throw new TypeError(`${label} is invalid`);
  }
}

function validateRecord(record) {
  plainObject(record, ['id', 'name', 'createdAt', 'updatedAt', 'document'], 'Saved project');
  const document = validateDocument(record.document);
  const identifier = validId(record.id);
  if (record.name !== document.name || identifier !== document.id) throw new TypeError('Project metadata does not match its document');
  const createdAt = validDate(record.createdAt);
  const updatedAt = validDate(record.updatedAt);
  if (Date.parse(updatedAt) < Date.parse(createdAt)) throw new TypeError('Project update precedes its creation');
  return { id: identifier, name: document.name, createdAt, updatedAt, document };
}

function validateEnvelope(envelope) {
  plainObject(envelope, ['schemaVersion', 'projects'], 'Saved project library');
  if (envelope.schemaVersion !== STORE_SCHEMA_VERSION) throw new TypeError('Saved project library has an unsupported schema version');
  if (!Array.isArray(envelope.projects) || envelope.projects.length > MAX_PROJECTS) throw new TypeError('Saved project library exceeds its project limit');
  const projects = envelope.projects.map(validateRecord);
  if (new Set(projects.map(project => project.id)).size !== projects.length) throw new TypeError('Saved project library has duplicate IDs');
  return { schemaVersion: STORE_SCHEMA_VERSION, projects };
}

/**
 * Inject a localStorage-compatible adapter. No browser global is touched by
 * this module, so file-backed adapters and deterministic tests use the same API.
 */
export class ProjectStore {
  constructor(storage, { key = STORAGE_KEY, now = () => new Date() } = {}) {
    if (!storage || !['getItem', 'setItem', 'removeItem'].every(method => typeof storage[method] === 'function')) {
      throw new TypeError('A localStorage-compatible storage adapter is required');
    }
    if (typeof key !== 'string' || !key.trim() || key.length > 200) throw new TypeError('Storage key is invalid');
    if (typeof now !== 'function') throw new TypeError('A clock function is required');
    this.storage = storage;
    this.key = key;
    this.now = now;
  }

  _load() {
    let serialized;
    try { serialized = this.storage.getItem(this.key); } catch (cause) {
      throw new PersistenceError('Could not read saved projects. Storage access may be unavailable.', 'read', cause);
    }
    if (serialized === null) return { schemaVersion: STORE_SCHEMA_VERSION, projects: [] };
    try {
      if (typeof serialized !== 'string') throw new TypeError('Storage returned non-string data');
      return validateEnvelope(JSON.parse(serialized));
    } catch (cause) {
      throw new PersistenceError('Saved projects could not be loaded because their data is invalid or uses an unsupported version.', 'invalid-data', cause);
    }
  }

  _write(envelope) {
    const serialized = JSON.stringify(envelope);
    try { this.storage.setItem(this.key, serialized); } catch (cause) {
      const quota = cause?.name === 'QuotaExceededError' || cause?.name === 'NS_ERROR_DOM_QUOTA_REACHED';
      throw new PersistenceError(quota
        ? 'Could not save the project because local storage is full. Export or remove a saved project to make room.'
        : 'Could not save the project. Storage access may be unavailable.', quota ? 'quota' : 'write', cause);
    }
  }

  /** Metadata summaries, most recently updated first. */
  list() {
    return this._load().projects
      .map(({ id, name, createdAt, updatedAt }) => ({ id, name, createdAt, updatedAt }))
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt) || left.name.localeCompare(right.name) || left.id.localeCompare(right.id));
  }

  /** Validated legacy records for non-destructive migration to the browser library. */
  readAll() { return this._load().projects; }

  /** Freshly validated record, or null when this ID is not saved. */
  read(projectId) {
    validId(projectId);
    return this._load().projects.find(project => project.id === projectId) ?? null;
  }

  /** Save updates the same ID; pass a different ID for Save as. */
  save(input, options = {}) {
    plainObject(options, ['id', 'name'], 'Save options');
    const document = validateDocument(input);
    if (Object.hasOwn(options, 'id')) document.id = validId(options.id);
    if (Object.hasOwn(options, 'name')) document.name = options.name;
    const safeDocument = validateDocument(document);
    const envelope = this._load();
    const existingIndex = envelope.projects.findIndex(project => project.id === safeDocument.id);
    if (existingIndex < 0 && envelope.projects.length >= MAX_PROJECTS) {
      throw new PersistenceError(`The local library supports up to ${MAX_PROJECTS} projects. Export or remove a saved project first.`, 'project-limit');
    }
    const now = this.now();
    const date = now instanceof Date ? now : new Date(now);
    if (!Number.isFinite(date.getTime())) throw new TypeError('Clock returned an invalid date');
    const previous = existingIndex < 0 ? null : envelope.projects[existingIndex];
    // A clock correction must not make saved metadata run backwards.
    const timestamp = previous && Date.parse(previous.updatedAt) > date.getTime() ? previous.updatedAt : date.toISOString();
    const record = {
      id: safeDocument.id, name: safeDocument.name,
      createdAt: previous?.createdAt ?? timestamp, updatedAt: timestamp, document: safeDocument,
    };
    if (existingIndex < 0) envelope.projects.push(record);
    else envelope.projects[existingIndex] = record;
    this._write(envelope);
    return validateRecord(record);
  }

  remove(projectId) {
    validId(projectId);
    const envelope = this._load();
    const index = envelope.projects.findIndex(project => project.id === projectId);
    if (index < 0) return false;
    envelope.projects.splice(index, 1);
    this._write(envelope);
    return true;
  }
}

export default ProjectStore;
