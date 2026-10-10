import {resolveFrame,createTextMeasurer} from './layout.js';
import {LIMITS} from './document.js';
import {initialBoundText} from './authoring-values.js';

const MIN_ZOOM = 0.01;
const MAX_ZOOM = 400;
const FRAME_GAP = 88;
const PLANE_PADDING = 96;
const LABEL_HEIGHT = 30;
const MIN_NODE_SIZE = 1;
const HANDLES = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];
const FONT_FAMILIES = {
  system: '-apple-system, BlinkMacSystemFont, "SF Pro Text", "SF Pro Display", "Segoe UI", sans-serif',
  serif: 'Georgia, "Times New Roman", serif',
  mono: 'ui-monospace, "SFMono-Regular", Menlo, Consolas, monospace',
};

const number = (value, fallback = 0) => Number.isFinite(Number(value)) ? Number(value) : fallback;
const round = value => Math.round(value * 100) / 100;
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const snapValue = value => Math.round(value / 8) * 8;
const editableTarget = target => target?.closest?.('input, textarea, select, [contenteditable="true"]');

/** Geometry stays in document pixels; only pointer deltas are divided by zoom. */
export function moveNodes(nodes, delta, { snap = false, axisLock = false } = {}) {
  let dx = number(delta.x);
  let dy = number(delta.y);
  if (axisLock) {
    if (Math.abs(dx) >= Math.abs(dy)) dy = 0;
    else dx = 0;
  }
  if (snap && nodes.length) {
    if (!axisLock || dx !== 0) dx = snapValue(number(nodes[0].x) + dx) - number(nodes[0].x);
    if (!axisLock || dy !== 0) dy = snapValue(number(nodes[0].y) + dy) - number(nodes[0].y);
  }
  if(nodes.length){
    dx=clamp(dx,Math.max(...nodes.map(node=>-LIMITS.position-number(node.x))),Math.min(...nodes.map(node=>LIMITS.position-number(node.x))));
    dy=clamp(dy,Math.max(...nodes.map(node=>-LIMITS.position-number(node.y))),Math.min(...nodes.map(node=>LIMITS.position-number(node.y))));
  }
  return nodes.map(node => ({ id: node.id, x: round(number(node.x) + dx), y: round(number(node.y) + dy) }));
}

export function resizeRect(rect, handle, delta, { snap = false, preserveAspect = false } = {}) {
  const original = { x: number(rect.x), y: number(rect.y), width: Math.max(MIN_NODE_SIZE, number(rect.width, MIN_NODE_SIZE)), height: Math.max(MIN_NODE_SIZE, number(rect.height, MIN_NODE_SIZE)) };
  let left = original.x;
  let top = original.y;
  let right = left + original.width;
  let bottom = top + original.height;
  const dx = number(delta.x);
  const dy = number(delta.y);
  if (handle.includes('w')) left += dx;
  if (handle.includes('e')) right += dx;
  if (handle.includes('n')) top += dy;
  if (handle.includes('s')) bottom += dy;
  if (snap) {
    if (handle.includes('w')) left = snapValue(left);
    if (handle.includes('e')) right = snapValue(right);
    if (handle.includes('n')) top = snapValue(top);
    if (handle.includes('s')) bottom = snapValue(bottom);
  }
  if (preserveAspect && handle.length === 2) {
    const ratio = original.width / original.height;
    let width = Math.max(MIN_NODE_SIZE, right - left);
    let height = Math.max(MIN_NODE_SIZE, bottom - top);
    if (Math.abs(width - original.width) / original.width >= Math.abs(height - original.height) / original.height) height = width / ratio;
    else width = height * ratio;
    const scale = Math.max(MIN_NODE_SIZE / width, MIN_NODE_SIZE / height, 1);
    width *= scale;
    height *= scale;
    if (handle.includes('w')) left = original.x + original.width - width;
    else right = original.x + width;
    if (handle.includes('n')) top = original.y + original.height - height;
    else bottom = original.y + height;
  }
  if (right - left < MIN_NODE_SIZE) {
    if (handle.includes('w')) left = right - MIN_NODE_SIZE;
    else right = left + MIN_NODE_SIZE;
  }
  if (bottom - top < MIN_NODE_SIZE) {
    if (handle.includes('n')) top = bottom - MIN_NODE_SIZE;
    else bottom = top + MIN_NODE_SIZE;
  }
  const anchorRight=original.x+original.width,anchorBottom=original.y+original.height;
  const minWidth=handle.includes('w')?Math.max(1,anchorRight-LIMITS.position):1,maxWidth=handle.includes('w')?Math.min(LIMITS.dimension,anchorRight+LIMITS.position):LIMITS.dimension;
  const minHeight=handle.includes('n')?Math.max(1,anchorBottom-LIMITS.position):1,maxHeight=handle.includes('n')?Math.min(LIMITS.dimension,anchorBottom+LIMITS.position):LIMITS.dimension;
  let width=clamp(right-left,minWidth,maxWidth),height=clamp(bottom-top,minHeight,maxHeight);
  if(preserveAspect&&handle.length===2){
    const factor=clamp((right-left)/original.width,Math.max(minWidth/original.width,minHeight/original.height),Math.min(maxWidth/original.width,maxHeight/original.height));
    width=original.width*factor;height=original.height*factor;
  }
  left=handle.includes('w')?anchorRight-width:original.x;top=handle.includes('n')?anchorBottom-height:original.y;
  return { x: round(left), y: round(top), width: round(width), height: round(height) };
}

