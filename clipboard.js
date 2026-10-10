import {validateDocument,getFrame,collectDescendantIds,defaultNode,createDocument,LIMITS} from './document.js';
import {resolveFrame} from './layout.js';
import {resolveInputBindings} from './bindings.js';
import {remapNodeReferences,nodeDependencies,viewDependencies} from './references.js';
import {initialBoundText} from './authoring-values.js';

const appearanceKeys=['fill','color','fontFamily','fontSize','fontWeight','strokeWidth'];
const clone=value=>JSON.parse(JSON.stringify(value));
function uniqueName(name,used) {
  let result=name,index=1;
  while(used.has(result)){const suffix=index===1?' copy':' copy '+index;result=name.slice(0,160-suffix.length)+suffix;index++;}
  used.add(result);return result;
}

/** Snapshot authored data and default-state geometry; later source edits cannot alter a copy. */
export function captureLayerClipboard(document,frameId,ids,{measureText}={}) {
  const source=validateDocument(document),frame=getFrame(source,frameId);
  if(!Array.isArray(ids)||ids.some(id=>!frame.nodes.some(node=>node.id===id)))throw Error('Choose layers in the source view to copy.');
  const nodeIds=collectDescendantIds(frame,ids);
  if(!nodeIds.length)return null;
  const boxes=new Map();
  for(const view of source.frames){
    const base=new Map(resolveFrame({...view,nodes:view.nodes.map(node=>({...node,visible:true,disabled:false,states:{}}))},view.width,{theme:source.theme,readText:(_id,node)=>initialBoundText(source,node),measureText}).nodes.map(node=>[node.id,node]));
    const visible=resolveFrame(view,view.width,{theme:source.theme,readText:(_id,node)=>initialBoundText(source,node),measureText}).nodes;
    const fallback=visible.length<view.nodes.length?resolveFrame({...view,nodes:view.nodes.map(node=>({...node,visible:true}))},view.width,{theme:source.theme,readText:(_id,node)=>initialBoundText(source,node),measureText}).nodes:[];
    for(const node of [...visible,...fallback])if(!boxes.has(node.id))boxes.set(node.id,{...Object.fromEntries(['x','y','width','height'].map(key=>[key,node[key]])),...Object.fromEntries(appearanceKeys.map(key=>[key,base.get(node.id)[key]]))});
  }
  return {source,frameId,nodeIds,boxes};
}

