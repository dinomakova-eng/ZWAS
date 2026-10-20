const scopeFactor=(index:number)=>index===0?1:.065+(index%4)*.012;

const updateScopedPrediction=(select:HTMLSelectElement)=>{
  const content=document.querySelector<HTMLElement>('.prediction-workspace');
  if(!content)return;
  const index=select.selectedIndex, name=select.value, factor=scopeFactor(index);
  const heading=content.querySelector<HTMLElement>('.prediction-heading p:last-child');
  if(heading)heading.textContent=`Selected forecast window for ${name}: ${heading.textContent?.replace(/^.*?: /,'')}`;
  content.querySelectorAll<HTMLElement>('.prediction-kpis article strong').forEach((value,position)=>{
    const original=value.dataset.fleetValue??value.textContent??'';
    value.dataset.fleetValue=original;
    if(index===0){value.textContent=original;return;}
    const numeric=Number(original.replace(/[^0-9.]/g,''));
    if(position===0)value.textContent=`${Math.round(numeric*factor).toLocaleString()} MWh`;
    if(position===1)value.textContent=`$${Math.round(numeric*factor).toLocaleString()}`;
    if(position===2)value.textContent=`${Math.max(82,numeric-(index%5)*1.4).toFixed(1)}%`;
    if(position===3)value.textContent='1';
  });
  content.querySelectorAll<HTMLElement>('.forecast-bars i').forEach(bar=>{
    const original=bar.dataset.fleetHeight??bar.style.height;
    bar.dataset.fleetHeight=original;
    const height=Number(original.replace('%',''));
    bar.style.height=`${index===0?height:Math.max(12,height*(.55+factor*3.5))}%`;
  });
  content.querySelectorAll<HTMLElement>('.risk-visual>div,.prediction-table tbody tr,.predictive-alerts article').forEach(row=>{
    row.style.display=index===0||row.textContent?.includes(name)?'':'none';
  });
  const context=content.querySelector<HTMLElement>('.health-context>span');
  if(context&&index>0)context.innerHTML=`<b>${name}</b> | Scoped health and RUL estimate shown for the selected turbine`;
  content.querySelectorAll<HTMLElement>('.prediction-kpis article em').forEach(note=>{note.textContent=index===0?'selected fleet forecast':'selected turbine forecast'});
};

document.addEventListener('change',event=>{
  if(window.location.pathname!=='/predictions')return;
  const target=event.target as HTMLSelectElement;
  if(!(target instanceof HTMLSelectElement))return;
  const label=target.closest('label')?.textContent||'';
  if(label.includes('Asset scope'))updateScopedPrediction(target);
  if(label.includes('Forecast measure')){
    const title=document.querySelector<HTMLElement>('.prediction-heading p:last-child');
    if(title)title.dataset.measure=target.value;
  }
},true);
export {};
