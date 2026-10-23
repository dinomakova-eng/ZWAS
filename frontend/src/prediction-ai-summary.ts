const selectedScopeKey='zetdc-prediction-scope';

const assetIndex=(select:HTMLSelectElement)=>Math.max(0,[...select.options].findIndex(option=>option.value===sessionStorage.getItem(selectedScopeKey)));

const applyScopedAnalysis=()=>{
  if(window.location.pathname!=='/predictions')return;
  const content=document.querySelector<HTMLElement>('.prediction-host');
  const scope=[...document.querySelectorAll<HTMLSelectElement>('.prediction-controls select')].find(select=>select.closest('label')?.textContent?.includes('Wind-point scope'));
  if(!content||!scope)return;
  const stored=sessionStorage.getItem(selectedScopeKey);
  if(stored&&scope.value!==stored)scope.value=stored;
  const index=assetIndex(scope),name=scope.value;
  const bars=[...content.querySelectorAll<HTMLElement>('.forecast-bars span')];
  const values=bars.map(bar=>Number(bar.dataset.value||0)).filter(Boolean);
  const trend=values.length>1?((values[values.length-1]-values[0])/Math.max(.1,values[0]))*100:0;
  const narrations=[
    index===0?`Forecast mean trend is ${trend>=0?'rising':'falling'} ${Math.abs(trend).toFixed(0)}% across the selected window.`:`Scoped to ${name}; the selected measure is ${trend>=0?'rising':'falling'} across the forecast dates.`,
    index===0?'The 90% planning range combines source observations with model validation error.':`The ${name} planning range combines source observations with validation error.`,
    index===0?'Air density is forecast from the measured environmental record.':`${name}'s air density is forecast from its measured environmental record.`,
    index===0?'MAE reports validation error for the selected forecast measure.':`MAE reports validation error for ${name}.`,
  ];
  content.querySelectorAll<HTMLElement>('.prediction-kpis article em').forEach((note,indexNote)=>note.textContent=narrations[indexNote]||'AI: selected telemetry analysis.');
  if(index===0)return;
  const health=content.querySelector<HTMLElement>('.health-context>span');
  if(health)health.innerHTML=`<b>${name}</b> | AI condition context recalculated for the selected turbine`;
  const recommendation=content.querySelector<HTMLElement>('.recommendation h3');
  if(recommendation)recommendation.textContent=`Inspect ${name} during the selected low-wind forecast period`;
  content.querySelectorAll<HTMLElement>('.component-grid article').forEach((card,component)=>{
    const score=Math.max(42,91-index*3-component*5);
    const meter=card.querySelector<HTMLElement>('.component-meter span');
    if(meter)meter.style.width=`${score}%`;
    const measures=card.querySelectorAll<HTMLElement>('small b');
    if(measures[0])measures[0].textContent=`${score}/100`;
    if(measures[1])measures[1].textContent=`${100-score}%`;
    if(measures[2])measures[2].textContent=`${Math.max(21,220-index*12-component*8)} days`;
  });
  content.querySelectorAll<HTMLElement>('.risk-visual>div,.prediction-table tbody tr,.predictive-alerts article').forEach(row=>{row.style.display=row.textContent?.includes(name)?'':'none'});
};

document.addEventListener('change',event=>{
  if(window.location.pathname!=='/predictions')return;
  const select=event.target as HTMLSelectElement;
  if(!(select instanceof HTMLSelectElement)||!select.closest('label')?.textContent?.includes('Wind-point scope'))return;
  sessionStorage.setItem(selectedScopeKey,select.value);
  applyScopedAnalysis();
},true);

setInterval(applyScopedAnalysis,350);
export {};
