/**
 * Versioned, data-only widget documents. Within each parent, array order is
 * back-to-front layer order and flow order. Mutations return validated copies.
 */
import {remapNodeReferences} from './references.js';

export const SCHEMA_VERSION = 1;
export const NODE_TYPES = Object.freeze(['text', 'button', 'rectangle', 'input', 'image', 'divider', 'checkbox', 'select', 'list']);
export const PRESETS = Object.freeze(['blank', 'card', 'task-list', 'form', 'workflow']);
export const DEFAULT_THEME = Object.freeze({accent:'#5856d6',onAccent:'#ffffff',surface:'#f1f3f8',control:'#e4e8f0',text:'#202127',muted:'#697487',fontFamily:'system',bodySize:14,headingSize:24});
export const STATE_NAMES = Object.freeze(['default','hover','disabled','loading','error','success']);
export const LIMITS = Object.freeze({ frames: 12, nodes: 300, dimension: 8192, position: 32768, imageUrlChars: 6_000_000, documentBytes: 8_000_000 });

const documentKeys = ['schemaVersion', 'id', 'name', 'frames', 'activeFrameId', 'entryFrameId', 'theme'];
const frameKeys = ['id', 'name', 'width', 'height', 'fill', 'nodes', 'layout', 'transition', 'flowHeight'];
const nodeKeys = ['id', 'type', 'name', 'x', 'y', 'width', 'height', 'text', 'fill', 'color', 'fontSize', 'fontWeight', 'fontFamily', 'radius', 'strokeWidth', 'stroke', 'textAlign', 'opacity', 'visible', 'locked', 'action', 'src', 'parentId', 'layout', 'widthMode', 'heightMode', 'styleRole', 'disabled', 'states', 'multiline', 'flowSizing', 'imageFit', 'imagePosition', 'checked', 'controlVariant', 'options', 'items', 'initialValue', 'inputType', 'validation', 'textBindingId'];
const actionKeys = ['kind', 'href', 'toolName', 'args', 'targetFrameId','localOp','targetNodeId','formFrameId','resultTargetId','resultPath','message','successFrameId','errorFrameId','clearInput','mode'];
const own = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
let fallbackSequence = 0;

function fail(path, detail) {
  throw new TypeError(`${path}: ${detail}`);
}

function object(value, path, allowedKeys) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(path, 'must be an object');
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) fail(path, 'must contain plain JSON data');
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string' || !allowedKeys.includes(key)) fail(`${path}.${String(key)}`, 'unsupported field');
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !own(descriptor, 'value')) fail(`${path}.${key}`, 'accessors are unsupported');
  }
  return value;
}

function string(value, path, maxLength, { nonempty = false, trim = false } = {}) {
  if (typeof value !== 'string') fail(path, 'must be a string');
  if (value.length > maxLength || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value)) fail(path, 'contains invalid or excessive text');
  const result = trim ? value.trim() : value;
  if (nonempty && !result.trim()) fail(path, 'must not be empty');
  return result;
}

function id(value, path) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(value)) fail(path, 'must be a valid ID');
  return value;
}

function number(value, path, minimum, maximum) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < minimum || value > maximum) {
    fail(path, `must be finite and between ${minimum} and ${maximum}`);
  }
  return value;
}

function boolean(value, path) {
  if (typeof value !== 'boolean') fail(path, 'must be a boolean');
  return value;
}

function array(value, path, maximum) {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length > maximum) fail(path, `must be an array with at most ${maximum} entries`);
  for (const key of Reflect.ownKeys(value)) {
    if (key === 'length') continue;
    if (typeof key !== 'string' || !/^(?:0|[1-9]\d*)$/.test(key) || Number(key) >= value.length
      || !own(Object.getOwnPropertyDescriptor(value, key), 'value')) fail(path, 'array contains unsupported fields or accessors');
  }
  for (let index = 0; index < value.length; index++) if (!own(value, index)) fail(path, 'array must not contain missing entries');
  return value;
}

