(function(root,factory){if(typeof module==='object'&&module.exports)module.exports=factory();else root.TuheInterestMap=factory();})(typeof globalThis!=='undefined'?globalThis:this,function(){
 'use strict';
 const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
 function render(sdk,map,area,pois=[],previous=[],{fit=true,bestId=null,onSelect=()=>{}}={}){
  if(previous.length)map.remove(previous);const overlays=[];if(!area?.polygon?.length)return overlays;
  const polygon=new sdk.Polygon({path:area.polygon,strokeColor:'#087f72',strokeWeight:3,strokeOpacity:.95,fillColor:'#2cb99d',fillOpacity:.19,zIndex:75,bubble:true});map.add(polygon);overlays.push(polygon);
  // Fit only the AOI, never the whole route or out-of-area search results.
  if(fit)map.setFitView([polygon],false,[55,60,65,60]);
  for(const p of pois){if(p.in_interest_area===false||p.direction?.pass===false||!p.location)continue;
   const best=p.id===bestId,state=p.evaluation??'not_evaluated',label=best?'★ 本次推荐':state==='conditional_candidate'?'时间通过':state==='constraint_rejected'?'时间不符':state==='unknown'?'待确认':'未精算',rating=p.rating===null||p.rating===undefined?'评分未知':'评分 '+p.rating+'/'+(p.rating_max??5),title=p.name+' · '+label+' · '+rating;
   const marker=new sdk.Marker({position:typeof p.location==='string'?p.location.split(',').map(Number):p.location,anchor:'center',title,zIndex:best?220:200,content:'<span class="shop-map-point '+(best?'shop-star':'shop-dot')+' '+esc(state)+'" role="img" aria-label="'+esc(title)+'">'+(best?'★':'')+'</span>',label:best?{direction:'top',content:esc('★ '+p.name)}:undefined});
   if(typeof marker.on==='function')marker.on('click',()=>onSelect(p.id));map.add(marker);overlays.push(marker);
  }
  return overlays;
 }
 return {render};
});
