'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const Area=require('../public/interest-area.js'),InterestMap=require('../public/interest-map.js'),RouteMap=require('../public/route-map.js'),G=require('../lib/geo.cjs'),{AmapClient,normalizePoi}=require('../lib/amap.cjs'),{parseAuthorizedDataset}=require('../lib/merchants.cjs'),{recommendMerchants}=require('../lib/planner.cjs');
// Synthetic geometry and business data only. Not evidence about real stores or actual ratings.
const O=[118.9,32.1],T=Area.unproject(O,[4000,0]),D=Area.unproject(O,[20000,0]),area=Area.create(O,T,{radius:3000});
const locate=(x,y)=>Area.unproject(O,[x,y]).map(n=>+n.toFixed(6)).join(',');
const shop=(id,x,y,rating=null,more={})=>({id,name:id,location:locate(x,y),rating,rating_max:5,source:'amap',...more});
const directed=p=>({...p,direction:Area.inspect(area,p.location),in_interest_area:Area.inspect(area,p.location).pass});
const input={origin:{name:'测试起点',location:O.join(','),citycode:'025'},destination:{name:'测试终点',location:D.join(','),citycode:'025'},departure:'2026-10-20T08:00',departure_ms:G.localDateTime('2026-10-20T08:00'),deadline_ms:null,bike_available:true,max_ride_minutes:30,parking_minutes:2,dwell_minutes:10};
const station={name:'测试站(地铁站)',station_key:'测试',location:T.join(',')};
function route(){return {id:'R1',mode:'cycling',station,access:[],transit:{first_stop:{from_location:T.join(',')},groups:[],sections:[]},total_seconds:3000};}
function mockSdk(){const active=new Set(),fits=[],removed=[];class Overlay{constructor(options){this.options=options;this.kind=this.constructor.name;this.handlers={};}on(event,fn){this.handlers[event]=fn;}}
 return {active,fits,removed,sdk:{Polygon:class Polygon extends Overlay{},Polyline:class Polyline extends Overlay{},Marker:class Marker extends Overlay{}},map:{add(o){active.add(o);},remove(items){for(const o of items){removed.push(o);active.delete(o);}},setFitView(items,...args){fits.push({items,args});}}};
}
function merchantClient(pois,{unavailable=new Set()}={}){const calls=[];return {calls,client:new AmapClient({key:'synthetic-key-not-real',intervalMs:0,fetchFn:async url=>{const u=new URL(url),p=u.searchParams;calls.push({endpoint:u.pathname,params:Object.fromEntries([...p].filter(([k])=>k!=='key'))});let raw={status:'1',infocode:'10000'};
 if(u.pathname==='/v3/place/around')raw.pois=pois.map(p=>({...p,biz_ext:{rating:p.rating===null?[]:String(p.rating)}}));
 else if(u.pathname.includes('bicycling')||u.pathname.includes('walking')){const bad=unavailable.has(p.get('destination'));raw.route={paths:bad?[]:[{cost:{duration:'200'},distance:'700',steps:[{polyline:p.get('origin')+';'+p.get('destination')}]}]};}
 else if(u.pathname.includes('transit'))raw.route={transits:[{cost:{duration:'1200'},segments:[{bus:{buslines:[{name:'地铁测试线',type:'地铁线路',departure_stop:{name:'测试站',location:T.join(',')},arrival_stop:{name:'目的站',location:D.join(',')},polyline:T.join(',')+';'+D.join(',')}]}}]}]};
 return new Response(JSON.stringify(raw));}})};}
