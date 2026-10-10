/** Honest mixed values, refreshed without replacing the focused inspector. */
export function showMixedProperties(root,nodes,displayNodes,frame,{preserveInput=null,state='default'}={}){
  if(nodes.length<2)return;
  for(const input of root.querySelectorAll('[data-prop],[data-state-prop],[data-layout],[data-action-field],[data-action-kind],[data-validation]')){
    if(input.getAttribute('aria-invalid')==='true')continue;
    const key=input.dataset.prop||input.dataset.stateProp||input.dataset.layout||input.dataset.actionField;
    const values=nodes.map(node=>{
      const display=displayNodes.get(node.id)||node;
      if(input.hasAttribute('data-action-kind'))return node.action.kind;
      if(input.dataset.validation)return node.validation?.[input.dataset.validation]??(input.dataset.validation==='required'?false:input.dataset.validation==='maxLength'?20000:input.dataset.validation==='minLength'?0:'');
      if(input.dataset.layout)return node.layout[key];
      if(input.dataset.actionField)return key==='args'?JSON.stringify(node.action.args,null,2):node.action[key]??(key==='mode'?'demo':key==='formFrameId'&&node.action.kind==='submit'?frame.id:'');
      if(key==='x'||key==='y'){
        const rule=frame.nodes.find(parent=>parent.id===node.parentId)?.layout||frame.layout;
        return rule.direction==='free'?node[key]:display[key==='x'?'relativeX':'relativeY']-rule.padding;
      }
      if(key==='items'||key==='options')return (node[key]||[]).join('\n');
      if(key==='imageFit')return node.imageFit||'cover';if(key==='imagePosition')return node.imagePosition||'center';
      if(key==='text'&&node.textBindingId)return node.states[state]?.text??node.text;
      const value=['width','height','fill','color','fontSize','fontWeight','fontFamily','opacity','strokeWidth','stroke','text'].includes(key)?display[key]:node[key];
      return key==='opacity'?Number((value*100).toFixed(2)):value??'';
    });
    const mixed=!values.every(value=>value===values[0]);
    if(input===preserveInput)continue;
    if(!mixed){
      delete input.dataset.mixed;input.removeAttribute('aria-checked');
      if(input.dataset.baseLabel)input.setAttribute('aria-label',input.dataset.baseLabel);
      if(input.type==='checkbox'){input.indeterminate=false;input.checked=Boolean(values[0]);}
      else{
        if(input.tagName==='SELECT')input.querySelector('option[value="__mixed__"]')?.remove();
        input.removeAttribute('placeholder');
        // Native color wells cannot show non-hex values; their paired field can.
        input.value=input.type==='color'?(/^#[\da-f]{6}$/i.test(values[0])?values[0]:'#ffffff'):String(values[0]);
      }
      input.dataset.acceptedValue=input.type==='checkbox'?String(input.checked):input.value;
      continue;
    }
    input.dataset.mixed='true';
    if(input.type==='checkbox'){input.indeterminate=true;input.setAttribute('aria-checked','mixed');}
    else if(input.tagName==='SELECT'){
      if(!input.querySelector('option[value="__mixed__"]')){const option=root.ownerDocument.createElement('option');option.value='__mixed__';option.textContent='Mixed';option.disabled=true;input.prepend(option);}
      input.value='__mixed__';
    }else if(input.type==='color'){
      input.dataset.baseLabel??=input.getAttribute('aria-label')||'Color';input.value='#808080';input.setAttribute('aria-label',input.dataset.baseLabel+' · Mixed');
    }else{input.value='';input.placeholder='Mixed';}
  }
}
