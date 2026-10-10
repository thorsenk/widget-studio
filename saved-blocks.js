import {validateDocument,defaultNode,getFrame} from './document.js';

const DB_NAME='widget-studio-saved-blocks-v1';
const requestValue=request=>new Promise((resolve,reject)=>{request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error);});
const identifier=value=>typeof value==='string'&&/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(value);
function meta(record){
  if(!record||!identifier(record.id)||typeof record.name!=='string'||!record.name.trim()||record.name.length>160||!['saved','trashed'].includes(record.kind)||!Number.isFinite(Date.parse(record.createdAt)))throw Error('A saved block record is unreadable. Its data was preserved.');
  return record;
}
function decode(value){
  if(!value||!identifier(value.frameId)||!Array.isArray(value.nodeIds)||!Array.isArray(value.boxes))throw Error('This block is unreadable. Its saved data was preserved.');
  const source=validateDocument(value.source),frame=getFrame(source,value.frameId);
  if(!value.nodeIds.length||value.nodeIds.some(id=>!frame.nodes.some(node=>node.id===id)))throw Error('The saved block layers are unavailable.');
  const boxes=new Map();
  for(const entry of value.boxes){
    if(!Array.isArray(entry)||entry.length!==2||!identifier(entry[0])||!entry[1]||['x','y','width','height'].some(key=>!Number.isFinite(entry[1][key])))throw Error('The saved block geometry is unreadable.');
    boxes.set(entry[0],entry[1]);
  }
  return {source,frameId:value.frameId,nodeIds:[...value.nodeIds],boxes};
}

/** Browser-local snapshots. Trash is reversible; no background eviction. */
export class SavedBlocks{
  static async open(indexedDB=globalThis.indexedDB){
    if(!indexedDB)throw Error('Saved blocks need browser storage. Your project can still be saved or exported.');
    const request=indexedDB.open(DB_NAME,1);
    request.onupgradeneeded=()=>{request.result.createObjectStore('meta',{keyPath:'id'});request.result.createObjectStore('content',{keyPath:'id'});};
    const db=await requestValue(request);db.onversionchange=()=>db.close();return new SavedBlocks(db);
  }
  constructor(db){this.db=db;}
  close(){this.db.close();}
  run(mode,work){return new Promise((resolve,reject)=>{
    let result,failure,tx;
    try{tx=this.db.transaction(['meta','content'],mode);}catch(error){reject(Error('Saved block storage is unavailable: '+error.message));return;}
    tx.oncomplete=()=>resolve(result);tx.onerror=()=>{failure??=tx.error;};tx.onabort=()=>reject(Error('Saved block storage failed; existing blocks were kept. '+(failure?.message||tx.error?.message||'')));
    Promise.resolve().then(()=>work(tx.objectStore('meta'),tx.objectStore('content'))).then(value=>{result=value;}).catch(error=>{failure=error;try{tx.abort();}catch{reject(error);}});
  });}
  async list(){return this.run('readonly',async store=>(await requestValue(store.getAll())).map(meta).sort((a,b)=>b.createdAt.localeCompare(a.createdAt)));}
  async save(name,clipboard){
    if(typeof name!=='string')throw Error('Give the block a text name.');
    name=name.trim();if(!name||name.length>160)throw Error('Give the block a name up to 160 characters.');
    const id='block-'+defaultNode('rectangle').id.slice(5),createdAt=new Date().toISOString();
    const data={source:{...clipboard.source,id},frameId:clipboard.frameId,nodeIds:clipboard.nodeIds,boxes:[...clipboard.boxes]};
    const snapshot=decode(data),record={id,name,kind:'saved',createdAt,layers:snapshot.nodeIds.length};
    return this.run('readwrite',(store,content)=>{store.add(record);content.add({id,clipboard:{...snapshot,boxes:[...snapshot.boxes]}});return record;});
  }
  async read(id){return this.run('readonly',async(store,content)=>{const record=meta(await requestValue(store.get(id)));if(record.kind!=='saved')throw Error('Restore this block from Trash before inserting it.');const value=await requestValue(content.get(id));return {record,clipboard:decode(value?.clipboard)};});}
  async trash(id){return this.location(id,'trashed');}
  async restore(id){return this.location(id,'saved');}
  async location(id,kind){return this.run('readwrite',async store=>{const record=meta(await requestValue(store.get(id)));store.put({...record,kind});});}
}
