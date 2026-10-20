'use strict';
const http=require('node:http'),fs=require('node:fs/promises'),path=require('node:path'),crypto=require('node:crypto');
const {AmapClient,createJobId}=require('./lib/amap.cjs');
const {planTrip,recommendMerchants}=require('./lib/planner.cjs');
const {parseAuthorizedDataset}=require('./lib/merchants.cjs');
const {completeGeometry}=require('./lib/route-geometry.cjs');
const G=require('./lib/geo.cjs');
function createApp({fetchFn=fetch,env=process.env,intervalMs=500}={}){
 const state={webServiceKey:env.AMAP_WEB_SERVICE_KEY||'',jsKey:env.AMAP_JS_KEY||'',securityJsCode:env.AMAP_SECURITY_JS_CODE||'',dataset:null,token:crypto.randomBytes(24).toString('hex')};
 const jobs=new Map();let busy=false,lastRequest=0,queue=Promise.resolve(),activePlanId=null;
 const schedule=()=>{const next=queue.then(async()=>{const gap=intervalMs-(Date.now()-lastRequest);if(gap>0)await new Promise(r=>setTimeout(r,gap));lastRequest=Date.now();});queue=next.catch(()=>{});return next;};
 const secrets=()=>[state.webServiceKey,state.securityJsCode];
 function safe(value){let str=JSON.stringify(value);for(const key of secrets())if(key)str=str.split(key).join('[隐藏]');return str;}
 const json=(res,status,value)=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});res.end(safe(value));};
 function error(res,e,status=400){json(res,status,{error:String(e.message||'请求失败'),code:e.code??null});}
 const config=()=>({csrf_token:state.token,web_service_ready:!!state.webServiceKey,map_ready:!!(state.jsKey&&state.securityJsCode),js_key:state.jsKey||null,merchant_sources:[{id:'amap',label:'高德商户POI',ready:!!state.webServiceKey},{id:'meituan_authorized_export',label:'美团授权导入（用户提供）',ready:!!state.dataset,count:state.dataset?.merchants.length??0}],limitations:['当前程序在本机运行；未部署公网、未接入真实大模型。','美团实时API尚未连接，需要正式业务权限、契约与凭证。']});
 function client(maxCalls=40,onProgress=()=>{}){return new AmapClient({key:state.webServiceKey,fetchFn,maxCalls,schedule,onProgress});}
 async function body(req,max=100000){if(!String(req.headers['content-type']??'').startsWith('application/json'))throw Error('请使用JSON请求');let size=0,chunks=[];for await(const chunk of req){size+=chunk.length;if(size>max)throw Error('请求内容过大');chunks.push(chunk);}try{return JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{throw Error('JSON格式错误');}}
 function runJob(kind,work,maxCalls=40){if(busy){const e=Error('已有任务正在计算，请等待完成，避免重复消耗接口额度');e.status=409;throw e;}busy=true;while(jobs.size>=10){const k=[...jobs.keys()].find(id=>id!==activePlanId);if(!k)break;jobs.delete(k);}const job={id:createJobId(),kind,status:'running',progress:'准备查询',api_calls:0,started_at:new Date().toISOString()};jobs.set(job.id,job);if(kind==='plan')activePlanId=job.id;const c=client(maxCalls,x=>{job.api_calls=x.calls;});
  job.completion=(async()=>{try{job.result=await work(c,label=>{job.progress=label;});job.status='completed';}catch(e){job.status='failed';job.error=String(e.message);job.records=c.records;}finally{job.api_calls=c.calls;job.finished_at=new Date().toISOString();busy=false;}})();return job;
 }
 const server=http.createServer(async(req,res)=>{
  res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Referrer-Policy','no-referrer');res.setHeader('X-Frame-Options','DENY');
  res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self' https://*.amap.com https://*.autonavi.com 'unsafe-eval' blob:; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https://*.amap.com https://*.autonavi.com; connect-src 'self' https://*.amap.com https://*.autonavi.com; worker-src 'self' blob:; font-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
  try{
   const port=server.address()?.port,allowedHosts=new Set(['127.0.0.1:'+port,'localhost:'+port]);if(!allowedHosts.has(req.headers.host)){json(res,403,{error:'仅接受本机地址访问'});return;}
   const origin='http://'+req.headers.host,url=new URL(req.url,origin);
   if(req.method==='POST'){
    if(req.headers.origin&&req.headers.origin!==origin){json(res,403,{error:'拒绝跨站请求'});return;}
    if(req.headers['x-tuhe-token']!==state.token){json(res,403,{error:'本机会话已失效，请刷新网页'});return;}
   }
   if(req.method==='GET'&&url.pathname==='/api/bootstrap'){res.setHeader('Set-Cookie','tuhe_local='+state.token+'; HttpOnly; SameSite=Strict; Path=/');json(res,200,config());return;}
   if(req.method==='POST'&&url.pathname==='/api/session'){
    if(busy)throw Object.assign(Error('请在路线任务结束后修改连接'),{status:409});const data=await body(req);
    if(data.clear===true){state.webServiceKey='';state.jsKey='';state.securityJsCode='';state.dataset=null;jobs.clear();json(res,200,config());return;}
    const updates={};for(const field of ['webServiceKey','jsKey','securityJsCode'])if(data[field]!==undefined&&data[field]!==''){if(typeof data[field]!=='string'||!/^[-\w]{16,128}$/.test(data[field].trim()))throw Error('请填写完整的高德Key或安全密钥');updates[field]=data[field].trim();}Object.assign(state,updates);
    jobs.clear();json(res,200,config());return;
   }
   if(req.method==='POST'&&url.pathname==='/api/search'){
    if(busy)throw Object.assign(Error('路线任务执行中，请稍后搜索'),{status:409});const data=await body(req),c=client(1);const pois=await c.search(G.text(data.keyword),G.text(data.city||'南京'));json(res,200,{pois,api_calls:c.calls,records:c.records});return;
   }
   if(req.method==='POST'&&url.pathname==='/api/merchants/import'){
    if(busy)throw Object.assign(Error('请等待路线任务结束再导入'),{status:409});state.dataset=parseAuthorizedDataset(await body(req,2000000));json(res,200,{count:state.dataset.merchants.length,provider:state.dataset.provider,imported_at:state.dataset.imported_at});return;
   }
   if(req.method==='POST'&&url.pathname==='/api/plan'){
    if(!state.webServiceKey)throw Error('请先在连接设置填写高德Web服务Key');const data=await body(req);const job=runJob('plan',async(c,progress)=>planTrip(c,data,{onProgress:r=>progress(r.progress??'完成')}));json(res,202,{job_id:job.id});return;
   }
   if(req.method==='POST'&&url.pathname==='/api/recommend'){
    const data=await body(req),p=jobs.get(data.plan_job_id);if(p?.kind!=='plan'||p.status!=='completed')throw Error('请先完成路线规划');const route=p.result.candidates.find(r=>r.id===data.route_id);if(!route)throw Error('未找到所选路线');
    const job=runJob('recommend',async(c,progress)=>recommendMerchants(c,p.result,route,data.options??{},{authorizedDataset:state.dataset,onProgress:progress}));job.plan_job_id=p.id;json(res,202,{job_id:job.id});return;
   }
   if(req.method==='POST'&&url.pathname==='/api/geometry'){
    const data=await body(req),plan=jobs.get(data.plan_job_id);if(plan?.kind!=='plan'||plan.status!=='completed')throw Error('请先完成路线规划');const index=plan.result.candidates.findIndex(r=>r.id===data.route_id);if(index<0)throw Error('未找到所选路线');
    const job=runJob('geometry',async(c,progress)=>{const result=await completeGeometry(c,plan.result.candidates[index],plan.result.input,plan.result.via,progress);plan.result.candidates[index]=result.route;plan.geometry_records=[...(plan.geometry_records??[]),...result.records];return result;},8);job.plan_job_id=plan.id;job.route_id=data.route_id;json(res,202,{job_id:job.id});return;
   }
   if(req.method==='POST'&&url.pathname==='/api/via'){
    const data=await body(req),rec=jobs.get(data.recommend_job_id);if(rec?.kind!=='recommend'||rec.status!=='completed')throw Error('活动候选已失效，请重新查询');const poi=rec.result.pois.find(p=>p.id===data.poi_id);if(poi?.evaluation!=='conditional_candidate')throw Error('请先选择已精算且满足时间条件的活动地点');const plan=jobs.get(rec.plan_job_id);if(!plan?.result)throw Error('原行程已过期，请重新规划');
    const via={id:poi.id,name:poi.name,location:poi.location,source:poi.source,evidence:poi.evidence,consumption_reference:poi.consumption_reference,hours_description:poi.hours_description};
    const job=runJob('plan',async(c,progress)=>planTrip(c,plan.result.input,{via,onProgress:r=>progress(r.progress??'完成')}));job.merchant_source_evidence={provider:rec.result.provider,poi:via,records:rec.result.records,originating_recommend_job_id:rec.id};json(res,202,{job_id:job.id});return;
   }
   const match=url.pathname.match(/^\/api\/(jobs|export)\/([\w-]+)$/);
   if(req.method==='GET'&&match){const job=jobs.get(match[2]);if(!job)throw Object.assign(Error('结果已过期，请重新计算'),{status:404});const data={...job};delete data.completion;if(match[1]==='export')res.setHeader('Content-Disposition','attachment; filename="tuhe-trip-'+job.id+'.json"');json(res,200,data);return;}
   if(req.method==='GET'&&url.pathname.startsWith('/_AMapService/')){
    if(!String(req.headers.cookie??'').split(/;\s*/).includes('tuhe_local='+state.token))throw Object.assign(Error('需要本机会话'),{status:403});if(!state.securityJsCode||!state.jsKey)throw Error('尚未配置地图JS API Key与安全密钥');
    const endpoint=url.pathname.slice('/_AMapService/'.length),styles=endpoint==='v4/map/styles';
    if(!styles&&!/^v[1-5]\/[a-zA-Z0-9/_-]+$/.test(endpoint))throw Object.assign(Error('地图代理路径格式不合法'),{status:403});
    const remote=new URL('https://'+(styles?'webapi.amap.com':'restapi.amap.com')+'/'+endpoint);for(const [k,v] of url.searchParams)if(!['key','jscode','sig'].includes(k))remote.searchParams.append(k,v);remote.searchParams.set('key',state.jsKey);remote.searchParams.set('jscode',state.securityJsCode);
    const upstream=await fetchFn(remote,{signal:AbortSignal.timeout(20000),redirect:'error'});if(!upstream.ok)throw Error('地图代理HTTP '+upstream.status);const data=await upstream.text();res.writeHead(200,{'Content-Type':upstream.headers.get('content-type')||'application/json','Cache-Control':'no-store'});let redacted=data;for(const k of secrets())if(k)redacted=redacted.split(k).join('[隐藏]');res.end(redacted);return;
   }
   const assets={'/':'index.html','/app.js':'app.js','/route-map.js':'route-map.js','/interest-area.js':'interest-area.js','/interest-map.js':'interest-map.js','/styles.css':'styles.css'};
   if(req.method==='GET'&&assets[url.pathname]){const ext=path.extname(assets[url.pathname]),mime={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8'};res.writeHead(200,{'Content-Type':mime[ext],'Cache-Control':'no-store'});res.end(await fs.readFile(path.join(__dirname,'public',assets[url.pathname])));return;}
   json(res,404,{error:'未找到该资源'});
  }catch(e){error(res,e,e.status??400);}
 });
 server.requestTimeout=30000;server.headersTimeout=15000;
 return {server,state,jobs,close:()=>new Promise(r=>server.close(r))};
}
if(require.main===module){
 const app=createApp();const port=Number(process.env.TUHE_PORT||8787);if(!Number.isInteger(port)||port<1024||port>65535)throw Error('端口需为1024至65535');
 app.server.listen(port,'127.0.0.1',()=>{console.log('途合真实地图工作台已启动：http://127.0.0.1:'+port);console.log('请在网页的连接设置填写Key，无需在终端粘贴。关闭本窗口会清除会话凭证。');if(process.argv.includes('--open')){const {spawn}=require('node:child_process'),url='http://127.0.0.1:'+port;if(process.platform==='win32')spawn('cmd',['/c','start','',url],{stdio:'ignore'}).unref();}});
 app.server.on('error',e=>{console.error(e.code==='EADDRINUSE'?'8787端口已占用。请先查看已打开的途合窗口，或关闭旧终端后重试。':'启动失败：'+e.code);process.exitCode=1;});
}
module.exports={createApp};
