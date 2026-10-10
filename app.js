import {createDocument,validateDocument,cloneDocument,getFrame,getNode,addNode,updateNode,removeNodes,duplicateNodes,reorderNode,addFrame,removeFrame,updateFrame,updateTheme,updateEntryFrame,collectDescendantIds,defaultNode,STATE_NAMES} from './document.js';
import {BrowserLibrary,LEGACY_CURRENT,EMERGENCY_PREFIX,keepEmergency,readEmergencies} from './browser-library.js';
import {libraryShell,libraryRows} from './library-ui.js';
import {createCanvas} from './canvas.js';
import {createPreviewHTML,newPreviewSession} from './preview.js';
import {parsePreviewAction,parsePreviewInfo} from './preview-events.js';
import {resolveFrame,createTextMeasurer} from './layout.js';
import {inspectorHTML,themeHTML} from './inspector.js';
import {captureLayerClipboard,pasteLayerClipboard} from './clipboard.js';
import {decorateTools,typeIcons} from './icons.js';
import {showMixedProperties} from './batch-properties.js';
import {SavedBlocks} from './saved-blocks.js';
import {localTargets} from './behavior-authoring.js';
import {initialBoundText} from './authoring-values.js';
import {exportReadiness} from './export.js';
import {parsePreviewSession,mergePreviewSession} from './preview-session.js';
import {wrapLayers,unwrapLayers,distributeLayers,duplicateView,reorderView} from './organize.js';
import {projectFetch,browserStorage,savedLocation} from './project-api.js';

const $=id=>document.getElementById(id);
const escape=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const stateProperties=new Set(['fill','color','opacity','text','strokeWidth','stroke','fontSize','fontWeight']);
const sharedProperties=['fill','color','fontFamily','fontSize','fontWeight','strokeWidth'];
const collapsedLayers=new Set();
const measureText=createTextMeasurer(document);
let authoringState='default',previewOptions=null,lastInlineError=null;
const previewSessions=new Map();
function rememberPreviewSession(){if(previewOptions)previewSessions.set(working.key,{...previewOptions,events:[...previewOptions.events]});}
const invalidFields=new Map();
let library,doc,selected=[],undoStack=[],redoStack=[],savedHash=null,draftHash=null,clipboard=null,toastTimer,saveTimer,currentTab='layers',inspectorTab='design',draggedLayer=null,editSession=null,modalSequence=0;
let working,editorClosed=false,choiceSequence=0,persistQueue=Promise.resolve(),saving=false,savingContext=null,savingDone=Promise.resolve(),libraryData=null,libraryFilter='all',libraryQuery='',recoveryWarnings=[];
let blocksPromise=null,pendingBlock=null,modalReturnFocus=null,pendingModalOpener=null;
function savedBlocks(){return blocksPromise??=(SavedBlocks.open(window.indexedDB).catch(error=>{blocksPromise=null;throw error;}));}
let session;
try{session=window.sessionStorage.getItem('widget-studio:session');if(!session){session=defaultNode('rectangle').id;window.sessionStorage.setItem('widget-studio:session',session);}}catch{session=defaultNode('rectangle').id;}
function newWorking(record=null){return {key:record?.key||defaultNode('rectangle').id,version:record?.version||0,baseRevision:record?.baseRevision||0,persisted:record?hash(record.document):null,clean:record?.kind==='saved'?hash(record.document):null,touched:Boolean(record)};}
try{
  library=await BrowserLibrary.open({indexedDB:window.indexedDB});
  recoveryWarnings.push(...await library.importLegacy(localStorage,session),...await library.importEmergencies(localStorage,session));
  const current=await library.current(session);editorClosed=Boolean(current?.closed);
  doc=current?.document||createDocument('Untitled widget','card');working=newWorking(current?.document?current:null);savedHash=working.clean;draftHash=working.persisted;
}catch(error){
  recoveryWarnings.push(error.message);let recovered=null;
  try{recovered=readEmergencies(localStorage)[0]||null;const raw=localStorage.getItem(LEGACY_CURRENT);if(!recovered&&raw)recovered={document:validateDocument(JSON.parse(raw)),baseRevision:0};}catch{recoveryWarnings.push('Unreadable browser data was preserved. Download recovery data from the library.');}
  doc=recovered?.document||createDocument('Untitled widget','card');working=newWorking();working.baseRevision=recovered?.baseRevision||0;working.touched=Boolean(recovered);
}
const canvas=createCanvas($('canvas-stage'),{
  onSelect(ids,frameId){finishEdit();doc={...doc,activeFrameId:frameId};selected=ids;renderPanels();},
  onFrameSelect(frameId){finishEdit();doc={...doc,activeFrameId:frameId};selected=[];render();},
  onCommit(patches){let next=doc;for(const item of patches)next=updateNode(next,item.frameId,item.id,item.patch);commit(next);},
  onFrameCommit({frameId,patch,positions}){let next=doc;for(const position of positions)next=updateFrame(next,position.id,{canvasX:position.canvasX,canvasY:position.canvasY});commit(updateFrame(next,frameId,patch),{selection:[]});},
  onReorder({frameId,nodeId,index}){commit(reorderNode(doc,frameId,nodeId,index));},
  onError(error){toast('Canvas edit could not be applied: '+errorDetail(error),true);},
  onEditText(id,text,frameId=doc.activeFrameId){try{const node=getNode(doc,frameId,id);commit(updateNode(doc,frameId,id,styledPatch(node,{text},frameId)));lastInlineError=null;}catch(error){lastInlineError=errorDetail(error);render();toast('Text: '+lastInlineError,true);}},
  onZoomChange(value){$('zoom-value').textContent=Number(value.toFixed(value<10?2:1))+'%';},
});

function toast(message,error=false){clearTimeout(toastTimer);($('modal').open?$('modal'):document.body).append($('toast'));$('toast').textContent=message;$('toast').classList.toggle('error',error);$('toast').hidden=false;toastTimer=setTimeout(()=>$('toast').hidden=true,4500);}
function hash(value=doc){const {activeFrameId,...design}=value;return JSON.stringify(design);}
function persist(context,snapshot){
  const snapshotHash=hash(snapshot);
  const job=persistQueue.then(async()=>{
    if(!library)throw Error('Browser storage is unavailable. Use Save or download the editable project.');
    const record=await library.saveCopy(snapshot,{key:context.key,version:context.version,baseRevision:context.baseRevision,clean:snapshotHash===context.clean,session,makeCurrent:working===context&&!editorClosed});
    context.key=record.key;context.version=record.version;context.baseRevision=Math.max(context.baseRevision,record.baseRevision);context.persisted=snapshotHash;
    if(working===context&&!editorClosed){draftHash=snapshotHash;updateStatus();}
    try{const key=EMERGENCY_PREFIX+session+':'+record.key,raw=localStorage.getItem(key);if(raw&&hash(JSON.parse(raw).document)===snapshotHash)localStorage.removeItem(key);}catch{}
    if(record.forked&&working===context)toast('Another window changed this copy. Both versions were kept as separate drafts.');
    return true;
  });
  persistQueue=job.catch(error=>{if(working===context&&!editorClosed){draftHash=null;updateStatus();toast(error.message,true);}return false;});
  return persistQueue;
}
function remember(){if(editorClosed)return;working.touched=true;choiceSequence++;clearTimeout(saveTimer);saveTimer=setTimeout(()=>{saveTimer=null;persist(working,cloneDocument(doc));},250);}
function activeNodes(){const frame=getFrame(doc);return selected.map(id=>frame.nodes.find(n=>n.id===id)).filter(Boolean);}
function isLocked(node,frame=getFrame(doc)){let current=node;while(current){if(current.locked)return true;current=current.parentId?frame.nodes.find(item=>item.id===current.parentId):null;}return false;}
function selectedRoots(){const frame=getFrame(doc),chosen=new Set(selected);return activeNodes().filter(node=>{let parent=node.parentId;while(parent){if(chosen.has(parent))return false;parent=frame.nodes.find(item=>item.id===parent)?.parentId;}return true;});}
function commit(next,{selection=selected}={}){
  finishEdit();
  try{next=validateDocument(next);}catch(error){toast(error.message,true);renderPanels();return;}
  if(hash(next)===hash())return;
  if(editorClosed)return;
  undoStack.push(cloneDocument(doc));if(undoStack.length>100)undoStack.shift();redoStack=[];doc=next;selected=selection.filter(id=>getFrame(doc).nodes.some(n=>n.id===id));remember();render();
}
function emergency(){if(editorClosed||!working.touched||hash()===working.persisted)return true;try{keepEmergency(localStorage,session,working.key,doc,working.baseRevision,working.version);return true;}catch(error){toast('Recovery could not be kept. Save or download this project before switching.',true);return false;}}
function replaceProject(next,{copy=null}={}){
  next=validateDocument(next);finishEdit();rememberNow();
  if(!emergency())return false;
  choiceSequence++;editorClosed=false;doc=next;working=newWorking(copy);undoStack=[];redoStack=[];selected=[];authoringState='default';lastInlineError=null;invalidFields.clear();collapsedLayers.clear();savedHash=working.clean;draftHash=working.persisted;
  if(!copy)remember();render();requestAnimationFrame(()=>canvas.fitAll());return true;
}
function rememberNow(){if(editorClosed)return persistQueue;canvas.flushEdits?.();finishEdit();clearTimeout(saveTimer);saveTimer=null;if(!working.touched)return persistQueue;return persist(working,cloneDocument(doc));}
function undo(){if(!undoStack.length)return;redoStack.push(cloneDocument(doc));doc=undoStack.pop();selected=selected.filter(id=>getFrame(doc).nodes.some(n=>n.id===id));remember();render();}
function redo(){if(!redoStack.length)return;undoStack.push(cloneDocument(doc));doc=redoStack.pop();selected=selected.filter(id=>getFrame(doc).nodes.some(n=>n.id===id));remember();render();}
async function request(path,options={}){const response=await projectFetch(path,{...options,headers:{'Content-Type':'application/json',...options.headers}});const data=await response.json();if(!response.ok)throw Error(data.error||'Request failed');return data;}
function acceptVisibleEdits(){
  const active=document.activeElement;
  if(editableField(active)&&!active.dataset.mixed){try{applyLive(active);}catch(error){markFieldError(active,error);}}
  const invalid=firstInvalidField();
  if(invalid){toast('Fix '+fieldName(invalid)+': '+invalidFields.get(invalid),true);invalid.focus();return false;}
  if(!$('modal').open&&active?.matches('button,a,[tabindex]'))pendingModalOpener=active;
  document.activeElement?.blur();canvas.flushEdits?.();finishEdit();
  if(lastInlineError){toast(lastInlineError,true);lastInlineError=null;return false;}
  return true;
}
async function save(){
  if(editorClosed||saving||!acceptVisibleEdits())return;
  const snapshot=cloneDocument(doc),snapshotHash=hash(snapshot),context=working,baseRevision=context.baseRevision;saving=true;savingContext=context;let endSaving;savingDone=new Promise(resolve=>endSaving=resolve);updateStatus();
  const keep=rememberNow();
  try{
    const record=await request('/api/projects',{method:'POST',body:JSON.stringify({document:snapshot,revision:baseRevision})});
    await keep;context.baseRevision=record.revision;context.clean=snapshotHash;
    try{await library?.finishFileSave(context.key,snapshot,baseRevision,record.revision);}catch(error){toast('File saved. '+error.message,true);}
    if(working===context&&!editorClosed){savedHash=snapshotHash;rememberNow();toast(hash()===snapshotHash?savedLocation+'.':'Project saved. Your newer edits are still a draft.');}
    else toast('The earlier project was saved. ');
  }catch(error){toast(error.message,true);}finally{saving=false;savingContext=null;updateStatus();endSaving();}}