function color(value, path) {
  if (typeof value !== 'string' || value.length > 64) fail(path, 'must be a supported color');
  const result = value.toLowerCase().trim();
  if (/^#(?:[0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/.test(result)) return result;
  if (['transparent', 'black', 'white'].includes(result)) return result;
  const match = /^(rgb|rgba)\(([^()]*)\)$/.exec(result);
  if (match) {
    const parts = match[2].split(',').map(part => part.trim());
    if (parts.length === (match[1] === 'rgb' ? 3 : 4)) {
      const rgbValid = parts.slice(0, 3).every(part => /^(?:\d+(?:\.\d+)?|\.\d+)%?$/.test(part)
        && Number.parseFloat(part) <= (part.endsWith('%') ? 100 : 255));
      const alphaValid = parts.length === 3 || (/^(?:\d+(?:\.\d+)?|\.\d+)$/.test(parts[3]) && Number(parts[3]) <= 1);
      if (rgbValid && alphaValid) return `${match[1]}(${parts.join(', ')})`;
    }
  }
  fail(path, 'must be hex, rgb, rgba, black, white, or transparent');
}

function url(value, path, image = false) {
  const source = string(value, path, image ? LIMITS.imageUrlChars : 4096);
  if (image && source === '') return source;
  if (source !== source.trim()) fail(path, 'URL must not contain surrounding whitespace');
  if (image && /^data:image\/(?:png|jpeg|gif|webp|avif);base64,[A-Za-z0-9+/]+={0,2}$/i.test(source)) return source;
  let parsed;
  try { parsed = new URL(source); } catch { fail(path, 'must be an absolute URL'); }
  if (!parsed.hostname || parsed.username || parsed.password || !(image ? ['https:'] : ['http:', 'https:']).includes(parsed.protocol)) {
    fail(path, image ? 'must be HTTPS or a raster image data URL' : 'must be HTTP or HTTPS without credentials');
  }
  return source;
}

function json(value, path, depth = 0, budget = { count: 0 }, ancestors = new Set()) {
  if (++budget.count > 10_000 || depth > 20) fail(path, 'JSON is too complex');
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'number') return number(value, path, -Number.MAX_VALUE, Number.MAX_VALUE);
  if (typeof value === 'string') return string(value, path, 20_000);
  if (!value || typeof value !== 'object') fail(path, 'must contain JSON values only');
  if (ancestors.has(value)) fail(path, 'must not contain cycles');
  ancestors.add(value);
  let result;
  if (Array.isArray(value)) {
    array(value, path, 1000);
    result = Array.from(value, (entry, index) => json(entry, `${path}[${index}]`, depth + 1, budget, ancestors));
  } else {
    const keys = Reflect.ownKeys(value);
    object(value, path, keys.filter(key => typeof key === 'string'));
    result = {};
    for (const key of keys) {
      if (['__proto__', 'constructor', 'prototype'].includes(key)) fail(path, 'unsafe JSON key');
      string(key, path, 256, { nonempty: true });
      result[key] = json(value[key], `${path}.${key}`, depth + 1, budget, ancestors);
    }
  }
  ancestors.delete(value);
  return result;
}

function action(input, path) {
  const value = input === undefined ? { kind: 'none' } : object(input, path, actionKeys);
  const kind = value.kind;
  if (!['none', 'link', 'tool', 'navigate', 'submit', 'local'].includes(kind)) fail(`${path}.kind`, 'unsupported action kind');
  const href = own(value, 'href') ? string(value.href, `${path}.href`, 4096) : '';
  const toolName = own(value, 'toolName') ? string(value.toolName, `${path}.toolName`, 128) : '';
  if (href) url(href, `${path}.href`);
  if (toolName && !/^[A-Za-z_][A-Za-z0-9_.-]{0,127}$/.test(toolName)) fail(`${path}.toolName`, 'invalid tool name');
  if (kind === 'link' && !href) fail(`${path}.href`, 'link action needs a URL');
  if (kind === 'tool' && !toolName) fail(`${path}.toolName`, 'tool action needs a tool name');
  const argsInput = own(value, 'args') ? value.args : {};
  if (!argsInput || typeof argsInput !== 'object' || Array.isArray(argsInput)) fail(`${path}.args`, 'must be a JSON object');
  const args = json(argsInput, `${path}.args`);
  if (JSON.stringify(args).length > 50_000) fail(`${path}.args`, 'JSON payload is too large');
  const result = { kind, href, toolName, args };
  if (kind === 'navigate') result.targetFrameId = id(value.targetFrameId, `${path}.targetFrameId`);
  for(const key of ['targetFrameId','formFrameId','resultTargetId','targetNodeId','successFrameId','errorFrameId'])if(own(value,key)&&value[key])result[key]=id(value[key],path+'.'+key);
  if(kind==='local'){
    result.localOp=choice(value.localOp,['set','toggle','increment','reset','list-add'],path+'.localOp');
    if(result.localOp==='list-add')result.clearInput=own(value,'clearInput')?boolean(value.clearInput,path+'.clearInput'):true;
    if(result.localOp!=='reset'&&!result.targetNodeId)fail(path+'.targetNodeId','Choose a local value to change');
  }
  if(own(value,'message'))result.message=string(value.message,path+'.message',1000);
  if(own(value,'resultPath')){
    result.resultPath=string(value.resultPath,path+'.resultPath',256);
    if(result.resultPath&&(!/^[A-Za-z0-9_]+(?:\.[A-Za-z0-9_]+)*$/.test(result.resultPath)||result.resultPath.split('.').some(key=>['__proto__','constructor','prototype'].includes(key))))fail(path+'.resultPath','Use simple result field names separated by dots');
  }
  if(own(value,'clearInput'))result.clearInput=boolean(value.clearInput,path+'.clearInput');
  if(own(value,'mode'))result.mode=choice(value.mode,['demo','external'],path+'.mode');
  return result;
}

