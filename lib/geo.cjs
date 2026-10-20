'use strict';
function text(v,label='文字',max=180){if(typeof v!=='string'||!v.trim()||v.length>max)throw Error(label+'不能为空且不能超过'+max+'字');return v.trim();}
function number(v,label,min,max){if(typeof v!=='number'||!Number.isFinite(v)||v<min||v>max)throw Error(label+'须为'+min+'至'+max+'的数值');return v;}
function coordinate(v){let a;if(typeof v==='string'&&v.trim())a=v.split(',').map(Number);else if(Array.isArray(v))a=v;else throw Error('坐标须为经度,纬度');if(a.length!==2||a.some(n=>typeof n!=='number'||!Number.isFinite(n))||a[0]<72||a[0]>136||a[1]<3||a[1]>54)throw Error('请使用中国大陆研究范围内的GCJ-02坐标（经度,纬度）');return a.map(n=>+n.toFixed(6)).join(',');}
function duration(v){for(const x of [v?.cost?.duration,v?.duration])if((typeof x==='string'&&x.trim()||typeof x==='number')&&Number.isFinite(+x)&&+x>=0)return +x;return null;}
function numeric(v){return (typeof v==='number'||typeof v==='string'&&v.trim())&&Number.isFinite(+v)?+v:null;}
const list=v=>Array.isArray(v)?v:[];
function distance(a,b){const [x,y]=coordinate(a).split(',').map(Number),[u,v]=coordinate(b).split(',').map(Number),r=Math.PI/180;const h=Math.sin((v-y)*r/2)**2+Math.cos(y*r)*Math.cos(v*r)*Math.sin((u-x)*r/2)**2;return 6371000*2*Math.asin(Math.min(1,Math.sqrt(h)));}
function localDateTime(v){if(typeof v!=='string'||!/^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d$/.test(v))throw Error('时间使用北京时间YYYY-MM-DDTHH:MM');const t=Date.parse(v+':00+08:00');if(!Number.isFinite(t)||new Date(t+28800000).toISOString().slice(0,16)!==v)throw Error('日期不存在');return t;}
function display(t){return new Date(t+28800000).toISOString().slice(0,19).replace('T',' ');}
function queryTime(t){const rounded=Math.ceil(t/60000)*60000,s=display(rounded);return {date:s.slice(0,10),time:s.slice(11,16).replace(':','-'),timestamp:rounded};}
function decodePolyline(value){
 let points=[];if(typeof value==='string'){
  if(value.includes(';'))points=value.split(';').map(p=>p.split(',').map(x=>x.trim()===''?NaN:Number(x)));
  else{const n=value.split(',').map(x=>x.trim()===''?NaN:Number(x));if(n.length%2)return [];for(let i=0;i<n.length;i+=2)points.push(n.slice(i,i+2));}
 }else if(Array.isArray(value))points=value;
 const paths=[];let path=[];const flush=()=>{if(path.length>1)paths.push(path);path=[];};
 for(const p of points){try{const pair=coordinate(p).split(',').map(Number);if(!path.length||pair[0]!==path.at(-1)[0]||pair[1]!==path.at(-1)[1])path.push(pair);}catch{flush();}}flush();return paths;
}
function geometry(steps){return list(steps).flatMap(s=>decodePolyline(s?.polyline));}
function normStation(s){return String(s??'').replace(/[（(].*?[）)]/g,'').replace(/\s/g,'').replace(/(?:[A-Z]?[0-9一二三四五六七八九十]+[A-Z]?|[A-Z])(?:号)?(?:出入口|入口|出口|口)$|(?:出入口|入口|出口)$/i,'').replace(/地铁站|地铁|站/g,'');}
function direction(origin,target,poi,angles=[45,30,25]){
 const [ox,oy]=coordinate(origin).split(',').map(Number),[tx,ty]=coordinate(target).split(',').map(Number),[px,py]=coordinate(poi).split(',').map(Number),r=Math.PI/180;
 const c=Math.cos(oy*r),dx=(tx-ox)*c,dy=ty-oy,vx=(px-ox)*c,vy=py-oy,len=Math.hypot(dx,dy),vlen=Math.hypot(vx,vy),d=distance(origin,poi);
 let threshold=d<=1000?angles[0]:d<=2000?angles[0]+(angles[1]-angles[0])*(d-1000)/1000:d<=3000?angles[1]+(angles[2]-angles[1])*(d-2000)/1000:angles[2];
 if(!len)return {distance_m:d,angle:null,threshold,pass:false,reason:'方向目标与起点重合，需更换参考目标'};
 const cos=vlen?Math.max(-1,Math.min(1,(dx*vx+dy*vy)/(len*vlen))):1,angle=Math.acos(cos)/r,projection=(dx*vx+dy*vy)/(len*len);
 const reason=projection<0?'位于身后':projection>1?'超出本段方向目标':angle>threshold?'偏离前进方向':null;
 return {distance_m:d,angle,threshold,projection,pass:!reason,reason};
}
function samplePath(paths,origin,target){const points=list(paths).flat(),base=points.length>1?points:[coordinate(origin).split(',').map(Number),coordinate(target).split(',').map(Number)];if(base.length<=3)return base.map(coordinate);const lens=[0];for(let i=1;i<base.length;i++)lens.push(lens.at(-1)+distance(base[i-1],base[i]));const out=[base[0]];for(const f of [.5,1]){const t=lens.at(-1)*f;let i=lens.findIndex(n=>n>=t);if(i<1)i=1;const z=(t-lens[i-1])/(lens[i]-lens[i-1]||1);out.push([base[i-1][0]+(base[i][0]-base[i-1][0])*z,base[i-1][1]+(base[i][1]-base[i-1][1])*z]);}return [...new Set(out.map(coordinate))];}
module.exports={text,number,coordinate,duration,numeric,list,distance,localDateTime,display,queryTime,geometry,decodePolyline,normStation,direction,samplePath};
