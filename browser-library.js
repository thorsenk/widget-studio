import {validateDocument,defaultNode} from './document.js';
import {ProjectStore,PersistenceError} from './project-store.js';

export const LIBRARY_NAME='widget-studio-working-copies-v2';
export const LEGACY_CURRENT='widget-studio:current-draft';
export const EMERGENCY_PREFIX='widget-studio:recovery-v2:';
export const designText=doc=>{const {activeFrameId,...design}=validateDocument(doc);return JSON.stringify(design);};
const requestValue=request=>new Promise((resolve,reject)=>{request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error);});
const identifier=value=>typeof value==='string'&&/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,255}$/.test(value);
const date=value=>typeof value==='string'&&Number.isFinite(Date.parse(value))&&new Date(value).toISOString()===value;
const revision=value=>Number.isSafeInteger(value)&&value>=0;
const newKey=()=>defaultNode('rectangle').id;
const metaKeys=new Set(['key','projectId','name','kind','createdAt','updatedAt','version','baseRevision','contentHash','views','layers','trashedAt','source']);
function checkMeta(meta){
  if(!meta||Object.getPrototypeOf(meta)!==Object.prototype||Reflect.ownKeys(meta).some(key=>!metaKeys.has(key)))throw new PersistenceError('Browser copy metadata is invalid. Recovery data was preserved.','invalid-data');
  if(!identifier(meta.key)||!identifier(meta.projectId)||typeof meta.name!=='string'||!['draft','saved','trashed'].includes(meta.kind)||!date(meta.createdAt)||!date(meta.updatedAt)||!revision(meta.baseRevision)||!Number.isSafeInteger(meta.version)||meta.version<1||!/^[a-f0-9]{64}$/.test(meta.contentHash)||!Number.isInteger(meta.views)||meta.views<1||!Number.isInteger(meta.layers)||meta.layers<0||!['new','legacy','file','recovery'].includes(meta.source)||!(meta.trashedAt===null||date(meta.trashedAt)))throw new PersistenceError('Browser copy metadata is invalid. Recovery data was preserved.','invalid-data');
  return meta;
}
async function fingerprint(doc){const bytes=new TextEncoder().encode(designText(doc));const digest=await globalThis.crypto.subtle.digest('SHA-256',bytes);return [...new Uint8Array(digest)].map(value=>value.toString(16).padStart(2,'0')).join('');}
function asError(error){if(error instanceof PersistenceError)return error;return new PersistenceError(error?.name==='QuotaExceededError'?'Browser storage is full. Save a file to preserve your work.':'Browser storage is unavailable. Existing recovery data was preserved.',error?.name==='QuotaExceededError'?'quota':'storage',error);}

