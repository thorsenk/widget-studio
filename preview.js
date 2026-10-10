import {cloneDocument,STATE_NAMES} from './document.js';
import {createWidgetHTML} from './export.js';
let previewSessionSequence=0;
export function newPreviewSession(){return globalThis.crypto?.randomUUID?.()||'preview-'+Date.now().toString(36)+'-'+(++previewSessionSequence);}

// Preview-only options never modify the saved design or add sandbox permissions.
function previewFeedback(session) {
  const root=document.querySelector('.widget-frame');let previous='',previousSession='',sequence=0,sessionSequence=0,active=true;
  function report(){
    const value=window.WidgetRuntime?.getState();if(!active||!value||!root)return;
    const height=Math.max(32,Math.min(8192,Math.ceil(root.getBoundingClientRect().height))),signature=value.view+':'+value.state+':'+height;
    const snapshotJSON=JSON.stringify(window.WidgetRuntime?.getSession());if(snapshotJSON&&snapshotJSON!==previousSession){previousSession=snapshotJSON;window.parent?.postMessage({type:'widget-studio:preview-session',session,sequence:++sessionSequence,snapshotJSON},'*');}
    if(signature===previous)return;previous=signature;
    window.parent?.postMessage({type:'widget-studio:preview-info',session,sequence:++sequence,view:value.view,state:value.state,height},'*');
  }
  root?.addEventListener('input',report);root?.addEventListener('change',report);
  const observer=new MutationObserver(report);if(root)observer.observe(root,{subtree:true,attributes:true,childList:true,characterData:true});
  window.addEventListener('pagehide',()=>{active=false;observer.disconnect();});report();
}
export function createPreviewHTML(document,frameId,{state='default',reduceMotion=false,session=newPreviewSession(),simulation=null,snapshot=null}={}) {
  if(!STATE_NAMES.includes(state))throw new TypeError('Unsupported preview state');
  const doc=cloneDocument(document);
  return createWidgetHTML(doc,frameId,{preview:true,state,feedback:'external',session,reduceMotion,inspectAllViews:true,simulation,previewSnapshot:snapshot}).replace('</body>',`<script>(${previewFeedback.toString()})(${JSON.stringify(session)});</script></body>`);
}
