'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const G=require('../lib/geo.cjs'),{AmapClient,parseTransit}=require('../lib/amap.cjs'),{planTrip}=require('../lib/planner.cjs'),{completeGeometry,clipLine}=require('../lib/route-geometry.cjs'),MapView=require('../public/route-map.js');
// All test coordinates and times are synthetic, not observed Nanjing journeys.
const O=[118.9,32.1],P=[118.91,32.1],Q=[118.92,32.1],D=[118.93,32.1];
const input={origin:{name:'测试起点',location:O.join(','),citycode:'025'},destination:{name:'测试目的地',location:D.join(','),citycode:'025'},departure:'2026-10-19T08:00',departure_ms:G.localDateTime('2026-10-19T08:00'),bike_available:false};
const section=(kind,a,b,more={})=>({kind,title:kind,from_location:a.join(','),to_location:b.join(','),paths:[[a,b]],...more});
function route(id='M',kind='metro'){
 const line={name:kind==='metro'?'地铁测试线':'测试公交',type:kind==='metro'?'地铁线路':'普通公交',from:'甲',to:'乙',from_location:P.join(','),to_location:Q.join(',')};
 return {id,mode:'walking',route_kind:kind==='metro'?'walk_metro':'walk_bus',label:kind==='metro'?'步行到地铁站 · 地铁':'步行到公交站 · 公交',access:[],station:null,total_seconds:3600,arrival:'2026-10-19 09:00:00',arrival_ms:input.departure_ms+3600000,delta_to_fastest_seconds:0,parking_seconds:0,dwell_seconds:0,rounding_seconds:0,bike_seconds:0,unknowns:[],transit:{seconds:3600,first_stop:line,query_time:{date:'2026-10-19',time:'08-00'},groups:[{selected:line,alternatives:[line]}],sections:[section('walking',O,P),section(kind,P,Q,{title:line.name,from_name:'甲',to_name:'乙',line_id:'line1',from_id:'stop1',to_id:'stop2'}),section('walking',Q,D)]}};
}
function sdkMock(){const active=new Set(),removed=[],fits=[];return {active,removed,fits,sdk:{Polyline:class{constructor(options){this.kind='polyline';this.options=options;}},Marker:class{constructor(options){this.kind='marker';this.options=options;}}},map:{add(o){active.add(o);},remove(items){items.forEach(o=>{removed.push(o);active.delete(o);});},setFitView(items,...args){fits.push({items,args});}}};}
test('坐标解析兼容分号与连续逗号；无效点打断路径，不跨缺口连直线',()=>{
 assert.equal(G.decodePolyline('118.9,32.1;118.91,32.1').length,1);assert.equal(G.decodePolyline('118.9,32.1,118.91,32.1')[0].length,2);
 const paths=G.decodePolyline('118.9,32.1;118.91,32.1;bad;118.92,32.1;118.93,32.1');assert.equal(paths.length,2);assert.equal(paths[0].length,2);assert.equal(paths[1].length,2);assert.deepEqual(G.decodePolyline('118.9,32.1,118.91'),[]);
});
test('公共交通解析保留首段步行、公交、换乘步行、地铁与末段步行的顺序',()=>{
 const stop=(name,loc)=>({name,location:loc.join(',')}),walk=(a,b)=>({origin:a.join(','),destination:b.join(','),distance:'100',steps:[{polyline:a.join(',')+';'+b.join(',')}]}),V=[118.915,32.1],W=[118.917,32.1];
 const raw={cost:{duration:'3600'},segments:[{walking:walk(O,P),bus:{buslines:[{id:'b',name:'测试公交',type:'普通公交',departure_stop:stop('公交甲',P),arrival_stop:stop('公交乙',V),polyline:P.join(',')+';'+V.join(',')}] }},{walking:walk(V,W),bus:[{id:'m',name:'地铁测试线',type:'地铁线路',departure_stop:stop('地铁甲',W),arrival_stop:stop('地铁乙',Q),polyline:W.join(',')+','+Q.join(',')}]},{walking:walk(Q,D)}]};
 const t=parseTransit(raw,{record_id:'test'},G.queryTime(input.departure_ms),{origin:input.origin.location,destination:input.destination.location});assert.deepEqual(t.sections.map(s=>s.kind),['walking','bus','walking','metro','walking']);assert.ok(t.sections.every(s=>s.paths.length));assert.equal(t.metro_only,false);
 const model=MapView.build({...route(),transit:t},input.origin,input.destination);assert.equal(model.complete,true);assert.equal(model.sections.length,5);
});
test('独立地铁优先查询生成步行地铁选项，公交没有被改名为纯地铁',async()=>{
 const calls=[];const client=new AmapClient({key:'synthetic-test-key',intervalMs:0,fetchFn:async url=>{const u=new URL(url);calls.push(u.searchParams.get('strategy'));const metro=u.searchParams.get('strategy')==='7';return new Response(JSON.stringify({status:'1',route:{transits:[{cost:{duration:metro?'3000':'2000'},segments:[{bus:{buslines:[{name:metro?'地铁测试线':'测试公交',type:metro?'地铁线路':'普通公交',departure_stop:{name:'甲',location:P.join(',')},arrival_stop:{name:'乙',location:Q.join(',')},polyline:P.join(',')+';'+Q.join(',')}]}}]}]}}));}});
 const r=await planTrip(client,input);assert.ok(calls.includes('7'));assert.ok(r.candidates.some(c=>c.route_kind==='walk_metro'));assert.ok(r.candidates.some(c=>c.route_kind==='walk_bus'));assert.ok(r.candidates.filter(c=>c.route_kind==='walk_metro').every(c=>c.transit.groups.every(g=>g.selected.type==='地铁线路')));
});
test('整条路线逐段高亮，地铁与公交不同色，切换清除旧方案并只缩放到所选路线',()=>{
 const x=sdkMock(),metro=MapView.build(route(),input.origin,input.destination);let overlays=MapView.render(x.sdk,x.map,metro);assert.equal(overlays.filter(o=>o.kind==='polyline').length,6);
 assert.ok(overlays.some(o=>o.options.strokeColor===MapView.colors.walking));assert.ok(overlays.some(o=>o.options.strokeColor===MapView.colors.metro));assert.ok(overlays.filter(o=>o.kind==='polyline').every(o=>o.options.strokeWeight>=9));
 const old=[...overlays];overlays=MapView.render(x.sdk,x.map,MapView.build(route('B','bus'),input.origin,input.destination),overlays);assert.ok(old.every(o=>x.removed.includes(o)&&!x.active.has(o)));assert.ok(overlays.some(o=>o.options.strokeColor===MapView.colors.bus));assert.ok(!overlays.some(o=>o.options.strokeColor===MapView.colors.metro));assert.ok(x.fits.at(-1).items.every(o=>overlays.includes(o)));
});
test('缺失地铁坐标时不绘制站点间直线，已知的首末步行仍高亮',()=>{
 const r=route();r.transit.sections[1].paths=[];const m=MapView.build(r,input.origin,input.destination),x=sdkMock(),o=MapView.render(x.sdk,x.map,m);
 assert.equal(m.complete,false);assert.equal(m.missing.length,1);assert.equal(m.missing[0].kind,'metro');assert.ok(!o.some(o=>o.options.strokeColor===MapView.colors.metro));assert.equal(o.filter(o=>o.options.strokeColor===MapView.colors.walking).length,2);
});
test('公交线只截取上下车站之间的坐标，不画整条公交线、不反向拼接',()=>{
 const r=route(),s=r.transit.sections[1],line={id:'line1',polyline:[O,P,Q,D].map(p=>p.join(',')).join(';'),busstops:[{id:'stop0',name:'起',location:O.join(',')},{id:'stop1',name:'甲',location:P.join(',')},{id:'stop2',name:'乙',location:Q.join(',')},{id:'stop3',name:'终',location:D.join(',')}]};
 const p=clipLine(line,s);assert.deepEqual(p[0][0],P);assert.deepEqual(p[0].at(-1),Q);assert.ok(!p[0].some(a=>a[0]===O[0]||a[0]===D[0]));assert.equal(clipLine(line,{...s,from_id:'stop2',to_id:'stop1'}),null);
});
test('补查首末步行和地铁线路后形成完整几何，总耗时保持原公交估计不重复加算',async()=>{
 const r=route();r.transit.sections.forEach(s=>s.paths=[]);const calls=[];
 const client=new AmapClient({key:'synthetic-test-key',intervalMs:0,maxCalls:8,fetchFn:async url=>{const u=new URL(url),p=u.searchParams;calls.push(u.pathname);const data=u.pathname==='/v3/bus/lineid'?{buslines:[{id:'line1',polyline:[O,P,Q,D].map(p=>p.join(',')).join(';'),busstops:[{id:'stop1',name:'甲',location:P.join(',')},{id:'stop2',name:'乙',location:Q.join(',')}]}]}:{route:{paths:[{distance:'100',cost:{duration:'1234'},steps:[{polyline:p.get('origin')+';'+p.get('destination')}]}]}};return new Response(JSON.stringify({status:'1',...data}));}});
 const result=await completeGeometry(client,r,input);assert.equal(result.api_calls,3);assert.equal(result.route.geometry_status.complete,true);assert.equal(result.route.total_seconds,3600);assert.equal(result.route.transit.seconds,3600);assert.deepEqual(result.route.transit.paths.map(s=>s.mode),['walking','metro','walking']);assert.ok(calls.includes('/v3/bus/lineid'));assert.ok(r.transit.sections.every(s=>!s.paths.length));
});
test('实际页面选择事件切换地铁与公交方案，地图覆盖物随所选方案更新',()=>{
 const elements=new Map();function el(id){if(!elements.has(id))elements.set(id,{id,value:id==='route-type'?'all':'',checked:false,disabled:false,hidden:false,innerHTML:'',textContent:'',dataset:{},querySelectorAll(){return [...this.innerHTML.matchAll(/data-route="([^"]+)"/g)].map(m=>({dataset:{route:m[1]}}));}});return elements.get(id);}
 const x=sdkMock(),context=vm.createContext({document:{getElementById:el,querySelectorAll:()=>[]},AMap:x.sdk,TuheRouteMap:MapView,TuheInterestArea:require('../public/interest-area.js'),TuheInterestMap:require('../public/interest-map.js'),console,setTimeout,clearTimeout});
 const source=fs.readFileSync(require.resolve('../public/app.js'),'utf8').replace('init().catch(showError);','');vm.runInContext(source,context);
 const r1=route(),r2=route('B','bus');context.testPlan={input,candidates:[r1,r2],issues:[],stations:[],station_comparison:[{name:'测试站',station_key:'测试',walking:{access_seconds:600,access_distance_m:800,best_total_seconds:1800,reason:'已比较步行与后续地铁全程'},cycling:{access_status:'not_queried',reason:'未选择自行车'}}],rejected:[],fastest_id:'M',api_calls:0};context.testMap=x.map;
 vm.runInContext('S.map=testMap;S.mapLoaded=true;S.planJob="test-job";applyPlan(testPlan);',context);assert.ok([...x.active].some(o=>o.options.strokeColor===MapView.colors.metro));
 // Save actual handlers attached by renderRoutes instead of reimplementing its selection logic.
 const list=el('route-list');list.querySelectorAll=function(){if(this.buttons)return this.buttons;return [];};list.buttons=[{dataset:{route:'M'}},{dataset:{route:'B'}}];vm.runInContext('renderRoutes();',context);list.buttons[1].onclick();
 assert.equal(vm.runInContext('S.selected',context),'B');assert.ok([...x.active].some(o=>o.options.strokeColor===MapView.colors.bus));assert.ok(![...x.active].some(o=>o.options.strokeColor===MapView.colors.metro));assert.match(el('map-route-status').textContent,/已高亮整条行程/);assert.match(el('station-comparison').innerHTML,/已比较步行与后续地铁全程/);assert.match(el('station-comparison').innerHTML,/全程 30/);
});
