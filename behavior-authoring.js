import {resolveInputBindings} from './bindings.js';
import {nodeDependencies,viewDependencies} from './references.js';

export function visibleValues(document,types=['input','checkbox','select','list']){
  return document.frames.flatMap(view=>view.nodes.filter(node=>types.includes(node.type)).filter(node=>{
    let current=node;while(current){if(!current.visible)return false;current=view.nodes.find(parent=>parent.id===current.parentId);}return true;
  }).map(node=>({node,view})));
}
export function localTargets(document,operation){
  const types=operation==='toggle'?['checkbox']:operation==='list-add'?['list']:operation==='increment'?['input','text']:operation==='reset'?['input','checkbox','select','list','text']:['input','checkbox','select','text'];
  return visibleValues(document,types);
}
export function actionProblems(document,node){
  const problems=[],frames=new Set(document.frames.map(view=>view.id)),values=new Map(visibleValues(document,['input','checkbox','select','list','text','button','rectangle','image','divider']).map(item=>[item.node.id,item.node]));
  for(const id of viewDependencies(node))if(!frames.has(id))problems.push('A target view is unavailable. Choose another view.');
  for(const id of nodeDependencies(node))if(!values.has(id))problems.push('A referenced value or outcome layer is unavailable. Choose a replacement.');
  if(node.action.resultTargetId&&values.get(node.action.resultTargetId)?.type!=='text')problems.push('Choose a text layer to show the outcome.');
  if(node.action.kind==='local'&&node.action.localOp!=='reset'&&!node.action.targetNodeId)problems.push('Choose a local value for this operation.');
  if(node.action.kind==='local'&&node.action.targetNodeId&&!localTargets(document,node.action.localOp).some(item=>item.node.id===node.action.targetNodeId))problems.push('Choose a local value that supports this operation.');
  if(['tool','local'].includes(node.action.kind))try{resolveInputBindings(node.action.args,(id,marker)=>{
    const value=values.get(id);if(!value||!(marker==='$input'?['input','select']:['input','checkbox','select','list','text']).includes(value.type))throw Error('A bound widget value is unavailable. Remove its argument or bind another value.');return '';
  });}catch(error){problems.push(error.message.includes('could not be read')?'A bound widget value is unavailable. Remove its argument or bind another value.':error.message);}
  return [...new Set(problems)];
}
