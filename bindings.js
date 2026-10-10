/**
 * Resolve exact {$input: nodeId} markers from JSON into current input values.
 * Keep this function self-contained: the widget exporter embeds its trusted
 * source so exported widgets need no module dependency or dynamic evaluation.
 */
export function resolveInputBindings(args, readInput) {
  if (typeof readInput !== 'function') throw new TypeError('Input bindings need an input reader');
  const ancestors = new Set();
  let count = 0;
  function invalid(path, reason) { throw new TypeError(`Input bindings ${path}: ${reason}`); }
  function text(value, path, limit = 20_000) {
    if (typeof value !== 'string' || value.length > limit || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value)) invalid(path, 'invalid or excessive text');
    return value;
  }
  function visit(value, path, depth) {
    if (++count > 10_000 || depth > 20) invalid(path, 'JSON is too complex');
    if (value === null || typeof value === 'boolean') return value;
    if (typeof value === 'string') return text(value, path);
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (!value || typeof value !== 'object') invalid(path, 'only finite JSON values are supported');
    if (ancestors.has(value)) invalid(path, 'cycles are unsupported');
    ancestors.add(value);
    let result;
    if (Array.isArray(value)) {
      if (Object.getPrototypeOf(value) !== Array.prototype || value.length > 1000) invalid(path, 'invalid or excessive array');
      for (const key of Reflect.ownKeys(value)) {
        if (key === 'length') continue;
        if (typeof key !== 'string' || !/^(?:0|[1-9]\d*)$/.test(key) || Number(key) >= value.length
          || !Object.hasOwn(Object.getOwnPropertyDescriptor(value, key), 'value')) invalid(path, 'array fields or accessors are unsupported');
      }
      result = [];
      for (let index = 0; index < value.length; index++) {
        if (!Object.hasOwn(value, index)) invalid(path, 'missing array entries are unsupported');
        result.push(visit(value[index], `${path}[${index}]`, depth + 1));
      }
    } else {
      const prototype = Object.getPrototypeOf(value);
      if (prototype !== Object.prototype && prototype !== null) invalid(path, 'only plain JSON objects are supported');
      const keys = Reflect.ownKeys(value);
      for (const key of keys) {
        if (typeof key !== 'string' || ['__proto__', 'constructor', 'prototype'].includes(key)) invalid(path, 'unsafe JSON key');
        text(key, path, 256);
        if (!key.trim()) invalid(path, 'empty JSON key');
        if (!Object.hasOwn(Object.getOwnPropertyDescriptor(value, key), 'value')) invalid(path, 'accessors are unsupported');
      }
      if (keys.length === 1 && ['$input','$control'].includes(keys[0])) {
        const marker=keys[0],identifier = value[marker];
        if (typeof identifier !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(identifier)) invalid(path, 'input marker needs a valid node ID');
        let inputValue;
        try { inputValue = readInput(identifier,marker); } catch (cause) {
          throw new Error(`Input "${identifier}" could not be read.`, { cause });
        }
        if(marker==='$control'){if(inputValue===undefined)throw new Error(`Control "${identifier}" is missing.`);result=visit(inputValue,`control "${identifier}"`,depth+1);}
        else {if (typeof inputValue !== 'string') throw new Error(`Input "${identifier}" is missing or does not provide a string value.`);
        result = text(inputValue, `input "${identifier}"`);}
      } else {
        result = {};
        for (const key of keys) result[key] = visit(value[key], `${path}.${key}`, depth + 1);
      }
    }
    ancestors.delete(value);
    return result;
  }
  const result = visit(args, 'args', 0);
  if (JSON.stringify(result).length > 50_000) invalid('args', 'resolved JSON payload is too large');
  return result;
}

/** Return independent JSON, remapping only markers whose input was copied. */
export function remapInputBindings(args, idMap) {
  let mapping;
  if (idMap instanceof Map && Object.getPrototypeOf(idMap) === Map.prototype) {
    if (Reflect.ownKeys(idMap).length) throw new TypeError('Input ID map contains unsupported fields or accessors');
    mapping = new Map(Map.prototype.entries.call(idMap));
  }
  else {
    if (!idMap || typeof idMap !== 'object' || Array.isArray(idMap)
      || ![Object.prototype, null].includes(Object.getPrototypeOf(idMap))) throw new TypeError('Input ID map must be a Map or plain object');
    mapping = new Map();
    for (const key of Reflect.ownKeys(idMap)) {
      if (typeof key !== 'string' || ['__proto__', 'constructor', 'prototype'].includes(key)
        || !Object.hasOwn(Object.getOwnPropertyDescriptor(idMap, key), 'value')) throw new TypeError('Input ID map contains unsafe fields or accessors');
      mapping.set(key, idMap[key]);
    }
  }
  for (const [oldId, newId] of mapping) {
    if (typeof oldId !== 'string' || typeof newId !== 'string'
      || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(oldId) || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(newId)) throw new TypeError('Input ID map contains invalid node IDs');
  }
  // Resolve first with an identity reader to validate every JSON branch without
  // allowing arbitrary object traversal to invoke an accessor. The returned
  // strings are discarded; the source data itself remains unchanged.
  resolveInputBindings(args, identifier => identifier);
  function visit(value) {
    if (value === null || typeof value !== 'object') return value;
    if (Array.isArray(value)) return value.map(visit);
    const keys = Reflect.ownKeys(value);
    if (keys.length === 1 && ['$input','$control'].includes(keys[0])) return { [keys[0]]: mapping.get(value[keys[0]]) ?? value[keys[0]] };
    const result = {};
    for (const key of keys) result[key] = visit(value[key]);
    return result;
  }
  return visit(args);
}
