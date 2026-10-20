(function(root,factory){if(typeof module==='object'&&module.exports)module.exports=factory();else root.TuheInterestArea=factory();})(typeof globalThis!=='undefined'?globalThis:this,function(){
 'use strict';
 const DEG=Math.PI/180,M=6371000*DEG;
 function point(v){const a=typeof v==='string'?v.split(',').map(Number):v;if(!Array.isArray(a)||a.length!==2||!a.every(Number.isFinite)||a[0]<72||a[0]>136||a[1]<3||a[1]>54)throw Error('兴趣区需要有效的GCJ-02经纬度');return a;}
 const threshold=(d,a)=>d<=1000?a[0]:d<=2000?a[0]+(a[1]-a[0])*(d-1000)/1000:d<=3000?a[1]+(a[2]-a[1])*(d-2000)/1000:a[2];
 const project=(origin,p)=>{origin=point(origin);p=point(p);return [(p[0]-origin[0])*M*Math.cos(origin[1]*DEG),(p[1]-origin[1])*M];};
 const unproject=(origin,p)=>[origin[0]+p[0]/(M*Math.cos(origin[1]*DEG)),origin[1]+p[1]/M];
 function create(origin,target,{radius=3000,angles=[45,30,25]}={}){
  origin=point(origin);target=point(target);if(!Number.isFinite(radius)||radius<100||radius>5000||!Array.isArray(angles)||angles.length!==3||angles.some(x=>!Number.isFinite(x)||x<1||x>89))throw Error('兴趣区距离为100—5000米，左右角度为1—89度');
  const delta=project(origin,target),length=Math.hypot(...delta);if(length<1)return null;
  const axis=delta.map(v=>v/length),left=[-axis[1],axis[0]],at=(r,t)=>[r*Math.cos(t*DEG),r*Math.sin(t*DEG)];
  const samples=[...new Set([0,radius,...Array.from({length:Math.ceil(radius/35)},(_,i)=>Math.min(radius,(i+1)*35)),...[1000,2000,3000].filter(v=>v<radius)])].sort((a,b)=>a-b),edge=samples.map(r=>at(r,-threshold(r,angles))),angle=threshold(radius,angles);
  for(let t=-angle+1;t<angle;t+=1)edge.push(at(radius,t));
  edge.push(...[...samples].reverse().map(r=>at(r,threshold(r,angles))));
  // Clip at the perpendicular through the boarding target; the region never extends past it.
  const clipped=[];for(let i=0;i<edge.length;i++){const a=edge[i],b=edge[(i+1)%edge.length],inside=a[0]<=length,next=b[0]<=length;if(inside)clipped.push(a);if(inside!==next){const f=(length-a[0])/(b[0]-a[0]);clipped.push([length,a[1]+f*(b[1]-a[1])]);}}
  const polygon=clipped.map(([x,y])=>unproject(origin,[axis[0]*x+left[0]*y,axis[1]*x+left[1]*y]));
  return {type:'variable_directional_interest_area',crs:'GCJ-02',origin,target,radius,angles:[...angles],axis,length,polygon,bounds:[[Math.min(...polygon.map(p=>p[0])),Math.min(...polygon.map(p=>p[1]))],[Math.max(...polygon.map(p=>p[0])),Math.max(...polygon.map(p=>p[1]))]],distance_basis:'起点至商户的近似直线距离；不是道路距离或等时圈'};
 }
 function inspect(area,location){
  const v=project(area.origin,location),d=Math.hypot(...v),forward=v[0]*area.axis[0]+v[1]*area.axis[1],cos=d?Math.max(-1,Math.min(1,forward/d)):1,angle=Math.acos(cos)/DEG,t=threshold(d,area.angles),projection=forward/area.length;
  const reason=d>area.radius+1e-6?'超过兴趣区最远距离':forward< -1e-6?'位于身后':forward>area.length+1e-6?'超出本段方向目标':angle>t+1e-7?'偏离前进方向':null;
  return {distance_m:d,angle,threshold:t,projection,pass:!reason,reason};
 }
 function queryCircles(area){
  const result=[],maxForward=Math.min(area.radius,area.length);
  for(const f of [0,.5,.85]){const p=unproject(area.origin,area.axis.map(v=>v*maxForward*f)),location=p.map(n=>+n.toFixed(6)).join(',');if(result.some(c=>c.location===location))continue;const radius=Math.ceil(Math.max(...area.polygon.map(q=>Math.hypot(...project(p,q)))))+2;result.push({location,radius:Math.min(50000,Math.max(100,radius))});}
  return result;
 }
 function rating(p){const value=p.rating,scale=p.rating_max??5;return typeof value==='number'&&Number.isFinite(value)&&typeof scale==='number'&&Number.isFinite(scale)&&scale>0&&value>=0&&value<=scale?value/scale:null;}
 function rank(rows,{radius=3000,rating_weight=.6}={}){
  if(!Number.isFinite(radius)||radius<=0||!Number.isFinite(rating_weight)||rating_weight<0||rating_weight>1)throw Error('评分权重须为0—1');
  const rated=rows.filter(p=>rating(p)!==null).length,mode=rating_weight===0?'distance_only':rated?'weighted':'distance_fallback',w=mode==='weighted'?rating_weight:0;
  const pois=rows.map(p=>{const r=rating(p),d=p.direction?.distance_m??Infinity,dc=Math.max(0,1-d/radius),score=w>0&&r===null?null:100*(w*(r??0)+(1-w)*dc);return {...p,recommendation_score:score,rating_component:r,distance_component:dc};}).sort((a,b)=>(b.recommendation_score??-Infinity)-(a.recommendation_score??-Infinity)||(a.direction?.distance_m??Infinity)-(b.direction?.distance_m??Infinity)||String(a.id).localeCompare(String(b.id)));
  return {pois,mode,rated_count:rated,unrated_count:rows.length-rated,rating_weight:w,distance_weight:1-w,distance_basis:'起点至店铺的直线距离，越近分越高'};
 }
 return {create,inspect,queryCircles,rank,rating,project,unproject,threshold};
});
