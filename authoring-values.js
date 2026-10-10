/** Initial-value rendering for the editable canvas; runtime reads live controls. */
export function initialBoundText(document,node){
  if(!node.textBindingId)return undefined;
  let target;
  for(const frame of document.frames){target=frame.nodes.find(item=>item.id===node.textBindingId);if(target)break;}
  if(!target)return undefined;
  const value=target.type==='checkbox'?(target.checked?'On':'Off'):target.type==='list'?String(target.items.length):['input','select'].includes(target.type)?target.initialValue||'':target.type==='text'?target.text:undefined;
  return value===undefined?undefined:node.text+value;
}
