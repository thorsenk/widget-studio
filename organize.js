import {cloneDocument,validateDocument,getFrame,defaultNode,collectDescendantIds} from './document.js';
import {resolveFrame} from './layout.js';
import {remapNodeReferences} from './references.js';
import {initialBoundText} from './authoring-values.js';

function editableRoots(frame,ids){
  const chosen=new Set(ids),byId=new Map(frame.nodes.map(node=>[node.id,node]));
  const roots=frame.nodes.filter(node=>chosen.has(node.id)&&!chosen.has(node.parentId));
  if(roots.length!==chosen.size)throw Error('Choose sibling layers without also selecting their children.');
  for(const node of roots){let ancestor=node;while(ancestor){if(ancestor.locked)throw Error('Unlock selected layers and their parents first.');ancestor=byId.get(ancestor.parentId);}}
  return roots;
}

function keepGeometry(before,document,frameId,measureText,message){
  const frame=getFrame(document,frameId),after=new Map(resolveFrame(frame,frame.width,{theme:document.theme,readText:(_id,node)=>initialBoundText(document,node),measureText}).nodes.map(node=>[node.id,node]));
  for(const [id,box] of before){const current=after.get(id);if(current&&['x','y','width','height'].some(key=>Math.abs(current[key]-box[key])>.02))throw Error(message);}
}

/** Wrap sibling roots; children and action IDs remain the same. */
export function wrapLayers(document,frameId,ids,{measureText}={}){
  const copy=cloneDocument(document),frame=getFrame(copy,frameId),roots=editableRoots(frame,ids);
  if(roots.length<2)throw Error('Select at least two sibling layers to wrap.');
  if(roots.some(node=>node.parentId!==roots[0].parentId))throw Error('Wrap layers from the same parent container.');
  const parent=frame.nodes.find(node=>node.id===roots[0].parentId),rule=parent?.layout||frame.layout;
  const siblings=frame.nodes.filter(node=>node.parentId===roots[0].parentId),indices=roots.map(node=>siblings.indexOf(node));
  if(Math.max(...indices)-Math.min(...indices)+1!==roots.length)throw Error('Choose adjacent siblings in the layer list to wrap without changing overlap order.');
  const boxes=new Map(resolveFrame(frame,frame.width,{theme:copy.theme,readText:(_id,node)=>initialBoundText(copy,node),measureText}).nodes.map(node=>[node.id,node]));
  if(roots.some(node=>!boxes.has(node.id)))throw Error('Show selected layers before wrapping.');
  const left=Math.min(...roots.map(node=>boxes.get(node.id).x)),top=Math.min(...roots.map(node=>boxes.get(node.id).y));
  const right=Math.max(...roots.map(node=>boxes.get(node.id).x+boxes.get(node.id).width)),bottom=Math.max(...roots.map(node=>boxes.get(node.id).y+boxes.get(node.id).height));
  const origin=parent?boxes.get(parent.id):{x:0,y:0,strokeWidth:0};
  const group={...defaultNode('rectangle'),name:'Group',parentId:roots[0].parentId,x:left-origin.x-origin.strokeWidth-rule.padding,y:top-origin.y-origin.strokeWidth-rule.padding,width:right-left,height:bottom-top,heightMode:'hug',fill:'transparent',radius:0};
  frame.nodes.splice(frame.nodes.indexOf(roots[0]),0,group);
  for(const node of roots){const box=boxes.get(node.id);Object.assign(node,{parentId:group.id,x:box.x-left,y:box.y-top,width:box.width,widthMode:'fixed'});delete node.flowSizing;}
  keepGeometry(boxes,copy,frameId,measureText,'Wrap would reflow content. Choose siblings in one flow row or switch the parent to Free position first.');
  return {document:validateDocument(copy),selection:[group.id]};
}

