'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const G=require('../lib/geo.cjs');
const {AmapClient,parseTransit,boardsAt,groupStations}=require('../lib/amap.cjs');
const {planTrip,recommendMerchants}=require('../lib/planner.cjs');
const {parseAuthorizedDataset}=require('../lib/merchants.cjs');
const O='118.9,32.1',D='118.8,32.05',ST='118.91,32.11',SHOP='118.905,32.105';
const input={origin:{name:'起点',location:O,citycode:'025'},destination:{name:'目的地',location:D,citycode:'025'},departure:'2026-10-19T08:00',bike_available:true,max_ride_minutes:15,parking_minutes:2,station_count:2,include_bus_only:false};
function pub(seconds,from='测试站',metro=true){return {cost:{duration:String(seconds)},walking_distance:'100',segments:[{walking:{steps:[{polyline:ST+';118.9101,32.1101'}]},bus:{buslines:[{name:metro?'地铁2号线':'70路',type:metro?'地铁线路':'普通公交线路',departure_stop:{name:from,location:ST},arrival_stop:{name:'终点站',location:D},polyline:ST+';'+D}]}}]};}
function fakeTransport({bikeSeconds=600,baseSeconds=3000,publicSeconds=1200,legSeconds=600,wrongStation=false,fail=false,shops=true}={}){const calls=[];return {calls,fetchFn:async url=>{const u=new URL(url),p=u.searchParams;calls.push({endpoint:u.pathname,params:Object.fromEntries([...p].filter(([k])=>k!=='key'))});if(fail)return new Response(JSON.stringify({status:'0',infocode:'10009',info:'USERKEY_PLAT_NOMATCH'}));let raw={status:'1',infocode:'10000'};
 if(u.pathname==='/v3/place/around')raw.pois=p.has('types')?[{id:'station1',name:'测试站(地铁站)',location:ST,type:'交通设施服务;地铁站',citycode:'025'}]:shops?[{id:'shop1',name:'早餐店',location:SHOP,address:'测试地址',biz_ext:{cost:'6'}}]:[];
 if(u.pathname.includes('bicycling'))raw.route={paths:[{distance:'2000',cost:{duration:String(p.get('origin')===O&&p.get('destination')===ST?bikeSeconds:legSeconds)},steps:[{polyline:p.get('origin')+';'+p.get('destination')}]}]};
 if(u.pathname.includes('walking'))raw.route={paths:[{distance:'500',cost:{duration:'600'},steps:[{polyline:p.get('origin')+';'+p.get('destination')}]}]};
 if(u.pathname.includes('transit/integrated'))raw.route={transits:[pub(p.get('origin')===O?baseSeconds:publicSeconds,wrongStation?'其他站':'测试站')]};
 return new Response(JSON.stringify(raw),{headers:{'Content-Type':'application/json'}});
 }};}