function updateStatus(){if(!$('save-status'))return;$('save-button').disabled=editorClosed||saving;if(editorClosed){$('save-status').textContent='No widget open';return;}$('save-status').textContent=saving&&savingContext===working?'Saving…':firstInvalidField()?'Fix invalid fields':hash()===savedHash?savedLocation:hash()===draftHash?'Draft kept':'Unsaved changes';$('undo-button').disabled=!undoStack.length;$('redo-button').disabled=!redoStack.length;const nodes=activeNodes();$('copy-button').disabled=!nodes.length;$('paste-button').disabled=!clipboard?.nodeIds.length;$('selection-status').textContent=nodes.length?`${nodes.length===1?nodes[0].name:nodes.length+' layers'} · ${getFrame(doc).name}`:`${getFrame(doc).name} · ${getFrame(doc).width} × ${getFrame(doc).height}`;}
function render(){document.querySelector('.workspace').hidden=editorClosed;let empty=$('empty-workspace');if(!empty){empty=document.createElement('main');empty.id='empty-workspace';empty.innerHTML='<h1>No widget open</h1><p>Create a widget or open a project from the library.</p><div><button data-action="new">New project</button><button data-action="open">Open project library</button></div>';document.body.append(empty);}empty.hidden=!editorClosed;for(const action of ['preview','export','theme'])document.querySelector('[data-action="'+action+'"]').disabled=editorClosed;$('project-name').disabled=editorClosed;if(editorClosed){$('project-name').value='';updateStatus();decorateTools();return;}canvas.render(doc,{selectedIds:selected,activeFrameId:doc.activeFrameId,previewState:authoringState});renderPanels();}
function renderPanels(){if(editorClosed){updateStatus();return;}const frame=getFrame(doc);selected=selected.filter(id=>frame.nodes.some(n=>n.id===id));$('project-name').value=doc.name;$('project-name').dataset.acceptedValue=doc.name;clearFieldError($('project-name'));renderFramePicker();renderLayers();renderInspector();updateStatus();decorateTools();}
function renderFramePicker(){$('frame-picker').innerHTML=doc.frames.map(f=>`<option value="${escape(f.id)}" ${f.id===doc.activeFrameId?'selected':''}>${escape(f.name)}</option>`).join('');$('frame-picker').dataset.acceptedValue=doc.activeFrameId;}
function renderLayers(){
  const frame=getFrame(doc);$('layer-count').textContent=frame.nodes.length;
  const children=new Map();for(const node of frame.nodes){const key=node.parentId||null;if(!children.has(key))children.set(key,[]);children.get(key).push(node);}
  function rows(parentId=null,depth=0,inheritedHidden=false){
    const siblings=[...(children.get(parentId)||[])];
    if((parentId?frame.nodes.find(node=>node.id===parentId)?.layout:frame.layout)?.direction==='free')siblings.reverse();
    return siblings.map(node=>{
      const nested=children.has(node.id),hidden=inheritedHidden||!node.visible;
      return `<div class="layer-row ${selected.includes(node.id)?'selected':''} ${isLocked(node,frame)?'locked':''} ${hidden?'invisible':''}" data-layer="${escape(node.id)}" draggable="${!isLocked(node,frame)}" style="--depth:${Math.min(depth,6)}"><button class="layer-select" data-layer="${escape(node.id)}" aria-label="Select ${escape(node.name)}"><span class="layer-kind" data-icon="${typeIcons[node.type]}"></span><span class="layer-name" title="${escape(node.name)}">${escape(node.name)}</span></button>${nested?`<button class="layer-disclosure" data-layer-collapse="${escape(node.id)}" aria-expanded="${!collapsedLayers.has(node.id)}">${collapsedLayers.has(node.id)?'Expand':'Collapse'}</button>`:''}<button data-layer-toggle="visible" data-id="${escape(node.id)}" aria-pressed="${node.visible}">${node.visible?'Hide':'Show'}</button><button data-layer-toggle="locked" data-id="${escape(node.id)}" aria-pressed="${node.locked}">${node.locked?'Unlock':'Lock'}</button></div>${nested&&!collapsedLayers.has(node.id)?rows(node.id,depth+1,hidden):''}`;
    }).join('');
  }
  $('layer-list').innerHTML=frame.nodes.length?rows():'<p class="subtle">Use the canvas tools to add a layer.</p>';
  decorateTools($('layer-list'));
}
function displayMap(frameId=doc.activeFrameId){
  const frame=getFrame(doc,frameId);
  const result=new Map(resolveFrame(frame,frame.width,{theme:doc.theme,readText:(_id,node)=>initialBoundText(doc,node),state:authoringState,measureText}).nodes.map(node=>[node.id,node]));
  if(result.size<frame.nodes.length)for(const node of resolveFrame({...frame,nodes:frame.nodes.map(item=>({...item,visible:true}))},frame.width,{theme:doc.theme,readText:(_id,node)=>initialBoundText(doc,node),state:authoringState,measureText}).nodes)if(!result.has(node.id))result.set(node.id,node);
  return result;
}
function renderInspector(){
  const frame=getFrame(doc),nodes=activeNodes(),displays=displayMap();
  $('inspector').innerHTML=inspectorHTML({doc,frame,nodes,displayNodes:displays,tab:inspectorTab,state:authoringState});
  showMixedProperties($('inspector'),nodes,displays,frame,{state:authoringState});
  for(const input of $('inspector').querySelectorAll('input,textarea,select'))rememberFieldValue(input);
}
function refreshDerivedGeometry(){
  if(activeNodes().length!==1)return;
  const node=activeNodes()[0];if(!node)return;
  const frame=getFrame(doc),box=displayMap().get(node.id);if(!box)return;
  const parent=node.parentId?frame.nodes.find(item=>item.id===node.parentId):null,padding=(parent?.layout||frame.layout).padding;
  for(const [key,value] of Object.entries({width:box.width,height:box.height,x:box.relativeX-padding,y:box.relativeY-padding})){
    const input=$('inspector').querySelector('[data-prop="'+key+'"]');
    if(input?.disabled&&!invalidFields.has(input)){input.value=String(value);input.dataset.acceptedValue=input.value;}
  }
}
function refreshValueChoices(input){
  if(input.dataset.prop==='options'){
    const node=activeNodes()[0],select=$('inspector').querySelector('[data-prop="initialValue"]');
    if(node?.type==='select'&&select){select.innerHTML='<option value="">Show placeholder</option>'+node.options.map(value=>`<option value="${escape(value)}">${escape(value)}</option>`).join('');select.value=node.initialValue||'';select.dataset.acceptedValue=select.value;}
  }
  if(input.dataset.frame==='name')for(const select of document.querySelectorAll('[data-entry-frame]'))for(const option of select.options){const view=doc.frames.find(view=>view.id===option.value);if(view)option.textContent=view.name;}
}
function styledPatch(node,patch,frameId=doc.activeFrameId,displays=null){
  if(authoringState!=='default'&&Object.keys(patch).some(key=>stateProperties.has(key))){
    const overrides={...node.states[authoringState]},base={};
    for(const [key,value] of Object.entries(patch)){if(stateProperties.has(key))overrides[key]=value;else base[key]=value;}
    return {...base,states:{...node.states,[authoringState]:overrides}};
  }
  if(authoringState==='default'&&node.styleRole!=='none'&&Object.keys(patch).some(key=>sharedProperties.includes(key))){
    const display=(displays||displayMap(frameId)).get(node.id)||node;
    return {...Object.fromEntries(sharedProperties.map(key=>[key,display[key]])),styleRole:'none',...patch};
  }
  return patch;
}
function updateSelected(patch){let next=doc;const displays=displayMap();for(const node of activeNodes())if(!(node.locked||displays.get(node.id)?.locked)||Object.keys(patch).every(k=>k==='locked'||k==='visible'))next=updateNode(next,doc.activeFrameId,node.id,styledPatch(node,patch,doc.activeFrameId,displays));commit(next);}
function changeLayout(document,frameId,parentId,patch){
  const frame=getFrame(document,frameId),parent=parentId?getNode(document,frameId,parentId):null,rule=parent?.layout||frame.layout;
  const copy=cloneDocument(document),target=getFrame(copy,frameId);
  if(rule.direction!=='free'&&patch.direction==='free'){
    const resolved=resolveFrame(frame,frame.width,{theme:document.theme,readText:(_id,node)=>initialBoundText(document,node),state:authoringState,measureText}),positions=new Map(resolved.nodes.map(node=>[node.id,node]));
    for(const node of target.nodes)if(node.parentId===(parentId||null)&&positions.has(node.id)){const box=positions.get(node.id);node.x=box.relativeX-rule.padding;node.y=box.relativeY-rule.padding;if(node.widthMode!=='fixed'){node.flowSizing={widthMode:node.widthMode,width:node.width};node.width=box.width;node.widthMode='fixed';}}
    if(!parentId){target.flowHeight=target.height;target.height=Math.max(target.height,resolved.height);}
  }
  if(rule.direction==='free'&&patch.direction&&patch.direction!=='free'){for(const node of target.nodes)if(node.parentId===(parentId||null)&&node.flowSizing){Object.assign(node,node.flowSizing);delete node.flowSizing;}if(!parentId&&target.flowHeight!==undefined){target.height=target.flowHeight;delete target.flowHeight;}}
  if(parentId)getNode(copy,frameId,parentId).layout={...rule,...patch};else target.layout={...rule,...patch};
  return validateDocument(copy);
}
function fieldDocument(input){
  const value=input.type==='checkbox'?input.checked:input.type==='number'?Number(input.value):input.value;
  if(input.id==='project-name')return {...doc,name:input.value.trim()};
  if(input.dataset.theme)return updateTheme(doc,{[input.dataset.theme]:value});
  if(input.dataset.frame)return updateFrame(doc,doc.activeFrameId,{[input.dataset.frame]:value,...(input.dataset.frame==='height'?{flowHeight:null}:{})});
  if(input.dataset.frameLayout)return changeLayout(doc,doc.activeFrameId,null,{[input.dataset.frameLayout]:value});
  if(input.dataset.frameTransition)return updateFrame(doc,doc.activeFrameId,{transition:{...getFrame(doc).transition,[input.dataset.frameTransition]:value}});
  const frame=getFrame(doc),displays=displayMap();let next=doc;
  const chosen=new Set(selected);
  const roots=activeNodes().filter(node=>{let parent=node.parentId;while(parent){if(chosen.has(parent))return false;parent=frame.nodes.find(candidate=>candidate.id===parent)?.parentId;}return true;});
  const targets=input.dataset.prop==='parentId'?roots:activeNodes();
  for(const node of targets){
    if(input.dataset.prop==='multiline'&&node.type!=='input')continue;
    if((node.locked||displays.get(node.id)?.locked)&&!['visible','locked'].includes(input.dataset.prop))continue;
    let patch=null;
    if(input.dataset.validation){const key=input.dataset.validation,rules={...node.validation,[key]:value};if(['min','max'].includes(key)&&!input.value.trim())delete rules[key];patch={validation:rules};}
    if(input.dataset.layout){next=changeLayout(next,doc.activeFrameId,node.id,{[input.dataset.layout]:value});continue;}
    if(input.dataset.stateProp){if(authoringState==='default')continue;const key=input.dataset.stateProp;patch={states:{...node.states,[authoringState]:{...node.states[authoringState],[key]:key==='opacity'?Number(value)/100:value}}};}
    if(input.dataset.prop){
      const key=input.dataset.prop;let item=key==='fontWeight'?Number(value):key==='opacity'?Number(value)/100:value;
      if(['items','options'].includes(key))item=input.value.split('\n').map(value=>value.trim()).filter(Boolean);
      patch={[key]:item};
      if(key==='options'&&!item.includes(node.initialValue))patch.initialValue='';
      if(key==='textBindingId'&&!item)patch.textBindingId=null;
      if(key==='inputType'&&item!=='text')patch.multiline=false;
      if(['width','widthMode','parentId'].includes(key))patch.flowSizing=null;
      if(key==='multiline'&&item){patch.inputType='text';if(node.height<120)patch.height=120;}
      if(key==='parentId'){
        const target=value?frame.nodes.find(candidate=>candidate.id===value):null,old=displays.get(node.id)||node,parent=target?displays.get(target.id):null,padding=(target?.layout||frame.layout).padding,border=parent?.strokeWidth||0;
        if(target&&isLocked(target,frame))throw Error('Unlock the destination container or its parent to edit.');
        patch={parentId:value||null,flowSizing:null,x:old.x-(parent?.x||0)-padding-border,y:old.y-(parent?.y||0)-padding-border};
      }
      if(key==='widthMode'&&item==='fixed')patch.width=displays.get(node.id)?.width||node.width;
      if(key==='heightMode'&&item==='fixed')patch.height=displays.get(node.id)?.height||node.height;
      patch=styledPatch(node,patch,doc.activeFrameId,displays);
    }
    if(input.dataset.actionField){
      const key=input.dataset.actionField,action={...node.action,[key]:key==='args'?JSON.parse(input.value):value};
      if(key==='localOp'){
        if(value==='reset')delete action.targetNodeId;
        else{const targets=localTargets(doc,value);if(!targets.length)throw Error('Add a value that supports this local operation first.');if(!targets.some(item=>item.node.id===action.targetNodeId))action.targetNodeId=targets[0].node.id;}
        if(value==='list-add'){action.clearInput=true;action.args={value:'New task'};}else if(value==='increment')action.args={value:1};else if(value==='set')action.args={value:''};else action.args={};
      }
      patch={action};
    }
    if(patch)next=updateNode(next,doc.activeFrameId,node.id,patch);
  }
  return next;
}
function editableField(input){return input instanceof HTMLElement&&(input.id==='project-name'||input.dataset.prop||input.dataset.frame||input.dataset.actionField||input.dataset.layout||input.dataset.frameLayout||input.dataset.frameTransition||input.dataset.theme||input.dataset.stateProp||input.dataset.validation)&&input.type!=='checkbox'&&input.tagName!=='SELECT';}
function fieldName(input){return input.getAttribute('aria-label')||input.closest('label')?.firstChild?.textContent.trim()||'this field';}
function clearFieldError(input){invalidFields.delete(input);input.removeAttribute('aria-invalid');input.removeAttribute('data-validation-error');input.setCustomValidity?.('');}
function errorDetail(error){return (error.message||String(error)).replace(/^[^:]+:\s*/,'');}
function markFieldError(input,error){const message=errorDetail(error);invalidFields.set(input,message);input.setAttribute('aria-invalid','true');input.dataset.validationError=message;input.setCustomValidity?.(message);updateStatus();}
function firstInvalidField(){for(const [input] of invalidFields){if(!input.isConnected){invalidFields.delete(input);continue;}return input;}return null;}
function explainInvalidField(){const input=firstInvalidField();if(!input)return;toast('Fix '+fieldName(input)+': '+invalidFields.get(input)+' Press Escape to revert this edit.',true);input.focus();}
function rememberFieldValue(input){if(input instanceof HTMLElement&&input.matches('input,textarea,select')&&!input.hasAttribute('data-accepted-value'))input.dataset.acceptedValue=input.type==='checkbox'?String(input.checked):input.value;}
function restoreFieldValue(input){if(input.type==='checkbox')input.checked=input.dataset.acceptedValue==='true';else input.value=input.dataset.acceptedValue??input.defaultValue??'';}
function protectInvalidEdit(event){
  if(!firstInvalidField()||editableField(event.target))return;
  if(!event.target.closest?.('button,a,select,input[type=checkbox],#canvas-stage'))return;
  if(event.type==='change')restoreFieldValue(event.target);
  event.preventDefault();event.stopImmediatePropagation();explainInvalidField();
}
// Stop context changes before a renderer can replace the unaccepted field.
for(const type of ['pointerdown','click','dblclick','change'])document.addEventListener(type,protectInvalidEdit,true);
document.addEventListener('keydown',event=>{
  const invalid=firstInvalidField();if(!invalid)return;
  if(event.key==='Escape'){event.preventDefault();event.stopImmediatePropagation();restoreFieldValue(invalid);clearFieldError(invalid);updateStatus();invalid.focus();toast('Invalid edit reverted.');return;}
  if(event.key!=='Tab'&&!event.target.closest?.('input,textarea,select,[contenteditable=true]')){event.preventDefault();event.stopImmediatePropagation();explainInvalidField();}
},true);
document.addEventListener('focusin',event=>rememberFieldValue(event.target),true);
function finishEdit(){if(!editSession)return;const session=editSession;editSession=null;if(hash(session.before)!==hash()){undoStack.push(session.before);if(undoStack.length>100)undoStack.shift();redoStack=[];}updateStatus();}
function syncColorFields(input){
  const group=input.closest('.color-field');if(!group)return;
  const text=group.querySelector('input[type=text]'),picker=group.querySelector('input[type=color]');
  if(input===picker&&text){text.value=picker.value;text.dataset.acceptedValue=text.value;clearFieldError(text);}
  if(input===text&&picker&&/^#[\da-f]{6}$/i.test(text.value)){picker.value=text.value;picker.dataset.acceptedValue=picker.value;clearFieldError(picker);}
}
function applyLive(input){clearFieldError(input);if(input.type==='number'&&!input.value.trim()&&!(input.dataset.validation&&['min','max'].includes(input.dataset.validation)))throw Error('Enter a number.');if(input.validity&&!input.validity.valid)throw Error(input.validationMessage||'Enter a valid value.');const next=fieldDocument(input);if(!next)return;const normalized=validateDocument(next);syncColorFields(input);input.dataset.acceptedValue=input.value;if(hash(normalized)===hash()){updateStatus();return;}if(!editSession||editSession.element!==input){finishEdit();editSession={element:input,before:cloneDocument(doc)};}doc=normalized;remember();canvas.render(doc,{selectedIds:selected,activeFrameId:doc.activeFrameId,previewState:authoringState});renderLayers();refreshDerivedGeometry();refreshValueChoices(input);const nodes=activeNodes();if(nodes.length>1)showMixedProperties($('inspector'),nodes,displayMap(),getFrame(doc),{preserveInput:input,state:authoringState});else{const role=document.querySelector('[data-prop=styleRole]');if(role&&nodes[0])role.value=nodes[0].styleRole;}if(input.dataset.frame==='name')renderFramePicker();const reset=document.querySelector('[data-action="reset-state"]');if(reset)reset.disabled=authoringState==='default'||!activeNodes().some(node=>node.states[authoringState]&&!isLocked(node));delete input.dataset.mixed;input.removeAttribute('aria-checked');if(input.dataset.baseLabel)input.setAttribute('aria-label',input.dataset.baseLabel);if(input.placeholder==='Mixed')input.removeAttribute('placeholder');updateStatus();}
document.addEventListener('focusin',event=>{if(editableField(event.target)){finishEdit();editSession={element:event.target,before:cloneDocument(doc)};}});
document.addEventListener('focusout',event=>{if(editSession?.element===event.target)finishEdit();});
function previewNumber(input,format=false){
  if(!previewOptions||!['preview-width','preview-delay'].includes(input.id))return false;
  if(!format&&(input.value===''||input.validity?.badInput||!Number.isFinite(Number(input.value))))return true;
  const width=input.id==='preview-width',value=Math.max(width?32:0,Math.min(width?8192:30000,Number(input.value)||(width?320:0)));
  if(width)previewOptions.width=value;else previewOptions.simulation.delay=value;
  if(format)input.value=String(value);updatePreview();return true;
}
document.addEventListener('input',event=>{if(previewNumber(event.target))return;if(!editableField(event.target))return;try{applyLive(event.target);}catch(error){markFieldError(event.target,error);}});
function add(type){const active=activeNodes()[0],parent=active?.type==='rectangle'?active:active?.parentId?getNode(doc,doc.activeFrameId,active.parentId):null;if(parent&&isLocked(parent)){toast('Unlock the destination container or its parent to add a layer.',true);return;}let next=addNode(doc,doc.activeFrameId,type);const node=getFrame(next).nodes.at(-1);if(parent)next=updateNode(next,doc.activeFrameId,node.id,{parentId:parent.id,x:0,y:0,widthMode:'fill'});commit(next,{selection:[node.id]});setTab('layers');}
function duplicate(){const ids=activeNodes().filter(node=>!isLocked(node)).map(node=>node.id);if(!ids.length)return;const old=new Set(getFrame(doc).nodes.map(node=>node.id));const next=duplicateNodes(doc,doc.activeFrameId,ids);const added=getFrame(next).nodes.filter(node=>!old.has(node.id)),addedIds=new Set(added.map(node=>node.id));commit(next,{selection:added.filter(node=>!addedIds.has(node.parentId)).map(node=>node.id)});}
function remove(){const ids=activeNodes().filter(n=>!isLocked(n)).map(n=>n.id);if(ids.length)commit(removeNodes(doc,doc.activeFrameId,ids),{selection:[]});}
function copy(){
  canvas.flushEdits?.();finishEdit();
  clipboard=captureLayerClipboard(doc,doc.activeFrameId,selected,{measureText});
  const count=clipboard?.nodeIds.length||0;updateStatus();toast(`${count} layer${count===1?'':'s'} copied.`);
}
function paste(){
  if(!clipboard)return;
  const result=pasteLayerClipboard(doc,doc.activeFrameId,clipboard);
  commit(result.document,{selection:result.selection});
  if(result.addedViews)requestAnimationFrame(()=>canvas.fitAll());
  toast(`Pasted ${result.addedLayers} layer${result.addedLayers===1?'':'s'}${result.addedViews?' and '+result.addedViews+' connected view'+(result.addedViews===1?'':'s'):''}${result.restoredLayers?' and restored '+result.restoredLayers+' dependency layer'+(result.restoredLayers===1?'':'s'):''}.${result.crossProject?' Source appearance kept as Custom styles.':''}`);
}
function align(kind){
  const frame=getFrame(doc),displays=displayMap();let next=doc;
  for(const node of activeNodes().filter(item=>!isLocked(item))){
    const parent=node.parentId?frame.nodes.find(item=>item.id===node.parentId):null,rule=parent?.layout||frame.layout;
    if(rule.direction!=='free')continue;
    const parentBox=parent?displays.get(parent.id):frame,box=displays.get(node.id)||node,p={};
    const inset=rule.padding+(parent?parentBox.strokeWidth:0),width=parentBox.width-inset*2,height=parentBox.height-inset*2;
    if(kind==='left')p.x=0;if(kind==='hcenter')p.x=(width-box.width)/2;if(kind==='right')p.x=width-box.width;
    if(kind==='top')p.y=0;if(kind==='vcenter')p.y=(height-box.height)/2;if(kind==='bottom')p.y=height-box.height;
    next=updateNode(next,frame.id,node.id,p);
  }
  commit(next);
}
function argumentKey(){const key=$('binding-key')?.value.trim();if(!/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(key)||['constructor','prototype','__proto__'].includes(key))throw Error('Use a simple value name, such as title.');return key;}
function setArgument(value){const key=argumentKey();let next=doc;for(const node of activeNodes().filter(node=>['tool','local'].includes(node.action.kind)&&!isLocked(node)))next=updateNode(next,doc.activeFrameId,node.id,{action:{...node.action,args:{...node.action.args,[key]:value}}});commit(next);}
function bindInput(){const id=$('binding-input')?.value;if(!id)return;const source=doc.frames.flatMap(view=>view.nodes).find(node=>node.id===id);setArgument({[['input','select'].includes(source?.type)?'$input':'$control']:id});toast('Widget value connected.');}
function staticArgument(){const type=document.querySelector('[data-arg-builder="type"]')?.value,text=$('static-value')?.value??'';let value=text;if(type==='number'){if(!text.trim()||!Number.isFinite(Number(text)))throw Error('Enter a finite number for the static value.');value=Number(text);}if(type==='true')value=true;if(type==='false')value=false;setArgument(value);toast('Static value connected.');}
function removeArgument(key){let next=doc;for(const node of activeNodes().filter(node=>['tool','local'].includes(node.action.kind)&&!isLocked(node))){const args={...node.action.args};delete args[key];next=updateNode(next,doc.activeFrameId,node.id,{action:{...node.action,args}});}commit(next);}
function moveLayer(delta){const frame=getFrame(doc),node=activeNodes()[0];if(!node||isLocked(node))return;const siblings=frame.nodes.filter(item=>item.parentId===node.parentId),index=siblings.findIndex(item=>item.id===node.id),target=siblings[Math.max(0,Math.min(siblings.length-1,index+delta))];if(target.id!==node.id)commit(reorderNode(doc,frame.id,node.id,frame.nodes.findIndex(item=>item.id===target.id)));}
function setTab(name){currentTab=name;for(const button of document.querySelectorAll('[data-tab]'))button.setAttribute('aria-pressed',String(button.dataset.tab===name));$('insert-panel').hidden=name!=='insert';$('layers-panel').hidden=name!=='layers';}
function renderedFocusTarget(element){return element?.isConnected&&!element.closest('[hidden]')&&!element.disabled&&element.tabIndex>=0&&element.getClientRects().length>0&&window.getComputedStyle(element).visibility!=='hidden';}
function restoreModalFocus(){
  if($('modal').open||!modalReturnFocus)return;
  const visible=element=>renderedFocusTarget(element)&&!element.closest('#modal');
  const candidates=[modalReturnFocus.element,...document.querySelectorAll('[data-action]')].filter(element=>element===modalReturnFocus.element||modalReturnFocus.action&&element.dataset.action===modalReturnFocus.action);
  for(const target of [...new Set(candidates),$('canvas-stage'),document.querySelector('[data-action="new"]')]){
    if(!visible(target))continue;target.focus({preventScroll:true});if(document.activeElement===target)return;
  }
}

function showModal(title,content,{preview=false}={}){if(!$('modal').open){const active=document.activeElement,element=active?.matches('button,input,textarea,select,a,[tabindex]')?active:pendingModalOpener;pendingModalOpener=null;modalReturnFocus={element:element?.matches('button,input,textarea,select,a,[tabindex]')?element:null,action:element?.dataset?.action};}if(!preview){rememberPreviewSession();previewOptions=null;}modalSequence++;$('modal-title').textContent=title;$('modal-content').innerHTML=content;$('modal').classList.toggle('preview-dialog',preview);$('modal').classList.remove('library-dialog');if(!$('modal').open)$('modal').showModal();decorateTools($('modal'));}
function closeModal(){choiceSequence++;modalSequence++;rememberPreviewSession();previewOptions=null;$('modal').close();$('modal-content').innerHTML='';renderPanels();restoreModalFocus();}
function saveBlockDialog(){
  if(!acceptVisibleEdits())return;
  pendingBlock=captureLayerClipboard(doc,doc.activeFrameId,selected,{measureText});if(!pendingBlock){toast('Select layers to save as a block.');return;}
  showModal('Save reusable block',`<form id="save-block-form" class="modal-form"><label>Block name<input name="name" id="block-name" value="${escape(activeNodes().length===1?activeNodes()[0].name:'Selected block')}" maxlength="160" required></label><p class="field-note">Saves a snapshot with its captured styles, embedded images and needed view/input bindings. Inserting makes independent editable copies. Source edits do not update saved blocks.</p><div class="modal-actions"><button type="button" data-action="close-modal">Cancel</button><button type="submit" class="primary">Save block</button></div></form>`);$('block-name').select();
}
async function blocksDialog(){
  showModal('Saved blocks','<p>Opening saved blocks…</p>');const sequence=modalSequence;
  try{const rows=await (await savedBlocks()).list();if(sequence!==modalSequence||!$('modal').open)return;
    const section=(kind,label)=>`<h3>${label}</h3>${rows.filter(row=>row.kind===kind).map(row=>`<div class="view-manager-row"><strong>${escape(row.name)}</strong><span class="field-note">${row.layers} layers</span>${kind==='saved'?`<button data-insert-block="${escape(row.id)}">Insert copy</button><button data-trash-block="${escape(row.id)}">Trash</button>`:`<button data-restore-block="${escape(row.id)}">Restore</button>`}</div>`).join('')||'<p class="field-note">No blocks here.</p>'}`;
    $('modal-content').innerHTML=`<p class="field-note">Independent snapshots on this browser. Copies bring their saved appearance and embedded images into the current view; needed views and inputs come with them. Image blocks also serve as reusable assets. Trash can be restored.</p>${section('saved','Ready to insert')}${section('trashed','Trash')}`;
    ($('modal-content').querySelector('[data-insert-block],[data-restore-block]')||$('modal').querySelector('[data-action="close-modal"]')).focus();
  }catch(error){if(sequence===modalSequence)$('modal-content').textContent=error.message;}
}
async function insertBlock(id){
  if(!acceptVisibleEdits())return;const context=working,sequence=modalSequence;
  try{const {clipboard:snapshot}=await (await savedBlocks()).read(id);if(context!==working||sequence!==modalSequence)return;
    const result=pasteLayerClipboard(doc,doc.activeFrameId,snapshot);commit(result.document,{selection:result.selection});closeModal();toast('Inserted an independent block copy with its saved styles and assets.');
  }catch(error){toast(error.message,true);}
}
async function moveBlock(id,restore=false){const sequence=modalSequence;try{const blocks=await savedBlocks();await (restore?blocks.restore(id):blocks.trash(id));if(sequence===modalSequence)blocksDialog();}catch(error){toast(error.message,true);}}
function viewsDialog(focusId=doc.activeFrameId){
  showModal('Views',`<p class="field-note">Select to edit. Copies are independent; internal input bindings are remapped. Use the inspector to rename a view.</p><div class="view-list">${doc.frames.map((view,index)=>`<div class="view-manager-row"><button data-select-view="${escape(view.id)}">${escape(view.name)}${view.id===doc.entryFrameId?' · Start':''}</button><button data-duplicate-view="${escape(view.id)}">Duplicate</button><button data-move-view="${escape(view.id)}" data-index="${index-1}" ${index===0?'disabled':''} aria-label="Move ${escape(view.name)} earlier">↑</button><button data-move-view="${escape(view.id)}" data-index="${index+1}" ${index===doc.frames.length-1?'disabled':''} aria-label="Move ${escape(view.name)} later">↓</button><button data-delete-view="${escape(view.id)}" ${doc.frames.length===1?'disabled':''} aria-label="Delete ${escape(view.name)}">Delete</button></div>`).join('')}</div><button data-action="add-managed-view">Add view</button>`);
  document.querySelector('[data-select-view="'+focusId+'"]')?.focus();
}
function newDialog(preset='blank'){choiceSequence++;showModal('New widget project',`<form class="modal-form" id="new-project-form"><label>Project name<input name="name" id="new-project-name" value="Untitled widget" maxlength="160" required></label><label>Starting point<select name="preset" aria-label="Starting point">${[['blank','Blank canvas'],['card','Information card'],['task-list','Task list'],['form','Simple form'],['workflow','Connected workflow']].map(([k,v])=>`<option value="${k}" ${k===preset?'selected':''}>${v}</option>`).join('')}</select></label><p class="field-note">Your current draft stays available in Open.</p><div class="modal-actions"><button type="button" data-action="close-modal">Cancel</button><button type="submit" class="primary">Create project</button></div></form>`);$('new-project-name').select();}
function renderLibrary(){
  if(!libraryData||!$('library-list'))return;
  const rows=libraryRows({...libraryData,browserStorage,currentKey:editorClosed?null:working.key,currentProjectId:!editorClosed&&hash()===savedHash?doc.id:null,filter:libraryFilter,query:libraryQuery});
  $('library-filters').innerHTML=rows.filters;$('library-list').innerHTML=rows.list;decorateTools($('modal'));
}
async function openDialog(){
  const keep=rememberNow(),intent=++choiceSequence;await keep;if(intent!==choiceSequence)return;
  showModal('Project library','<p class="subtle">Loading projects…</p>');$('modal').classList.add('library-dialog');
  const sequence=modalSequence;
  const results=await Promise.allSettled([request('/api/projects'),request('/api/trash'),library?library.list():Promise.reject(Error('Browser draft storage is unavailable.'))]);
  if(sequence!==modalSequence||!$('modal').open)return;
  const [savedResult,trashResult,copyResult]=results;
  libraryData={saved:savedResult.status==='fulfilled'?savedResult.value.projects:[],trash:trashResult.status==='fulfilled'?trashResult.value.projects:[],copies:copyResult.status==='fulfilled'?copyResult.value:[]};
  const errors=[...recoveryWarnings,...results.filter(item=>item.status==='rejected').map(item=>item.reason.message)];
  $('modal-content').innerHTML=libraryShell({errors,browserStorage,location:savedResult.status==='fulfilled'?savedResult.value.location:''});
  renderLibrary();$('library-search').value=libraryQuery;$('library-search').focus();
}
async function openSaved(id){
  if(!acceptVisibleEdits())return;const sequence=++choiceSequence,modal=modalSequence;await rememberNow();
  try{
    const record=await request('/api/projects/'+encodeURIComponent(id));if(sequence!==choiceSequence||modal!==modalSequence)return;
    const copy=library?await library.openSaved(record.document,record.revision,null):{document:record.document,kind:'saved',baseRevision:record.revision};
    if(sequence!==choiceSequence||modal!==modalSequence)return;
    if(!replaceProject(record.document,{copy}))return;
    working.touched=true;const adopted=working,adoptedSequence=choiceSequence;await rememberNow();if(working!==adopted||choiceSequence!==adoptedSequence||modalSequence!==modal)return;closeModal();toast('Saved file opened. Other browser drafts are still in the library.');
  }catch(error){toast(error.message,true);}
}
async function recover(key){
  if(!acceptVisibleEdits())return;const sequence=++choiceSequence,modal=modalSequence;await rememberNow();
  try{const record=await library.read(key);if(!record||record.kind!=='draft')throw Error('This draft changed location. Refresh the library.');if(sequence!==choiceSequence||modal!==modalSequence)return;if(!replaceProject(record.document,{copy:record}))return;const adopted=working,adoptedSequence=choiceSequence;await rememberNow();if(working!==adopted||choiceSequence!==adoptedSequence||modalSequence!==modal)return;closeModal();toast('Browser draft recovered.');}catch(error){toast(error.message,true);}
}
function libraryIntent(){return {context:working,choice:choiceSequence,modal:modalSequence};}
function keepsLibraryIntent(intent){return intent&&working===intent.context&&choiceSequence===intent.choice&&modalSequence===intent.modal;}
async function restore(key){const intent=libraryIntent();try{await request('/api/trash/'+encodeURIComponent(key)+'/restore',{method:'POST',body:'{}'});if(keepsLibraryIntent(intent))await openDialog();toast('Saved file restored.');}catch(error){toast(error.message,true);}}
async function trash(id){const intent=libraryIntent();try{await request('/api/projects/'+encodeURIComponent(id),{method:'DELETE'});const refresh=keepsLibraryIntent(intent);if(!editorClosed&&doc.id===id){savedHash=null;working.clean=null;remember();updateStatus();}if(refresh)await openDialog();toast(browserStorage?'Saved project moved to browser Trash. Drafts were preserved.':'Saved file moved to Mac file Trash. Browser drafts were preserved.');}catch(error){toast(error.message,true);}}
async function trashCopy(key,version){
  const context=working,active=!editorClosed&&context.key===key;let intent;
  try{
    if(active){canvas.flushEdits?.();finishEdit();clearTimeout(saveTimer);saveTimer=null;}
    intent=libraryIntent();if(active)await persistQueue;
    await library.trash(key,version,session);const refresh=keepsLibraryIntent(intent);
    if(active&&working===context&&!editorClosed){choiceSequence++;editorClosed=true;clearTimeout(saveTimer);saveTimer=null;selected=[];undoStack=[];redoStack=[];invalidFields.clear();render();}
    if(refresh)await openDialog();toast('Browser draft moved to Trash. Its saved file is unchanged.');
  }catch(error){if(keepsLibraryIntent(intent))await openDialog();toast(error.message,true);}
}
async function restoreCopy(key,version){const intent=libraryIntent();try{await library.restore(key,version);if(keepsLibraryIntent(intent))await openDialog();toast('Browser draft restored. Recover it from Drafts to continue editing.');}catch(error){toast(error.message,true);}}
function downloadRecovery(){
  const records={};for(let index=0;index<localStorage.length;index++){const key=localStorage.key(index);if(key?.startsWith('widget-studio:'))records[key]=localStorage.getItem(key);}
  download(new Blob([JSON.stringify(records,null,2)],{type:'application/json'}),'widget-studio-browser-recovery.json');
}
function preview(){
  if(!acceptVisibleEdits())return;
  const retained=previewSessions.get(working.key);
  previewOptions={simulation:{delay:400,outcome:'success'},frameId:doc.entryFrameId||doc.activeFrameId,width:getFrame(doc,doc.entryFrameId||doc.activeFrameId).width,state:authoringState,reduceMotion:false,events:[],lastSequence:0,lastInfoSequence:0,lastSessionSequence:0,session:null,snapshot:null,...(retained?{...retained,events:[...retained.events],frameId:doc.frames.some(frame=>frame.id===retained.currentFrameId)?retained.currentFrameId:(doc.entryFrameId||doc.activeFrameId||doc.frames[0].id)}:{}),lastSessionSequence:0};
  showModal('Widget preview',`<div class="preview-controls"><label class="field">Inspect view<select id="preview-frame" aria-label="Preview frame">${doc.frames.map(frame=>`<option value="${escape(frame.id)}" ${frame.id===previewOptions.frameId?'selected':''}>${escape(frame.name)}</option>`).join('')}</select></label><label class="field">Width<input id="preview-width" aria-label="Preview width" type="number" min="32" max="8192" value="${previewOptions.width}"></label><label class="field">State<select id="preview-state" aria-label="Preview state">${STATE_NAMES.map(state=>`<option value="${state}" ${state===previewOptions.state?'selected':''}>${state[0].toUpperCase()+state.slice(1)}</option>`).join('')}</select></label><label class="toggle-field"><input id="preview-motion" type="checkbox" ${previewOptions.reduceMotion?'checked':''}>Reduce motion</label><label class="field">Tool outcome<select id="preview-tool-outcome" aria-label="Simulated tool outcome"><option value="success" ${previewOptions.simulation.outcome==='success'?'selected':''}>Success</option><option value="error" ${previewOptions.simulation.outcome==='error'?'selected':''}>Error</option></select></label><label class="field">Tool delay (ms)<input id="preview-delay" aria-label="Simulated tool delay" type="number" min="0" max="30000" value="${previewOptions.simulation.delay}"></label></div><div class="control-row"><button data-action="preview-entry">Go to start view</button><button data-action="preview-editor-view">Go to editor view</button><button data-action="restart-preview">Restart from start</button></div><p class="field-note">First opens at the Start view; reopening resumes compatible test values and activity. Inspection keeps the session. Restart uses current initial values. Pending simulations stop when the preview is rebuilt.</p><div class="preview-widths" role="group" aria-label="Preview widths"><button data-preview-width="320">320</button><button data-preview-width="768">768</button><button data-preview-width="1280">1280</button></div><div class="preview-workspace"><div class="preview-surface"><iframe id="widget-preview" title="Widget preview" sandbox="allow-scripts allow-forms"></iframe></div><section class="preview-activity" aria-label="Preview activity"><div class="preview-activity-heading"><h3>Activity</h3><span id="preview-event-count">0</span><button data-action="clear-preview-events">Clear activity</button></div><div id="preview-event-list" class="preview-event-list" role="log" aria-live="off"></div><p id="preview-live" class="sr-only" role="status" aria-live="polite" aria-atomic="true"></p></section></div><p class="preview-description"><span id="preview-current"></span> · View navigation and inputs are live. Plugin tools are simulated.</p>`,{preview:true});
  updatePreview(true,{resume:Boolean(retained)});
}
function updatePreview(rebuild=false,{changeState=false,changeView=false,resume=false}={}){
  if(!previewOptions||!$('widget-preview'))return;
  const iframe=$('widget-preview'),width=previewOptions.width;
  iframe.width=String(width);iframe.style.width=width+'px';
  if(rebuild)iframe.height=String(Math.max(32,Math.min(8192,Math.ceil(resolveFrame(getFrame(doc,previewOptions.frameId),width,{theme:doc.theme,readText:(_id,node)=>initialBoundText(doc,node),state:previewOptions.state,measureText}).height))));
  $('modal').style.setProperty('--preview-dialog-width',Math.max(720,width+360)+'px');
  $('modal').style.setProperty('--preview-widget-width',width+'px');
  if(rebuild){previewOptions.session=newPreviewSession();if(!resume){previewOptions.events=[];previewOptions.snapshot=null;}previewOptions.lastSequence=0;previewOptions.lastInfoSequence=0;previewOptions.lastSessionSequence=0;renderPreviewActivity();iframe.srcdoc=createPreviewHTML(doc,previewOptions.frameId,previewOptions);}
  else iframe.contentWindow?.postMessage({type:'widget-studio:preview-options',session:previewOptions.session,reduceMotion:previewOptions.reduceMotion,simulation:previewOptions.simulation,...(changeState?{state:previewOptions.state}:{}),...(changeView?{view:previewOptions.frameId}:{})},'*');
}
function renderPreviewActivity(){
  const list=$('preview-event-list');if(!list||!previewOptions)return;
  list.replaceChildren();$('preview-event-count').textContent=String(previewOptions.events.length);
  const clear=document.querySelector('[data-action="clear-preview-events"]');if(clear)clear.disabled=!previewOptions.events.length;
  if(!previewOptions.events.length){const empty=document.createElement('p');empty.className='field-note';empty.textContent='Test an action to see what it would do.';list.append(empty);return;}
  for(const event of [...previewOptions.events].reverse()){
    const item=document.createElement('article');item.className='preview-event'+(event.outcome==='error'?' preview-event-error':'');
    const heading=document.createElement('div');heading.className='preview-event-heading';
    const title=document.createElement('strong');title.textContent=event.title;
    const outcome=document.createElement('span');outcome.textContent={simulated:'Simulated',error:'Error',navigated:'Navigated',info:'Previewed',changed:'Local change',success:'Submitted'}[event.outcome];heading.append(title,outcome);
    const origin=document.createElement('p');origin.className='preview-event-origin';origin.textContent=event.viewName+' / '+event.layerName;
    const message=document.createElement('p');message.textContent=event.message+(event.truncated?' … Message truncated.':'');item.append(heading,origin,message);
    const detail=event.argsText??event.link;
    if(detail!==null){const details=document.createElement('details'),summary=document.createElement('summary'),pre=document.createElement('pre');summary.textContent=event.argsText!==null?'Arguments'+(event.argsTruncated?' (truncated)':''):'Link URL';pre.textContent=detail;details.append(summary,pre);item.append(details);}
    list.append(item);
  }
}
function clearPreviewActivity(){if(!previewOptions)return;previewOptions.events=[];renderPreviewActivity();$('preview-live').textContent='Preview activity cleared.';}
window.addEventListener('message',event=>{
  const iframe=$('widget-preview'),data=event.data;
  if(!$('modal').open||!previewOptions||!iframe||event.source!==iframe.contentWindow)return;
  const retained=parsePreviewSession(data,doc,previewOptions.session,previewOptions.lastSessionSequence);if(retained){previewOptions.snapshot=mergePreviewSession(previewOptions.snapshot,retained.snapshot,doc);previewOptions.lastSessionSequence=retained.sequence;rememberPreviewSession();return;}
  const entry=parsePreviewAction(data,doc,previewOptions.session,previewOptions.lastSequence);
  if(entry){
    previewOptions.lastSequence=entry.sequence;previewOptions.events.push(entry);if(previewOptions.events.length>10)previewOptions.events.shift();
    renderPreviewActivity();$('preview-live').textContent=entry.viewName+', '+entry.layerName+': '+entry.message;return;
  }
  const info=parsePreviewInfo(data,doc,previewOptions.session,previewOptions.lastInfoSequence);if(!info)return;
  previewOptions.lastInfoSequence=info.sequence;previewOptions.state=info.state;previewOptions.currentFrameId=info.viewId;
  $('preview-state').value=info.state;$('preview-frame').value=info.viewId;$('preview-current').textContent=info.viewName+' · '+info.state;iframe.height=String(info.height);

});
function themeDialog(){showModal('Shared styles',themeHTML(doc.theme));}
function resetState(){if(authoringState==='default')return;let next=doc;for(const node of activeNodes().filter(node=>!node.locked)){const states={...node.states};delete states[authoringState];next=updateNode(next,doc.activeFrameId,node.id,{states});}commit(next);}

function readinessHTML(){
  const report=exportReadiness(doc);
  return `<h3>Ready to use locally</h3><p>Open the downloaded widget.html to use fields, tasks, validation, local actions and view navigation. Values stay in that open session.</p><p>${report.views.length} connected views · ${report.localControls} local controls · ${report.embeddedImages} embedded images</p>${report.issues.length?`<h3>Review in the editor</h3><ul>${report.issues.map(issue=>`<li>${escape(issue)}</li>`).join('')}</ul>`:''}<h3>Plugin tool setup</h3>${report.tools.length?`<ul>${report.tools.map(tool=>`<li><strong>${escape(tool.name)}</strong> · ${tool.setup==='external'?'External setup needed. Export returns a setup error until connected.':'Synthetic demo. Echoes values; no external action.'}</li>`).join('')}</ul>`:'<p>No plugin tool actions. Local use needs no integration.</p>'}${report.remoteImageOrigins.length?'<p>HTTPS images remain remote and depend on the host’s network access.</p>':''}<p>Codex and ChatGPT native connection/rendering: unverified. Give the whole bundle and AGENT-HANDOFF.md to your agent to prepare the connection and verification.</p>`;
}
function exportDialog(){if(!acceptVisibleEdits())return;const frame=getFrame(doc,doc.entryFrameId||doc.activeFrameId);showModal('Export widget',`<label class="field">Start view<select data-entry-frame="id" aria-label="Start view">${doc.frames.map(view=>`<option value="${escape(view.id)}" ${view.id===(doc.entryFrameId||doc.activeFrameId)?'selected':''}>${escape(view.name)}</option>`).join('')}</select></label><p class="subtle" id="export-start-size">${frame.width} × ${frame.height}</p><section class="export-readiness" aria-label="Export readiness" id="export-readiness">${readinessHTML()}</section><div class="export-choice"><h3>Widget bundle</h3><p>Usable widget HTML, editable project, readiness report and a complete agent brief. Includes the local MCP Apps server for host setup.</p><button data-action="download-bundle" class="primary">Download widget bundle</button></div><div class="export-choice"><h3>Editable project</h3><p>Keep all views, layers and embedded images in a JSON file. Reopen it in Widget Studio.</p><button data-action="download-json">Download project JSON</button></div><div class="control-row"><button data-action="save-copy">Save as a new copy</button></div>`);}

function download(blob,name){const url=URL.createObjectURL(blob),link=document.createElement('a');link.href=url;link.download=name;document.body.append(link);link.click();link.remove();setTimeout(()=>URL.revokeObjectURL(url),30000);}
async function downloadBundle(){if(!acceptVisibleEdits())return;const snapshot=cloneDocument(doc);const button=document.querySelector('[data-action=download-bundle]');button.disabled=true;button.textContent='Preparing bundle…';try{const response=await projectFetch('/api/export',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({document:snapshot})});if(!response.ok){const error=await response.json();throw Error(error.error||'Export failed');}download(await response.blob(),snapshot.name.replace(/[^\w-]+/g,'-')+'-widget.zip');toast('Widget bundle downloaded.');}catch(error){toast(error.message,true);}finally{button.disabled=false;button.textContent='Download widget bundle';}}
function jsonDownload(){if(!acceptVisibleEdits())return;download(new Blob([JSON.stringify(doc)+'\n'],{type:'application/json'}),doc.name.replace(/[^\w-]+/g,'-')+'.widget.json');toast('Editable project downloaded.');}
function saveCopy(){const base=createDocument(doc.name+' copy','blank');if(!replaceProject({...cloneDocument(doc),id:base.id,name:base.name}))return;closeModal();save();}
function shortcuts(){showModal('Keyboard shortcuts',`<table class="shortcut-table">${[['Undo','⌘ / Ctrl Z'],['Redo','⌘ / Ctrl Shift Z'],['Save project','⌘ / Ctrl S'],['Duplicate selection','⌘ / Ctrl D'],['Copy / paste layers','⌘ / Ctrl C / V'],['Delete selected layer','Delete / Backspace'],['Move / reorder selected layer','Arrow keys · Shift = 10 steps'],['Pan canvas','Space + drag'],['Multiselect','Shift + click'],['Box selection in one view','Drag empty space · Shift adds · Escape cancels'],['Edit text','Double-click · Enter to commit'],['Cancel text edit','Escape'],['Fit all views','Shift 1'],['Focus selection / active view','Shift 2'],['Revert an invalid field','Escape']].map(([a,b])=>`<tr><td>${a}</td><td>${b}</td></tr>`).join('')}</table>`);}

