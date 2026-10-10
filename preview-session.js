/** Validate transient preview data against this project's known control IDs. */
export function sanitizePreviewSession(value,document){
  const object=item=>item&&typeof item==='object'&&!Array.isArray(item);
  if(!object(value)||!object(value.values)||!object(value.lists)||!object(value.drafts)||!object(value.texts)||!object(value.errors)||!object(value.states)||typeof value.view!=='string')return null;
  const nodes=new Map(document.frames.flatMap(view=>view.nodes.map(node=>[node.id,node]))),frames=new Set(document.frames.map(view=>view.id));
  const result={values:{},lists:{},drafts:{},texts:{},errors:{},states:{},view:frames.has(value.view)?value.view:[document.entryFrameId,document.activeFrameId,document.frames[0]?.id].find(id=>frames.has(id))};
  const put=(target,id,item)=>Object.defineProperty(target,id,{value:item,enumerable:true,writable:true,configurable:true});
  for(const [id,item] of Object.entries(value.values)){
    const node=nodes.get(id);if(!node)continue;
    if(node.type==='checkbox'){if(typeof item!=='boolean')return null;put(result.values,id,item);}
    else if(['input','select'].includes(node.type)){if(typeof item!=='string'||item.length>20000)return null;if(node.type==='select'&&item&&!node.options.includes(item))continue;put(result.values,id,item);}
  }
  for(const [id,items] of Object.entries(value.lists)){
    if(nodes.get(id)?.type!=='list')continue;
    if(!Array.isArray(items)||items.length>100||items.some(item=>!object(item)||typeof item.text!=='string'||item.text.length>1000||typeof item.done!=='boolean'))return null;
    put(result.lists,id,items.map(({text,done})=>({text,done})));
  }
  for(const key of ['drafts','texts','errors'])for(const [id,item] of Object.entries(value[key])){
    const node=nodes.get(id);if(!node||key==='drafts'&&node.type!=='list'||key==='texts'&&node.type!=='text')continue;
    if(typeof item!=='string'||item.length>(key==='drafts'?1000:key==='errors'?4000:20000))return null;put(result[key],id,item);
  }
  for(const [id,state] of Object.entries(value.states)){if(!frames.has(id))continue;if(!['default','hover','disabled','loading','error','success'].includes(state))return null;put(result.states,id,state);}
  return result;
}
export function parsePreviewSession(data,document,session,lastSequence=0){
  if(!data||data.type!=='widget-studio:preview-session'||data.session!==session||!session||!Number.isSafeInteger(data.sequence)||data.sequence<=lastSequence||typeof data.snapshotJSON!=='string'||data.snapshotJSON.length>16000000)return null;
  try{const snapshot=sanitizePreviewSession(JSON.parse(data.snapshotJSON),document);return snapshot?{sequence:data.sequence,snapshot}:null;}catch{return null;}
}

/** Hidden compatible nodes may be omitted by a preview, but remain in the project. */
export function mergePreviewSession(previous,next,document){
  const nodes=new Map(document.frames.flatMap(view=>view.nodes.map(node=>[node.id,node])));
  const hidden=id=>{let node=nodes.get(id);while(node){if(node.visible===false)return true;node=nodes.get(node.parentId);}return false;};
  const merged={...next};for(const key of ['values','lists','drafts','texts','errors','states'])merged[key]={...Object.fromEntries(Object.entries(previous?.[key]||{}).filter(([id])=>hidden(id))),...next[key]};
  return sanitizePreviewSession(merged,document);
}
