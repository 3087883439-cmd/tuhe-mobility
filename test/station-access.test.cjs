'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {AmapClient}=require('../lib/amap.cjs'),{planTrip}=require('../lib/planner.cjs'),G=require('../lib/geo.cjs'),MapView=require('../public/route-map.js');
// All locations and durations here are synthetic regression fixtures, not measured Nanjing trips.
const O='118.9,32.1',O2='118.92,32.12',D='118.85,32.05',SHOP='118.902,32.102';
const point=(name,location)=>({name,location,citycode:'025'});
const base={origin:point('测试起点',O),destination:point('测试终点',D),departure:'2026-10-20T08:00',bike_available:false,station_count:8};
const st=(name,location,walk=600,ride=300,transit=1200)=>({id:name,name:name+'(地铁站)',location,citycode:'025',walk,ride,transit});
function harness(stations,{around=stations,byOrigin=null,walkFail=false,wrongBoard=false,viaWalk=125,shopToStation=185,budget=40}={}){
 const calls=[];
 const fetchFn=async url=>{const u=new URL(url),p=u.searchParams,origin=p.get('origin'),dest=p.get('destination');calls.push({path:u.pathname,...Object.fromEntries([...p].filter(([k])=>k!=='key'))});let raw={status:'1',infocode:'10000'};
  if(u.pathname==='/v3/place/around')raw.pois=Object.entries(byOrigin??{}).find(([k])=>G.coordinate(k)===p.get('location'))?.[1]??around;
  else if(u.pathname==='/v3/place/text')raw.pois=stations.filter(s=>G.normStation(s.name)===G.normStation(p.get('keywords')));
  else if(u.pathname.includes('/direction/walking')||u.pathname.includes('/direction/bicycling')){
   const target=stations.find(s=>G.coordinate(s.location)===dest),walk=u.pathname.includes('/walking'),seconds=dest===SHOP?viaWalk:origin===SHOP&&walk?shopToStation:target?.[walk?'walk':'ride']??600;
   raw.route={paths:walkFail&&walk&&dest!==SHOP?[]:[{distance:'1000',cost:{duration:String(seconds)},steps:[{polyline:origin+';'+dest}]}]};
  }else if(u.pathname.includes('/transit/integrated')){
   const station=stations.find(s=>G.coordinate(s.location)===origin),far=stations.find(s=>G.normStation(s.name)==='金马路')??stations.at(-1),selected=station&&!wrongBoard?station:far;
   const from=origin,to=selected.location,line={id:'synthetic-line',name:'地铁测试线',type:'地铁线路',departure_stop:{name:G.normStation(selected.name),location:to},arrival_stop:{name:'终点站',location:D},polyline:to+';'+D};
   raw.route={transits:[{cost:{duration:String(station?station.transit:5400)},segments:[{walking:{origin:from,destination:to,steps:from===to?[]:[{polyline:from+';'+to}]},bus:{buslines:[line]}}]}]};
  }
  return new Response(JSON.stringify(raw));
 };
 return {calls,client:new AmapClient({key:'synthetic-not-a-real-key',fetchFn,intervalMs:0,maxCalls:budget})};
}
test('基线只返回金马路时，仍独立发现学则路步行地铁并按全程排名',async()=>{
 const stations=[st('学则路','118.905,32.105',900,300,1500),st('金马路','118.93,32.13',3600,1200,1800)],h=harness(stations),p=await planTrip(h.client,base);
 const candidate=p.candidates.find(c=>c.station?.station_key==='学则路'&&c.mode==='walking');assert.ok(candidate);assert.equal(candidate.total_seconds,2400);assert.equal(candidate.route_kind,'walk_metro');assert.equal(candidate.parking_seconds,0);assert.equal(p.fastest_id,candidate.id);
 assert.equal(candidate.transit.query_time.time,'08-15');assert.ok(h.calls.some(c=>c.path.includes('/walking')&&c.destination===stations[0].location));assert.equal(MapView.build(candidate,base.origin,base.destination).complete,true);
 const row=p.station_comparison.find(s=>s.station_key==='学则路');assert.equal(row.walking.transit_status,'queried');assert.equal(row.walking.best_total_seconds,2400);assert.ok(!h.calls.some(c=>c.path.includes('bicycling')));
});
test('更换起点和全部站名仍会发现新的步行候选，不依赖学则路特例',async()=>{
 const stations=[st('第一近站','118.901,32.101'),st('第二近站','118.921,32.121'),st('远站','118.94,32.14',3000,1200,1800)];
 for(const [location,name] of [[O,'第一近站'],[O2,'第二近站']]){
  const h=harness(stations,{byOrigin:{[O]:stations.filter(s=>s.id!=='第二近站'),[O2]:stations.filter(s=>s.id!=='第一近站')}}),p=await planTrip(h.client,{...base,origin:point('变更起点',location)});
  const c=p.candidates.find(c=>c.station?.station_key===G.normStation(name));assert.ok(c);assert.equal(c.access[0].from,G.coordinate(location));assert.equal(p.fastest_id,c.id);assert.ok(h.calls.some(c=>c.path==='/v3/place/around'&&c.location===G.coordinate(location)));
 }
});
test('无自行车时，周边检索外的指定站也优先补查步行与后续地铁',async()=>{
 const stations=Array.from({length:14},(_,i)=>st('附近'+i,(118.901+i*.001).toFixed(6)+','+(32.101+i*.001).toFixed(6))),specified=st('指定站','118.95,32.15',800);stations.push(specified);
 const h=harness(stations,{around:stations.slice(0,14)}),p=await planTrip(h.client,{...base,station_count:1,station_keywords:'指定站'}),row=p.station_comparison.find(s=>s.station_key===G.normStation('指定站'));
 assert.equal(row.required,true);assert.equal(row.walking.transit_status,'queried');assert.ok(p.candidates.some(c=>c.station?.station_key===G.normStation('指定站')));assert.equal(p.coverage.walking_full_queried,1);assert.ok(p.station_comparison.some(s=>s.walking.transit_status==='not_queried'));
});
test('40次预算内两种接驳均留有后续查询，未测入口保持未知',async()=>{
 const stations=Array.from({length:12},(_,i)=>[st('候选'+i,(118.901+i*.001).toFixed(6)+',32.101',600+i,300+i),st('候选'+i+'地铁站2号口',(118.901+i*.001).toFixed(6)+',32.102',500+i,200+i)]).flat();
 // Give the second entrance a matching normalized station name.
 stations.forEach((s,i)=>{if(i%2)s.name='候选'+Math.floor(i/2)+'地铁站2号口';});
 const h=harness(stations),p=await planTrip(h.client,{...base,bike_available:true});assert.ok(p.api_calls<=40);assert.ok(p.coverage.walking_full_queried>0);assert.ok(p.coverage.cycling_full_queried>0);assert.equal(p.coverage.budget_limited,true);assert.ok(p.station_comparison.some(s=>s.walking.access_points_measured<2||s.cycling.access_points_measured<2));assert.ok(p.issues.some(i=>i.code==='COVERAGE_LIMIT'));
});
test('步行到站后接口改从别站上车，不能冒充该站步行地铁方案',async()=>{
 const stations=[st('近站','118.905,32.105'),st('远站','118.93,32.13')],h=harness(stations,{wrongBoard:true}),p=await planTrip(h.client,base),row=p.station_comparison.find(s=>s.station_key===G.normStation('近站'));
 assert.ok(!p.candidates.some(c=>c.station?.station_key===G.normStation('近站')));assert.equal(row.walking.transit_status,'unconfirmed');assert.match(row.walking.reason,/不代表现实无路/);
});
test('步行缺路径时保留基线，不能把该站标为已完整比较或现实不可达',async()=>{
 const h=harness([st('近站','118.905,32.105'),st('远站','118.93,32.13')],{walkFail:true}),p=await planTrip(h.client,base);
 assert.ok(p.candidates.some(c=>!c.station));assert.ok(p.station_comparison.every(s=>s.walking.access_status==='unknown'));assert.ok(p.station_comparison.every(s=>s.walking.transit_status==='not_queried'));assert.ok(!p.candidates.some(c=>c.candidate_source==='station_expansion'));
});
test('早餐后步行到站采用累积时间重新查车，停留与取整等待仅加一次',async()=>{
 const h=harness([st('近站','118.905,32.105')]),p=await planTrip(h.client,{...base,dwell_minutes:10},{via:{id:'shop',name:'测试早餐店',location:SHOP}}),c=p.candidates.find(c=>c.candidate_source==='station_expansion');
 assert.ok(c);assert.equal(c.access.length,2);assert.equal(c.access_seconds,310);assert.equal(c.dwell_seconds,600);assert.equal(c.rounding_seconds,50);assert.equal(c.transit.query_time.time,'08-16');assert.equal(c.total_seconds,2160);assert.equal(c.parking_seconds,0);assert.ok(h.calls.some(c=>c.path==='/v3/place/around'&&c.location===G.coordinate(SHOP)));
});
test('步行和骑行分别择入口，不能拿骑行最快入口代替步行最快入口',async()=>{
 const a=st('测试站','118.901,32.101',900,100),b=st('测试站','118.905,32.105',100,900);a.name='测试站地铁站1号口';b.name='测试站地铁站2号口';
 const p=await planTrip(harness([a,b]).client,{...base,bike_available:true,max_ride_minutes:40}),w=p.candidates.find(c=>c.station?.station_key===G.normStation('测试站')&&c.mode==='walking'),r=p.candidates.find(c=>c.mode==='cycling');
 assert.equal(w.station.location,G.coordinate(b.location));assert.equal(r.station.location,G.coordinate(a.location));assert.equal(w.access_seconds,100);assert.equal(r.bike_seconds,100);
});
test('接驳更近不直接当作全程更优，两站后续地铁均实算',async()=>{
 const h=harness([st('近站','118.901,32.101',300,100,3000),st('远站','118.905,32.105',900,300,600)]),p=await planTrip(h.client,base),best=p.candidates.find(c=>c.id===p.fastest_id);
 assert.equal(best.station.station_key,G.normStation('远站'));assert.equal(best.total_seconds,1500);assert.equal(p.fastest_measured_walking_station_key,G.normStation('近站'));
});
