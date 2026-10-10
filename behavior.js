/** Emitted verbatim with the widget. All state stays in this runtime session. */
export function createLocalBehavior(model,{relayout,onMessage}={}){
  const nodes=new Map(model.frames.flatMap(frame=>frame.nodes.map(node=>[node.id,{node,frameId:frame.id}])));
  const errors=new Map(),texts=new Map(),lists=new Map();let sequence=0;
  const element=id=>document.querySelector('[data-node-id="'+id+'"]');
  const field=id=>{const el=element(id);return el?.matches?.('input,textarea,select')?el:el?.querySelector('input[type=checkbox]');};
  const initialItems=node=>(node.items||[]).map(text=>({id:'task-'+(++sequence),text,done:false}));
  const enabled=id=>element(id)?.dataset.controlDisabled!=='true';
  function read(id){
    const source=nodes.get(id)?.node;if(!source)return undefined;
    if(source.type==='list')return (lists.get(id)||[]).map(item=>({...item}));
    if(source.type==='checkbox')return field(id)?.checked;
    if(['input','select'].includes(source.type))return field(id)?.value;
    if(source.type==='text')return texts.get(id)??source.text;
    return undefined;
  }
  function label(node){return node.name||node.text||'This field';}
  function validate(node){
    if(node.disabled||!enabled(node.id))return '';
    const rules=node.validation||{},value=read(node.id);
    if(value===undefined)return '';
    if(node.inputType==='number'&&field(node.id)?.validity?.badInput)return label(node)+': enter a number.';
    const empty=node.type==='checkbox'?!value:Array.isArray(value)?!value.length:!String(value).trim();
    if(rules.required&&empty)return label(node)+(node.type==='checkbox'?': select this option.':': enter a value.');
    if(empty)return '';
    if(typeof value==='string'){
      if(value.length<(rules.minLength||0))return label(node)+': use at least '+rules.minLength+' characters.';
      if(value.length>(rules.maxLength||20000))return label(node)+': use at most '+rules.maxLength+' characters.';
      if(node.inputType==='email'&&!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value))return label(node)+': enter a valid email address.';
      if(node.inputType==='number'){
        const number=Number(value);if(!Number.isFinite(number))return label(node)+': enter a number.';
        if(rules.min!==undefined&&number<rules.min)return label(node)+': minimum is '+rules.min+'.';
        if(rules.max!==undefined&&number>rules.max)return label(node)+': maximum is '+rules.max+'.';
      }
    }
    return '';
  }
  function changed(id){
    const node=nodes.get(id)?.node;
    if(errors.has(id)){const error=validate(node);if(error)errors.set(id,error);else errors.delete(id);}
    relayout?.();
  }
  function diagnostic(id,message,kind='control',values=null,error=false){onMessage?.(message,{nodeId:id,kind,values,error});}
  function addTask(id,text,clearDraft=false){
    text=String(text??'').trim();if(!text)throw Error('Enter a task title first.');if(text.length>1000)throw Error('Task titles can use up to 1,000 characters.');
    const items=lists.get(id);if(!items)throw Error('Choose an available task list.');if(items.length>=100)throw Error('This list holds up to 100 tasks. Remove a task before adding another.');
    items.push({id:'task-'+(++sequence),text,done:false});renderList(id,clearDraft);changed(id);
  }
  function renderList(id,clearDraft=false){
    const el=element(id),node=nodes.get(id)?.node;if(!el||!node)return;
    const draft=clearDraft?'':el.querySelector('.task-composer input')?.value||'';
    el.replaceChildren();
    const header=document.createElement('div');header.className='task-header';
    const title=document.createElement('strong');title.className='task-title';title.textContent=node.text;
    const count=document.createElement('span');count.className='task-count';
    const updateCount=()=>{const items=lists.get(id);count.textContent=items.length+' tasks · '+items.filter(item=>item.done).length+' complete';};updateCount();
    header.append(title,count);el.append(header);
    const rows=document.createElement('div');rows.className='task-items';
    const items=lists.get(id);
    if(!items.length){const empty=document.createElement('p');empty.className='task-empty';empty.textContent='No tasks yet. Add your first task below.';rows.append(empty);}
    items.forEach((item,index)=>{
      const row=document.createElement('div');row.className='task-row'+(item.done?' is-done':'');
      const check=document.createElement('input');check.type='checkbox';check.checked=item.done;check.setAttribute('aria-label','Complete '+item.text);
      check.addEventListener('change',()=>{if(!enabled(id))return;item.done=check.checked;row.classList.toggle('is-done',item.done);updateCount();changed(id);diagnostic(id,item.done?'Task completed.':'Task reopened.','list',{title:item.text,done:item.done});});
      const text=document.createElement('input');text.type='text';text.value=item.text;text.maxLength=1000;text.setAttribute('aria-label','Task title');
      text.addEventListener('input',()=>{if(!enabled(id))return;const value=text.value.trim();if(value){item.text=value;check.setAttribute('aria-label','Complete '+value);remove.setAttribute('aria-label','Remove '+value);}});
      text.addEventListener('change',()=>{if(!enabled(id))return;if(!text.value.trim()){text.value=item.text;diagnostic(id,'Task title kept. Enter a title before leaving the field.','list');}else diagnostic(id,'Task title updated.','list',{title:item.text});});
      const remove=document.createElement('button');remove.type='button';remove.textContent='Remove';remove.setAttribute('aria-label','Remove '+item.text);
      remove.addEventListener('click',()=>{if(!enabled(id))return;items.splice(index,1);renderList(id);changed(id);const next=element(id).querySelectorAll('.task-row input[type=text]');(next[Math.min(index,next.length-1)]||element(id).querySelector('.task-composer input'))?.focus();diagnostic(id,'Task removed.','list',{title:item.text});});
      row.append(check,text,remove);rows.append(row);
    });el.append(rows);
    const composer=document.createElement('form');composer.className='task-composer';
    const input=document.createElement('input');input.type='text';input.placeholder='Add a task…';input.setAttribute('aria-label','New task');input.required=true;input.maxLength=1000;input.value=draft;
    const button=document.createElement('button');button.type='submit';button.textContent='Add task';
    composer.append(input,button);composer.addEventListener('submit',event=>{event.preventDefault();if(!enabled(id))return;try{const text=input.value;addTask(id,text,true);element(id).querySelector('.task-composer input')?.focus();diagnostic(id,'Task added.','list',{title:text.trim()});}catch(error){diagnostic(id,error.message,'list',null,true);}});el.append(composer);
  }
  function writeText(id,value){const node=nodes.get(id)?.node;if(node?.type==='text'){texts.set(id,String(value).slice(0,20000));return true;}return false;}
  function write(id,value){
    const node=nodes.get(id)?.node,target=field(id);if(!node)throw Error('Choose an available local value.');
    if(node.type==='text'){writeText(id,typeof value==='string'?value:JSON.stringify(value));relayout?.();return;}
    if(!target)throw Error('Choose an input, selection, checkbox or text layer.');
    if(node.type==='checkbox'){
      if(![true,false,'true','false'].includes(value))throw Error('Checkbox values are true or false.');target.checked=value===true||value==='true';
    }else{
      const text=String(value??'');if(text.length>20000)throw Error('Local values can use up to 20,000 characters.');
      if(node.type==='select'&&text&&!node.options.includes(text))throw Error('Choose one of the authored selection options.');
      if(node.inputType==='number'&&text&&!Number.isFinite(Number(text)))throw Error('Enter a number for this field.');target.value=text;
    }
    changed(id);
  }
  function reset(frameId,targetId=null){
    for(const [id,{node,frameId:owner}] of nodes){if(targetId?id!==targetId:owner!==frameId)continue;
      if(node.type==='list'){lists.set(id,initialItems(node));renderList(id,true);}
      else if(node.type==='checkbox'){if(field(id))field(id).checked=Boolean(node.checked);}
      else if(['input','select'].includes(node.type)){if(field(id))field(id).value=node.initialValue||'';}
      texts.delete(id);errors.delete(id);
    }relayout?.();
  }
  function validateForm(owner,frameId=owner){
    const failed=[];if(!model.frames.some(frame=>frame.id===owner))return {ok:false,frameId,first:null,message:'This form view is unavailable. Choose a new Form view in Widget actions.'};
    for(const [id,{node,frameId:source}] of nodes)if(source===owner&&['input','checkbox','select','list'].includes(node.type)){
      const error=validate(node);if(error){errors.set(id,error);failed.push(id);}else errors.delete(id);
    }
    relayout?.();if(failed.length)return {ok:false,frameId:owner,first:failed[0],message:errors.get(failed[0])};
    return {ok:true,frameId:owner};
  }
  function submit(action,frameId){
    const owner=action.formFrameId||frameId,checked=validateForm(owner,frameId);if(!checked.ok)return checked;
    const message=action.message||'Form complete. Values are kept in this widget session.';
    if(action.resultTargetId)writeText(action.resultTargetId,message);
    relayout?.();return {ok:true,message,values:{fields:[...nodes.values()].filter(item=>item.frameId===owner&&['input','checkbox','select','list'].includes(item.node.type)).map(({node})=>({label:label(node),value:read(node.id)}))}};
  }
  function perform(action,frameId,args){
    const id=action.targetNodeId;
    if(action.localOp==='reset'){reset(action.formFrameId||frameId,id);return 'Local values reset.';}
    if(action.localOp==='list-add'){
      try{addTask(id,args.value);}catch(error){const ref=action.args.value?.$input||action.args.value?.$control;if(ref){errors.set(ref,error.message);relayout?.();}throw error;}
      if(action.clearInput){const ref=action.args.value?.$input||action.args.value?.$control;if(ref)write(ref,'');}return 'Task added.';
    }
    if(action.localOp==='toggle'){
      if(nodes.get(id)?.node.type!=='checkbox')throw Error('Toggle needs a checkbox or switch.');write(id,!read(id));return 'Checkbox value changed.';
    }
    if(action.localOp==='increment'){
      const number=Number(read(id)||0)+(args.value===undefined?1:Number(args.value));if(!Number.isFinite(number)||Math.abs(number)>1e12)throw Error('Choose a finite increment within the supported number range.');write(id,String(number));return 'Number increased.';
    }
    write(id,args.value??'');return 'Local value updated.';
  }
  for(const [id,{node}] of nodes){
    if(node.type==='list'){lists.set(id,initialItems(node));renderList(id,true);}
    const input=['input','checkbox','select'].includes(node.type)?field(id):null;if(input){
      if(node.type==='checkbox')input.checked=Boolean(node.checked);else input.value=node.initialValue||'';
      input.addEventListener('input',()=>{if(enabled(id))changed(id);});
      if(['checkbox','select'].includes(node.type))input.addEventListener('change',()=>{if(enabled(id)){changed(id);diagnostic(id,'Local value changed.','control',{value:read(id)});}});
    }
  }
  function snapshot(){
    return {values:Object.fromEntries([...nodes].filter(([,{node}])=>['input','checkbox','select'].includes(node.type)).map(([id])=>[id,read(id)])),lists:Object.fromEntries([...lists].map(([id,items])=>[id,items.map(({text,done})=>({text,done}))])),drafts:Object.fromEntries([...lists.keys()].map(id=>[id,element(id)?.querySelector('.task-composer input')?.value||''])),texts:Object.fromEntries(texts),errors:Object.fromEntries(errors)};
  }
  function restore(snapshot){
    for(const [id,value] of Object.entries(snapshot.values||{})){const node=nodes.get(id)?.node,target=field(id);if(!target)continue;if(node?.type==='checkbox')target.checked=Boolean(value);else if(['input','select'].includes(node?.type))target.value=value;}
    for(const [id,items] of Object.entries(snapshot.lists||{}))if(nodes.get(id)?.node.type==='list'){lists.set(id,items.map(({text,done})=>({id:'task-'+(++sequence),text,done})));renderList(id,true);}
    for(const [id,value] of Object.entries(snapshot.drafts||{})){const input=element(id)?.querySelector('.task-composer input');if(input)input.value=value;}
    for(const [id,value] of Object.entries(snapshot.texts||{}))if(nodes.get(id)?.node.type==='text')texts.set(id,value);
    // Recompute attempted validation against current labels/rules, not cached prose.
    for(const id of Object.keys(snapshot.errors||{})){const node=nodes.get(id)?.node;if(node&&['input','checkbox','select','list'].includes(node.type)){const error=validate(node);if(error)errors.set(id,error);}}
    relayout?.();
  }
  return {snapshot,restore,read,writeText,clearText:id=>texts.delete(id),perform,submit,validateForm,focus:id=>field(id)?.focus(),errors:()=>Object.fromEntries(errors),list:id=>lists.get(id)||[],displayText(id,styled){
    if(texts.has(id))return texts.get(id);
    const source=nodes.get(id)?.node;if(!source?.textBindingId)return undefined;const value=read(source.textBindingId);if(value===undefined)return undefined;
    return styled.text+(Array.isArray(value)?String(value.length):typeof value==='boolean'?(value?'On':'Off'):String(value));
  }};
}

/** Same harmless synthetic response in Studio simulation and the exported server. */
export function makeDemoResult(name,args,forceError=false){
  const failed=forceError||args.__demoError===true||Object.values(args).includes('demo:error');
  return {...(failed?{isError:true}:{}),content:[{type:'text',text:failed?'Demo failure requested. Edit your input and try again.':'Demo '+name+' received '+JSON.stringify(args)+'.'}],structuredContent:{tool:name,arguments:args,demo:true}};
}
