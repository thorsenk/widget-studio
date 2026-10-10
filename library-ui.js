import {icon} from './icons.js';
const escape=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const date=value=>new Date(value).toLocaleString(undefined,{dateStyle:'medium',timeStyle:'medium'});
const button=(glyph,label,attribute,value)=>`<button class="icon-button" aria-label="${escape(label)}" data-tooltip="${escape(label)}" ${attribute}="${escape(value)}">${icon(glyph)}</button>`;
export function libraryShell({errors=[],location='',browserStorage=false }={}){
  return `<div class="library-controls"><input id="library-search" type="search" aria-label="Search projects" placeholder="Search projects"><div id="library-filters" role="group" aria-label="Project locations"></div></div>${errors.length?`<div class="library-errors" role="status">${errors.map(message=>`<p>${escape(message)}</p>`).join('')}<button data-action="download-recovery">Download recovery data</button></div>`:''}<div id="library-list" role="region" aria-label="Projects" tabindex="0"></div><div class="library-footer"><span class="file-location">${escape(location||(browserStorage?'Saved projects and drafts in this browser':'Saved files on this Mac · Drafts in this browser'))}</span><button data-action="import">Import project</button><button data-action="new">New project</button></div>`;
}
export function libraryRows({saved=[],copies=[],trash=[],currentKey=null,currentProjectId=null,filter='all',query='',browserStorage=false}){
  const drafts=copies.filter(item=>item.kind==='draft'),deleted=copies.filter(item=>item.kind==='trashed');
  const counts={all:saved.length+drafts.length,saved:saved.length,drafts:drafts.length,trash:trash.length+deleted.length};
  const filters=Object.entries({all:'All',saved:'Saved',drafts:'Drafts',trash:'Trash'}).map(([key,label])=>`<button data-library-filter="${key}" aria-label="${label} (${counts[key]})" aria-pressed="${key===filter}">${label}<span>${counts[key]}</span></button>`).join('');
  const rows=[...saved.map(item=>({...item,location:'saved'})),...drafts.map(item=>({...item,location:'drafts'})),...deleted.map(item=>({...item,location:'trash',browser:true})),...trash.map(item=>({...item,location:'trash',browser:false}))];
  const needle=query.trim().toLocaleLowerCase();
  const shown=rows.filter(item=>(filter==='all'?item.location!=='trash':item.location===filter)&&[item.name,item.id,item.projectId,item.key,item.location,item.location==='drafts'||item.browser?'browser':'Mac'].join(' ').toLocaleLowerCase().includes(needle));
  const list=shown.map(item=>{
    const local=item.location==='drafts'||item.browser,identity=String(local?item.key:item.id||item.key.replace(/\.widget\.json$/,'')).slice(-8),open=local?currentKey===item.key:currentProjectId===item.id;
    const label=item.location==='saved'?`${browserStorage?'Browser project':'Mac file'} · Version ${item.revision}`:item.location==='drafts'?`Browser draft · ${item.baseRevision?'Based on '+(browserStorage?'saved':'file')+' version '+item.baseRevision:'No saved '+(browserStorage?'project':'file')}`:local?'Browser draft Trash':browserStorage?'Saved project Trash':'Mac file Trash';
    const details=local?`${item.views} view${item.views===1?'':'s'} · ${item.layers} layers · Copy ${identity}`:`File ${identity}`;
    const stamp=item.location==='trash'?item.trashedAt||item.deletedAt||item.updatedAt:item.updatedAt;
    const version=local?` data-copy-version="${item.version}"`:'';
    const controls=item.location==='saved'?button('folder-open','Open '+item.name,'data-open-project',item.id)+button('trash-2','Move saved file to Trash: '+item.name,'data-trash-project',item.id):item.location==='drafts'?button('folder-open','Recover '+item.name+' · Copy '+identity,'data-recover',item.key)+button('trash-2','Move browser draft to Trash: '+item.name+' · Copy '+identity,'data-trash-copy',item.key):button('rotate-ccw','Restore '+item.name+(local?' · Copy ':' · File ')+identity,local?'data-restore-copy':'data-restore-project',item.key);
    return `<article class="project-row"${version}><span class="library-kind">${icon(item.location==='trash'?'trash-2':local?'layers':'folder-open')}</span><div class="project-meta"><div class="project-row-title"><strong title="${escape(item.name)}">${escape(item.name)}</strong>${open?'<span class="library-current">Open now</span>':''}</div><small>${escape(label)}</small><small>${escape(details)} · ${item.location==='trash'&&(item.trashedAt||item.deletedAt)?'Trashed':'Edited'} ${escape(date(stamp))}</small></div>${controls}</article>`;
  }).join('')||`<p class="library-empty">${needle?'No matching projects.':filter==='trash'?'Trash is empty.':'No projects here yet.'}</p>`;
  return {filters,list,count:shown.length};
}
