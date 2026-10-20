'use strict';
const crypto=require('node:crypto');
const {text,coordinate,list,geometry,duration,numeric,normStation,distance}=require('./geo.cjs');
const ALLOWED=new Set(['v3/place/text','v3/place/around','v3/bus/lineid','v5/direction/walking','v5/direction/bicycling','v5/direction/transit/integrated']);
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
class AmapClient{
 constructor({key,fetchFn=fetch,intervalMs=500,maxCalls=40,onProgress=()=>{},schedule=null}){this.key=key;this.fetchFn=fetchFn;this.intervalMs=intervalMs;this.maxCalls=maxCalls;this.onProgress=onProgress;this.schedule=schedule;this.calls=0;this.cacheHits=0;this.records=[];this.cache=new Map();this.last=0;this.blocked=null;this.failures=0;this.batchId=crypto.randomUUID();}
 async request(endpoint,params){
  if(!ALLOWED.has(endpoint))throw Error('未允许的地图接口');if(!this.key)throw Error('请先在连接设置中填写高德Web服务Key');if(this.blocked)throw this.blocked;
  const signature=JSON.stringify([endpoint,Object.entries(params).sort()]);if(this.cache.has(signature)){this.cacheHits++;return this.cache.get(signature);}
  if(this.calls>=this.maxCalls){const e=Error('达到本次'+this.maxCalls+'次地图请求预算，未查询的候选保持未知');e.code='BUDGET';throw e;}
  if(this.schedule)await this.schedule();else if(this.intervalMs)await sleep(Math.max(0,this.intervalMs-(Date.now()-this.last)));
  this.last=Date.now();this.calls++;const id=this.batchId+':'+(this.records.length+1),record={record_id:id,provider:'amap',endpoint,parameters:params,queried_at:new Date().toISOString(),ok:false};this.records.push(record);this.onProgress(this);
  try{
   const url=new URL('https://restapi.amap.com/'+endpoint);url.search=new URLSearchParams({...params,key:this.key,output:'json'}).toString();
   const response=await this.fetchFn(url,{signal:AbortSignal.timeout(20000),redirect:'error'});if(!response.ok)throw Error('高德HTTP '+response.status);
   const raw=await response.json();if(String(raw.status)!=='1'){record.provider_code=String(raw.infocode??'');const e=Error('高德 '+record.provider_code+'：'+String(raw.info??'请求失败'));e.code=record.provider_code;throw e;}
   record.ok=true;this.failures=0;const result={raw,record_id:id};this.cache.set(signature,result);return result;
  }catch(e){record.error=String(e.message).split(this.key).join('[隐藏]');const safe=Error(record.error);safe.code=e.code??'UPSTREAM';this.failures++;if(['10001','10009','10013'].includes(safe.code)||this.failures>=3)this.blocked=safe;throw safe;}finally{this.onProgress(this);}
 }
 async search(keywords,city='南京',{types}={}){
  const params={keywords:text(keywords),city:text(city),citylimit:'true',offset:'10',page:'1',extensions:'all'};if(types)params.types=types;
  const r=await this.request('v3/place/text',params);return list(r.raw.pois).map(p=>normalizePoi(p,r.record_id)).filter(p=>p.location);
 }
 async around(location,{keywords,types,radius=3000,page=1}={}){
  const params={location:coordinate(location),radius:String(radius),offset:'20',page:String(page),sortrule:'distance',extensions:'all'};if(keywords)params.keywords=text(keywords);if(types)params.types=types;
  const r=await this.request('v3/place/around',params);return list(r.raw.pois).map(p=>normalizePoi(p,r.record_id)).filter(p=>p.location);
 }
 async active(mode,origin,destination){
  if(!['walking','cycling'].includes(mode))throw Error('未知接驳方式');if(distance(origin,destination)<1)return {seconds:0,meters:0,paths:[],evidence:null};
  const r=await this.request('v5/direction/'+(mode==='cycling'?'bicycling':'walking'),{origin:coordinate(origin),destination:coordinate(destination),show_fields:'cost,polyline',alternative_route:'3'});
  return list(r.raw.route?.paths).map((p,i)=>({seconds:duration(p),meters:numeric(p.distance),paths:geometry(p.steps).length?geometry(p.steps):geometry([p]),evidence:{record_id:r.record_id,provider_index:i}})).filter(p=>p.seconds!==null).sort((a,b)=>a.seconds-b.seconds)[0]??null;
 }
 async transit(origin,destination,when,citycode,strategy=8){
  const r=await this.request('v5/direction/transit/integrated',{origin:coordinate(origin),destination:coordinate(destination),city1:citycode,city2:citycode,strategy:String(strategy),AlternativeRoute:'10',date:when.date,time:when.time,show_fields:'cost,polyline'});
  return list(r.raw.route?.transits).map((p,i)=>parseTransit(p,{record_id:r.record_id,provider_index:i},when,{origin,destination})).filter(Boolean).sort((a,b)=>a.seconds-b.seconds);
 }
 async lineGeometry(id){const r=await this.request('v3/bus/lineid',{id:text(id,'公交线路ID',100),extensions:'all'});return {lines:list(r.raw.buslines),evidence:{record_id:r.record_id}};}
}
function normalizePoi(p,record){const rawRating=numeric(p.biz_ext?.rating),rating=rawRating!==null&&rawRating>0&&rawRating<=5?rawRating:null;let location=null;try{location=coordinate(p.location);}catch{}return {id:String(p.id??''),name:String(p.name??''),location,address:typeof p.address==='string'?p.address:'',citycode:typeof p.citycode==='string'?p.citycode:'',adcode:typeof p.adcode==='string'?p.adcode:'',type:typeof p.type==='string'?p.type:'',parent:typeof p.parent==='string'?p.parent:'',source:'amap',evidence:{record_id:record},consumption_reference:numeric(p.biz_ext?.cost),rating,rating_max:5,rating_source:'amap',hours_description:typeof p.biz_ext?.open_time==='string'?p.biz_ext.open_time:typeof p.biz_ext?.opentime2==='string'?p.biz_ext.opentime2:null,price_verified:false,hours_verified:false};}
const buslines=s=>Array.isArray(s.bus)?s.bus:list(s.bus?.buslines);
function substantive(v){if(Array.isArray(v))return v.some(substantive);if(v&&typeof v==='object')return Object.values(v).some(substantive);return typeof v==='string'?v.trim()!==''&&v!=='0':typeof v==='number'&&v>0;}
const metroLine=l=>/地铁|轨道|轻轨|磁悬浮/.test(l.type+' '+l.name);
function safeCoord(v){try{return coordinate(v);}catch{return null;}}
function parseTransit(p,evidence,when,bounds={}){
 const seconds=duration(p),segments=list(p.segments);if(seconds===null||seconds<=0||!segments.some(s=>buslines(s).length))return null;
 if(segments.some(s=>['taxi','railway','bicycle','riding','airplane'].some(k=>substantive(s[k]))))return null;
 const groups=[],sections=[];let cursor=safeCoord(bounds.origin);
 for(const s of segments){
  const lines=buslines(s),g=lines.length?{alternatives:lines.map(l=>({id:typeof l.id==='string'?l.id:null,name:String(l.name??''),type:String(l.type??''),from:l.departure_stop?.name??'',to:l.arrival_stop?.name??'',from_id:l.departure_stop?.id??null,to_id:l.arrival_stop?.id??null,from_location:safeCoord(l.departure_stop?.location),to_location:safeCoord(l.arrival_stop?.location),paths:geometry([l]),meters:numeric(l.distance),seconds:duration(l)})),selected_index:0}:null;
  const w=s.walking&&typeof s.walking==='object'&&!Array.isArray(s.walking)?s.walking:null,wp=geometry(w?.steps).length?geometry(w.steps):geometry(w?[w]:[]),wf=safeCoord(w?.origin)||cursor,wt=safeCoord(w?.destination)||g?.alternatives[0]?.from_location||safeCoord(bounds.destination);
  const needsWalk=wp.length||(numeric(w?.distance)??0)>0||(duration(w)??0)>0||(wf&&wt&&require('./geo.cjs').distance(wf,wt)>15);
  if(needsWalk)sections.push({kind:'walking',title:g?(groups.length?'步行换乘':'步行到乘车站'):'步行至目的地',from_location:wf,to_location:wt,paths:wp,meters:numeric(w?.distance),seconds:duration(w),inferred_connection:!w,evidence});
  if(g){const index=groups.length;groups.push(g);sections.push({kind:'transit',group_index:index,evidence});cursor=g.alternatives[0].to_location;}else if(wt)cursor=wt;
 }
 const end=safeCoord(bounds.destination);if(cursor&&end&&require('./geo.cjs').distance(cursor,end)>15)sections.push({kind:'walking',title:'末段步行',from_location:cursor,to_location:end,paths:[],meters:null,seconds:null,inferred_connection:true,evidence});
 const base={seconds,meters:numeric(p.distance),walking_m:numeric(p.walking_distance),groups,section_templates:sections,first_stop:null,evidence,query_time:{date:when.date,time:when.time},query_timestamp:when.timestamp};
 return selectTransitVariant(base);
}
function selectTransitVariant(t,{metroOnly=false,station=null}={}){
 // Keep the provider's primary line for each leg so geometry and total duration refer to one interpretation.
 const groups=[];for(const [i,g] of t.groups.entries()){const l=g.alternatives[0];if(!l||metroOnly&&!metroLine(l)||station&&i===0&&(!metroLine(l)||normStation(l.from)!==normStation(station.name)))return null;groups.push({...g,selected_index:0,selected:l});}
 const sections=(t.section_templates??t.sections??[]).map(s=>{if(s.group_index===undefined)return {...s};const l=groups[s.group_index].selected;return {...s,kind:metroLine(l)?'metro':'bus',title:l.name,from_location:l.from_location,to_location:l.to_location,from_name:l.from,to_name:l.to,line_id:l.id,from_id:l.from_id,to_id:l.to_id,paths:l.paths,meters:l.meters,seconds:l.seconds};});
 return {...t,groups,sections,paths:sections.filter(s=>s.paths?.length).map(s=>({mode:s.kind,paths:s.paths})),first_stop:groups[0]?.selected??null,metro_only:groups.length>0&&groups.every(g=>metroLine(g.selected)),bus_only:groups.length>0&&groups.every(g=>!metroLine(g.selected))};
}
function boardsAt(t,station){const l=t.groups[0]?.selected??t.groups[0]?.alternatives[0];return !!l&&metroLine(l)&&normStation(l.from)===normStation(station.name);}
function groupStations(pois,origin){
 const valid=pois.filter(p=>p.location&&!/停车场/.test(p.name));const nameById=new Map(valid.filter(p=>p.id).map(p=>[p.id,normStation(p.name)])),groups=new Map();
 for(const p of valid){
  const k=nameById.get(p.parent)||normStation(p.name);if(!k)continue;let g=groups.get(k);
  if(!g){g={...p,station_key:k,access_points:[],sources:[],required:false,baseline_seed:false};groups.set(k,g);}
  g.required ||= p.required===true;g.baseline_seed ||= p.baseline_seed===true;
  const source=p.discovery_source??'nearby';if(!g.sources.includes(source))g.sources.push(source);
  const old=g.access_points.find(a=>a.location===p.location);if(!old)g.access_points.push({id:p.id,name:p.name,location:p.location,evidence:p.evidence??null,source:p.source??'amap'});
 }
 for(const g of groups.values()){
  g.access_points.sort((a,b)=>distance(origin,a.location)-distance(origin,b.location));
  const first=g.access_points[0],center=valid.find(p=>normStation(p.name)===g.station_key&&!p.baseline_seed&&(p.name===g.station_key||/站[）)]?$/.test(p.name)));
  g.id=center?.id||g.parent||g.id;g.name=center?.name||g.station_key+'(地铁站)';g.location=first.location;
 }
 return [...groups.values()].sort((a,b)=>distance(origin,a.location)-distance(origin,b.location));
}
function createJobId(){return crypto.randomUUID();}
module.exports={AmapClient,normalizePoi,parseTransit,selectTransitVariant,metroLine,boardsAt,groupStations,buslines,createJobId,ALLOWED};