function client(fake){return new AmapClient({key:'test-key-not-real',fetchFn:fake.fetchFn,intervalMs:0});}
test('时间、坐标和方向规则拒绝无效值，并区分身后与顺路',()=>{
 assert.throws(()=>G.localDateTime('2026-02-30T08:00'));assert.throws(()=>G.coordinate('0,0'));assert.throws(()=>G.coordinate('118.9,'));
 assert.equal(G.direction(O,ST,'118.899,32.099').pass,false);assert.equal(G.direction(O,ST,SHOP).pass,true);
 assert.equal(G.direction(O,O,SHOP).pass,false);assert.equal(G.queryTime(G.localDateTime('2026-10-19T08:00')+1000).time,'08-01');
});
test('不同站口按站名归并，公交分组保留备选而非串行相加',()=>{
 assert.equal(groupStations([{id:'a',name:'测试站地铁站1号口',location:ST},{id:'b',name:'测试站(地铁站)',location:'118.912,32.112'}],O).length,1);
 const p=pub(1200);p.segments[0].bus.buslines.push({...p.segments[0].bus.buslines[0],name:'地铁备选'});const t=parseTransit(p,{record_id:1,provider_index:0},G.queryTime(G.localDateTime(input.departure)));
 assert.equal(t.groups.length,1);assert.equal(t.groups[0].alternatives.length,2);assert.equal(boardsAt(t,{name:'测试站地铁站1号口'}),true);assert.equal(t.seconds,1200);
 p.segments.push({taxi:{distance:'1000'}});assert.equal(parseTransit(p,{},{}),null);
});
test('有车偏好可以前置更慢的骑行候选，同时保留真正最快的普通公共交通',async()=>{
 const f=fakeTransport({baseSeconds:600}),c=client(f),r=await planTrip(c,input);assert.equal(r.candidates[0].mode,'cycling');const fastest=r.candidates.find(x=>x.id===r.fastest_id);assert.equal(fastest.mode,'walking');assert.ok(r.candidates[0].delta_to_fastest_seconds>0);assert.equal(r.candidates[0].conditional,true);assert.equal(r.candidates[0].total_seconds,1920);
 const q=f.calls.find(x=>x.endpoint.includes('transit')&&x.params.origin===ST&&x.params.time==='08-12');assert.ok(q);assert.equal(q.params.time,'08-12');assert.equal(r.candidates[0].parking_seconds,120);assert.equal(r.candidates[0].transit.seconds,1200);
});
test('没有自行车不查骑行；上限不足保留步行基线',async()=>{
 let f=fakeTransport(),r=await planTrip(client(f),{...input,bike_available:false});assert.ok(r.candidates.length>=2);assert.ok(r.candidates.every(c=>c.mode==='walking'));assert.ok(r.candidates.some(c=>c.candidate_source==='station_expansion'));assert.ok(!f.calls.some(x=>x.endpoint.includes('bicycling')));assert.ok(f.calls.some(x=>x.endpoint.includes('place/around')));
 f=fakeTransport();r=await planTrip(client(f),{...input,max_ride_minutes:5});assert.ok(r.candidates.every(x=>x.mode==='walking'));assert.ok(r.rejected.some(x=>/累计骑行/.test(x.reason)));
});
test('活动前后两段骑行必须累计；停车不在普通公共交通内重复计入',async()=>{
 const r=await planTrip(client(fakeTransport({legSeconds:600})),input,{via:{id:'s',name:'早餐店',location:SHOP}});
 assert.ok(r.candidates.every(x=>x.mode==='walking'));assert.equal(r.candidates[0].total_seconds,2400);assert.equal(r.candidates[0].parking_seconds,0);assert.ok(r.rejected.some(x=>x.ride_seconds===1200));
});
test('自行车必须接到所查询地铁站；不能拿其他首乘站替代',async()=>{
 const r=await planTrip(client(fakeTransport({wrongStation:true})),input);assert.ok(!r.candidates.some(x=>x.mode==='cycling'&&G.normStation(x.station.name)==='测试'));assert.ok(r.rejected.some(x=>G.normStation(x.station)==='测试'&&/未确认/.test(x.reason)));
});
test('硬到达期限被执行；失败记录不会被当成现实无解',async()=>{
 const r=await planTrip(client(fakeTransport()),{...input,latest_arrival:'2026-10-19T08:20'});assert.equal(r.candidates.length,0);assert.equal(r.status,'no_candidate_in_returned_set');
 const f=fakeTransport({fail:true}),broken=await planTrip(client(f),input);assert.equal(broken.status,'incomplete');assert.equal(broken.api_calls,1);assert.equal(broken.records[0].provider_code,'10009');assert.equal(broken.candidates.length,0);
});
test('接口预算与精确请求缓存不跨不同公交出发时间复用，记录不含Key',async()=>{
 const f=fakeTransport(),c=new AmapClient({key:'never-export-this-key',fetchFn:f.fetchFn,intervalMs:0,maxCalls:2});const t=G.queryTime(G.localDateTime(input.departure));await c.transit(O,D,t,'025');await c.transit(O,D,t,'025');assert.equal(c.calls,1);assert.equal(c.cacheHits,1);await c.transit(O,D,G.queryTime(t.timestamp+60000),'025');assert.equal(c.calls,2);await assert.rejects(()=>c.search('测试'),/预算/);assert.ok(!JSON.stringify(c.records).includes('never-export-this-key'));
});
test('沿途活动重算班次时刻，计入停车、停留与累计骑行，价格未知保持未知',async()=>{
 const f=fakeTransport({legSeconds:200}),p=await planTrip(client(f),input),route=p.candidates.find(x=>x.mode==='cycling');const rc=client(f),rec=await recommendMerchants(rc,p,route,{keyword:'早餐',max_extra_minutes:15});const shop=rec.pois[0];assert.equal(shop.evaluation,'conditional_candidate');assert.equal(shop.bike_seconds,400);assert.equal(shop.consumption_reference,6);assert.equal(shop.price_verified,false);assert.equal(shop.plan_preview.dwell_seconds,600);assert.equal(shop.plan_preview.parking_seconds,120);assert.equal(shop.plan_preview.transit.query_time.time,'08-19');assert.equal(shop.total_seconds,2340);
 const r2=await recommendMerchants(client(fakeTransport({legSeconds:600})),p,route,{keyword:'早餐'});assert.equal(r2.pois[0].evaluation,'constraint_rejected');assert.match(r2.pois[0].reason,/累计骑行/);
});
test('授权商户导入必须声明依据和GCJ-02，不将高德结果伪装成美团',()=>{
 const doc={provider:'meituan_authorized_export',crs:'GCJ-02',authorization_confirmed:true,authorization_reference:'测试用授权声明，不是真实数据',merchants:[{id:'1',name:'早餐店',location:SHOP,average_price:6}]};const d=parseAuthorizedDataset(doc);assert.equal(d.merchants[0].source,'meituan_authorized_export');assert.equal(d.merchants[0].price_verified,false);assert.throws(()=>parseAuthorizedDataset({...doc,authorization_confirmed:false}));assert.throws(()=>parseAuthorizedDataset({...doc,crs:'WGS84'}));assert.throws(()=>parseAuthorizedDataset({...doc,merchants:[{...doc.merchants[0],url:'https://evil.example/'}]}));
});
test('公交无耗时字段不擅自填零；同名不同城市与不可能日期拒绝',async()=>{
 const p=pub(1200);delete p.cost;assert.equal(parseTransit(p,{},{}),null);
 await assert.rejects(()=>planTrip(client(fakeTransport()),{...input,destination:{...input.destination,citycode:'010'}}),/同城/);
});
test('无编号的地铁出入口与主站归并，同时保留新街口的真实站名',()=>{
 assert.equal(G.normStation('尧化门地铁站出入口'),G.normStation('尧化门(地铁站)'));
 assert.equal(G.normStation('新街口'),'新街口');assert.equal(G.normStation('新街口地铁站14号口'),'新街口');
 const groups=groupStations([{id:'parent',name:'尧化门(地铁站)',location:ST},{id:'entry',parent:'parent',name:'尧化门地铁站出入口',location:SHOP}],O);
 assert.equal(groups.length,1);assert.equal(groups[0].access_points.length,2);
});
// Regression coordinates and times below are synthetic. They are NOT Nanjing route evidence.
function stationTransport(stations,{around=stations,search=stations,seconds=1000}={}){const calls=[];return {calls,fetchFn:async url=>{const u=new URL(url),p=u.searchParams;calls.push({path:u.pathname,origin:p.get('origin'),destination:p.get('destination')});let raw={status:'1',infocode:'10000'};
 if(u.pathname==='/v3/place/around')raw.pois=around;
 if(u.pathname==='/v3/place/text')raw.pois=search.filter(s=>G.normStation(p.get('keywords')).includes(G.normStation(s.name)));
 if(u.pathname.includes('bicycling')){const st=stations.find(s=>G.coordinate(s.location)===p.get('destination'));raw.route={paths:[{cost:{duration:String(st?.bike??600)},distance:String(st?.meters??1000),steps:[{polyline:p.get('origin')+';'+p.get('destination')}]}]};}
 if(u.pathname.includes('transit')){const st=stations.find(s=>G.coordinate(s.location)===p.get('origin'));raw.route={transits:[pub(st?seconds:4000,st?G.normStation(st.name):'普通公交起点',!!st)]};}
 return new Response(JSON.stringify(raw));
 }};}
