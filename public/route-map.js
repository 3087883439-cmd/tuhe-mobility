(function(root,factory){if(typeof module==='object'&&module.exports)module.exports=factory();else root.TuheRouteMap=factory();})(typeof globalThis!=='undefined'?globalThis:this,function(){
 'use strict';
 const colors={walking:'#e89420',cycling:'#009b7c',bus:'#246dde',metro:'#8b45d3'};
 const coord=v=>{const a=typeof v==='string'?v.split(',').map(Number):v;return Array.isArray(a)&&a.length===2&&a.every(Number.isFinite)&&a[0]>=72&&a[0]<=136&&a[1]>=3&&a[1]<=54?a:null;};
 const meters=(a,b)=>{a=coord(a);b=coord(b);if(!a||!b)return Infinity;const r=Math.PI/180,h=Math.sin((a[1]-b[1])*r/2)**2+Math.cos(a[1]*r)*Math.cos(b[1]*r)*Math.sin((a[0]-b[0])*r/2)**2;return 12742000*Math.asin(Math.min(1,Math.sqrt(h)));};
 const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
 function validPaths(paths){const out=[];for(const p of paths??[]){let current=[];for(const q of p??[]){const a=coord(q);if(a)current.push(a);else{if(current.length>1)out.push(current);current=[];}}if(current.length>1)out.push(current);}return out;}
 function build(route,origin,destination,via=null){
  const model={sections:[],markers:[],missing:[],gaps:[],complete:false};if(!route)return model;
  const O=coord(origin?.location??origin),D=coord(destination?.location??destination),addMarker=(p,label)=>{p=coord(p);if(!p)return;const old=model.markers.find(m=>meters(m.position,p)<3);if(old){if(!old.labels.includes(label))old.labels.push(label);}else model.markers.push({position:p,labels:[label]});};
  addMarker(O,'起点');addMarker(D,'目的地');if(via)addMarker(via.location,via.name);
  for(const [i,a] of (route.access??[]).entries())model.sections.push({...a,id:'access:'+i,kind:a.mode,title:(a.mode==='cycling'?'骑行接驳':'步行接驳'),from_location:a.from,to_location:a.to,paths:validPaths(a.paths)});
  const publicSections=route.transit?.sections??(route.transit?.paths??[]).map(p=>({...p,kind:p.mode==='transit'?'bus':p.mode,title:'公共交通分段'}));
  for(const [i,s] of publicSections.entries())model.sections.push({...s,id:'transit:'+i,paths:validPaths(s.paths)});
  if(route.mode==='cycling'&&route.station)addMarker(route.station.location,'停车换乘 · '+route.station.name);
  model.sections=model.sections.filter(s=>s.paths.length||!(s.from_location&&s.to_location&&meters(s.from_location,s.to_location)<2&&(s.seconds??0)===0));
  let rideIndex=0;for(const s of model.sections){
   if(s.kind==='bus'||s.kind==='metro'){rideIndex++;addMarker(s.from_location,rideIndex+' 上车 · '+(s.from_name||s.title));addMarker(s.to_location,rideIndex+' 下车 · '+(s.to_name||s.title));}
   if(!s.paths.length){model.missing.push({id:s.id,title:s.title,kind:s.kind,from_location:s.from_location,to_location:s.to_location});continue;}
   const start=s.paths[0][0],end=s.paths.at(-1).at(-1);
   if(s.from_location&&meters(s.from_location,start)>80)model.gaps.push({id:s.id,title:s.title+'起始衔接未覆盖'});
   if(s.to_location&&meters(end,s.to_location)>80)model.gaps.push({id:s.id,title:s.title+'末端衔接未覆盖'});
   for(let i=1;i<s.paths.length;i++)if(meters(s.paths[i-1].at(-1),s.paths[i][0])>80)model.gaps.push({id:s.id,title:s.title+'内部坐标存在缺口'});
  }
  for(let i=1;i<model.sections.length;i++){const a=model.sections[i-1],b=model.sections[i];if(a.to_location&&b.from_location&&meters(a.to_location,b.from_location)>80)model.gaps.push({id:a.id+'>'+b.id,title:'相邻行程段之间缺少衔接路径'});}
  const first=model.sections[0],last=model.sections.at(-1);
  if(first&&O&&meters(O,first.from_location??first.paths[0]?.[0])>80)model.gaps.push({id:'origin',title:'起点到首段路线未覆盖'});
  if(last&&D&&meters(last.to_location??last.paths.at(-1)?.at(-1),D)>80)model.gaps.push({id:'destination',title:'末段路线到目的地未覆盖'});
  model.complete=model.sections.length>0&&!model.missing.length&&!model.gaps.length;return model;
 }
 function render(sdk,map,model,previous=[],{fit:shouldFit=true}={}){
  if(previous.length)map.remove(previous);const overlays=[],fit=[];
  const add=(o,include=true)=>{map.add(o);overlays.push(o);if(include)fit.push(o);};
  for(const s of model.sections)for(const p of s.paths){
   const common={path:p,lineJoin:'round',lineCap:'round',strokeStyle:s.kind==='walking'?'dashed':'solid',strokeDasharray:[10,5]};
   add(new sdk.Polyline({...common,strokeColor:'#ffffff',strokeWeight:16,strokeOpacity:.98,zIndex:100}));
   add(new sdk.Polyline({...common,strokeColor:colors[s.kind]||colors.bus,strokeWeight:9,strokeOpacity:1,showDir:s.kind!=='walking',zIndex:110}));
  }
  for(const m of model.markers){const label=m.labels.join(' / ');add(new sdk.Marker({position:m.position,title:label,zIndex:130,label:{direction:'top',content:esc(label)}}));}
  if(shouldFit&&fit.length)map.setFitView(fit,false,[70,85,85,70]);return overlays;
 }
 return {build,render,colors,meters};
});
