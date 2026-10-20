'use strict';
const G=require('./geo.cjs');
const Interest=require('../public/interest-area.js');
const {boardsAt,groupStations,selectTransitVariant}=require('./amap.cjs');
const {fromAuthorized}=require('./merchants.cjs');
function validateInput(v){
 if(!v||typeof v!=='object')throw Error('缺少行程条件');
 const point=(p,label)=>{if(!p)throw Error('请选择'+label);return {id:typeof p.id==='string'?p.id.slice(0,80):'',name:G.text(p.name,label),location:G.coordinate(p.location),citycode:G.text(p.citycode||'025','城市代码',6)};};
 const origin=point(v.origin,'出发点'),destination=point(v.destination,'目的地');
 if(!/^\d{3,4}$/.test(origin.citycode)||origin.citycode!==destination.citycode)throw Error('当前版本支持同城规划，请选择同城地点并核对城市代码');
 if(G.distance(origin.location,destination.location)<10)throw Error('起点与目的地太接近，请重新选点');
 if(typeof v.bike_available!=='boolean')throw Error('请选择是否有自行车');
 const departure=G.localDateTime(v.departure),deadline=v.latest_arrival?G.localDateTime(v.latest_arrival):null;if(deadline!==null&&deadline<departure)throw Error('最晚到达不能早于出发时刻');
 const station_count=v.station_count??8;G.number(station_count,'全程比较站数',1,8);if(!Number.isInteger(station_count))throw Error('站点数须为整数');
 const station_keywords=typeof v.station_keywords==='string'?v.station_keywords.trim():'';if(station_keywords.length>80||station_keywords.split(/[,，;；]/).filter(s=>s.trim()).length>2)throw Error('最多补充两个地铁站名称，以逗号分隔');
 return {origin,destination,departure:v.departure,departure_ms:departure,latest_arrival:v.latest_arrival??null,deadline_ms:deadline,bike_available:v.bike_available,prefer_bike:v.bike_available&&v.prefer_bike!==false,max_ride_minutes:G.number(v.max_ride_minutes??20,'累计骑行上限',0,90),parking_minutes:G.number(v.parking_minutes??2,'停车时间',0,30),dwell_minutes:G.number(v.dwell_minutes??10,'活动停留',0,180),station_count,station_keywords,station_radius:G.number(v.station_radius??5000,'找站半径',500,5000),include_bus_only:v.include_bus_only===true};
}
function rankCandidates(items,input){return [...items].sort((a,b)=>{if(input.prefer_bike&&a.mode!==b.mode)return a.mode==='cycling'?-1:1;return a.total_seconds-b.total_seconds;});}
function publicWarnings(via,cycling){return [...(cycling?['停车许可、车位与进站口待核实，自行车停在所列站点。']:[]),...(via?['商户营业、供应、排队与具体商品价格待核实；人均价不等于本次餐品价格。']:[]),'公共交通耗时已包含接口计入的步行、候车与换乘，不额外重复叠加。','仅比较本次有限候选，预计到达时间不保证实际准时。'];}
function summarize(result,client){result.api_calls=client.calls;result.cache_hits=client.cacheHits;result.records=client.records;result.queried_at=new Date().toISOString();return result;}
async function planTrip(client,raw,{via=null,onProgress=()=>{}}={}){
 const input=validateInput(raw),O=input.origin.location,D=input.destination.location,start=input.departure_ms;
 const result={kind:'live_amap_candidate_planning',crs:'GCJ-02',input,via,candidates:[],rejected:[],issues:[],stations:[],station_comparison:[],status:'calculating',scope:'同城、单程、上车前至多一个活动点；骑行到站后停车，末端按公交接口结果接驳。'};
 const baselineStops=[];
 const report=label=>{result.progress=label;summarize(result,client);onProgress(result);};
 function issue(stage,e){result.issues.push({stage,code:e.code??null,message:String(e.message)});}
 function add(mode,access,station,t,details){
  const total=(t.query_timestamp-start)/1000+t.seconds,arrival=start+total*1000;
  if(input.deadline_ms!==null&&arrival>input.deadline_ms){result.rejected.push({station:station?.name??'普通公共交通',mode,reason:'预计到达超过设定期限',arrival:G.display(arrival)});return;}
  const route_kind=mode==='cycling'?'cycling_transit':t.metro_only?'walk_metro':t.bus_only?'walk_bus':'walk_mixed';
  const route={id:'R'+(result.candidates.length+1),mode,route_kind,station,access,transit:t,total_seconds:total,arrival:G.display(arrival),arrival_ms:arrival,bike_seconds:mode==='cycling'?access.reduce((s,a)=>s+a.seconds,0):0,bike_end_location:mode==='cycling'?station.location:input.origin.location,parking_verified:false,conditional:mode==='cycling'||!!via,unknowns:publicWarnings(via,mode==='cycling'),...details};
  result.candidates.push(route);
 }
 let walkAccess=[],ready=start;
 if(via){
  report('计算步行到活动地点');try{const a=await client.active('walking',O,via.location);if(a){walkAccess=[{...a,mode:'walking',from:O,to:via.location}];ready=start+(a.seconds+input.dwell_minutes*60)*1000;}else{ready=null;result.rejected.push({mode:'walking',reason:'步行到活动地点未返回可解析路径'});}}catch(e){ready=null;issue('步行到活动地点',e);}
 }
 if(ready!==null){
  for(const strategy of input.include_bus_only?[8,7,5]:[8,7]){
   report(strategy===5?'查询不乘地铁的公交对照':strategy===7?'查询步行接驳地铁':'查询普通公共交通对照');
   try{const when=G.queryTime(ready),returned=await client.transit(via?via.location:O,D,when,input.origin.citycode,strategy),ts=strategy===7?returned.map(t=>selectTransitVariant(t,{metroOnly:true})).filter(Boolean):returned;
    for(const t of ts){
     add('walking',walkAccess,null,t,{label:t.metro_only?'步行到地铁站 · 地铁':strategy===5?'步行到公交站 · 公交':t.bus_only?'步行到公交站 · 公交':'步行接驳 · 公交与地铁',parking_seconds:0,dwell_seconds:via?input.dwell_minutes*60:0,rounding_seconds:(when.timestamp-ready)/1000});
     for(const g of t.groups){const lines=g.alternatives.filter(l=>/地铁|轨道/.test(l.type+' '+l.name));if(lines.length){for(const l of lines){try{const location=G.coordinate(l.from_location);if(G.distance(O,location)<=input.station_radius)baselineStops.push({id:'transit-stop:'+G.normStation(l.from),name:l.from+'(地铁站)',location,baseline_seed:true,discovery_source:'baseline_transit',source:'amap_transit_stop',evidence:t.evidence});}catch{}}break;}}
    }
    if(!ts.length)result.rejected.push({mode:'walking',reason:strategy===7?'本次地铁优先查询未返回可确认的仅步行与地铁方案；不把公交接驳方案改名为步行地铁':'本次公共交通查询未返回可解析的公交或地铁方案；不代表现实无路'});
   }catch(e){issue('普通公共交通',e);}
  }
 }
 // Both modes use the same discovered station pool. A provider's origin-to-destination
 // shortlist is retained as a baseline, not treated as exhaustive walking coverage.
 {
  const pois=[...baselineStops],searchOrigin=via?.location??O;
  for(const page of [1,2]){report('查找步行与骑行可比较的地铁站（第'+page+'页）');try{pois.push(...await client.around(searchOrigin,{types:'150500',radius:input.station_radius,page}));}catch(e){issue('站点搜索',e);}}
  for(const keyword of input.station_keywords.split(/[,，;；]/).map(s=>s.trim()).filter(Boolean)){
   report('补充检索指定站：'+keyword);try{const matches=await client.search(keyword,input.origin.citycode,{types:'150500'});const valid=matches.filter(p=>G.normStation(p.name)===G.normStation(keyword)&&(!p.citycode||p.citycode===input.origin.citycode));
    if(!valid.length)result.issues.push({stage:'指定站检索',message:keyword+'未返回可确认的同城地铁站，请核对名称；不据此判定该站不可达。'});
    pois.push(...valid.map(p=>({...p,required:true,discovery_source:'user_specified'})));
   }catch(e){issue('指定站 '+keyword,e);}
  }
  const groups=groupStations(pois,searchOrigin),priority=g=>g.required?0:g.baseline_seed?1:2;
  const pool=[...groups].sort((a,b)=>priority(a)-priority(b)||G.distance(searchOrigin,a.location)-G.distance(searchOrigin,b.location)).slice(0,12);
  result.coverage={discovered_stations:groups.length,access_screen_limit:12,access_screened:0,walking_access_screened:0,cycling_access_screened:0,walking_full_queried:0,cycling_full_queried:0,full_comparison_limit:input.station_count,max_access_points_per_station:2,request_budget:client.maxCalls,budget_limited:false,search_origin:searchOrigin};
  const empty=()=>({access_status:'not_queried',transit_status:'not_queried',access_points_measured:0,reason:'尚未计算，不能据此认定不可达'});
  result.station_comparison=groups.map(g=>({station_key:g.station_key,name:g.name,required:g.required,sources:g.sources,straight_distance_m:G.distance(searchOrigin,g.location),access_points_discovered:g.access_points.length,walking:empty(),cycling:empty(),access_status:'not_queried',transit_status:'not_queried'}));
  const poolKeys=new Set(pool.map(g=>g.station_key));
  for(const row of result.station_comparison){if(!poolKeys.has(row.station_key)){row.walking.reason='已检索到，但受12站筛查上限限制未计算';row.cycling.reason=row.walking.reason;}if(!input.bike_available)row.cycling.reason='未选择自行车，未查骑行';}
  if(!pool.length)result.issues.push({stage:'站点搜索',message:'本次未得到地铁站候选，尚不能逐站比较步行或骑行接驳。'});
  const modes=['walking',...(input.bike_available?['cycling']:[])];
  for(const [modeIndex,mode] of modes.entries()){
   const title=mode==='walking'?'步行':'骑行',phaseStart=client.calls;
   // Reserve a fair share for the other mode, and reserve transit calls before
   // measuring entrances. Otherwise access screening alone can exhaust the job.
   const remaining=Math.max(0,client.maxCalls-client.calls),phaseBudget=Math.floor(remaining/(modes.length-modeIndex));
   const transitReserve=Math.min(input.station_count,pool.length,Math.floor(phaseBudget/2)),screenBudget=Math.max(0,phaseBudget-transitReserve);
   const measured=new Map(),attempted=new Set();let limited=false;
   if(mode==='walking'&&ready===null){for(const row of result.station_comparison)row.walking.reason='步行到活动地点缺少可用路径，后续逐站比较未完成';continue;}
   // One entrance per station first; only use remaining budget for second entrances.
   // This prevents a station's many entrances consuming all coverage of other stations.
   for(let entryIndex=0;entryIndex<2;entryIndex++){
    for(const group of pool){
     const point=group.access_points[entryIndex];if(!point)continue;
     const row=result.station_comparison.find(r=>r.station_key===group.station_key),state=row[mode],upperCalls=mode==='cycling'&&via?2:1;
     if(client.blocked){state.reason='接口鉴权或连续请求失败，尚未完成比较';continue;}
     if(client.calls-phaseStart+upperCalls>screenBudget){limited=true;continue;}
     attempted.add(group.station_key);report('逐站计算实际'+title+'：'+group.name);
     try{
      const legs=mode==='walking'?[...walkAccess]:[],points=mode==='walking'?[searchOrigin,point.location]:via?[O,via.location,point.location]:[O,point.location];let missing=false;
      for(let i=1;i<points.length;i++){const a=await client.active(mode,points[i-1],points[i]);if(!a){missing=true;break;}legs.push({...a,mode,from:points[i-1],to:points[i]});}
      state.access_points_measured++;if(missing){if(!measured.has(group.station_key)){state.access_status='unknown';state.reason=title+'接口未返回可解析路径；不代表现实不可达';}continue;}
      const activeSeconds=legs.reduce((sum,a)=>sum+a.seconds,0),best=measured.get(group.station_key);
      if(!best||activeSeconds<best.activeSeconds)measured.set(group.station_key,{station:{...group,location:point.location,access_point_name:point.name,access_point_id:point.id},legs,activeSeconds});
     }catch(e){if(!measured.has(group.station_key)){state.access_status='unknown';state.reason=String(e.message);}issue(group.name+' / '+title+' / '+point.name,e);}
    }
   }
   const eligible=[];
   for(const group of pool){
    const state=result.station_comparison.find(r=>r.station_key===group.station_key)[mode],best=measured.get(group.station_key);
    if(!best){if(state.access_status==='not_queried')state.reason=client.blocked?'接口失败，未完成查询':title+'搜索或请求预算有限，尚未计算';continue;}
    state.access_status='measured';state.access_seconds=best.activeSeconds;state.access_distance_m=best.legs.every(a=>typeof a.meters==='number')?best.legs.reduce((sum,a)=>sum+a.meters,0):null;state.access_point_name=best.station.access_point_name;state.reason='已测'+state.access_points_measured+'个入口，未测入口仍未知';
    if(mode==='cycling'&&best.activeSeconds>input.max_ride_minutes*60){state.access_status='over_limit';state.reason='已测路径累计骑行超过上限；其他未测站口仍未知';result.rejected.push({station:group.name,mode,reason:state.reason,ride_seconds:best.activeSeconds});continue;}
    eligible.push(best);
   }
   const selected=eligible.sort((a,b)=>(a.station.required?0:1)-(b.station.required?0:1)||a.activeSeconds-b.activeSeconds).slice(0,input.station_count);
   const selectedKeys=new Set(selected.map(m=>m.station.station_key));
   for(const m of eligible)if(!selectedKeys.has(m.station.station_key))result.station_comparison.find(r=>r.station_key===m.station.station_key)[mode].reason='已算'+title+'，受全程比较站点上限限制，后续地铁未查';
   for(const {station,legs,activeSeconds} of selected){
    const state=result.station_comparison.find(r=>r.station_key===station.station_key)[mode];
    if(client.calls-phaseStart>=phaseBudget||client.blocked){state.reason=client.blocked?'接口失败，后续地铁未完成':title+'阶段预算已用完，后续地铁未查';limited=true;continue;}
    report('逐站比较'+title+'接驳全程：'+station.name);
    try{
     const park=mode==='cycling'?input.parking_minutes*60:0,dwell=via?input.dwell_minutes*60:0,readyAt=start+(activeSeconds+park+dwell)*1000,when=G.queryTime(readyAt);
     const returned=await client.transit(station.location,D,when,input.origin.citycode,7),matching=returned.filter(t=>boardsAt(t,station)&&(mode!=='walking'||t.metro_only));
     result.coverage[mode+'_full_queried']++;
     if(!matching.length){state.transit_status='unconfirmed';state.reason='本次返回未确认从该站首先乘地铁'+(mode==='walking'?'且不含公交':'')+'的方案；不代表现实无路';result.rejected.push({station:station.name,mode,reason:state.reason});continue;}
     state.transit_status='queried';state.best_total_seconds=Math.min(...matching.map(t=>(t.query_timestamp-start)/1000+t.seconds));state.meets_arrival_deadline=input.deadline_ms===null||start+state.best_total_seconds*1000<=input.deadline_ms;state.reason='已比较'+title+'与后续地铁全程；仅测'+state.access_points_measured+'个入口';
     if(!result.stations.some(s=>s.station_key===station.station_key))result.stations.push(station);
     for(const t of matching)add(mode,legs,station,t,{label:title+'到 '+station.station_key+' · 地铁'+(!t.metro_only?'与公交':''),candidate_source:'station_expansion',access_seconds:activeSeconds,parking_seconds:park,dwell_seconds:dwell,rounding_seconds:(when.timestamp-readyAt)/1000});
    }catch(e){state.transit_status='unknown';state.reason=String(e.message);issue(station.name+' / '+title+'后续地铁',e);}
   }
   result.coverage[mode+'_access_screened']=attempted.size;
   if(limited){result.coverage.budget_limited=true;result.issues.push({stage:title+'候选覆盖',code:'COVERAGE_LIMIT',message:title+'逐站比较受本次'+client.maxCalls+'次总请求及模式分配限制，未测站点/入口保持未知；可指定站名优先补查。'});}
  }
  // Preserve bicycle field names for older exported-result readers.
  for(const row of result.station_comparison){const b=row.cycling;row.access_status=b.access_status;row.transit_status=b.transit_status;if(b.access_seconds!==undefined)row.bike_seconds=b.access_seconds;if(b.access_distance_m!==undefined)row.bike_distance_m=b.access_distance_m;row.access_point_name=b.access_point_name;row.best_total_seconds=b.best_total_seconds;row.meets_arrival_deadline=b.meets_arrival_deadline;row.reason=b.reason;}
  result.coverage.access_screened=result.coverage.cycling_access_screened;
  result.station_comparison.sort((a,b)=>(a.walking.access_seconds??Infinity)-(b.walking.access_seconds??Infinity)||a.straight_distance_m-b.straight_distance_m);
  const timed=result.station_comparison.filter(r=>typeof r.bike_seconds==='number').sort((a,b)=>a.bike_seconds-b.bike_seconds);result.fastest_measured_access_station_key=timed[0]?.station_key??null;
  const walked=result.station_comparison.filter(r=>typeof r.walking.access_seconds==='number').sort((a,b)=>a.walking.access_seconds-b.walking.access_seconds);result.fastest_measured_walking_station_key=walked[0]?.station_key??null;
 }
 // Deduplicate provider alternatives without pretending independent strategies are new evidence.
 const unique=new Map();for(const c of result.candidates){const sig=JSON.stringify([c.mode,c.station?.id,c.total_seconds,c.transit.groups.map(g=>g.alternatives.map(l=>[l.name,l.from,l.to]))]);if(!unique.has(sig))unique.set(sig,c);}
 result.candidates=rankCandidates([...unique.values()],input);
 const fastest=[...result.candidates].sort((a,b)=>a.total_seconds-b.total_seconds)[0];result.fastest_id=fastest?.id??null;
 result.candidates.forEach(c=>{c.delta_to_fastest_seconds=c.total_seconds-fastest.total_seconds;c.preference_first=c.mode==='cycling'&&input.prefer_bike;});
 result.status=result.candidates.length?'candidates':result.issues.length?'incomplete':'no_candidate_in_returned_set';
 report('计算完成');delete result.progress;return summarize(result,client);
}
async function recommendMerchants(client,plan,route,raw,{authorizedDataset=null,onProgress=()=>{}}={}){
 if(plan.via)throw Error('当前已有活动地点，请先移除，再比较其他地点');
 const opts={provider:raw.provider??'amap',keyword:G.text(raw.keyword??'早餐','活动关键词',40),radius:G.number(raw.radius??3000,'兴趣区最远距离',100,5000),rating_weight:G.number(raw.rating_weight??.6,'评分权重',0,1),max_extra_minutes:G.number(raw.max_extra_minutes??15,'整段增加上限',0,120),max_evaluations:G.number(raw.max_evaluations??3,'精算商户数',1,5),angles:[raw.a1??45,raw.a2??30,raw.a3??25]};
 if(!Number.isInteger(opts.max_evaluations))throw Error('精算商户数须为整数');opts.angles.forEach(x=>G.number(x,'方向角度',1,89));
 const input=plan.input,target=route.station?.location??route.transit.first_stop?.from_location??input.destination.location;
 const interest_area=Interest.create(input.origin.location,target,{radius:opts.radius,angles:opts.angles});if(!interest_area)throw Error('首段方向目标与起点重合，无法建立方向兴趣区，请选择其他接驳方案');
 const circles=Interest.queryCircles(interest_area),centers=circles.map(c=>c.location),pool=[],issues=[];
 if(opts.provider==='amap'){
  for(const circle of circles)for(const page of [1,2]){onProgress('检索兴趣区商户（第'+page+'页）');try{pool.push(...await client.around(circle.location,{keywords:opts.keyword,radius:circle.radius,page}));}catch(e){issues.push({stage:'商户检索',message:String(e.message)});}}
 }else if(opts.provider==='meituan_authorized_export')pool.push(...fromAuthorized(authorizedDataset,[input.origin.location],opts.radius+5,opts.keyword));else throw Error('未知商户数据来源');
 const map=new Map();for(const p of pool){if(!p.id||!p.location)continue;map.set(p.id,p);}
 const rows=[...map.values()].map(p=>{const direction=Interest.inspect(interest_area,p.location);return {...p,direction,in_interest_area:direction.pass,evaluation:direction.pass?'not_evaluated':'direction_rejected',...(!direction.pass?{reason:direction.reason}:{})};});
 const screened=rows.filter(p=>p.in_interest_area),initial=Interest.rank(screened,opts),selected=initial.pois.slice(0,opts.max_evaluations);
 for(const candidate of selected){const p=rows.find(p=>p.id===candidate.id);
  onProgress('精算活动地点：'+p.name);try{
   const mode=route.mode,a=await client.active(mode,input.origin.location,p.location);if(!a){p.evaluation='unknown';p.reason='去商户路径未返回';continue;}
   const access=[{...a,mode,from:input.origin.location,to:p.location}];
   if(mode==='cycling'){const b=await client.active('cycling',p.location,route.station.location);if(!b){p.evaluation='unknown';p.reason='商户至站点路径未返回';continue;}access.push({...b,mode,from:p.location,to:route.station.location});}
   const riding=mode==='cycling'?access.reduce((s,a)=>s+a.seconds,0):0;if(riding>input.max_ride_minutes*60){p.evaluation='constraint_rejected';p.reason='两段累计骑行超过上限';p.bike_seconds=riding;continue;}
   const active=access.reduce((s,a)=>s+a.seconds,0),park=mode==='cycling'?input.parking_minutes*60:0,dwell=input.dwell_minutes*60,ready=input.departure_ms+(active+park+dwell)*1000,when=G.queryTime(ready);
   let ts=await client.transit(mode==='cycling'?route.station.location:p.location,input.destination.location,when,input.origin.citycode,8);if(mode==='cycling')ts=ts.filter(t=>boardsAt(t,route.station));
   const t=ts[0];if(!t){p.evaluation='unknown';p.reason='未返回可确认的后续公共交通方案';continue;}
   const arrival=when.timestamp+t.seconds*1000,total=(arrival-input.departure_ms)/1000,extra=total-route.total_seconds;
   p.extra_seconds=extra;p.total_seconds=total;p.arrival=G.display(arrival);p.bike_seconds=riding;p.evidence_routes=access.map(a=>a.evidence).concat([t.evidence]);
   p.plan_preview={mode,station:route.station,access,transit:t,total_seconds:total,arrival:p.arrival,arrival_ms:arrival,bike_seconds:riding,parking_seconds:park,dwell_seconds:dwell,rounding_seconds:(when.timestamp-ready)/1000,unknowns:publicWarnings(p,mode==='cycling'),conditional:true};
   if(input.deadline_ms!==null&&arrival>input.deadline_ms){p.evaluation='constraint_rejected';p.reason='加入活动后预计超过到达期限';}
   else if(extra>opts.max_extra_minutes*60){p.evaluation='constraint_rejected';p.reason='全程增加耗时超过上限（含停留和班次影响）';}
   else{p.evaluation='conditional_candidate';p.reason='时间条件满足，商户及停车等条件待确认';}
  }catch(e){p.evaluation='unknown';p.reason=String(e.message);}
 }
 const eligible=rows.filter(p=>p.evaluation==='conditional_candidate'),ranking=Interest.rank(eligible,opts),scored=Interest.rank(rows.filter(p=>p.in_interest_area),opts);
 const scoreMap=new Map(scored.pois.map(p=>[p.id,p]));for(const p of rows)if(scoreMap.has(p.id)){const s=scoreMap.get(p.id);p.recommendation_score=s.recommendation_score;p.rating_component=s.rating_component;p.distance_component=s.distance_component;}
 for(const ranked of ranking.pois){const p=rows.find(p=>p.id===ranked.id);p.recommendation_score=ranked.recommendation_score;p.ranking_mode=ranking.mode;}
 const best=ranking.pois[0]??null,recommendation={best_id:best?.id??null,mode:ranking.mode,score:best?.recommendation_score??null,rating_weight:ranking.rating_weight,distance_weight:ranking.distance_weight,rated_count:ranking.rated_count,unrated_count:ranking.unrated_count,distance_basis:ranking.distance_basis,scope:'仅在本次兴趣区内已精算且通过时间条件的店铺中比较；营业、供应与价格仍待确认'};
 const priority={conditional_candidate:0,not_evaluated:1,unknown:2,constraint_rejected:3,direction_rejected:4};
 rows.sort((a,b)=>priority[a.evaluation]-priority[b.evaluation]||(b.recommendation_score??-Infinity)-(a.recommendation_score??-Infinity)||a.direction.distance_m-b.direction.distance_m);
 return {provider:opts.provider,options:opts,reference_route_id:route.id,target,centers,query_circles:circles,interest_area,recommendation,pois:rows,issues,coverage:{retrieved:rows.length,in_interest_area:screened.length,direction_passed:screened.length,evaluated:selected.length,outside_interest_area:rows.length-screened.length,query_pages_per_circle:2,spatial_query_circles:circles.length},limitations:['兴趣区是直线方向与可变张角的几何筛选，不是道路可达范围或等时圈。','最多3个包围检索圆各2页，接口返回不是兴趣区内全部商户；预算与失败仍会减少覆盖。','综合分默认评分60%与距离40%，评分按来源量表归一化；缺评分不伪造，全部缺评分时回退为距离优先。','距离分采用起点至店铺直线距离，不混用道路距离；道路和班次仍须精算。','星标仅比较已通过时间精算的有限候选，不保证营业、供应、价格或全局最优。','骑行精算固定当前上车站；点击加入行程会重新比较候选站点。'],api_calls:client.calls,records:client.records};
}
module.exports={validateInput,rankCandidates,planTrip,recommendMerchants,publicWarnings};