/** Native transactions protect metadata, content and session choices across windows. */
export class BrowserLibrary {
  static async open({indexedDB=globalThis.indexedDB,name=LIBRARY_NAME,now=()=>new Date(),maxDrafts=100,maxTrash=100}={}){
    if(!indexedDB?.open)throw new PersistenceError('Browser storage is unavailable. Saved files can still be opened.','unavailable');
    const request=indexedDB.open(name,1);
    request.onupgradeneeded=()=>{for(const store of ['copies','documents','sessions'])request.result.createObjectStore(store,{keyPath:'key'});};
    const db=await requestValue(request);db.onversionchange=()=>db.close();
    return new BrowserLibrary(db,{now,maxDrafts,maxTrash});
  }
  constructor(db,{now,maxDrafts,maxTrash}){this.db=db;this.now=now;this.maxDrafts=maxDrafts;this.maxTrash=maxTrash;}
  close(){this.db.close();}
  _time(previous){const value=this.now(),stamp=(value instanceof Date?value:new Date(value)).toISOString();return previous&&previous>stamp?previous:stamp;}
  _run(mode,work){return new Promise((resolve,reject)=>{
    let tx,failure,result;
    try{tx=this.db.transaction(['copies','documents','sessions'],mode);}catch(error){reject(asError(error));return;}
    const stores=Object.fromEntries(['copies','documents','sessions'].map(name=>[name,tx.objectStore(name)]));
    tx.oncomplete=()=>resolve(result);tx.onerror=()=>{failure??=tx.error;};tx.onabort=()=>reject(asError(failure||tx.error));
    Promise.resolve().then(()=>work(stores)).then(value=>{result=value;}).catch(error=>{failure=error;try{tx.abort();}catch{reject(asError(error));}});
  });}
  async _putSession(stores,session,key,activeFrameId,closed=false,discardedKey=null){
    stores.sessions.put({key:'session:'+session,currentKey:key,activeFrameId,closed,discardedKey});stores.sessions.put({key:'last-session',value:session});
  }
  async list(){return this._run('readonly',async stores=>(await requestValue(stores.copies.getAll())).map(checkMeta).sort((a,b)=>b.updatedAt.localeCompare(a.updatedAt)||a.key.localeCompare(b.key)));}
  async read(key){return this._run('readonly',async stores=>{
    const meta=await requestValue(stores.copies.get(key));if(!meta)return null;checkMeta(meta);
    const stored=await requestValue(stores.documents.get(key));if(!stored)throw new PersistenceError('This copy’s content is unavailable. Existing data was preserved.','invalid-data');
    const document=validateDocument(stored.document);if(document.id!==meta.projectId||document.name!==meta.name)throw new PersistenceError('Browser copy content does not match its metadata.','invalid-data');
    return {...meta,document};
  });}
  async current(session){
    const pointer=await this._run('readonly',async stores=>(await requestValue(stores.sessions.get('session:'+session)))||await requestValue(stores.sessions.get('last-session')).then(last=>last?requestValue(stores.sessions.get('session:'+last.value)):null));
    if(!pointer)return null;if(pointer.closed||!pointer.currentKey)return {closed:true};
    const record=await this.read(pointer.currentKey);if(!record||record.kind==='trashed')return {closed:true};
    if(record.document.frames.some(frame=>frame.id===pointer.activeFrameId))record.document.activeFrameId=pointer.activeFrameId;
    return record;
  }
  async saveCopy(document,{key=null,version=null,baseRevision=0,clean=false,session=null,makeCurrent=true,source='new'}={}){
    document=validateDocument(document);if(!revision(baseRevision)||key!==null&&!identifier(key)||version!==null&&!revision(version)||session!==null&&!identifier(session)||!['new','legacy','file','recovery'].includes(source))throw new TypeError('Working copy options are invalid.');const contentHash=await fingerprint(document);
    return this._run('readwrite',async stores=>{
      const records=(await requestValue(stores.copies.getAll())).map(checkMeta),old=key?records.find(item=>item.key===key):null;
      const forked=Boolean(key&&(old?(old.kind==='trashed'||old.version!==version||old.projectId!==document.id):version>0));
      if(!key||forked){key=newKey();if(records.some(item=>item.key===key))throw new PersistenceError('Copy identity collision. Try again.','conflict');}
      const existing=forked?null:old,kind=clean?'saved':'draft';
      if(kind==='draft'&&(!existing||existing.kind!=='draft')&&records.filter(item=>item.kind==='draft').length>=this.maxDrafts)throw new PersistenceError(`The browser library holds up to ${this.maxDrafts} drafts. Save or move a draft to Trash first.`,'capacity');
      const changed=!existing||existing.contentHash!==contentHash,stamp=this._time(existing?.updatedAt);
      const meta={key,projectId:document.id,name:document.name,kind,createdAt:existing?.createdAt||stamp,updatedAt:changed?stamp:existing.updatedAt,version:existing?existing.version+(changed?1:0):1,baseRevision:existing?Math.max(existing.baseRevision,baseRevision):baseRevision,contentHash,views:document.frames.length,layers:document.frames.reduce((count,frame)=>count+frame.nodes.length,0),trashedAt:null,source:existing?.source||source};
      stores.copies.put(meta);stores.documents.put({key,document});if(session&&makeCurrent)await this._putSession(stores,session,key,document.activeFrameId);
      return {...meta,document,forked};
    });
  }
  async openSaved(document,fileRevision,session){
    document=validateDocument(document);if(!revision(fileRevision))throw new TypeError('File revision is invalid.');const hash=await fingerprint(document);
    const cached=(await this.list()).find(item=>item.kind==='saved'&&item.projectId===document.id&&item.contentHash===hash&&item.baseRevision===fileRevision);
    return this.saveCopy(document,{key:cached?.key,version:cached?.version,baseRevision:fileRevision,clean:true,session,source:'file'});
  }
  async recover(key,session){return this._run('readwrite',async stores=>{
    const meta=checkMeta(await requestValue(stores.copies.get(key)));if(meta.kind!=='draft')throw new PersistenceError('This draft changed location. Refresh the library.','conflict');
    const stored=await requestValue(stores.documents.get(key)),document=validateDocument(stored.document);
    await this._putSession(stores,session,key,document.activeFrameId);return {...meta,document};
  });}
  async trash(key,version,session){return this._run('readwrite',async stores=>{
    const meta=checkMeta(await requestValue(stores.copies.get(key)));if(meta.kind!=='draft'||meta.version!==version)throw new PersistenceError('This draft changed in another window. Refresh before moving it.','conflict');
    const records=(await requestValue(stores.copies.getAll())).map(checkMeta);if(records.filter(item=>item.kind==='trashed').length>=this.maxTrash)throw new PersistenceError(`Browser Trash holds up to ${this.maxTrash} drafts. Restore a draft first.`,'capacity');
    const next={...meta,kind:'trashed',trashedAt:this._time(meta.updatedAt),version:meta.version+1};stores.copies.put(next);
    const pointer=await requestValue(stores.sessions.get('session:'+session));if(pointer?.currentKey===key)await this._putSession(stores,session,null,null,true,key);
    return next;
  });}
  async restore(key,version){return this._run('readwrite',async stores=>{
    const meta=checkMeta(await requestValue(stores.copies.get(key)));if(meta.kind!=='trashed'||meta.version!==version)throw new PersistenceError('This Trash entry changed. Refresh the library.','conflict');
    const records=(await requestValue(stores.copies.getAll())).map(checkMeta);if(records.filter(item=>item.kind==='draft').length>=this.maxDrafts)throw new PersistenceError('The browser draft limit is reached. Save or move another draft first.','capacity');
    const next={...meta,kind:'draft',trashedAt:null,version:meta.version+1};stores.copies.put(next);return next;
  });}
  async closeSession(session){return this._run('readwrite',stores=>this._putSession(stores,session,null,null,true));}
  async finishFileSave(key,snapshot,baseRevision,fileRevision){
    snapshot=validateDocument(snapshot);if(!revision(baseRevision)||!revision(fileRevision)||fileRevision<=baseRevision)throw new TypeError('File completion revisions are invalid.');
    const contentHash=await fingerprint(snapshot);return this._run('readwrite',async stores=>{
      const meta=key?await requestValue(stores.copies.get(key)):null;if(!meta||meta.kind==='trashed')return meta;
      checkMeta(meta);if(meta.projectId!==snapshot.id||meta.baseRevision!==baseRevision)return meta;
      const next={...meta,baseRevision:fileRevision,kind:meta.contentHash===contentHash?'saved':'draft'};stores.copies.put(next);return next;
    });
  }
  async importEmergencies(storage,session){
    const warnings=[];
    // Oldest first lets the newest snapshot become the session's current copy.
    for(const value of readEmergencies(storage).reverse()){
      const contentHash=await fingerprint(value.document);
      await this._run('readwrite',async stores=>{
        const records=(await requestValue(stores.copies.getAll())).map(checkMeta);
        const original=records.find(item=>item.key===value.key);
        let meta=records.find(item=>item.projectId===value.document.id&&item.contentHash===contentHash&&item.baseRevision>=value.baseRevision);
        const pointer=await requestValue(stores.sessions.get('session:'+value.session));
        // An explicit discard wins over an older close-time snapshot.
        if(original?.kind==='trashed'&&pointer?.closed&&pointer.discardedKey===value.key)return;
        if(!meta){
          const document=value.document,sameVersion=original&&original.kind!=='trashed'&&original.version===value.version&&original.projectId===document.id;
          const key=!original||sameVersion?value.key:newKey();
          meta={key,projectId:document.id,name:document.name,kind:'draft',createdAt:sameVersion?original.createdAt:value.updatedAt,updatedAt:sameVersion&&original.updatedAt>value.updatedAt?original.updatedAt:value.updatedAt,version:sameVersion?original.version+1:1,baseRevision:sameVersion?Math.max(original.baseRevision,value.baseRevision):value.baseRevision,contentHash,views:document.frames.length,layers:document.frames.reduce((sum,frame)=>sum+frame.nodes.length,0),trashedAt:null,source:sameVersion?original.source:'recovery'};
          stores.copies.put(meta);stores.documents.put({key,document});
        }
        if(meta.kind!=='trashed'&&(!pointer||!pointer.closed&&pointer.currentKey===value.key))await this._putSession(stores,value.session,meta.key,value.document.activeFrameId);
      });
      // Only remove a snapshot after its transaction committed.
      try{storage.removeItem(value.storageKey);}catch{warnings.push('A recovery snapshot was imported but its temporary backup could not be removed.');}
    }
    const valid=new Set(readEmergencies(storage).map(item=>item.storageKey));
    for(let index=0;index<storage.length;index++){const key=storage.key(index);if(key?.startsWith(EMERGENCY_PREFIX)&&!valid.has(key))warnings.push('Unreadable recovery data was preserved. Download recovery data from the library.');}
    return warnings;
  }
  async importLegacy(storage,session){
    const warnings=[],candidates=[];let currentDoc=null,flags=null,revisions={};
    try{const value=storage.getItem('widget-studio:draft-ids');if(value!==null){const parsed=JSON.parse(value);if(!Array.isArray(parsed)||parsed.some(id=>!identifier(id)))throw Error();flags=new Set(parsed);}}catch{warnings.push('Draft flags were unreadable; valid local copies were retained conservatively.');}
    try{const parsed=JSON.parse(storage.getItem('widget-studio:file-revisions')||'{}');if(!parsed||Array.isArray(parsed)||typeof parsed!=='object'||Object.entries(parsed).some(([id,value])=>!identifier(id)||!revision(value)))throw Error();revisions=parsed;}catch{warnings.push('File revision metadata was unreadable. Older drafts retain a conservative base revision.');}
    try{for(const record of new ProjectStore(storage).readAll())candidates.push({...record,kind:flags&&!flags.has(record.id)&&revisions[record.id]>0?'saved':'draft',baseRevision:revisions[record.id]||0});}catch(error){warnings.push(error.message);}
    try{const raw=storage.getItem(LEGACY_CURRENT);if(raw!==null){currentDoc=validateDocument(JSON.parse(raw));if(!candidates.some(item=>designText(item.document)===designText(currentDoc)))candidates.push({document:currentDoc,createdAt:this._time(),updatedAt:this._time(),kind:'draft',baseRevision:revisions[currentDoc.id]||0});}}catch{warnings.push('Unreadable legacy recovery data was preserved. Download it from the library before replacing it.');}
    const prepared=await Promise.all(candidates.map(async candidate=>({...candidate,contentHash:await fingerprint(candidate.document)})));
    await this._run('readwrite',async stores=>{
      const records=(await requestValue(stores.copies.getAll())).map(checkMeta),first=!(await requestValue(stores.sessions.get('legacy-imported')));let selected=null;
      for(const item of prepared){
        const migrationKey='legacy:'+item.document.id+':'+item.contentHash;
        if(await requestValue(stores.sessions.get(migrationKey)))continue;
        let meta=records.find(record=>record.projectId===item.document.id&&record.contentHash===item.contentHash);
        if(!meta){const key=newKey(),stamp=this._time(),document=validateDocument(item.document);meta={key,projectId:document.id,name:document.name,kind:item.kind,createdAt:date(item.createdAt)?item.createdAt:stamp,updatedAt:date(item.updatedAt)?item.updatedAt:stamp,version:1,baseRevision:item.baseRevision,contentHash:item.contentHash,views:document.frames.length,layers:document.frames.reduce((sum,frame)=>sum+frame.nodes.length,0),trashedAt:null,source:'legacy'};records.push(meta);stores.copies.put(meta);stores.documents.put({key,document});}
        stores.sessions.put({key:migrationKey,value:true});
        if(currentDoc&&designText(item.document)===designText(currentDoc)&&meta.kind!=='trashed')selected=meta;
      }
      if(first&&selected&&!(await requestValue(stores.sessions.get('session:'+session))))await this._putSession(stores,session,selected.key,currentDoc.activeFrameId);
      stores.sessions.put({key:'legacy-imported',value:true});
    });
    return warnings;
  }
}

/** Synchronous close-time fallback. Legacy content keys are never overwritten. */
export function keepEmergency(storage,session,key,document,baseRevision,version){
  if(!identifier(session)||!identifier(key)||!revision(baseRevision)||!revision(version))throw new TypeError('Recovery snapshot identity or revision is invalid.');
  const value={schemaVersion:1,session,key,document:validateDocument(document),baseRevision,version,updatedAt:new Date().toISOString()};
  storage.setItem(EMERGENCY_PREFIX+session+':'+key,JSON.stringify(value));return value;
}
export function readEmergencies(storage){const values=[];for(let index=0;index<storage.length;index++){const key=storage.key(index);if(!key?.startsWith(EMERGENCY_PREFIX))continue;try{const value=JSON.parse(storage.getItem(key));if(value.schemaVersion!==1||!identifier(value.session)||!identifier(value.key)||!revision(value.baseRevision)||!revision(value.version)||!date(value.updatedAt)||key!==EMERGENCY_PREFIX+value.session+':'+value.key)continue;values.push({...value,document:validateDocument(value.document),storageKey:key});}catch{}}return values.sort((a,b)=>b.updatedAt.localeCompare(a.updatedAt));}