test('第五个直线候选骑行更快：必须先测道路再选前四个全程比较站',async()=>{
 const stations=['候选甲','候选乙','候选丙','候选丁','学则路'].map((name,i)=>({id:'s'+i,name:name+'(地铁站)',location:(118.901+i*.001).toFixed(6)+','+(32.101+i*.001).toFixed(6),bike:i===4?200:1000-i*50,citycode:'025'}));
 const f=stationTransport(stations),r=await planTrip(client(f),{...input,station_count:4,max_ride_minutes:40});
 assert.equal(r.coverage.discovered_stations,5);assert.equal(r.coverage.access_screened,5);assert.equal(r.fastest_measured_access_station_key,'学则路');assert.equal(r.station_comparison.find(s=>s.station_key==='学则路').bike_seconds,200);assert.ok(r.stations.some(s=>s.station_key==='学则路'));
 const firstPublic=f.calls.findIndex(x=>x.path.includes('transit')&&x.origin!==O);assert.equal(f.calls.slice(0,firstPublic).filter(x=>x.path.includes('bicycling')).length,5);
});
test('较远站口可以骑行更快：比较两个入口后采用实际更快的路径',async()=>{
 const stations=[{id:'a',name:'测试站地铁站1号口',location:'118.901,32.101',bike:900},{id:'b',name:'测试站地铁站2号口',location:'118.905,32.105',bike:200}];
 const r=await planTrip(client(stationTransport(stations)),{...input,max_ride_minutes:40});const bike=r.candidates.find(c=>c.mode==='cycling');
 assert.equal(r.coverage.discovered_stations,1);assert.equal(bike.bike_seconds,200);assert.equal(bike.station.location,stations[1].location);assert.match(bike.station.access_point_name,/2号口/);
});
test('用户指定站未出现在周边结果时单独检索保留，不把未查站判为不可行',async()=>{
 const stations=[{id:'a',name:'候选甲(地铁站)',location:'118.901,32.101',bike:300,citycode:'025'},{id:'b',name:'学则路(地铁站)',location:'118.905,32.105',bike:900,citycode:'025'}];
 const r=await planTrip(client(stationTransport(stations,{around:stations.slice(0,1)})),{...input,station_count:2,max_ride_minutes:40,station_keywords:'学则路'});
 const row=r.station_comparison.find(s=>s.station_key==='学则路');assert.equal(row.required,true);assert.equal(row.access_status,'measured');assert.equal(row.transit_status,'queried');assert.ok(r.stations.some(s=>s.station_key==='学则路'));
});
module.exports={fakeTransport,input,SHOP};