function choice(value, values, path) {
  if (!values.includes(value)) fail(path, 'unsupported value');
  return value;
}
function layout(input, path) {
  const value = input === undefined ? {} : object(input,path,['direction','padding','gap','wrap']);
  return {direction:choice(value.direction??'free',['free','vertical','horizontal'],path+'.direction'),
    padding:number(value.padding??0,path+'.padding',0,512),gap:number(value.gap??12,path+'.gap',0,512),
    wrap:boolean(value.wrap??true,path+'.wrap')};
}
function transition(input, path) {
  const value = input === undefined ? {} : object(input,path,['duration','easing']);
  return {duration:number(value.duration??160,path+'.duration',0,1000),
    easing:choice(value.easing??'ease-out',['linear','ease','ease-in-out','ease-out'],path+'.easing')};
}
function theme(input) {
  const value=input===undefined?{}:object(input,'theme',Object.keys(DEFAULT_THEME));
  const result={...DEFAULT_THEME,...value};
  for(const key of ['accent','onAccent','surface','control','text','muted'])result[key]=color(result[key],'theme.'+key);
  result.fontFamily=choice(result.fontFamily,['system','serif','mono'],'theme.fontFamily');
  result.bodySize=number(result.bodySize,'theme.bodySize',8,80);
  result.headingSize=number(result.headingSize,'theme.headingSize',8,160);
  return result;
}
function states(input,path) {
  const value=input===undefined?{}:object(input,path,STATE_NAMES.filter(name=>name!=='default'));
  const result={};
  for(const [name,override] of Object.entries(value)) {
    object(override,path+'.'+name,['fill','color','opacity','text','strokeWidth','stroke','fontSize','fontWeight']);
    const style={};
    for(const [key,item] of Object.entries(override)) {
      if(['fill','color','stroke'].includes(key))style[key]=color(item,path+'.'+name+'.'+key);
      else if(key==='text')style.text=string(item,path+'.'+name+'.text',20000);
      else style[key]=number(item,path+'.'+name+'.'+key,key==='fontSize'?8:0,key==='opacity'?1:key==='strokeWidth'?64:key==='fontSize'?160:900);
      if(key==='fontWeight'&&(!Number.isInteger(item)||item<100||item%100!==0))fail(path+'.'+name+'.fontWeight','must be a multiple of 100');
    }
    result[name]=style;
  }
  return result;
}