/** Marquee encloses visible editable boxes; a contained parent is selected once. */
export function enclosedLayers(nodes,box){
  const hits=nodes.filter(node=>node.visible!==false&&!node.locked&&node.x>=box.x&&node.y>=box.y&&node.x+node.width<=box.x+box.width&&node.y+node.height<=box.y+box.height);
  const chosen=new Set(hits.map(node=>node.id)),byId=new Map(nodes.map(node=>[node.id,node]));
  return hits.filter(node=>{let parent=node.parentId;while(parent){if(chosen.has(parent))return false;parent=byId.get(parent)?.parentId;}return true;}).map(node=>node.id);
}

export function layoutFrames(frames) {
  let x = PLANE_PADDING;
  let maxHeight = 0;
  const layout = frames.map(frame => {
    const item = { id: frame.id, x, y: PLANE_PADDING + LABEL_HEIGHT, width: Math.max(1, number(frame.width, 480)), height: Math.max(1, number(frame.height, 360)) };
    x += item.width + FRAME_GAP;
    maxHeight = Math.max(maxHeight, item.height);
    return item;
  });
  return {
    frames: layout,
    width: frames.length ? x - FRAME_GAP + PLANE_PADDING : PLANE_PADDING * 2 + 480,
    height: PLANE_PADDING * 2 + LABEL_HEIGHT + Math.max(maxHeight, 360),
  };
}

function element(tag, className, text) {
  const el = document.createElement(tag);
  if (className) el.className = className;
  if (text !== undefined) el.textContent = text;
  return el;
}

function safeImageUrl(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  try {
    const url = new URL(value, document.baseURI);
    if (['http:', 'https:', 'blob:'].includes(url.protocol)) return url.href;
    if (/^data:image\/(png|jpeg|jpg|gif|webp|avif);base64,/i.test(value)) return value;
  } catch { /* Invalid URLs are represented by the placeholder. */ }
  return null;
}

function applyNodeStyle(el, node) {
  Object.assign(el.style, {
    left: `${number(node.relativeX??node.x)}px`, top: `${number(node.relativeY??node.y)}px`,
    width: `${Math.max(1, number(node.width, 120))}px`, height: `${Math.max(1, number(node.height, 40))}px`,
    backgroundColor: node.fill || 'transparent', color: node.color || '#20242c',
    fontFamily: FONT_FAMILIES[node.fontFamily] || FONT_FAMILIES.system,
    fontSize: `${number(node.fontSize, 14)}px`, fontWeight: String(node.fontWeight || 400), lineHeight:'1.4',
    borderRadius: `${Math.max(0, number(node.radius))}px`,
    borderStyle: number(node.strokeWidth) > 0 ? 'solid' : 'none',
    borderWidth: `${Math.max(0, number(node.strokeWidth))}px`, borderColor: node.stroke || 'transparent',
    textAlign: ['left', 'center', 'right'].includes(node.textAlign) ? node.textAlign : 'left',
    opacity: String(clamp(number(node.opacity, 1), 0, 1)),
  });
}

function renderNode(node, frameId) {
  const el = element('div', `wui-node wui-node--${node.type}`);
  el.dataset.nodeId = node.id;
  el.dataset.frameId = frameId;
  el.dataset.nodeType = node.type;
  if(node.type==='input'&&node.multiline)el.classList.add('is-multiline');
  el.dataset.locked = String(Boolean(node.locked));
  el.setAttribute('role', 'button');
  el.setAttribute('aria-label', `${node.name || node.type}${node.locked ? ', locked' : ''}`);
  el.tabIndex = -1;
  applyNodeStyle(el, node);
  if (node.type === 'image') {
    const src = safeImageUrl(node.src || node.imageUrl || node.url);
    if (src) {
      const img = element('img', 'wui-node-image');
      img.src = src;
      img.alt = node.text || node.name || '';
      img.draggable = false;
      img.style.objectFit=node.imageFit||'cover';img.style.objectPosition=node.imagePosition||'center';
      img.addEventListener('error', () => {
        img.remove();
        el.append(element('span', 'wui-image-placeholder', 'Image unavailable · replace in Image properties'));
      }, { once: true });
      el.append(img);
    } else el.append(element('span', 'wui-image-placeholder', 'Image'));
  } else if(node.type==='checkbox'){
    const mark=element('span','wui-check-mark'+(node.controlVariant==='switch'?' is-switch':'')+(node.checked?' is-checked':''),node.controlVariant==='switch'?'':node.checked?'✓':'');
    el.append(mark,element('span','wui-node-content',node.text));
  } else if(node.type==='select'){
    el.append(element('span','wui-node-content',node.initialValue||node.text||'Choose an option'),element('span','wui-select-arrow','▾'));
  } else if(node.type==='list'){
    const header=element('div','wui-task-header');header.append(element('strong','',node.text),element('span','wui-task-count',(node.items||[]).length+' tasks · 0 complete'));el.append(header);
    for(const title of node.items||[]){const row=element('div','wui-task-row');row.append(element('span','wui-check-mark'),element('span','wui-task-title',title),element('span','wui-task-remove','Remove'));el.append(row);}
    if(!node.items?.length)el.append(element('div','wui-task-empty','No tasks yet. Add your first task below.'));
    const composer=element('div','wui-task-composer');composer.append(element('span','wui-task-title','Add a task…'),element('span','wui-task-add','Add task'));el.append(composer);
  } else if (node.type === 'input') {
    const content = element('span', 'wui-node-content', node.initialValue || node.text || '');
    el.append(content);
  } else if (node.type !== 'rectangle' && node.type !== 'divider') {
    el.append(element('span', 'wui-node-content', node.text || ''));
  }
  return el;
}

