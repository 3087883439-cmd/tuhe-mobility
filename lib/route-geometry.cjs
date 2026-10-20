'use strict';
const G=require('./geo.cjs'),MapModel=require('../public/route-map.js');
function clipLine(line,section){
 const paths=G.decodePolyline(line.polyline);if(paths.length!==1)return null;const points=paths[0],stops=G.list(line.busstops);
 const findStop=(id,name,location)=>{const exact=id?stops.findIndex(s=>String(s.id)===String(id)):-1;if(exact>=0)return exact;const indices=stops.map((s,i)=>{if(s.name!==name)return -1;try{return location&&G.distance(s.location,location)<=100?i:-1;}catch{return -1;}}).filter(i=>i>=0);return indices.length===1?indices[0]:-1;};
 const a=findStop(section.from_id,section.from_name,section.from_location),b=findStop(section.to_id,section.to_name,section.to_location);if(a<0||b<=a)return null;
 let from,to;try{from=G.coordinate(stops[a].location);to=G.coordinate(stops[b].location);}catch{return null;}
 const nearest=p=>{const q=p.split(',').map(Number),c=Math.cos(q[1]*Math.PI/180);let best={index:-1,distance:Infinity};for(let i=0;i<points.length-1;i++){const a=points[i],b=points[i+1],dx=(b[0]-a[0])*c,dy=b[1]-a[1],t=Math.max(0,Math.min(1,(((q[0]-a[0])*c)*dx+(q[1]-a[1])*dy)/(dx*dx+dy*dy||1))),point=[a[0]+t*(b[0]-a[0]),a[1]+t*(b[1]-a[1])],d=G.distance(q,point);if(d<best.distance)best={index:i+t,distance:d,point};}return best;},x=nearest(from),y=nearest(to);
 if(x.index>=y.index||x.distance>200||y.distance>200)return null;
 return [[x.point,...points.slice(Math.floor(x.index)+1,Math.ceil(y.index)),y.point]];
}
async function completeGeometry(client,route,input,via=null,onProgress=()=>{}){
 const fixed=structuredClone(route);fixed.geometry_notes=[];
 const initial=MapModel.build(fixed,input.origin,input.destination,via),deficient=new Set([...initial.missing,...initial.gaps].map(s=>s.id));
 const target=[];for(const [i,a] of fixed.access.entries())if(!a.paths?.length||deficient.has('access:'+i))target.push({object:a,kind:a.mode,from:a.from,to:a.to,title:'首段接驳 '+(i+1)});
 for(const [i,s] of (fixed.transit.sections??[]).entries())if(!s.paths?.length||deficient.has('transit:'+i))target.push({object:s,kind:s.kind,from:s.from_location,to:s.to_location,title:s.title});
 for(const task of target){onProgress('补查线路坐标：'+task.title);try{
  if(task.kind==='walking'||task.kind==='cycling'){
   if(!task.from||!task.to)throw Error('缺少明确的路段端点，不能用直线代替道路');
   if(G.distance(task.from,task.to)<2)continue;
   const r=await client.active(task.kind,task.from,task.to);if(!r?.paths?.length)throw Error('接口未返回可绘制的道路坐标');
   task.object.paths=r.paths;task.object.geometry_evidence=r.evidence;task.object.geometry_source='supplementary_active_route';
   fixed.geometry_notes.push(task.title+'使用补查的同端点路径；仅补充图形，不将新增估计耗时再次叠加到公共交通时间。');
  }else if(task.kind==='bus'||task.kind==='metro'){
   const s=task.object;if(!s.line_id)throw Error('缺少公交或地铁线路ID，无法可靠补全线路');
   const result=await client.lineGeometry(s.line_id),line=result.lines.find(l=>String(l.id)===String(s.line_id));if(!line)throw Error('未返回匹配的线路ID');
   const paths=clipLine(line,s);if(!paths)throw Error('无法确认上下车站的顺序或截取相应线路段');
   s.paths=paths;s.geometry_evidence=result.evidence;s.geometry_source='line_id_clipped_to_stops';
  }
 }catch(e){fixed.geometry_notes.push(task.title+'：'+e.message);}}
 fixed.transit.paths=(fixed.transit.sections??[]).filter(s=>s.paths?.length).map(s=>({mode:s.kind,paths:s.paths}));
 const model=MapModel.build(fixed,input.origin,input.destination,via);fixed.geometry_status={complete:model.complete,missing:model.missing,gaps:model.gaps,checked_at:new Date().toISOString()};
 return {route:fixed,api_calls:client.calls,records:client.records};
}
module.exports={clipLine,completeGeometry};
