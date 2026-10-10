/** One layout engine for the editor, preview and exported widget. No scaling. */
export function resolveFrame(frame, requestedWidth = frame.width, options = {}) {
  const theme = options.theme || {};
  const state = options.state || 'default';
  const width = Math.max(32, Number(requestedWidth) || frame.width);
  const children = new Map();
  for (const node of frame.nodes) {
    const parent = node.parentId || null;
    if (!children.has(parent)) children.set(parent, []);
    children.get(parent).push(node);
  }
  function styled(source) {
    const node = {...source};
    const role = node.styleRole;
    if (role && role !== 'none') {
      node.fontFamily = theme.fontFamily || node.fontFamily;
      if (role === 'heading') Object.assign(node, {color:theme.text || node.color,fontSize:theme.headingSize || node.fontSize,fontWeight:600});
      if (role === 'body') Object.assign(node, {color:theme.text || node.color,fontSize:theme.bodySize || node.fontSize});
      if (role === 'muted') Object.assign(node, {color:theme.muted || node.color,fontSize:theme.bodySize || node.fontSize});
      if (role === 'accent') Object.assign(node, {fill:theme.accent || node.fill,color:theme.onAccent || node.color,fontSize:theme.bodySize || node.fontSize});
      if (role === 'surface') node.fill = theme.surface || node.fill;
      if (role === 'field') Object.assign(node, {fill:theme.control || theme.surface || node.fill,color:theme.text || node.color,fontSize:theme.bodySize || node.fontSize,strokeWidth:0});
    }
    const active = node.disabled ? 'disabled' : state;
    Object.assign(node, node.states?.[active] || {});
    if(!node.disabled && !['disabled','loading'].includes(state) && options.hoveredIds?.includes(node.id))Object.assign(node,node.states?.hover||{});
    const liveText=options.readText?.(node.id,node);if(typeof liveText==='string')node.text=liveText;
    return node;
  }
  function contentWidth(source,availableWidth){
    const node=styled(source);
    if(node.widthMode!=='hug')return node.width;
    const value=['input','select'].includes(node.type)?options.readInput?.(node.id):undefined;
    const text=typeof value==='string'&&value.length?value:String(node.type==='select'?(node.initialValue||node.text||node.options?.[0]||''):node.text||'');
    const measured=options.measureText?.width?.(text,node);
    const natural=measured>0?measured:Math.max(1,...text.split('\n').map(line=>line.length))*node.fontSize*.55;
    const padding=node.type==='text'?0:node.type==='checkbox'?(node.controlVariant==='switch'?42:28):node.type==='select'?44:24;
    return Math.max(1,Math.min(availableWidth,natural+padding+(node.strokeWidth||0)*2));
  }
  function measure(source, availableWidth) {
    const node = styled(source);
    node.width = Math.max(1, node.widthMode === 'fill' ? availableWidth : contentWidth(source,availableWidth));
    const border=node.strokeWidth || 0;
    const content = arrange(node.id,Math.max(1,node.width-border*2),node.layout || {});
    if (node.heightMode === 'hug') {
      if(node.type==='list'){
        const items=options.readList?.(node.id)||node.items||[],count=items.length,done=items.filter(item=>item?.done).length;
        const caption=count+' tasks · '+done+' complete',countWidth=options.measureText?.width?.(caption,{...node,fontSize:11,fontWeight:400})||caption.length*6;
        const labelWidth=Math.max(1,node.width-border*2-24-countWidth-8),measured=options.measureText?.(node.text,labelWidth,{...node,fontWeight:600});
        const header=node.text?(measured>0?measured:Math.ceil(node.text.length/Math.max(1,labelWidth/(node.fontSize*.55)))*node.fontSize*1.4):0;
        node.height=border*2+24+Math.max(24,header)+8+(count?count*44+Math.max(0,count-1)*8:24)+52;
      }
      else if (node.type === 'rectangle') node.height = Math.max(1,content.height+border*2);
      else if (['text','button','input','checkbox','select'].includes(node.type)) {
        const control=node.type!=='text',padding=control?12:0;
        const horizontal=node.type==='checkbox'?(node.controlVariant==='switch'?42:28):node.type==='select'?44:padding*2;
        const inside=Math.max(1,node.width-border*2-horizontal);
        const value=['input','select'].includes(node.type)?options.readInput?.(node.id):undefined;
        const text=typeof value==='string'&&value.length?value:String(node.type==='select'?(node.initialValue||node.text||node.options?.[0]||''):node.text||'');
        let height;
        if(node.type==='select'||node.type==='input'&&!node.multiline)height=node.fontSize*1.4;
        else {
          const measured=options.measureText?.(text,inside,node);
          height=measured>0?measured:Math.max(node.fontSize*1.4,text.split('\n').reduce((rows,line)=>rows+Math.max(1,Math.ceil(line.length/Math.max(1,inside/(node.fontSize*.55)))),0)*node.fontSize*1.4);
        }
        node.height=Math.max(control?44:1,height+border*2+padding*2);
      }
    }
    const error=options.errors&&Object.hasOwn(options.errors,node.id)?options.errors[node.id]:undefined;if(error){const h=options.measureText?.(error,node.width,{...node,fontSize:12,fontWeight:400});node.errorText=error;node.errorHeight=Math.max(17,h>0?h:Math.ceil(error.length/Math.max(1,node.width/7))*17)+4;node.height+=node.errorHeight;}
    return {node,children:content.items};
  }
  function arrange(parentId, parentWidth, rule) {
    const padding = rule.padding || 0, gap = rule.gap ?? 12, direction = rule.direction || 'free';
    const inside = Math.max(1,parentWidth-padding*2);
    const nodes = (children.get(parentId) || []).filter(node => node.visible !== false);
    const items = [];
    let x=padding,y=padding,rowHeight=0,maxBottom=padding;
    if(direction==='horizontal'){
      const rows=[];let row=[],used=0;
      for(const source of nodes){
        // Fill needs a usable starting target before sharing a resolved row.
        const preferred=source.widthMode==='fill'?Math.min(({input:80,select:88,checkbox:88,list:160})[source.type]||44,inside):contentWidth(source,inside);
        if(rule.wrap!==false&&row.length&&used+gap+preferred>inside+.01){rows.push(row);row=[];used=0;}
        used+=(row.length?gap:0)+preferred;row.push(source);
      }
      if(row.length)rows.push(row);
      for(const row of rows){
        const count=row.filter(node=>node.widthMode==='fill').length;
        const fixed=row.filter(node=>node.widthMode!=='fill').reduce((sum,node)=>sum+contentWidth(node,inside),0);
        const share=Math.max(1,(inside-fixed-gap*Math.max(0,row.length-1))/Math.max(1,count));
        x=padding;rowHeight=0;
        for(const source of row){const item=measure(source,source.widthMode==='fill'?share:inside);item.localX=x;item.localY=y;x+=item.node.width+gap;rowHeight=Math.max(rowHeight,item.node.height);items.push(item);}
        maxBottom=Math.max(maxBottom,y+rowHeight);y+=rowHeight+gap;
      }
      return {items,height:maxBottom+padding};
    }
    for (const source of nodes) {
      const budget = direction==='free' ? Math.max(1,inside-Math.max(0,source.x)) : inside;
      const item=measure(source,budget);
      if(direction==='free') {item.localX=padding+source.x;item.localY=padding+source.y;}
      else if(direction==='vertical') {item.localX=padding;item.localY=y;y+=item.node.height+gap;}
      maxBottom=Math.max(maxBottom,item.localY+item.node.height);items.push(item);
    }
    return {items,height:maxBottom+padding};
  }
  const content=arrange(null,width,frame.layout || {});
  const nodes=[];
  function flatten(items,offsetX,offsetY,locked) {
    for(const item of items) {
      const node={...item.node,relativeX:item.localX,relativeY:item.localY,
        x:offsetX+item.localX,y:offsetY+item.localY,locked:locked || item.node.locked};
      nodes.push(node);flatten(item.children,node.x+(node.strokeWidth||0),node.y+(node.strokeWidth||0),node.locked);
    }
  }
  flatten(content.items,0,0,false);
  return {...frame,width,height:Math.max(frame.height,content.height),nodes};
}