/** Native DOM canvas for authoring. onCommit is a single history transaction. */
export function createCanvas(container, callbacks = {}) {
  if (!container?.append) throw new TypeError('Canvas requires a DOM container.');
  const viewport = element('div', 'wui-canvas');
  viewport.tabIndex = 0;
  viewport.setAttribute('role', 'region');
  viewport.setAttribute('aria-label', 'Widget design canvas');
  viewport.setAttribute('aria-description','Drag empty space around layers to select them in this view. Shift adds layers. Escape cancels a drag. Space and drag pans.');
  const stage = element('div', 'wui-canvas-stage');
  const plane = element('div', 'wui-canvas-plane');
  const live = element('div', 'wui-canvas-live');
  live.setAttribute('aria-live', 'polite');
  stage.append(plane);
  viewport.append(stage, live);
  container.append(viewport);
  let doc = null;
  let selection = [];
  let activeFrameId = null;
  let zoom = 100;
  let snap = false;
  let spacePressed = false;
  let tool = 'select';
  let camera = {x:0,y:0};
  let suppressClick = false;
  let spaceTarget = null;
  let spacePanned = false;
  let keyboardFocus = false;
  let interaction = null;
  let editing = null;
  let layout = layoutFrames([]);
  let destroyed = false;
  const nodeEls = new Map();
  const overlayEls = new Map();
  const frameEls = new Map();
  const geometry = new Map();
  const measureText = createTextMeasurer(container.ownerDocument);
  let visualState = 'default';

  const frameById = id => doc?.frames?.find(frame => frame.id === id);
  const nodeById = (id, frameId = activeFrameId) => frameById(frameId)?.nodes?.find(node => node.id === id);
  const key = (frameId, id) => `${frameId}:${id}`;

  function updateScale() {
    const scale = zoom / 100;
    plane.style.transform = `translate(${camera.x}px, ${camera.y}px) scale(${scale})`;
    plane.style.width = `${layout.width}px`;
    plane.style.height = `${layout.height}px`;
    plane.style.setProperty('--wui-inverse-zoom', String(1 / scale));
    viewport.dataset.cameraX = String(camera.x);
    viewport.dataset.cameraY = String(camera.y);
    viewport.dataset.zoom = String(zoom);
  }

  function setZoom(percent, anchor) {
    finishInteraction(false);
    const next = Math.round(clamp(number(percent, zoom), MIN_ZOOM, MAX_ZOOM) * 100) / 100;
    const previousScale = zoom / 100;
    const nextScale = next / 100;
    const point = anchor || { x: viewport.clientWidth / 2, y: viewport.clientHeight / 2 };
    const worldX = (point.x - camera.x) / previousScale;
    const worldY = (point.y - camera.y) / previousScale;
    zoom = next;
    camera = {x:point.x-worldX*nextScale,y:point.y-worldY*nextScale};
    updateScale();
    drawSelection();
    callbacks.onZoomChange?.(zoom);
    return zoom;
  }

  function select(ids, frameId) {
    selection = [...new Set(ids)];
    activeFrameId = frameId;
    for(const [id,board] of frameEls){board.parentElement.classList.toggle('is-active',id===frameId);board.parentElement.querySelector('.wui-frame-label')?.setAttribute('aria-pressed',String(id===frameId));}
    drawSelection();
    callbacks.onSelect?.([...selection], frameId);
  }

  function previewNode(id, frameId, patch) {
    const changes = interaction?.patches || [{id,patch}];
    const frame = frameById(frameId);
    if(!frame)return;
    const next={...frame,nodes:frame.nodes.map(node=>({...node,...(changes.find(item=>item.id===node.id)?.patch || {})}))};
    previewFrame(frameId,next);
  }

  function previewFrame(frameId,next) {
    const resolved=resolveFrame(next,next.width,{theme:doc.theme,readText:(_id,node)=>initialBoundText(doc,node),state:visualState,measureText});
    for(const node of resolved.nodes) {
      geometry.set(key(frameId,node.id),node);
      const el=nodeEls.get(key(frameId,node.id));if(el)applyNodeStyle(el,node);
      const overlay=overlayEls.get(key(frameId,node.id));
      if(overlay)Object.assign(overlay.style,{left:node.x+'px',top:node.y+'px',width:node.width+'px',height:node.height+'px'});
    }
    const board=frameEls.get(frameId);if(board)board.style.height=resolved.height+'px';
  }

  function drawSelection() {
    for (const overlay of overlayEls.values()) overlay.remove();
    overlayEls.clear();
    for (const nodeEl of nodeEls.values()) nodeEl.classList.remove('is-selected');
    const frame = frameById(activeFrameId);
    const frameEl = frameEls.get(activeFrameId);
    if (!frame || !frameEl) return;
    for (const id of selection) {
      const node = geometry.get(key(frame.id,id));
      if (!node) continue;
      nodeEls.get(key(frame.id, id))?.classList.add('is-selected');
      const overlay = element('div', `wui-selection${node.locked ? ' is-locked' : ''}`);
      overlay.dataset.nodeId = id;
      overlay.dataset.frameId = frame.id;
      Object.assign(overlay.style, { left: `${number(node.x)}px`, top: `${number(node.y)}px`, width: `${number(node.width, 120)}px`, height: `${number(node.height, 40)}px` });
      if (selection.length === 1 && !node.locked) {
        const parent=node.parentId?frame.nodes.find(item=>item.id===node.parentId):null,flow=(parent?.layout||frame.layout)?.direction;
        const editable=HANDLES.filter(handle=>(!flow||flow==='free'||['e','s','se'].includes(handle))&&!(['fill','hug'].includes(node.widthMode)&&/[ew]/.test(handle))&&!(node.heightMode==='hug'&&/[ns]/.test(handle)));
        const thinX=node.width*zoom/100<24,thinY=node.height*zoom/100<24;
        // Small projections cannot fit eight targets. Keep separated edge targets
        // (or one useful corner for tiny boxes) so width drags do not hit a corner.
        const separated=thinX&&thinY?[]:editable.filter(handle=>!(thinY&&/[ns]/.test(handle))&&!(thinX&&/[ew]/.test(handle)));
        const handles=separated.length?separated:[['se','e','s','nw','w','n'].find(handle=>editable.includes(handle))].filter(Boolean);
        for (const handle of handles) {
          const control = element('span', `wui-resize-handle wui-resize-handle--${handle}`);
          control.dataset.handle = handle;
          control.dataset.nodeId = id;
          control.dataset.frameId = frame.id;
          control.setAttribute('aria-hidden', 'true');
          overlay.append(control);
        }
        const dimensions = element('span', 'wui-selection-dimensions', `${round(number(node.width))} × ${round(number(node.height))}`);
        overlay.append(dimensions);
      }
      frameEl.append(overlay);
      overlayEls.set(key(frame.id, id), overlay);
    }
  }

  function draw() {
    nodeEls.clear();
    frameEls.clear();
    overlayEls.clear();
    geometry.clear();
    plane.replaceChildren();
    const frames=(doc?.frames||[]).map(frame=>resolveFrame(frame,frame.width,{theme:doc.theme,readText:(_id,node)=>initialBoundText(doc,node),state:visualState,measureText}));
    layout = layoutFrames(frames);
    for (const frame of frames) {
      const position = layout.frames.find(item => item.id === frame.id);
      const group = element('section', `wui-frame-group${frame.id === activeFrameId ? ' is-active' : ''}`);
      group.dataset.frameId = frame.id;
      Object.assign(group.style, { left: `${position.x}px`, top: `${position.y - LABEL_HEIGHT}px`, width: `${position.width}px` });
      const label = element('button', 'wui-frame-label');
      label.type = 'button';
      label.dataset.frameLabel = frame.id;
      label.append(element('span', 'wui-frame-name', frame.name || 'Frame'), element('span', 'wui-frame-size', `${round(position.width)} × ${round(position.height)}`));
      label.setAttribute('aria-pressed', String(frame.id === activeFrameId));
      const artboard = element('div', 'wui-artboard');
      artboard.dataset.artboard = frame.id;
      Object.assign(artboard.style, { width: `${position.width}px`, height: `${position.height}px`, backgroundColor: frame.fill || '#ffffff' });
      const content = element('div', 'wui-artboard-content');
      for (const node of frame.nodes || []) {
        if (node.visible === false) continue;
        const nodeEl = renderNode(node, frame.id);
        geometry.set(key(frame.id,node.id),node);
        (node.parentId ? nodeEls.get(key(frame.id,node.parentId)) : content).append(nodeEl);
        nodeEls.set(key(frame.id, node.id), nodeEl);
      }
      artboard.append(content);
      group.append(label, artboard);
      plane.append(group);
      frameEls.set(frame.id, artboard);
    }
    drawSelection();
    updateScale();
    if (interaction?.patches) for (const patch of interaction.patches) previewNode(patch.id, patch.frameId, patch.patch);
    if (editing) mountEditor();
  }

  function finishEditor(commit, focusCanvas = false) {
    if (!editing) return;
    const session = editing;
    const text = session.el?.value ?? session.value;
    editing = null;
    session.el?.remove();
    nodeEls.get(key(session.frameId, session.id))?.classList.remove('is-editing');
    if (commit && text !== session.original) callbacks.onEditText?.(session.id, text, session.frameId);
    drawSelection();
    if (focusCanvas) viewport.focus({ preventScroll: true });
  }

  function mountEditor() {
    const node = geometry.get(key(editing.frameId,editing.id));
    const artboard = frameEls.get(editing.frameId);
    if (!node || !artboard || node.visible === false || node.locked) { editing = null; return; }
    const previous = editing.el;
    const start = previous?.selectionStart;
    const end = previous?.selectionEnd;
    editing.value = previous?.value ?? editing.value;
    const editor = element('textarea', 'wui-inline-editor');
    editor.maxLength = 20000;
    editor.value = editing.value;
    editor.spellcheck = false;
    editor.setAttribute('aria-label', `Edit ${node.name || 'text'}`);
    applyNodeStyle(editor, node);
    editor.style.left=node.x+'px';editor.style.top=node.y+'px';
    editor.style.backgroundColor = node.fill && node.fill !== 'transparent' ? node.fill : 'transparent';
    editor.addEventListener('pointerdown', event => event.stopPropagation());
    editor.addEventListener('keydown', event => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') return;
      event.stopPropagation();
      if (event.key === 'Escape') { event.preventDefault(); finishEditor(false, true); }
      else if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); finishEditor(true, true); }
    });
    editor.addEventListener('blur', () => { if (editing?.el === editor) finishEditor(true); });
    editing.el = editor;
    nodeEls.get(key(editing.frameId, editing.id))?.classList.add('is-editing');
    artboard.append(editor);
    editor.focus({ preventScroll: true });
    if (start !== undefined) editor.setSelectionRange(start, end);
    else editor.select();
  }

  function beginEditor(id, frameId) {
    const node = geometry.get(key(frameId,id));
    if (!node || node.type !== 'text' || node.locked) return;
    finishEditor(true);
    select([id], frameId);
    const value=node.textBindingId?(nodeById(id,frameId)?.states?.[visualState]?.text??nodeById(id,frameId)?.text??''):node.text||'';
    editing = { id, frameId, original: value, value, el: null };
    mountEditor();
  }

  function pointerDown(event) {
    keyboardFocus=false;
    if (event.button !== 0 && event.button !== 1) return;
    if(interaction)return;
    if (editableTarget(event.target)) return;
    suppressClick = false;
    if (tool === 'hand' || spacePressed || event.button === 1) {
      if(spacePressed)spacePanned=true;
      event.preventDefault();
      finishEditor(true);
      interaction = { type: 'pan', pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, camera:{...camera} };
      capturePointer(interaction);
      viewport.classList.add('is-panning');
      return;
    }
    const handle = event.target.closest('[data-handle]');
    const nodeEl = event.target.closest('.wui-node');
    const label = event.target.closest('[data-frame-label]');
    const artboard = event.target.closest('[data-artboard]');
    if (label) {
      event.preventDefault();
      activateFrameLabel(label.dataset.frameLabel);
      return;
    }
    viewport.focus({ preventScroll: true });
    if (handle) {
      const { nodeId: id, frameId, handle: direction } = handle.dataset;
      const node = nodeById(id, frameId);
      if (!node || geometry.get(key(frameId,id))?.locked) return;
      event.preventDefault();
      interaction = { type: 'resize', pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, frameId, direction, nodes: [{ ...node }], patches: [] };
      viewport.classList.add('is-resizing');
      return;
    }
    if (!nodeEl) {
      event.preventDefault();finishEditor(true);
      const point=canvasPoint(event),frameId=artboard?.dataset.artboard||activeFrameId;
      interaction={type:'marquee',pointerId:event.pointerId,startX:event.clientX,startY:event.clientY,origin:point,frameId,originalFrameId:activeFrameId,originalSelection:[...selection],baseSelection:event.shiftKey&&frameId===activeFrameId?[...selection]:[],additive:event.shiftKey,moved:false,box:null};
      return;
    }
    event.preventDefault();
    const { nodeId: id, frameId } = nodeEl.dataset;
    const node = nodeById(id, frameId);
    if (!node) return;
    let next = activeFrameId === frameId ? [...selection] : [];
    if (event.shiftKey) next = next.includes(id) ? next.filter(item => item !== id) : [...next, id];
    else if (!next.includes(id)) next = [id];
    select(next, frameId);
    if (geometry.get(key(frameId,id))?.locked || !next.includes(id)) return;
    const frame=frameById(frameId);
    const rule=node.parentId?frame.nodes.find(item=>item.id===node.parentId)?.layout:frame.layout;
    if(rule?.direction && rule.direction!=='free' && next.length===1) {
      const siblings=frame.nodes.filter(item=>(item.parentId||null)===(node.parentId||null)&&item.visible!==false);
      interaction={type:'reorder',pointerId:event.pointerId,startX:event.clientX,startY:event.clientY,frameId,nodes:[{...node}],patches:[],moved:false,
        originalIndex:frame.nodes.findIndex(item=>item.id===id),index:frame.nodes.findIndex(item=>item.id===id),
        slots:siblings.map(item=>{const box=geometry.get(key(frameId,item.id));return {id:item.id,x:box.x+box.width/2,y:box.y+box.height/2};})};
      return;
    }
    const nodes = frame?.nodes.filter(item => {
      if(!next.includes(item.id)||geometry.get(key(frameId,item.id))?.locked||item.visible===false)return false;
      let parent=item.parentId;
      while(parent){if(next.includes(parent))return false;parent=frame.nodes.find(node=>node.id===parent)?.parentId;}
      const rule=item.parentId?frame.nodes.find(node=>node.id===item.parentId)?.layout:frame.layout;
      return !rule?.direction||rule.direction==='free';
    }).map(item => ({ ...item })) || [];
    if (!nodes.length) return;
    interaction = { type: 'move', pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, frameId, nodes, patches: [], moved: false };
  }

  function canvasPoint(event){const bounds=viewport.getBoundingClientRect(),scale=zoom/100;return {x:(event.clientX-bounds.left-camera.x)/scale,y:(event.clientY-bounds.top-camera.y)/scale};}
  function capturePointer(current){if(current.captured)return;try{viewport.setPointerCapture?.(current.pointerId);current.captured=true;}catch{/* Synthetic events and unavailable capture still use window listeners. */}}

  function pointerMove(event) {
    if (!interaction || event.pointerId !== interaction.pointerId) return;
    const current = interaction;
    const dx = event.clientX - current.startX;
    const dy = event.clientY - current.startY;
    if (current.type === 'pan') {
      camera = {x:current.camera.x+dx,y:current.camera.y+dy};
      updateScale();
      return;
    }
    if (Math.abs(dx) + Math.abs(dy) < 3 && !current.moved) return;
    current.moved = true;
    capturePointer(current);
    if(current.type==='marquee'){
      const point=canvasPoint(event),box={x:Math.min(point.x,current.origin.x),y:Math.min(point.y,current.origin.y),width:Math.abs(point.x-current.origin.x),height:Math.abs(point.y-current.origin.y)};
      if(!current.box){current.box=element('div','wui-marquee');current.box.setAttribute('aria-hidden','true');plane.append(current.box);}
      Object.assign(current.box.style,{left:box.x+'px',top:box.y+'px',width:box.width+'px',height:box.height+'px'});
      const frame=layout.frames.find(item=>item.id===current.frameId);
      if(frame){const nodes=(frameById(current.frameId)?.nodes||[]).map(node=>geometry.get(key(current.frameId,node.id))).filter(Boolean),hits=enclosedLayers(nodes,{...box,x:box.x-frame.x,y:box.y-frame.y});const ids=[...new Set([...current.baseSelection,...hits])];
        if(activeFrameId!==current.frameId||ids.join(':')!==selection.join(':'))select(ids,current.frameId);
      }
      return;
    }
    viewport.classList.add(current.type === 'resize' ? 'is-resizing' : 'is-moving');
    const delta = { x: dx / (zoom / 100), y: dy / (zoom / 100) };
    if(current.type==='reorder') {
      const origin=current.slots.find(item=>item.id===current.nodes[0].id);
      const point={x:origin.x+delta.x,y:origin.y+delta.y};
      const nearest=current.slots.reduce((best,item)=>Math.hypot(item.x-point.x,item.y-point.y)<Math.hypot(best.x-point.x,best.y-point.y)?item:best);
      const frame=frameById(current.frameId);
      current.index=frame.nodes.findIndex(item=>item.id===nearest.id);
      const nodes=[...frame.nodes],source=nodes.splice(current.originalIndex,1)[0];nodes.splice(current.index,0,source);
      previewFrame(current.frameId,{...frame,nodes});
      return;
    }
    if (current.type === 'move') {
      current.patches = moveNodes(current.nodes, delta, { snap, axisLock: event.shiftKey }).map(node => ({ id: node.id, frameId: current.frameId, patch: { x: node.x, y: node.y } }));
    } else {
      current.patches = [{ id: current.nodes[0].id, frameId: current.frameId, patch: resizeRect(current.nodes[0], current.direction, delta, { snap, preserveAspect: event.shiftKey }) }];
    }
    for (const patch of current.patches) previewNode(patch.id, patch.frameId, patch.patch);
    if (current.type === 'resize') {
      const patch = current.patches[0];
      const dimensions = overlayEls.get(key(patch.frameId, patch.id))?.querySelector('.wui-selection-dimensions');
      const resolved=geometry.get(key(patch.frameId,patch.id));
      if (dimensions&&resolved) dimensions.textContent = `${round(resolved.width)} × ${round(resolved.height)}`;
    }
  }

  function finishInteraction(commit,notifySelection=true) {
    if (!interaction) return;
    const current = interaction;
    interaction = null;
    if(current.captured){try{if(viewport.hasPointerCapture?.(current.pointerId))viewport.releasePointerCapture(current.pointerId);}catch{/* Already released by the browser. */}}
    viewport.classList.remove('is-moving', 'is-resizing', 'is-panning');
    if(current.type==='pan'){
      suppressClick = true;
      if(!commit){camera={...current.camera};updateScale();}
      return;
    }
    if(current.type==='marquee'){
      current.box?.remove();
      if(!commit){if(notifySelection)select(current.originalSelection,current.originalFrameId);}
      else if(!current.moved)select(current.additive?current.baseSelection:[],current.frameId);
      if(commit)live.textContent=`Selected ${selection.length} layer${selection.length===1?'':'s'}.`;
      return;
    }
    if(current.type==='reorder') {
      if(commit && current.index!==current.originalIndex && callbacks.onReorder) {
        try{callbacks.onReorder({frameId:current.frameId,nodeId:current.nodes[0].id,index:current.index});}catch(error){draw();callbacks.onError?.(error);live.textContent='Reorder was not applied.';return;}
        live.textContent='Reordered '+current.nodes[0].name+'.';
      } else if(current.moved)draw();
      return;
    }
    const patches = current.patches?.filter(item => {
      const original = current.nodes.find(node => node.id === item.id);
      return Object.entries(item.patch).some(([prop, value]) => value !== number(original[prop]));
    }) || [];
    if (commit && patches.length) {
      try{callbacks.onCommit?.(patches);}catch(error){draw();callbacks.onError?.(error);live.textContent='Edit was not applied.';return;}
      live.textContent = `${current.type === 'resize' ? 'Resized' : 'Moved'} ${patches.length === 1 ? 'layer' : `${patches.length} layers`}.`;
    // A click must retain its target until the browser dispatches dblclick.
    // Only a real gesture has temporary geometry that needs to be restored.
    } else if (current.type !== 'pan' && current.moved) draw();
  }

  function pointerUp(event) { if (event.pointerId === interaction?.pointerId) finishInteraction(true); }
  function cancelGesture(){
    const active=Boolean(interaction);finishInteraction(false);
    spacePressed=false;spaceTarget=null;viewport.classList.toggle('can-pan',tool==='hand');
    return active;
  }
  function pointerCancel(event) { if (event.pointerId === interaction?.pointerId) cancelGesture(); }
  function lostCapture(event){if(event.pointerId===interaction?.pointerId)cancelGesture();}
  function doubleClick(event) {
    if(tool==='hand'||spacePressed||suppressClick)return;
    const node = event.target.closest('.wui-node');
    if (node) { event.preventDefault(); beginEditor(node.dataset.nodeId, node.dataset.frameId); }
  }
  function activateFrameLabel(frameId) {
    finishEditor(true);
    select([], frameId);
    callbacks.onFrameSelect?.(frameId);
    frameEls.get(frameId)?.parentElement.querySelector('.wui-frame-label')?.focus({preventScroll:true});
  }
  function clickFrame(event) {
    if(suppressClick||tool==='hand'||spacePressed){event.preventDefault();suppressClick=false;return;}
    const label=event.target.closest('[data-frame-label]');
    if(label)activateFrameLabel(label.dataset.frameLabel);
  }
  function keyDown(event) {
    if(event.key==='Tab')keyboardFocus=true;
    if (editableTarget(event.target)||event.target.closest?.('dialog')) return;
    if (event.code === 'Space' && !event.metaKey && !event.ctrlKey) {
      if(!spacePressed){spaceTarget=event.target.closest?.('button');spacePanned=false;}
      spacePressed = true;
      viewport.classList.add('can-pan');
      event.preventDefault();
    }
    if (event.key === 'Escape') {
      if(interaction){event.preventDefault();finishInteraction(false);}
      spacePressed=false;viewport.classList.toggle('can-pan',tool==='hand');
      spaceTarget=null;
    }
  }
  function keyUp(event) {
    if (event.code === 'Space' && spacePressed) {
      event.preventDefault();spacePressed=false;
      if(interaction?.type==='pan')finishInteraction(true);
      viewport.classList.toggle('can-pan',tool==='hand');
      const target=spaceTarget;spaceTarget=null;
      if(!spacePanned&&target?.isConnected&&!target.disabled)target.click();
    }
  }
  function windowBlur() {
    spacePressed = false;
    spaceTarget=null;
    viewport.classList.toggle('can-pan',tool==='hand');
    finishInteraction(false);
  }
  function revealKeyboardFocus(event){
    if(!keyboardFocus||!event.target.matches?.('[data-frame-label]'))return;
    // Cancellation restores the starting camera; measure the resulting bounds.
    finishInteraction(false);
    const bounds=viewport.getBoundingClientRect(),target=event.target.getBoundingClientRect(),gutter=24;
    const width=Math.min(target.width,Math.max(1,bounds.width-gutter*2));
    let dx=0,dy=0;
    if(target.left<bounds.left+gutter)dx=bounds.left+gutter-target.left;
    else if(target.left+width>bounds.right-gutter)dx=bounds.right-gutter-target.left-width;
    if(target.top<bounds.top+gutter)dy=bounds.top+gutter-target.top;
    else if(target.bottom>bounds.bottom-gutter)dy=bounds.bottom-gutter-target.bottom;
    if(dx||dy){camera={x:camera.x+dx,y:camera.y+dy};updateScale();}
  }
  function wheel(event) {
    event.preventDefault();
    if (!event.metaKey && !event.ctrlKey) {
      finishInteraction(false);
      const units=event.deltaMode===1?16:event.deltaMode===2?viewport.clientHeight:1;
      camera={x:camera.x-(event.shiftKey&&!event.deltaX?event.deltaY:event.deltaX)*units,y:camera.y-(event.shiftKey&&!event.deltaX?0:event.deltaY)*units};
      updateScale();return;
    }
    const bounds = viewport.getBoundingClientRect();
    setZoom(zoom * Math.exp(-event.deltaY * 0.002), { x: event.clientX - bounds.left, y: event.clientY - bounds.top });
  }

  viewport.addEventListener('pointerdown', pointerDown);
  viewport.addEventListener('lostpointercapture',lostCapture);
  viewport.addEventListener('dblclick', doubleClick);
  viewport.addEventListener('click', clickFrame);
  viewport.addEventListener('focusin',revealKeyboardFocus);
  viewport.addEventListener('wheel', wheel, { passive: false });
  window.addEventListener('pointermove', pointerMove);
  window.addEventListener('pointerup', pointerUp);
  window.addEventListener('pointercancel', pointerCancel);
  window.addEventListener('keydown', keyDown);
  window.addEventListener('keyup', keyUp);
  window.addEventListener('blur', windowBlur);
  const observer = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(updateScale) : null;
  observer?.observe(viewport);

  function fitBounds(boxes) {
    if(!boxes.length)return zoom;
    const left=Math.min(...boxes.map(box=>box.x)),top=Math.min(...boxes.map(box=>box.y));
    const right=Math.max(...boxes.map(box=>box.x+box.width)),bottom=Math.max(...boxes.map(box=>box.y+box.height));
    const width=Math.max(1,viewport.clientWidth-96),height=Math.max(1,viewport.clientHeight-144);
    // Round down so fitting never pushes a valid edge outside the available area.
    zoom=clamp(Math.floor(Math.min(width/Math.max(1,right-left),height/Math.max(1,bottom-top))*10000)/100,MIN_ZOOM,MAX_ZOOM);
    const scale=zoom/100;
    camera={x:viewport.clientWidth/2-(left+right)/2*scale,y:(viewport.clientHeight-48)/2-(top+bottom)/2*scale};
    updateScale();
    drawSelection();
    callbacks.onZoomChange?.(zoom);
    return zoom;
  }
  const frameBox=frame=>({...frame,y:frame.y-LABEL_HEIGHT,height:frame.height+LABEL_HEIGHT});

  return {
    render(document, state = {}) {
      if (destroyed) return;
      // The owner already chose new document/selection state; do not report an
      // old marquee's restored IDs into that newly selected project.
      if(interaction && document!==doc)finishInteraction(false,false);
      doc = document;
      activeFrameId = state.activeFrameId || document?.activeFrameId || document?.frames?.[0]?.id || null;
      selection = Array.isArray(state.selectedIds) ? [...state.selectedIds] : selection;
      visualState = state.previewState || state.state || 'default';
      draw();
    },
    setZoom,
    getZoom: () => zoom,
    getCamera: () => ({...camera}),
    setTool(value){
      finishInteraction(false);spacePressed=false;spaceTarget=null;suppressClick=false;tool=value==='hand'?'hand':'select';
      viewport.classList.toggle('can-pan',tool==='hand');viewport.dataset.tool=tool;
    },
    cancelInteraction:cancelGesture,
    flushEdits() { finishEditor(true); },
    setSnap(enabled) { snap = Boolean(enabled); viewport.classList.toggle('has-grid', snap); },
    fit() {
      finishInteraction(false);
      if (!doc?.frames?.length) return zoom;
      const frame = layout.frames.find(item => item.id === activeFrameId) || layout.frames[0];
      return fitBounds([frameBox(frame)]);
    },
    fitAll() {finishInteraction(false);return fitBounds(layout.frames.map(frameBox));},
    fitSelection() {
      finishInteraction(false);
      const frame=layout.frames.find(item=>item.id===activeFrameId);
      if(!frame)return zoom;
      const boxes=selection.map(id=>geometry.get(key(activeFrameId,id))).filter(Boolean).map(node=>({x:frame.x+node.x,y:frame.y+node.y,width:node.width,height:node.height}));
      return fitBounds(boxes.length?boxes:[frameBox(frame)]);
    },
    destroy() {
      destroyed = true;
      editing = null;
      interaction = null;
      observer?.disconnect();
      measureText.destroy();
      viewport.removeEventListener('pointerdown', pointerDown);
      viewport.removeEventListener('lostpointercapture',lostCapture);
      viewport.removeEventListener('dblclick', doubleClick);
      viewport.removeEventListener('click', clickFrame);
      viewport.removeEventListener('focusin',revealKeyboardFocus);
      viewport.removeEventListener('wheel', wheel);
      window.removeEventListener('pointermove', pointerMove);
      window.removeEventListener('pointerup', pointerUp);
      window.removeEventListener('pointercancel', pointerCancel);
      window.removeEventListener('keydown', keyDown);
      window.removeEventListener('keyup', keyUp);
      window.removeEventListener('blur', windowBlur);
      viewport.remove();
    },
  };
}
