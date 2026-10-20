'use strict';
const crypto=require('node:crypto');
const {text,coordinate,numeric,distance}=require('./geo.cjs');
// An authorized file is a user-supplied dataset, never an invented Meituan API response.
function parseAuthorizedDataset(doc){
 if(!doc||doc.provider!=='meituan_authorized_export'||doc.crs!=='GCJ-02'||doc.authorization_confirmed!==true)throw Error('导入需标记provider=meituan_authorized_export、crs=GCJ-02及authorization_confirmed=true');
 const authorization_reference=text(doc.authorization_reference,'授权来源说明',500);if(!Array.isArray(doc.merchants)||doc.merchants.length>2000)throw Error('商户清单最多2000条');
 const seen=new Set(),merchants=doc.merchants.map((p,i)=>{
  const id=text(p.id,'商户ID',80);if(seen.has(id))throw Error('商户ID重复：'+id);seen.add(id);
  let url=null;if(p.url){const u=new URL(p.url);if(u.protocol!=='https:'||!/(^|\.)(meituan\.com|dianping\.com)$/.test(u.hostname))throw Error('商户链接仅允许美团或大众点评HTTPS地址');url=u.href;}
  const rating=numeric(p.rating),rawScale=p.rating_max??doc.rating_max??5,scale=numeric(rawScale);if(scale===null||scale<=0||scale>100||rating!==null&&(rating<0||rating>scale))throw Error('评分必须在声明的rating_max量表内，缺失请用null');
  return {id:'mt:'+id,name:text(p.name,'商户名称'),location:coordinate(p.location),address:typeof p.address==='string'?p.address.slice(0,300):'',category:typeof p.category==='string'?p.category.slice(0,150):'',keywords:typeof p.keywords==='string'?p.keywords.slice(0,300):'',source:'meituan_authorized_export',source_label:'美团授权导入（用户提供）',consumption_reference:numeric(p.average_price),rating,rating_max:scale,rating_source:'meituan_authorized_export',hours_description:typeof p.hours==='string'?p.hours.slice(0,300):null,price_verified:false,hours_verified:false,url,evidence:{dataset_row:i+1}};
 });
 return {provider:doc.provider,authorization_reference,exported_at:typeof doc.exported_at==='string'?doc.exported_at:null,imported_at:new Date().toISOString(),sha256:crypto.createHash('sha256').update(JSON.stringify(doc)).digest('hex'),merchants};
}
function fromAuthorized(dataset,centers,radius,keywords){if(!dataset)throw Error('尚未导入有权使用的美团商户数据；可改用高德商户检索');return dataset.merchants.filter(p=>centers.some(c=>distance(c,p.location)<=radius)&&(!keywords||[p.name,p.address,p.category,p.keywords].some(s=>s.includes(keywords)))).map(p=>({...p,evidence:{...p.evidence,dataset_sha256:dataset.sha256}}));}
module.exports={parseAuthorizedDataset,fromAuthorized};