function makeId(prefix) {
  const suffix = globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}-${(++fallbackSequence).toString(36)}-${Math.random().toString(36).slice(2)}`;
  return `${prefix}-${suffix}`;
}

function nodeDefaults(type) {
  if (!NODE_TYPES.includes(type)) fail('node.type', 'unsupported node type');
  const defaults = {
    type, name: type.charAt(0).toUpperCase() + type.slice(1), x: 32, y: 32,
    width: 240, height: 40, text: '', fill: 'transparent', color: '#202127',
    fontSize: 16, fontWeight: 400, fontFamily: 'system', radius: 0, strokeWidth: 0, stroke: '#d9dce3',
    textAlign: 'left', opacity: 1, visible: true, locked: false,
    action: { kind: 'none', href: '', toolName: '', args: {} },
  };
  if (type === 'text') Object.assign(defaults, { text: 'Text', height: 36 });
  if (type === 'button') Object.assign(defaults, { text: 'Button', width: 160, height: 44, heightMode:'hug', fill: '#5856d6', color: '#ffffff', radius: 10, fontWeight: 600, textAlign: 'center' });
  if (type === 'rectangle') Object.assign(defaults, { width: 200, height: 120, fill: '#ececf8', radius: 12 });
  if (type === 'input') Object.assign(defaults, { multiline:false, text: 'Enter a value…', height: 44, fill: '#edf0f5', radius: 8, strokeWidth: 0, color: '#202127' });
  if (type === 'image') Object.assign(defaults, { width: 240, height: 160, fill: '#e8eaf0', radius: 12, src: '' });
  if(type==='checkbox')Object.assign(defaults,{text:'Checkbox label',width:240,height:44,checked:false,controlVariant:'checkbox',heightMode:'hug'});
  if(type==='select')Object.assign(defaults,{text:'Choose an option',options:['First choice','Second choice'],initialValue:'',width:240,height:44,fill:'#edf0f5',radius:8});
  if(type==='list')Object.assign(defaults,{text:'Tasks',items:[],widthMode:'fill',width:320,height:132,heightMode:'hug',fill:'#f1f3f8',radius:8});
  if (type === 'divider') Object.assign(defaults, { height: 1, fill: '#e3e5eb' });
  return defaults;
}

export function defaultNode(type) {
  return { id: makeId('node'), ...nodeDefaults(type) };
}

function normalizeNode(input, path, identifiers) {
  const value = object(input, path, nodeKeys);
  const identifier = id(value.id, `${path}.id`);
  if (identifiers.has(identifier)) fail(`${path}.id`, 'duplicate ID');
  identifiers.add(identifier);
  const defaults = nodeDefaults(value.type);
  const field = key => own(value, key) ? value[key] : defaults[key];
  if (value.type !== 'image' && own(value, 'src')) fail(`${path}.src`, 'only image nodes support src');
  const result = {
    id: identifier, type: value.type,
    name: string(field('name'), `${path}.name`, 160, { nonempty: true, trim: true }),
    x: number(field('x'), `${path}.x`, -LIMITS.position, LIMITS.position),
    y: number(field('y'), `${path}.y`, -LIMITS.position, LIMITS.position),
    width: number(field('width'), `${path}.width`, 1, LIMITS.dimension),
    height: number(field('height'), `${path}.height`, 1, LIMITS.dimension),
    text: string(field('text'), `${path}.text`, 20_000),
    fill: color(field('fill'), `${path}.fill`), color: color(field('color'), `${path}.color`),
    fontSize: number(field('fontSize'), `${path}.fontSize`, 8, 160),
    fontWeight: number(field('fontWeight'), `${path}.fontWeight`, 100, 900),
    fontFamily: field('fontFamily'),
    radius: number(field('radius'), `${path}.radius`, 0, 2048),
    strokeWidth: number(field('strokeWidth'), `${path}.strokeWidth`, 0, 64),
    stroke: color(field('stroke'), `${path}.stroke`),
    textAlign: field('textAlign'), opacity: number(field('opacity'), `${path}.opacity`, 0, 1),
    visible: boolean(field('visible'), `${path}.visible`), locked: boolean(field('locked'), `${path}.locked`),
    action: action(field('action'), `${path}.action`),
    parentId: value.parentId === undefined || value.parentId === null ? null : id(value.parentId,path+'.parentId'),
    layout: layout(value.layout,path+'.layout'),
    widthMode: choice(value.widthMode??'fixed',['fixed','fill','hug'],path+'.widthMode'),
    heightMode: choice(value.heightMode??'fixed',['fixed','hug'],path+'.heightMode'),
    styleRole: choice(value.styleRole??'none',['none','heading','body','muted','accent','surface','field'],path+'.styleRole'),
    disabled: boolean(value.disabled??false,path+'.disabled'),
    states: states(value.states,path+'.states'),
  };
  if (!['left', 'center', 'right'].includes(result.textAlign)) fail(`${path}.textAlign`, 'unsupported alignment');
  if (!['system', 'serif', 'mono'].includes(result.fontFamily)) fail(`${path}.fontFamily`, 'unsupported font family');
  if (!Number.isInteger(result.fontWeight) || result.fontWeight % 100 !== 0) fail(`${path}.fontWeight`, 'must be a multiple of 100');
  const hugWidthTypes=['text','button','input','checkbox','select'];
  if(result.widthMode==='hug'&&!hugWidthTypes.includes(value.type))fail(path+'.widthMode','Hug width needs text, button or input content');
  if(value.flowSizing!==undefined&&value.flowSizing!==null){
    const saved=object(value.flowSizing,path+'.flowSizing',['widthMode','width']);
    const mode=choice(saved.widthMode,['fill','hug'],path+'.flowSizing.widthMode');
    if(mode==='hug'&&!hugWidthTypes.includes(value.type))fail(path+'.flowSizing','Hug width needs text or control content');
    result.flowSizing={widthMode:mode,width:number(saved.width,path+'.flowSizing.width',1,LIMITS.dimension)};
  }
  if(value.type!=='image'&&(own(value,'imageFit')||own(value,'imagePosition')))fail(path+'.imageFit','only image layers support image fit and crop');
  if(value.type==='image'){
    result.src=url(field('src'),path+'.src',true);
    if(own(value,'imageFit'))result.imageFit=choice(value.imageFit,['cover','contain','fill'],path+'.imageFit');
    if(own(value,'imagePosition'))result.imagePosition=choice(value.imagePosition,['center','top','bottom','left','right'],path+'.imagePosition');
  }
  if (value.type === 'input') result.multiline = boolean(value.multiline??false,path+'.multiline');
  else if(own(value,'multiline'))fail(path+'.multiline','only input nodes support multiline');
  if(['checkbox','select','list'].includes(value.type)&&result.action.kind!=='none')fail(path+'.action','Controls update their values directly; use a button to run actions');
  if(value.type==='checkbox'){
    result.checked=boolean(value.checked??false,path+'.checked');result.controlVariant=choice(value.controlVariant??'checkbox',['checkbox','switch'],path+'.controlVariant');
  }else if(own(value,'checked')||own(value,'controlVariant'))fail(path+'.checked','Only checkbox controls have checked state');
  if(value.type==='select'){
    result.options=array(value.options??defaults.options,path+'.options',50).map((item,index)=>string(item,path+'.options['+index+']',160,{nonempty:true}));
    if(!result.options.length||new Set(result.options).size!==result.options.length)fail(path+'.options','Use distinct nonempty options');
  }else if(own(value,'options'))fail(path+'.options','Only selection controls have options');
  if(value.type==='list')result.items=array(value.items??[],path+'.items',100).map((item,index)=>string(item,path+'.items['+index+']',1000,{nonempty:true}));
  else if(own(value,'items'))fail(path+'.items','Only task lists have initial items');
  if(['input','select'].includes(value.type)){
    if(own(value,'initialValue'))result.initialValue=string(value.initialValue,path+'.initialValue',20000);
    if(value.type==='select'&&result.initialValue&&!result.options.includes(result.initialValue))fail(path+'.initialValue','Choose an authored option');
    if(value.type==='input'&&own(value,'inputType'))result.inputType=choice(value.inputType,['text','email','number'],path+'.inputType');
  }else if(own(value,'initialValue')||own(value,'inputType'))fail(path+'.initialValue','Only fields have initial values');
  if(value.validation!==undefined){
    if(!['input','checkbox','select','list'].includes(value.type))fail(path+'.validation','Only controls have field validation');
    const rules=object(value.validation,path+'.validation',['required','minLength','maxLength','min','max']);
    result.validation={required:boolean(rules.required??false,path+'.validation.required'),minLength:number(rules.minLength??0,path+'.validation.minLength',0,20000),maxLength:number(rules.maxLength??20000,path+'.validation.maxLength',1,20000)};
    if(result.validation.minLength>result.validation.maxLength)fail(path+'.validation','Minimum length exceeds maximum');
    for(const key of ['min','max'])if(rules[key]!==undefined)result.validation[key]=number(rules[key],path+'.validation.'+key,-1e12,1e12);
    if(result.validation.min!==undefined&&result.validation.max!==undefined&&result.validation.min>result.validation.max)fail(path+'.validation','Minimum exceeds maximum');
  }
  if(value.textBindingId)result.textBindingId=id(value.textBindingId,path+'.textBindingId');
  return result;
}

function enforceDocumentBudget(document) {
  const encoder = new TextEncoder();
  let bytes = 0;
  function add(count) {
    bytes += count;
    if (bytes > LIMITS.documentBytes) fail('document', `normalized JSON exceeds the ${LIMITS.documentBytes.toLocaleString('en-US')}-byte document limit; reduce embedded images or content`);
  }
  // Count the exact compact JSON representation in bounded pieces. Avoid
  // allocating a single enormous string from an already oversized document.
  function count(value) {
    if (value === null || typeof value !== 'object') {
      add(encoder.encode(JSON.stringify(value)).byteLength);
      return;
    }
    const entries = Array.isArray(value) ? value : Object.keys(value);
    add(2 + Math.max(0, entries.length - 1)); // Brackets/braces and commas.
    for (const entry of entries) {
      if (Array.isArray(value)) count(entry);
      else {
        add(encoder.encode(JSON.stringify(entry)).byteLength + 1); // Key and colon.
        count(value[entry]);
      }
    }
  }
  count(document);
}

/** Validate schema version and allowed fields, filling only omitted style defaults. */
export function validateDocument(input) {
  const value = object(input, 'document', documentKeys);
  if (value.schemaVersion !== SCHEMA_VERSION) fail('document.schemaVersion', 'unsupported schema version');
  const identifier = id(value.id, 'document.id');
  array(value.frames, 'document.frames', LIMITS.frames);
  if (value.frames.length < 1) fail('document.frames', `must contain 1–${LIMITS.frames} frames`);
  const identifiers = new Set([identifier]);
  let nodeCount = 0;
  const frames = value.frames.map((frameInput, index) => {
    const path = `document.frames[${index}]`;
    const frame = object(frameInput, path, frameKeys);
    const frameId = id(frame.id, `${path}.id`);
    if (identifiers.has(frameId)) fail(`${path}.id`, 'duplicate ID');
    identifiers.add(frameId);
    array(frame.nodes, `${path}.nodes`, LIMITS.nodes);
    nodeCount += frame.nodes.length;
    if (nodeCount > LIMITS.nodes) fail(`${path}.nodes`, `document limit is ${LIMITS.nodes} nodes`);
    return {
      id: frameId, name: string(frame.name, `${path}.name`, 160, { nonempty: true, trim: true }),
      width: number(frame.width, `${path}.width`, 32, LIMITS.dimension),
      height: number(frame.height, `${path}.height`, 32, LIMITS.dimension),
      fill: color(frame.fill, `${path}.fill`),
      layout: layout(frame.layout,path+'.layout'),
      transition: transition(frame.transition,path+'.transition'),
      ...(frame.flowHeight===undefined||frame.flowHeight===null?{}:{flowHeight:number(frame.flowHeight,path+'.flowHeight',32,LIMITS.dimension)}),
      nodes: frame.nodes.map((node, nodeIndex) => normalizeNode(node, `${path}.nodes[${nodeIndex}]`, identifiers)),
    };
  });
  for(const frame of frames) {
    const nodes=new Map(frame.nodes.map(node=>[node.id,node]));
    for(const node of frame.nodes) {
      const seen=new Set([node.id]);let parentId=node.parentId;
      while(parentId) {
        const parent=nodes.get(parentId);
        if(!parent||parent.type!=='rectangle')fail('node.parentId','parent must be a container in the same view');
        if(parent.action.kind!=='none')fail('node.parentId','containers with children use child controls for actions');
        if(seen.has(parentId))fail('node.parentId','container cycle');
        seen.add(parentId);parentId=parent.parentId;
      }
      for(const key of ['targetFrameId','formFrameId','successFrameId','errorFrameId'])if(node.action[key]&&!frames.some(target=>target.id===node.action[key]))fail('action.'+key,'view does not exist');
    }
  }
  const activeFrameId = id(value.activeFrameId, 'document.activeFrameId');
  if (!frames.some(frame => frame.id === activeFrameId)) fail('document.activeFrameId', 'frame does not exist');
  const result = { schemaVersion: SCHEMA_VERSION, id: identifier, name: string(value.name, 'document.name', 160, { nonempty: true, trim: true }), frames, activeFrameId, theme:theme(value.theme) };
  if(own(value,'entryFrameId')) {
    result.entryFrameId=id(value.entryFrameId,'document.entryFrameId');
    if(!frames.some(frame=>frame.id===result.entryFrameId))fail('document.entryFrameId','start view does not exist');
  }
  enforceDocumentBudget(result);
  return result;
}

export function cloneDocument(document) {
  return validateDocument(document);
}

function starterFrames(preset){
  const first=makeId('frame'),second=makeId('frame'),listId=makeId('node'),statusId=makeId('node');
  const make=(type,patch)=>({...defaultNode(type),widthMode:'fill',...(['text','button'].includes(type)?{heightMode:'hug'}:{}),...patch});
  const view=(id,name,nodes)=>({id,name,width:400,height:400,fill:'#ffffff',layout:{direction:'vertical',padding:20,gap:12,wrap:true},nodes});
  if(preset==='blank')return [view(first,'Widget',[])].map(frame=>({...frame,layout:{direction:'free',padding:0,gap:12,wrap:true}}));
  if(preset==='card')return [view(first,'Widget',[
    make('text',{name:'Eyebrow',text:'CUSTOM WIDGET',styleRole:'muted',fontSize:11}),
    make('text',{name:'Title',text:'Your next great idea',styleRole:'heading'}),
    make('text',{name:'Description',text:'Give an idea a useful interface. Customize this card, then use its action to open the details view.',styleRole:'body'}),
    make('divider',{name:'Divider'}),
    make('button',{name:'Primary action',text:'View details',styleRole:'accent',action:{kind:'navigate',targetFrameId:second}})
  ]),view(second,'Details',[
    make('text',{name:'Details heading',text:'A useful next step',styleRole:'heading'}),
    make('text',{name:'Details body',text:'This connected view is ready to customize. Change the content, add fields, or replace navigation with a local action or plugin tool.',styleRole:'body'}),
    make('button',{name:'Back',text:'Back to card',styleRole:'accent',action:{kind:'navigate',targetFrameId:first}})
  ])];
  if(preset==='task-list')return [view(first,'Tasks',[
    make('text',{name:'Title',text:'Today’s focus',styleRole:'heading'}),
    make('text',{name:'Subtitle',text:'Add, complete, edit or remove tasks. Values stay in this widget session.',styleRole:'muted'}),
    make('list',{id:listId,name:'Task list',text:'My tasks',items:['Outline the idea','Build the first version','Share for feedback'],heightMode:'hug',styleRole:'surface'}),
    make('text',{name:'Task count',text:'Tasks in your list: ',textBindingId:listId,styleRole:'body'}),
    make('button',{name:'View summary',text:'View summary',styleRole:'accent',action:{kind:'navigate',targetFrameId:second}})
  ]),view(second,'Summary',[
    make('text',{name:'Summary heading',text:'Keep moving forward',styleRole:'heading'}),
    make('text',{name:'Summary count',text:'Tasks in this session: ',textBindingId:listId,styleRole:'body'}),
    make('button',{name:'Back to tasks',text:'Back to tasks',styleRole:'accent',action:{kind:'navigate',targetFrameId:first}})
  ])];
  return [view(first,'Form',[
    make('text',{name:'Title',text:'Tell us a little more',styleRole:'heading'}),
    make('text',{name:'Name label',text:'Name · required',fontSize:14,fontWeight:600}),
    make('input',{name:'Name',text:'Your name',styleRole:'field',validation:{required:true,minLength:2,maxLength:160}}),
    make('text',{name:'Email label',text:'Email · required',fontSize:14,fontWeight:600}),
    make('input',{name:'Email',text:'you@example.com',inputType:'email',styleRole:'field',validation:{required:true,maxLength:254}}),
    make('button',{name:'Submit',text:'Continue',styleRole:'accent',action:{kind:'submit',resultTargetId:statusId,message:'Form complete. Your values are kept in this widget session.'},states:{hover:{opacity:.85},error:{text:'Try again'},success:{text:'Submit again'}}}),
    make('text',{id:statusId,name:'Submission status',text:'Complete the required fields, then Continue.',styleRole:'body'})
  ])];
}

export function createDocument(name = 'Untitled widget', preset = 'card') {
  if (typeof preset !== 'string' || !PRESETS.includes(preset.toLowerCase())) fail('preset', 'unsupported preset');
  const selected = preset.toLowerCase();
  if(selected==='workflow')return createWorkflow(name);
  const frames=starterFrames(selected),frame=frames[0];
  return validateDocument({ schemaVersion: SCHEMA_VERSION, id: makeId('project'), name, frames, activeFrameId: frame.id, entryFrameId:frame.id });
}

export function getFrame(document, frameId = document.activeFrameId) {
  const frame = document.frames.find(candidate => candidate.id === frameId);
  if (!frame) fail('frame', `not found: ${frameId}`);
  return frame;
}

export function getNode(document, frameId, nodeId) {
  const node = getFrame(document, frameId).nodes.find(candidate => candidate.id === nodeId);
  if (!node) fail('node', `not found: ${nodeId}`);
  return node;
}

function change(document, mutate) {
  const copy = cloneDocument(document);
  mutate(copy);
  return validateDocument(copy);
}

function selection(nodes, frame) {
  if (!Array.isArray(nodes) || nodes.some(value => typeof value !== 'string')) fail('node IDs', 'must be an array of IDs');
  const selected = new Set(nodes);
  for (const identifier of selected) if (!frame.nodes.some(node => node.id === identifier)) fail('node', `not found: ${identifier}`);
  return selected;
}

export function addNode(document, frameId, type) {
  return change(document, copy => getFrame(copy, frameId).nodes.push(defaultNode(type)));
}

export function updateNode(document, frameId, nodeId, patch) {
  object(patch, 'node patch', nodeKeys.filter(key => key !== 'id' && key !== 'type'));
  return change(document, copy => {
    const node=getNode(copy,frameId,nodeId);
    if(!own(patch,'flowSizing')&&['width','widthMode','parentId'].some(key=>own(patch,key)&&patch[key]!==node[key]))delete node.flowSizing;
    Object.assign(node,patch);
  });
}

export function removeNodes(document, frameId, nodeIds) {
  return change(document, copy => {
    const frame = getFrame(copy, frameId);
    const selected = new Set(collectDescendantIds(frame, [...selection(nodeIds, frame)]));
    frame.nodes = frame.nodes.filter(node => !selected.has(node.id));
  });
}

export function duplicateNodes(document, frameId, nodeIds) {
  return change(document, copy => {
    const frame = getFrame(copy, frameId);
    const selected = new Set(collectDescendantIds(frame, [...selection(nodeIds, frame)]));
    const originals = frame.nodes.filter(node => selected.has(node.id));
    const idMap = new Map(originals.map(node => [node.id, makeId('node')]));
    const duplicates = originals.map(node => ({
      ...remapNodeReferences(node,idMap), id: idMap.get(node.id), name: `${node.name.slice(0, 154)} copy`,
      parentId: idMap.get(node.parentId)??node.parentId,
      x: Math.min(LIMITS.position, node.x + (selected.has(node.parentId)?0:16)), y: Math.min(LIMITS.position, node.y + (selected.has(node.parentId)?0:16)),
    }));
    frame.nodes.push(...duplicates);
  });
}

export function reorderNode(document, frameId, nodeId, newIndex) {
  return change(document, copy => {
    const frame = getFrame(copy, frameId);
    const index = frame.nodes.findIndex(node => node.id === nodeId);
    if (index < 0) fail('node', `not found: ${nodeId}`);
    if (!Number.isInteger(newIndex) || newIndex < 0 || newIndex >= frame.nodes.length) fail('layer index', 'outside the layer list');
    const [node] = frame.nodes.splice(index, 1);
    frame.nodes.splice(newIndex, 0, node);
  });
}

export function addFrame(document, options = {}) {
  object(options, 'frame options', ['name', 'width', 'height', 'fill']);
  return change(document, copy => {
    const frame = { id: makeId('frame'), name: `Widget ${copy.frames.length + 1}`, width: 400, height: 400, fill: '#ffffff', ...options, nodes: [] };
    copy.frames.push(frame);
    copy.activeFrameId = frame.id;
  });
}

export function removeFrame(document, frameId) {
  return change(document, copy => {
    getFrame(copy, frameId);
    if (copy.frames.length === 1) fail('frame', 'cannot remove the last frame');
    copy.frames = copy.frames.filter(frame => frame.id !== frameId);
    for(const frame of copy.frames)for(const node of frame.nodes){if(node.action.kind==='navigate'&&node.action.targetFrameId===frameId||node.action.formFrameId===frameId){node.action={kind:'none'};continue;}for(const key of ['targetFrameId','successFrameId','errorFrameId'])if(node.action[key]===frameId)delete node.action[key];}
    if (copy.activeFrameId === frameId) copy.activeFrameId = copy.frames[0].id;
    if (copy.entryFrameId === frameId) copy.entryFrameId = copy.frames[0].id;
  });
}

export function updateFrame(document, frameId, patch) {
  object(patch, 'frame patch', ['name', 'width', 'height', 'fill','layout','transition','flowHeight']);
  return change(document, copy => {const frame=getFrame(copy,frameId);if(own(patch,'height')&&!own(patch,'flowHeight'))delete frame.flowHeight;Object.assign(frame,patch);});
}

export function updateTheme(document,patch) {
  object(patch,'theme patch',Object.keys(DEFAULT_THEME));
  return change(document,copy=>{copy.theme={...copy.theme,...patch};});
}
export function updateEntryFrame(document,frameId) {
  return change(document,copy=>{getFrame(copy,frameId);copy.entryFrameId=frameId;});
}
export function collectDescendantIds(frame,nodeIds) {
  const chosen=new Set(nodeIds);let size;
  do{size=chosen.size;for(const node of frame.nodes)if(chosen.has(node.parentId))chosen.add(node.id);}while(size!==chosen.size);
  return [...chosen];
}
function createWorkflow(name) {
  const first=makeId('frame'),second=makeId('frame'),container=makeId('node'),input=makeId('node');
  const make=(type,patch)=>({...defaultNode(type),...(type==='text'?{heightMode:'hug'}:{}),...patch});
  const card={id:container,type:'rectangle',name:'Form container',x:0,y:0,width:360,height:240,widthMode:'fill',heightMode:'hug',layout:{direction:'vertical',padding:20,gap:14,wrap:true},styleRole:'surface',radius:12};
  return validateDocument({schemaVersion:1,id:makeId('project'),name,activeFrameId:first,entryFrameId:first,theme:DEFAULT_THEME,frames:[
    {id:first,name:'Create',width:400,height:350,fill:'#ffffff',layout:{direction:'vertical',padding:20,gap:16,wrap:true},nodes:[
      make('text',{name:'Title',text:'Make something useful',x:0,y:0,widthMode:'fill',styleRole:'heading',height:38}),
      make('rectangle',card),
      make('text',{name:'Description',text:'Design your widget, then connect it to a plugin.',parentId:container,widthMode:'fill',height:44,styleRole:'muted'}),
      make('input',{id:input,name:'Idea',text:'Your next idea',parentId:container,widthMode:'fill',styleRole:'field'}),
      make('button',{name:'Continue',text:'Continue',parentId:container,widthMode:'fill',styleRole:'accent',action:{kind:'navigate',targetFrameId:second},states:{hover:{opacity:0.85},disabled:{opacity:0.45}}})]},
    {id:second,name:'Review',width:400,height:350,fill:'#ffffff',layout:{direction:'vertical',padding:20,gap:16,wrap:true},nodes:[
      make('text',{name:'Review heading',text:'Ready to save',styleRole:'heading',widthMode:'fill',height:38}),
      make('text',{name:'Status',text:'Submit your idea to the demo tool.',styleRole:'body',widthMode:'fill',height:48,states:{loading:{text:'Saving your idea…'},error:{text:'Something went wrong. Please try again.',color:'#a32836'},success:{text:'Your idea was received.',color:'#24735c'}}}),
      make('button',{name:'Save idea',text:'Save idea',styleRole:'accent',widthMode:'fill',action:{kind:'tool',toolName:'save_idea',args:{title:{$input:input}}},states:{loading:{text:'Saving…'},error:{text:'Try again'},success:{text:'Save again'},hover:{opacity:0.85},disabled:{opacity:0.45}}}),
      make('button',{name:'Back',text:'Back to edit',widthMode:'fill',action:{kind:'navigate',targetFrameId:first}})]}
  ]});
}
