import {remapInputBindings} from './bindings.js';

/** Remap only declared references; literal strings remain authored content. */
export function remapNodeReferences(node,idMap,frameMap=new Map()){
  const action={...node.action,args:remapInputBindings(node.action.args,idMap)};
  for(const key of ['targetNodeId','resultTargetId'])if(action[key])action[key]=idMap.get(action[key])||action[key];
  for(const key of ['targetFrameId','formFrameId','successFrameId','errorFrameId'])if(action[key])action[key]=frameMap.get(action[key])||action[key];
  return {...node,...(node.textBindingId?{textBindingId:idMap.get(node.textBindingId)||node.textBindingId}:{}),action};
}

export function nodeDependencies(node){
  return [node.textBindingId,node.action.targetNodeId,node.action.resultTargetId].filter(Boolean);
}

export function viewDependencies(node){
  return [node.action.targetFrameId,node.action.formFrameId,node.action.successFrameId,node.action.errorFrameId].filter(Boolean);
}
