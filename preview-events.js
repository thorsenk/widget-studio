import {resolveInputBindings} from './bindings.js';
import {STATE_NAMES} from './document.js';

const keys=new Set(['type','session','sequence','view','node','kind','outcome','message','truncated','argsJSON']);
function recordHasKeys(data,allowed){
  if(!data||typeof data!=='object'||![Object.prototype,null].includes(Object.getPrototypeOf(data)))return false;
  const names=Reflect.ownKeys(data);if(names.length!==allowed.size)return false;
  return names.every(key=>typeof key==='string'&&allowed.has(key)&&Object.hasOwn(Object.getOwnPropertyDescriptor(data,key),'value'));
}
/** Parse bounded diagnostics from the current opaque preview, never authored HTML. */
export function parsePreviewAction(data,document,session,lastSequence=0) {
  if(!recordHasKeys(data,keys))return null;
  if(data.type!=='widget-studio:preview-action'||data.session!==session||typeof session!=='string'||!session)return null;
  if(!Number.isSafeInteger(data.sequence)||data.sequence<=lastSequence||data.sequence<1)return null;
  if(typeof data.message!=='string'||data.message.length>4000||typeof data.truncated!=='boolean')return null;
  const view=document.frames.find(view=>view.id===data.view),node=view?.nodes.find(node=>node.id===data.node);
  if(!node||!(node.action.kind===data.kind||data.kind==='list'&&node.type==='list'||data.kind==='control'&&['input','checkbox','select'].includes(node.type)))return null;
  const outcomes={tool:['simulated','error'],navigate:['navigated'],link:['info'],none:['info'],local:['changed','error'],submit:['success','error'],list:['changed','error'],control:['changed','error']};
  if(!outcomes[data.kind]?.includes(data.outcome))return null;
  let argsText=null,argsTruncated=false;
  if(data.argsJSON!==null){
    if(!['tool','local','submit','list','control'].includes(data.kind)||typeof data.argsJSON!=='string'||data.argsJSON.length>50000)return null;
    try{
      const args=JSON.parse(data.argsJSON);
      if(!args||typeof args!=='object'||Array.isArray(args))return null;
      resolveInputBindings(args,()=>{throw Error('Unexpected unresolved marker.');});
      argsText=JSON.stringify(args,null,2);argsTruncated=argsText.length>100000;
      if(argsTruncated)argsText=argsText.slice(0,100000)+'\n… Display truncated.';
    }catch{return null;}
  }else if(data.kind==='tool'&&data.outcome==='simulated')return null;
  return {sequence:data.sequence,viewId:view.id,nodeId:node.id,viewName:view.name,layerName:node.name,kind:data.kind,outcome:data.outcome,message:data.message,truncated:data.truncated,argsText,argsTruncated,
    title:data.kind==='tool'?node.action.toolName:data.kind==='navigate'?'View navigation':data.kind==='link'?'Link preview':data.kind==='local'?'Local action':data.kind==='submit'?'Form submit':data.kind==='list'?'Local tasks':data.kind==='control'?'Local value':'No action',link:data.kind==='link'?node.action.href:null};
}

const infoKeys=new Set(['type','session','sequence','view','state','height']);
export function parsePreviewInfo(data,document,session,lastSequence=0){
  if(!recordHasKeys(data,infoKeys)||data.type!=='widget-studio:preview-info'||data.session!==session||typeof session!=='string'||!session)return null;
  if(!Number.isSafeInteger(data.sequence)||data.sequence<=lastSequence||data.sequence<1||!STATE_NAMES.includes(data.state))return null;
  if(!Number.isInteger(data.height)||data.height<32||data.height>8192)return null;
  const view=document.frames.find(view=>view.id===data.view);if(!view)return null;
  return {sequence:data.sequence,viewId:view.id,viewName:view.name,state:data.state,height:data.height};
}