/** Browser text measurement uses the same typography as emitted widgets. */
export function createTextMeasurer(doc) {
  const box=doc.createElement('div');
  box.style.cssText='position:fixed;left:-100000px;top:0;visibility:hidden;pointer-events:none;white-space:pre-wrap;overflow-wrap:anywhere;line-height:1.4;padding:0;border:0;box-sizing:border-box;';
  box.setAttribute('aria-hidden','true');doc.body.append(box);
  const families={system:'-apple-system,BlinkMacSystemFont,"SF Pro Text","SF Pro Display","Segoe UI",sans-serif',serif:'Georgia,serif',mono:'ui-monospace,monospace'};
  const measure=(text,width,node)=>{
    box.textContent=text;box.style.width=width+'px';box.style.fontFamily=families[node.fontFamily]||families.system;
    box.style.fontSize=node.fontSize+'px';box.style.fontWeight=String(node.fontWeight);
    return box.getBoundingClientRect().height;
  };
  measure.width=(text,node)=>{
    box.textContent=text;box.style.width='max-content';box.style.whiteSpace='pre';
    box.style.fontFamily=families[node.fontFamily]||families.system;box.style.fontSize=node.fontSize+'px';box.style.fontWeight=String(node.fontWeight);
    const width=box.getBoundingClientRect().width;box.style.whiteSpace='pre-wrap';return width;
  };
  measure.destroy=()=>box.remove();return measure;
}