/** Unwrap keeps resolved child boxes, including their bindings and paint order. */
export function unwrapLayers(document,frameId,ids,{measureText}={}){
  const copy=cloneDocument(document),frame=getFrame(copy,frameId),groups=editableRoots(frame,ids);
  if(!groups.length||groups.some(node=>node.type!=='rectangle'))throw Error('Choose containers to unwrap.');
  const boxes=new Map(resolveFrame(frame,frame.width,{theme:copy.theme,readText:(_id,node)=>initialBoundText(copy,node),measureText}).nodes.map(node=>[node.id,node]));
  const selection=[];
  for(const group of groups){
    const children=frame.nodes.filter(node=>node.parentId===group.id);
    if(!boxes.has(group.id)||children.some(node=>!boxes.has(node.id)||node.locked))throw Error('Show and unlock the container and its children before unwrapping.');
    const parent=frame.nodes.find(node=>node.id===group.parentId),origin=parent?boxes.get(parent.id):{x:0,y:0,strokeWidth:0},rule=parent?.layout||frame.layout;
    for(const node of children){const box=boxes.get(node.id);Object.assign(node,{parentId:group.parentId,x:box.x-origin.x-origin.strokeWidth-rule.padding,y:box.y-origin.y-origin.strokeWidth-rule.padding,width:box.width,widthMode:'fixed'});delete node.flowSizing;selection.push(node.id);}
    const descendants=new Set(collectDescendantIds(frame,children.map(node=>node.id)));
    const index=frame.nodes.slice(0,frame.nodes.indexOf(group)).filter(node=>!descendants.has(node.id)).length;
    const ordered=frame.nodes.filter(node=>descendants.has(node.id));frame.nodes=frame.nodes.filter(node=>node!==group&&!descendants.has(node.id));frame.nodes.splice(Math.min(index,frame.nodes.length),0,...ordered);
  }
  keepGeometry(boxes,copy,frameId,measureText,'Unwrap would reflow content. Switch the parent to Free position first to keep these boxes.');
  return {document:validateDocument(copy),selection};
}

export function distributeLayers(document,frameId,ids,axis,{measureText}={}){
  if(!['x','y'].includes(axis))throw Error('Choose horizontal or vertical distribution.');
  const copy=cloneDocument(document),frame=getFrame(copy,frameId),roots=editableRoots(frame,ids),size=axis==='x'?'width':'height';
  if(roots.length<3)throw Error('Select at least three layers to distribute.');
  if(roots.some(node=>node.parentId!==roots[0].parentId))throw Error('Distribute sibling layers in the same container.');
  const parent=frame.nodes.find(node=>node.id===roots[0].parentId);
  if((parent?.layout||frame.layout).direction!=='free')throw Error('Stack spacing follows Gap. Choose free position to distribute layers.');
  const boxes=new Map(resolveFrame(frame,frame.width,{theme:copy.theme,readText:(_id,node)=>initialBoundText(copy,node),measureText}).nodes.map(node=>[node.id,node]));
  if(roots.some(node=>!boxes.has(node.id)))throw Error('Show selected layers before distributing.');
  roots.sort((a,b)=>boxes.get(a.id)[axis]-boxes.get(b.id)[axis]);
  const first=boxes.get(roots[0].id)[axis],last=boxes.get(roots.at(-1).id),extent=last[axis]+last[size]-first;
  const gap=(extent-roots.reduce((sum,node)=>sum+boxes.get(node.id)[size],0))/(roots.length-1);
  let position=first;
  for(const node of roots){const box=boxes.get(node.id);node[axis]+=position-box[axis];position+=box[size]+gap;}
  return validateDocument(copy);
}

export function duplicateView(document,frameId){
  const copy=cloneDocument(document),source=getFrame(copy,frameId),viewId=defaultNode('rectangle').id;
  const ids=new Map(source.nodes.map(node=>[node.id,defaultNode(node.type).id]));
  const view={...source,id:viewId,name:source.name.slice(0,154)+' copy',nodes:source.nodes.map(node=>({...remapNodeReferences(node,ids,new Map([[frameId,viewId]])),id:ids.get(node.id),parentId:ids.get(node.parentId)||node.parentId}))};
  copy.frames.splice(copy.frames.indexOf(source)+1,0,view);copy.activeFrameId=viewId;
  return validateDocument(copy);
}

export function reorderView(document,frameId,index){
  const copy=cloneDocument(document),view=getFrame(copy,frameId);
  if(!Number.isInteger(index)||index<0||index>=copy.frames.length)throw Error('View order is outside the list.');
  copy.frames.splice(copy.frames.indexOf(view),1);copy.frames.splice(index,0,view);return validateDocument(copy);
}