const actions={'set-argument':staticArgument,'blocks':blocksDialog,'save-block':saveBlockDialog,'add-managed-view':()=>{commit(addFrame(doc),{selection:[]});viewsDialog();},'restart-preview':()=>{previewOptions.frameId=doc.entryFrameId||doc.activeFrameId;previewOptions.state='default';$('preview-frame').value=previewOptions.frameId;$('preview-state').value='default';updatePreview(true);},'preview-entry':()=>{previewOptions.frameId=doc.entryFrameId||doc.activeFrameId;$('preview-frame').value=previewOptions.frameId;updatePreview(false,{changeView:true});},'preview-editor-view':()=>{previewOptions.frameId=doc.activeFrameId;$('preview-frame').value=doc.activeFrameId;updatePreview(false,{changeView:true});},'wrap':()=>{const result=wrapLayers(doc,doc.activeFrameId,selected,{measureText});commit(result.document,{selection:result.selection});toast('Wrapped as one container. Current child widths are fixed; Layout can make them responsive.');},'unwrap':()=>{const result=unwrapLayers(doc,doc.activeFrameId,selected,{measureText});commit(result.document,{selection:result.selection});toast('Container removed. Child IDs and bindings kept; current widths are fixed.');},'distribute-x':()=>commit(distributeLayers(doc,doc.activeFrameId,selected,'x',{measureText})),'distribute-y':()=>commit(distributeLayers(doc,doc.activeFrameId,selected,'y',{measureText})),'views':viewsDialog,'download-recovery':downloadRecovery,'clear-preview-events':clearPreviewActivity,theme:themeDialog,'reset-state':resetState,new:()=>newDialog(),open:openDialog,save,preview,export:exportDialog,'close-modal':closeModal,undo,redo,copy,paste,duplicate,delete:remove,'layer-up':()=>moveLayer(1),'layer-down':()=>moveLayer(-1),'clear-fill':()=>updateSelected({fill:'transparent'}),'zoom-in':()=>canvas.setZoom(canvas.getZoom()+10),'zoom-out':()=>canvas.setZoom(canvas.getZoom()-10),fit:()=>canvas.fitAll(),'focus-selection':()=>canvas.fitSelection(),shortcuts,import:()=>{choiceSequence++;$('project-import').click();},'image-upload':()=>$('image-upload').click(),'download-json':jsonDownload,'download-bundle':downloadBundle,'save-copy':saveCopy,'bind-input':bindInput,'add-frame':()=>{commit(addFrame(doc),{selection:[]});requestAnimationFrame(()=>canvas.fit());},'remove-frame':()=>{if(doc.frames.length>1)commit(removeFrame(doc,doc.activeFrameId),{selection:[]});}};
document.addEventListener('click',event=>{const panel=event.target.closest('[data-panel-toggle]');if(panel){const workspace=document.querySelector('.workspace');if(panel.dataset.panelToggle==='layers'){const open=workspace.classList.toggle('layers-open');for(const button of document.querySelectorAll('[data-panel-toggle="layers"]'))button.setAttribute('aria-expanded',String(open));if(!open)document.querySelector('.canvas-toolbar [data-panel-toggle="layers"]')?.focus();}else panel.setAttribute('aria-expanded',String(!workspace.classList.toggle('properties-hidden')));return;}const button=event.target.closest('[data-canvas-tool]');if(!button)return;canvas.setTool(button.dataset.canvasTool);for(const item of document.querySelectorAll('[data-canvas-tool]'))item.setAttribute('aria-pressed',String(item===button));});
document.addEventListener('click',event=>{const target=event.target.closest('button,[data-layer]');if(!target)return;try{
  if(target.dataset.removeArgument){removeArgument(target.dataset.removeArgument);return;}
  if(target.dataset.insertBlock){insertBlock(target.dataset.insertBlock);return;}
  if(target.dataset.trashBlock){moveBlock(target.dataset.trashBlock);return;}
  if(target.dataset.restoreBlock){moveBlock(target.dataset.restoreBlock,true);return;}
  if(target.dataset.selectView){finishEdit();doc={...doc,activeFrameId:target.dataset.selectView};selected=[];closeModal();render();return;}
  if(target.dataset.duplicateView){commit(duplicateView(doc,target.dataset.duplicateView),{selection:[]});viewsDialog();return;}
  if(target.dataset.moveView){commit(reorderView(doc,target.dataset.moveView,Number(target.dataset.index)));viewsDialog(target.dataset.moveView);return;}
  if(target.dataset.deleteView){commit(removeFrame(doc,target.dataset.deleteView),{selection:[]});viewsDialog();return;}
  if(target.dataset.action){actions[target.dataset.action]?.();return;}
  if(target.dataset.libraryFilter){libraryFilter=target.dataset.libraryFilter;renderLibrary();$('library-filters').querySelector('[data-library-filter="'+libraryFilter+'"]').focus();return;}
  if(target.dataset.trashCopy){trashCopy(target.dataset.trashCopy,Number(target.closest('[data-copy-version]').dataset.copyVersion));return;}
  if(target.dataset.restoreCopy){restoreCopy(target.dataset.restoreCopy,Number(target.closest('[data-copy-version]').dataset.copyVersion));return;}
  if(target.dataset.layerCollapse){const id=target.dataset.layerCollapse;collapsedLayers.has(id)?collapsedLayers.delete(id):collapsedLayers.add(id);renderLayers();[...$('layer-list').querySelectorAll('[data-layer-collapse]')].find(button=>button.dataset.layerCollapse===id)?.focus({preventScroll:true});return;}
  if(target.dataset.previewWidth){previewOptions.width=Number(target.dataset.previewWidth);$('preview-width').value=target.dataset.previewWidth;updatePreview();return;}
  if(target.dataset.inspectorTab){finishEdit();inspectorTab=target.dataset.inspectorTab;renderInspector();decorateTools($('inspector'));$('inspector').querySelector('[data-inspector-tab="'+inspectorTab+'"]')?.focus({preventScroll:true});return;}
  if(target.dataset.tab){setTab(target.dataset.tab);return;}
  if(target.dataset.add){add(target.dataset.add);return;}
  if(target.dataset.template){newDialog(target.dataset.template);return;}
  if(target.dataset.layerToggle){const node=getNode(doc,doc.activeFrameId,target.dataset.id);const property=target.dataset.layerToggle;commit(updateNode(doc,doc.activeFrameId,node.id,{[property]:!node[property]}));[...$('layer-list').querySelectorAll('[data-layer-toggle]')].find(button=>button.dataset.id===node.id&&button.dataset.layerToggle===property)?.focus({preventScroll:true});return;}
  if(target.dataset.layer){const id=target.dataset.layer;selected=event.shiftKey?(selected.includes(id)?selected.filter(item=>item!==id):[...selected,id]):[id];render();[...$('layer-list').querySelectorAll('.layer-select')].find(button=>button.dataset.layer===id)?.focus({preventScroll:true});return;}
  if(target.dataset.align){align(target.dataset.align);return;}
  if(target.dataset.width){commit(updateFrame(doc,doc.activeFrameId,{width:Number(target.dataset.width)}));return;}
  if(target.dataset.openProject){openSaved(target.dataset.openProject);return;}
  if(target.dataset.recover){recover(target.dataset.recover);return;}
  if(target.dataset.restoreProject){restore(target.dataset.restoreProject);return;}
  if(target.dataset.trashProject){const id=target.dataset.trashProject;showModal('Delete project?',`<p class="subtle">${browserStorage?'The saved project will be moved to this browser’s Trash.':'The saved file will be moved to the project folder’s Trash.'}</p><div class="modal-actions"><button data-action="open">Cancel</button><button class="danger" id="confirm-trash">Move to Trash</button></div>`);$('confirm-trash').onclick=()=>trash(id);}
}catch(error){toast(error.message,true);}});
document.addEventListener('input',event=>{if(event.target.id==='library-search'){libraryQuery=event.target.value;renderLibrary();}});
document.addEventListener('change',event=>{const input=event.target;try{
  if(editableField(input)){applyLive(input);finishEdit();return;}
  if(input.id==='frame-picker'){finishEdit();doc={...doc,activeFrameId:input.value};selected=[];render();return;}
  if(input.id==='snap-toggle'){canvas.setSnap(input.checked);return;}
  if(input.id==='preview-frame'){previewOptions.frameId=input.value;updatePreview(false,{changeView:true});return;}
  if(previewNumber(input,true))return;
  if(input.id==='preview-state'){if(!STATE_NAMES.includes(input.value))return;previewOptions.state=input.value;updatePreview(false,{changeState:true});return;}
  if(input.id==='preview-tool-outcome'){previewOptions.simulation.outcome=input.value==='error'?'error':'success';updatePreview();return;}
  if(input.id==='preview-motion'){previewOptions.reduceMotion=input.checked;updatePreview();return;}
  if(input.id==='authoring-state'){if(!STATE_NAMES.includes(input.value))return;canvas.flushEdits?.();finishEdit();authoringState=input.value;render();$('authoring-state')?.focus({preventScroll:true});return;}
  if(input.dataset.entryFrame){commit(updateEntryFrame(doc,input.value));const size=$('export-start-size');if(size){const frame=getFrame(doc,input.value);size.textContent=frame.width+' × '+frame.height;const readiness=$('export-readiness');if(readiness)readiness.innerHTML=readinessHTML();}return;}
  if(input.dataset.frame||input.dataset.prop||input.dataset.layout||input.dataset.frameLayout||input.dataset.frameTransition||input.dataset.theme||input.dataset.stateProp||input.dataset.validation){const next=fieldDocument(input);if(next)commit(next);return;}
  if(input.hasAttribute('data-action-kind')){const action=input.value==='navigate'?{kind:'navigate',targetFrameId:doc.frames.find(frame=>frame.id!==doc.activeFrameId)?.id||doc.activeFrameId}:input.value==='link'?{kind:'link',href:'https://example.com'}:input.value==='tool'?{kind:'tool',toolName:'widget_action',args:{}}:input.value==='submit'?{kind:'submit',message:'Form complete. Values are kept in this widget session.'}:input.value==='local'?{kind:'local',localOp:'reset',args:{}}:{kind:'none'};updateSelected({action});return;}
  if(input.dataset.actionField){const next=fieldDocument(input);if(next)commit(next);}
}catch(error){if(editableField(input)){markFieldError(input,error);toast('Fix '+fieldName(input)+': '+invalidFields.get(input),true);}else{toast(error.message,true);renderPanels();}}});
document.addEventListener('submit',async event=>{
  if(event.target.id!=='save-block-form')return;event.preventDefault();const snapshot=pendingBlock,sequence=modalSequence,name=new FormData(event.target).get('name'),button=event.target.querySelector('[type=submit]');button.disabled=true;
  try{if(!snapshot)throw Error('Choose the layers to save again.');await (await savedBlocks()).save(name,snapshot);if(sequence===modalSequence){pendingBlock=null;blocksDialog();toast('Reusable block saved. Insert copies in any project on this browser.');}}
  catch(error){if(sequence===modalSequence){button.disabled=false;toast(error.message,true);}}
});
document.addEventListener('submit',event=>{if(event.target.id!=='new-project-form')return;event.preventDefault();const form=new FormData(event.target);try{if(!replaceProject(createDocument(String(form.get('name')).trim(),String(form.get('preset')))))return;closeModal();toast('Project created. Add and edit elements on the canvas.');}catch(error){toast(error.message,true);}});
$('project-import').addEventListener('change',async event=>{const file=event.target.files?.[0];if(!file)return;const sequence=++choiceSequence,modal=modalSequence;try{if(file.size>16*1024*1024)throw Error('Project file exceeds 16 MB. Its editable contents must fit within 8 MB.');const parsed=JSON.parse(await file.text());const imported=validateDocument(parsed?.document?.schemaVersion===1?parsed.document:parsed);const fresh=createDocument(imported.name,'blank');if(sequence!==choiceSequence||modal!==modalSequence)return;if(!replaceProject({...imported,id:fresh.id}))return;closeModal();toast('Project imported as a new draft.');}catch(error){toast('Project was kept. Choose a project JSON exported by Widget Studio. Import failed: '+errorDetail(error),true);}event.target.value='';});
$('image-upload').addEventListener('change',event=>{
  const file=event.target.files?.[0];if(!file)return;
  if(!['image/png','image/jpeg','image/webp','image/gif'].includes(file.type)||file.size>4*1024*1024){toast('Choose a PNG, JPG, WebP or GIF under 4 MB.',true);event.target.value='';return;}
  const projectId=doc.id,frameId=doc.activeFrameId,ids=activeNodes().filter(n=>n.type==='image'&&!n.locked).map(n=>n.id),reader=new FileReader();
  reader.onload=()=>{if(doc.id!==projectId)return;try{let next=doc;for(const id of ids){const node=getFrame(next,frameId).nodes.find(n=>n.id===id);if(node?.type==='image'&&!node.locked)next=updateNode(next,frameId,id,{src:String(reader.result)});}commit(next);}catch(error){toast(error.message,true);}};
  reader.onerror=()=>toast('Could not read image file.',true);reader.readAsDataURL(file);event.target.value='';
});
document.addEventListener('keydown',event=>{
  const modal=$('modal');if(!modal.open||event.key!=='Tab'||event.defaultPrevented)return;
  const controls=[...modal.querySelectorAll('button,input,textarea,select,a[href],summary,iframe,[tabindex]')].filter(renderedFocusTarget);
  if(!controls.length)return;
  const first=controls[0],last=controls.at(-1),active=document.activeElement;
  if(!controls.includes(active)||event.shiftKey&&active===first||!event.shiftKey&&active===last){event.preventDefault();(event.shiftKey?last:first).focus({preventScroll:true});}
},true);
$('modal').addEventListener('cancel',event=>{if(firstInvalidField()){event.preventDefault();explainInvalidField();return;}choiceSequence++;modalSequence++;});
$('modal').addEventListener('close',()=>{if(!$('modal').open){modalSequence++;rememberPreviewSession();previewOptions=null;$('modal-content').innerHTML='';if($('toast').parentElement===$('modal'))document.body.append($('toast'));renderPanels();restoreModalFocus();}});
document.querySelector('.brand').addEventListener('click',event=>{event.preventDefault();openDialog();});
$('layer-list').addEventListener('dragstart',event=>{const row=event.target.closest('.layer-row');if(row){draggedLayer=row.dataset.layer;event.dataTransfer.setData('text/plain',draggedLayer);}});
$('layer-list').addEventListener('dragover',event=>{const row=event.target.closest('.layer-row');if(row&&draggedLayer){event.preventDefault();for(const item of document.querySelectorAll('.drag-target'))item.classList.remove('drag-target');row.classList.add('drag-target');}});
$('layer-list').addEventListener('drop',event=>{event.preventDefault();const row=event.target.closest('.layer-row');if(row&&draggedLayer){const frame=getFrame(doc),source=getNode(doc,frame.id,draggedLayer),target=getNode(doc,frame.id,row.dataset.layer);if(!isLocked(source)&&source.parentId===target.parentId)commit(reorderNode(doc,frame.id,draggedLayer,frame.nodes.findIndex(n=>n.id===target.id)));else if(source.parentId!==target.parentId)toast('Choose a Parent container in Layout to move between containers.');}draggedLayer=null;renderLayers();});
$('layer-list').addEventListener('dragend',()=>{draggedLayer=null;renderLayers();});
document.addEventListener('keydown',event=>{
  const editing=event.target.matches('input,textarea,select,[contenteditable=true]'),mod=event.metaKey||event.ctrlKey;
  if(mod&&event.key.toLowerCase()==='s'){event.preventDefault();save();return;}
  if($('modal').open||editorClosed)return;
  if(editing)return;
  if(event.key==='Escape'&&canvas.cancelInteraction()){event.preventDefault();event.stopPropagation();return;}
  if(event.shiftKey&&!mod&&(event.code==='Digit1'||event.key==='!')){event.preventDefault();canvas.fitAll();return;}
  if(event.shiftKey&&!mod&&(event.code==='Digit2'||event.key==='@')){event.preventDefault();canvas.fitSelection();return;}
  if(mod&&event.key.toLowerCase()==='z'){event.preventDefault();event.shiftKey?redo():undo();return;}
  if(mod&&event.key.toLowerCase()==='y'){event.preventDefault();redo();return;}
  if(mod&&event.key.toLowerCase()==='d'){event.preventDefault();duplicate();return;}
  if(mod&&event.key.toLowerCase()==='c'){event.preventDefault();copy();return;}
  if(mod&&event.key.toLowerCase()==='v'){event.preventDefault();paste();return;}
  if(['Delete','Backspace'].includes(event.key)){event.preventDefault();remove();return;}
  if(event.key==='Escape'){selected=[];render();return;}
  if(event.key.startsWith('Arrow')&&selected.length){
    event.preventDefault();const step=event.shiftKey?10:1,forward=['ArrowDown','ArrowRight'].includes(event.key),frame=getFrame(doc),roots=selectedRoots().filter(node=>!isLocked(node)),chosen=new Set(roots.map(node=>node.id));let next=doc;
    roots.sort((a,b)=>frame.nodes.indexOf(a)-frame.nodes.indexOf(b));if(forward)roots.reverse();
    for(const node of roots){
      const current=getFrame(next),parent=node.parentId?current.nodes.find(item=>item.id===node.parentId):null;
      if((parent?.layout||current.layout).direction==='free')next=updateNode(next,current.id,node.id,{x:node.x+(event.key==='ArrowRight'?step:event.key==='ArrowLeft'?-step:0),y:node.y+(event.key==='ArrowDown'?step:event.key==='ArrowUp'?-step:0)});
      else{const siblings=current.nodes.filter(item=>item.parentId===node.parentId),index=siblings.findIndex(item=>item.id===node.id),target=siblings[Math.max(0,Math.min(siblings.length-1,index+(forward?step:-step)))];if(target.id!==node.id&&!chosen.has(target.id))next=reorderNode(next,current.id,node.id,current.nodes.findIndex(item=>item.id===target.id));}
    }
    commit(next);
  }
});
window.addEventListener('beforeunload',()=>{if(editorClosed)return;canvas.flushEdits?.();finishEdit();emergency();});
window.addEventListener('pagehide',()=>{library?.close();blocksPromise?.then(blocks=>blocks.close()).catch(()=>{});});
document.body.removeAttribute('data-loading');$('startup-notice')?.remove();
render();requestAnimationFrame(()=>canvas.fitAll());
if(recoveryWarnings.length)setTimeout(()=>toast('Recovery needs attention. Open the project library for details.',true),50);
const initialContext=working,initialHash=hash(),initialSequence=choiceSequence;
if(!editorClosed)request('/api/projects/'+encodeURIComponent(doc.id)).then(record=>{
  if(working===initialContext&&choiceSequence===initialSequence&&hash()===initialHash&&hash(validateDocument(record.document))===initialHash){
    // A recovered draft keeps its own base even if a newer file looks identical.
    if(!working.touched||working.clean||working.baseRevision===0){working.baseRevision=record.revision;working.clean=initialHash;savedHash=initialHash;rememberNow();}
  }updateStatus();
}).catch(()=>{});
// Read-only state seam for QA and agent-assisted design handoff.
window.WidgetStudio={getDocument:()=>cloneDocument(doc),getSelection:()=>[...selected],getZoom:()=>canvas.getZoom(),getCamera:()=>canvas.getCamera(),whenIdle:async(waitForSave=true)=>{if(saveTimer)await new Promise(resolve=>setTimeout(resolve,270));if(waitForSave)await savingDone;let pending;do{pending=persistQueue;await pending;}while(pending!==persistQueue);}};