test('可变兴趣区按距离收窄张角，排除身后、越界及超过方向目标的点',()=>{
 assert.equal(Area.threshold(500,[45,30,25]),45);assert.equal(Area.threshold(1500,[45,30,25]),37.5);assert.equal(Area.threshold(2500,[45,30,25]),27.5);
 assert.equal(Area.inspect(area,locate(600,300)).pass,true);assert.equal(Area.inspect(area,locate(-100,0)).reason,'位于身后');assert.equal(Area.inspect(area,locate(3001,0)).reason,'超过兴趣区最远距离');assert.equal(Area.inspect(area,locate(1000,1000)).pass,false);
 const short=Area.create(O,locate(700,0),{radius:3000});assert.ok(short.polygon.every(p=>Area.project(O,p)[0]<=700.01));assert.equal(Area.inspect(short,locate(800,0)).reason,'超出本段方向目标');
});
test('兴趣区旋转和缩放生效，几何与筛选共享同一规则，重合目标不生成假区域',()=>{
 const north=Area.create(O,locate(0,4000),{radius:1000,angles:[30,25,20]});assert.equal(Area.inspect(north,locate(100,700)).pass,true);assert.equal(Area.inspect(north,locate(700,100)).pass,false);assert.ok(north.polygon.length>20);assert.equal(Area.create(O,O),null);assert.throws(()=>Area.create(O,T,{radius:90000}));
 for(const p of north.polygon){const r=Area.inspect(north,p);assert.ok(r.distance_m<1000.1);assert.ok(r.angle<=r.threshold+.1);}
});
test('每个检索圆覆盖显示的兴趣区，最多三圆，查询范围与高亮范围分开标明',()=>{
 const circles=Area.queryCircles(area);assert.ok(circles.length<=3);for(const c of circles)for(const p of area.polygon)assert.ok(Math.hypot(...Area.project(c.location,p))<=c.radius+.1);
});
test('评分与距离权重改变推荐次序，评分量表归一化且缺评分保留未知',()=>{
 const near=directed(shop('近店',300,0,3)),rated=directed(shop('高分店',600,0,5)),missing=directed(shop('无评分',100,0));
 assert.equal(Area.rank([near,rated,missing],{radius:3000,rating_weight:.6}).pois[0].id,'高分店');assert.equal(Area.rank([near,rated,missing],{radius:3000,rating_weight:0}).pois[0].id,'无评分');
 const rank=Area.rank([near,missing]);assert.equal(rank.pois.find(p=>p.id==='无评分').recommendation_score,null);assert.equal(Area.rating({...rated,rating:9,rating_max:10}),.9);assert.equal(Area.rating({...rated,rating:9,rating_max:5}),null);
});
test('全部缺评分时距离回退有明确模式，不给未知店铺伪造评分',()=>{
 const a=directed(shop('远店',600,0)),b=directed(shop('近店',300,0)),r=Area.rank([a,b]);assert.equal(r.mode,'distance_fallback');assert.equal(r.rating_weight,0);assert.equal(r.pois[0].id,'近店');assert.equal(r.pois[0].rating,null);
});
test('高德评分空值和异常量表保持未知，美团导入声明量表并拒绝越界值',()=>{
 assert.equal(normalizePoi({location:O.join(','),biz_ext:{rating:'4.8'}},'mock').rating,4.8);for(const value of [[],null,'','9','0','NaN'])assert.equal(normalizePoi({location:O.join(','),biz_ext:{rating:value}},'mock').rating,null);
 const doc={provider:'meituan_authorized_export',crs:'GCJ-02',authorization_confirmed:true,authorization_reference:'仅为测试声明',rating_max:10,merchants:[{id:'1',name:'模拟商户',location:locate(300,0),rating:9}]};assert.equal(parseAuthorizedDataset(doc).merchants[0].rating_max,10);assert.throws(()=>parseAuthorizedDataset({...doc,rating_max:5}),/评分/);assert.throws(()=>parseAuthorizedDataset({...doc,rating_max:'bad'}),/评分/);
});
test('真实推荐流程按综合排序精算，仅星标通过时间条件的店铺，区外不推荐',async()=>{
 const near=shop('近店',300,0,3),high=shop('高分店',600,0,5),outside=shop('后方店',-100,0,5),h=merchantClient([near,high,outside]),r=await recommendMerchants(h.client,{input,via:null},route(),{max_evaluations:2,rating_weight:.6,radius:3000});
 assert.equal(r.recommendation.best_id,'高分店');assert.equal(r.recommendation.mode,'weighted');assert.equal(r.coverage.in_interest_area,2);assert.equal(r.coverage.outside_interest_area,1);assert.equal(r.pois.find(p=>p.id==='后方店').in_interest_area,false);assert.equal(r.pois.find(p=>p.id==='高分店').evaluation,'conditional_candidate');assert.equal(h.calls.filter(c=>c.endpoint==='/v3/place/around').length,6);
 const firstAccess=h.calls.find(c=>c.endpoint.includes('bicycling'));assert.equal(firstAccess.params.destination,high.location);assert.ok(r.interest_area.polygon.length>20);assert.ok(!JSON.stringify(r).includes('synthetic-key-not-real'));
});
test('评分最高但道路缺证据的店铺不标星，无评分可行店回退距离推荐',async()=>{
 const high=shop('高分但缺路',600,0,5),unknown=shop('无评分可行',300,0),h=merchantClient([high,unknown],{unavailable:new Set([high.location])}),r=await recommendMerchants(h.client,{input,via:null},route(),{max_evaluations:2});
 assert.equal(r.pois.find(p=>p.id===high.id).evaluation,'unknown');assert.equal(r.recommendation.best_id,unknown.id);assert.equal(r.recommendation.mode,'distance_fallback');assert.equal(r.pois.find(p=>p.id===unknown.id).ranking_mode,'distance_fallback');
});
test('无满足行程时间的店铺不标最推荐，不把最高评分变成可行性证据',async()=>{
 const h=merchantClient([shop('高分店',600,0,5)]),r=await recommendMerchants(h.client,{input:{...input,deadline_ms:input.departure_ms+1000},via:null},route(),{});assert.equal(r.recommendation.best_id,null);assert.equal(r.pois[0].evaluation,'constraint_rejected');
});
test('地图显示全部区内商户点及唯一星标，缩放只看兴趣区并清除旧点旧区域',()=>{
 const x=mockSdk(),pois=[directed(shop('推荐',300,0,5,{evaluation:'conditional_candidate'})),directed(shop('未精算',600,0,4)),directed(shop('时间不符',800,0,4,{evaluation:'constraint_rejected'})),directed(shop('区外',-100,0,5))];let selected=null;
 const first=InterestMap.render(x.sdk,x.map,area,pois,[],{bestId:'推荐',onSelect:id=>{selected=id;}});assert.equal(first.filter(o=>o.kind==='Polygon').length,1);assert.equal(first.filter(o=>o.kind==='Marker').length,3);assert.equal(first.filter(o=>o.options.content?.includes('shop-star')).length,1);assert.equal(x.fits.at(-1).items.length,1);assert.equal(x.fits.at(-1).items[0].kind,'Polygon');first.find(o=>o.options.title?.startsWith('推荐')).handlers.click();assert.equal(selected,'推荐');
 const second=InterestMap.render(x.sdk,x.map,area,[],first);assert.ok(first.every(o=>x.removed.includes(o)&&!x.active.has(o)));assert.equal(second.length,1);
});
test('页面真实范围输入处理只预览不联网，商户显示后重复绘图仍保持兴趣区缩放',async()=>{
 const elements=new Map(),x=mockSdk();function el(id){if(!elements.has(id))elements.set(id,{id,value:({radius:'3000','aoi-range':'3000',a1:'45',a2:'30',a3:'25','rating-weight':'60','route-type':'all'})[id]??'',dataset:{},hidden:false,disabled:false,innerHTML:'',textContent:'',listeners:{},addEventListener(event,fn){this.listeners[event]=fn;},querySelectorAll(){return [];}});return elements.get(id);}
 const context=vm.createContext({document:{getElementById:el,querySelectorAll:()=>[],addEventListener(){}},AMap:x.sdk,TuheRouteMap:RouteMap,TuheInterestArea:Area,TuheInterestMap:InterestMap,setTimeout,clearTimeout,console});let apiCalls=0;context.bootstrap=async()=>{apiCalls++;return {web_service_ready:true,map_ready:false,merchant_sources:[]};};
 const source=fs.readFileSync(require.resolve('../public/app.js'),'utf8').replace('init().catch(showError);','');vm.runInContext(source,context);await vm.runInContext('api=bootstrap;init();',context);
 context.testMap=x.map;context.testPlan={input,via:null,candidates:[route()]};vm.runInContext('S.map=testMap;S.mapLoaded=true;S.plan=testPlan;S.selected="R1";',context);const before=apiCalls;
 el('aoi-range').value='1500';el('aoi-range').listeners.input();assert.equal(el('radius').value,'1500');assert.equal(apiCalls,before);assert.equal(vm.runInContext('S.mapView',context),'interest');assert.equal(x.fits.at(-1).items[0].kind,'Polygon');
 context.result={interest_area:Area.create(O,T,{radius:1500}),pois:[directed(shop('推荐',300,0,5,{evaluation:'conditional_candidate'})),directed(shop('未精算',600,0))],recommendation:{best_id:'推荐'},coverage:{in_interest_area:2}};vm.runInContext('S.recs=result;drawMap();drawMap();',context);assert.equal(x.fits.at(-1).items.length,1);assert.equal(x.fits.at(-1).items[0].kind,'Polygon');assert.equal([...x.active].filter(o=>o.kind==='Marker'&&o.options.content).length,2);assert.match(el('interest-status').textContent,/区内店铺 2 家/);vm.runInContext('setBusy(true);drawMap();setBusy(false);',context);assert.equal(el('fit-interest').disabled,false);
});