/** Build one atomic paste, including navigation/input dependency closure. */
export function pasteLayerClipboard(document,frameId,clipboard) {
  const target=validateDocument(document),frame=getFrame(target,frameId);
  if(!clipboard)return {document:target,selection:[],addedViews:0,addedLayers:0};
  const source=validateDocument(clipboard.source),origin=getFrame(source,clipboard.frameId);
  const crossProject=source.id!==target.id,originIds=new Set(clipboard.nodeIds);
  if(!originIds.size||[...originIds].some(id=>!origin.nodes.some(node=>node.id===id)))throw Error('The copied layers are unavailable.');
  const originalIds=new Set(originIds),imports=new Map(),restores=new Map(),scanned=new Set(),restoringIds=new Set();
  const existingViews=new Set(target.frames.map(view=>view.id));
  const existingInputs=new Set(target.frames.flatMap(view=>view.nodes.map(node=>node.id)));
  const owners=new Map(source.frames.flatMap(view=>view.nodes.map(node=>[node.id,{view,node}])));
  const queue=origin.nodes.filter(node=>originIds.has(node.id));
  const frameMap=new Map();
  if(crossProject||!existingViews.has(origin.id))frameMap.set(origin.id,frameId);
  function includeView(id) {
    if(frameMap.has(id)||(!crossProject&&existingViews.has(id))||imports.has(id))return;
    const view=source.frames.find(item=>item.id===id);
    if(!view)throw Error('A copied navigation view is missing.');
    imports.set(id,view);queue.push(...view.nodes);
  }
  function includeInput(id,marker=null) {
    if(originIds.has(id)||restoringIds.has(id)||(!crossProject&&existingInputs.has(id)))return;
    const owner=owners.get(id);
    if(!owner||marker==='$input'&&!['input','select'].includes(owner.node.type)||marker==='$control'&&!['input','checkbox','select','list','text'].includes(owner.node.type))throw Error('Cannot paste: a bound input is missing or a local value is unavailable in the copied project.');
    if(owner.view.id!==origin.id){
      if(!crossProject&&existingViews.has(owner.view.id)){
        const current=getFrame(target,owner.view.id),currentNodes=new Map(current.nodes.map(node=>[node.id,node]));
        let root=owner.node;
        while(root.parentId){
          const parent=currentNodes.get(root.parentId);
          if(parent?.type==='rectangle'&&parent.action.kind==='none'){
            let ancestor=parent;
            while(ancestor){if(ancestor.locked)throw Error('Unlock the dependency destination container or its parent before pasting.');ancestor=currentNodes.get(ancestor.parentId);}
            break;
          }
          root=owners.get(root.parentId).node;
        }
        if(!restores.has(owner.view.id))restores.set(owner.view.id,new Map());
        const pending=restores.get(owner.view.id);
        for(const child of collectDescendantIds(owner.view,[root.id]))if((child===id||child===root.id||!currentNodes.has(child))&&!pending.has(child)){const node=owners.get(child).node;pending.set(child,node);restoringIds.add(child);queue.push(node);}
      }else includeView(owner.view.id);
      return;
    }
    let root=owner.node;
    while(root.parentId)root=owners.get(root.parentId).node;
    for(const child of collectDescendantIds(origin,[root.id]))if(!originIds.has(child)){originIds.add(child);queue.push(owners.get(child).node);}
  }
  for(let index=0;index<queue.length;index++){
    const node=queue[index];if(scanned.has(node.id))continue;scanned.add(node.id);
    for(const id of viewDependencies(node))includeView(id);
    for(const id of nodeDependencies(node))includeInput(id);
    if(['tool','local','submit'].includes(node.action.kind)){const refs=[];resolveInputBindings(node.action.args,(id,marker)=>{refs.push({id,marker});return '';});for(const {id,marker} of refs)includeInput(id,marker);}
  }
  const baseNodes=origin.nodes.filter(node=>originIds.has(node.id));
  const allNodes=[...baseNodes,...[...imports.values()].flatMap(view=>view.nodes),...[...restores.values()].flatMap(nodes=>[...nodes.values()])];
  const idMap=new Map(allNodes.map(node=>[node.id,defaultNode(node.type).id]));
  for(const view of imports.values())frameMap.set(view.id,getFrame(createDocument('Pasted view','blank')).id);
  const roots=baseNodes.filter(node=>!originIds.has(node.parentId));
  const box=node=>clipboard.boxes.get(node.id)||node;
  const minX=Math.min(...roots.map(node=>box(node).x)),minY=Math.min(...roots.map(node=>box(node).y));
  const names=new Set(frame.nodes.map(node=>node.name));
  function remap(node,base=false,restoredView=null) {
    const copy=remapNodeReferences(clone(node),idMap,frameMap),geometry=box(node);
    copy.id=idMap.get(node.id);copy.locked=false;
    copy.parentId=idMap.get(node.parentId)||(restoredView?.nodes.some(parent=>parent.id===node.parentId)?node.parentId:null);
    if(crossProject&&copy.styleRole!=='none'){for(const key of appearanceKeys)copy[key]=geometry[key];copy.styleRole='none';}
    if(base){
      copy.name=uniqueName(copy.name,names);
      if(!originIds.has(node.parentId)){
        copy.x=crossProject?geometry.x-minX+16:geometry.x-origin.layout.padding+16;
        copy.y=crossProject?geometry.y-minY+16:geometry.y-origin.layout.padding+16;
        copy.x=Math.min(LIMITS.position,copy.x);copy.y=Math.min(LIMITS.position,copy.y);
        if(crossProject){copy.width=geometry.width;copy.height=geometry.height;}
      }
    }
    return copy;
  }
  const additions=baseNodes.map(node=>remap(node,true));
  frame.nodes.push(...additions);
  if(crossProject){
    const right=Math.max(frame.width,...additions.filter(node=>!node.parentId&&node.widthMode!=='fill').map(node=>node.x+node.width+frame.layout.padding+16));
    if(right>LIMITS.dimension)throw Error('Cannot paste: the fixed layers exceed the maximum view width.');
    frame.width=right;
  }
  const viewNames=new Set(target.frames.map(view=>view.name));
  for(const view of imports.values())target.frames.push({...clone(view),id:frameMap.get(view.id),name:uniqueName(view.name,viewNames),nodes:view.nodes.map(node=>remap(node))});
  for(const [id,pending] of restores){
    const view=getFrame(target,id),original=getFrame(source,id);
    for(const node of pending.values()){
      const copy=remap(node,false,view),index=original.nodes.findIndex(item=>item.id===node.id);
      const following=original.nodes.slice(index+1).map(item=>idMap.get(item.id)||item.id).find(id=>view.nodes.some(item=>item.id===id&&item.parentId===copy.parentId));
      const insertion=following?view.nodes.findIndex(item=>item.id===following):view.nodes.length;
      view.nodes.splice(insertion,0,copy);
    }
  }
  const normalized=validateDocument(target);
  const selection=baseNodes.filter(node=>originalIds.has(node.id)&&!originalIds.has(node.parentId)).map(node=>idMap.get(node.id));
  return {document:normalized,selection,addedViews:imports.size,addedLayers:additions.length,restoredLayers:restoringIds.size,crossProject};
}
