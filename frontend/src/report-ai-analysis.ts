import './report-ai-analysis.css';

const api='/api';
const sum=(rows:any[],key:string)=>rows.reduce((total,row)=>total+Number(row[key]||0),0);
const average=(rows:any[],key:string)=>rows.length?sum(rows,key)/rows.length:0;
const format=(value:number,digits=1)=>value.toLocaleString('en-US',{maximumFractionDigits:digits});

const reportAnalysis=(name:string,rows:any[],assets:any[])=>{
  const dates=rows.map(row=>row.timestamp).sort();
  const latestDate=dates[dates.length-1];
  const current=rows.filter(row=>row.timestamp===latestDate);
  const energy=sum(current,'energy_produced_mwh');
  const expected=sum(current,'expected_energy_mwh');
  const delta=energy-expected;
  const availability=average(current,'availability_pct');
  const wind=average(current,'wind_speed');
  const health=average(current,'component_health_score');
  const risk=average(current,'failure_risk_pct');
  const critical=sum(current,'critical_alarm_count');
  const downtime=sum(current,'planned_downtime_h')+sum(current,'unplanned_downtime_h')+sum(current,'grid_downtime_h');
  const revenue=sum(current,'estimated_revenue_usd');
  const top=[...current].sort((a,b)=>b.energy_produced_mwh-a.energy_produced_mwh)[0];
  const lowestHealth=[...current].sort((a,b)=>a.component_health_score-b.component_health_score)[0];
  const byId=new Map(assets.map(asset=>[asset.id,asset]));
  const topName=byId.get(top?.turbine_id)?.name||'Leading turbine';
  const healthName=byId.get(lowestHealth?.turbine_id)?.name||'Priority turbine';
  const base={period:latestDate?.slice(0,7)||'latest reporting period',energy,expected,delta,availability,wind,health,risk,critical,downtime,revenue,topName,healthName,top,lowestHealth};
  const lower=name.toLowerCase();
  if(/energy|generation|power curve|power output|energy loss|curtailment/.test(lower))return {...base,focus:'Production performance',metric:`${format(energy)} MWh`,summary:`Production for ${base.period} was ${format(Math.abs(delta))} MWh ${delta>=0?'above':'below'} the modelled expectation. ${topName} contributed the highest recorded energy output.`,drivers:[['Energy produced',`${format(energy)} MWh`,86],['Expected energy',`${format(expected)} MWh`,Math.min(100,expected?energy/expected*100:0)],['Average wind',`${format(wind)} m/s`,Math.min(100,wind/8*100)]],actions:[delta<0?'Review turbine-level production losses against wind conditions and curtailment.':'Maintain current operating set-points while monitoring the highest-output sites.','Inspect assets below the fleet availability benchmark before the next reporting period.']};
  if(/revenue|co2/.test(lower))return {...base,focus:'Commercial and sustainability performance',metric:`$${format(revenue,0)}`,summary:`Estimated revenue for ${base.period} is $${format(revenue,0)}, supported by ${format(energy)} MWh of recorded generation. Production variance versus expected energy is ${format(delta)} MWh.`,drivers:[['Estimated revenue',`$${format(revenue,0)}`,82],['Energy tariff exposure',`$${format(revenue/(energy||1),2)}/MWh`,75],['CO2 avoided',`${format(energy*.82)} t`,78]],actions:['Validate the reporting tariff and curtailment records before publishing commercial results.','Prioritise production recovery on turbines that are below expected energy.']};
  if(/wind|resource|weather/.test(lower))return {...base,focus:'Wind resource assessment',metric:`${format(wind)} m/s`,summary:`Average wind speed for ${base.period} was ${format(wind)} m/s. This resource level explains the current production profile and should be considered alongside availability before classifying a performance shortfall.`,drivers:[['Average wind speed',`${format(wind)} m/s`,Math.min(100,wind/8*100)],['Expected energy',`${format(expected)} MWh`,72],['Recorded generation',`${format(energy)} MWh`,Math.min(100,expected?energy/expected*100:0)]],actions:['Schedule non-urgent service during forecast lower-wind windows.','Review wind-to-power variance for turbines that depart materially from fleet performance.']};
  if(/availability|downtime|turbines online|alarm|fault/.test(lower))return {...base,focus:'Availability and reliability',metric:`${format(availability)}%`,summary:`Fleet availability for ${base.period} was ${format(availability)}%, with ${format(downtime)} recorded downtime hours and ${format(critical,0)} critical alarms. The main operational priority is preventing unplanned downtime from growing.`,drivers:[['Fleet availability',`${format(availability)}%`,availability],['Downtime recorded',`${format(downtime)} h`,Math.max(10,100-downtime/4)],['Critical alarms',format(critical,0),Math.max(10,100-critical*12)]],actions:[critical>0?'Investigate critical alarms and confirm equipment status with site teams.':'Maintain alarm surveillance and validate communications from each turbine.','Separate planned maintenance from unplanned and grid downtime in the next review.']};
  if(/rul|failure|health|bearing|gearbox|blade|vibration|temperature|maintenance|anomaly/.test(lower))return {...base,focus:'Predictive maintenance assessment',metric:`${format(health)}/100`,summary:`Average component health is ${format(health)}/100 with an average failure-risk estimate of ${format(risk)}%. ${healthName} has the lowest current health score and should be the first asset reviewed.`,drivers:[['Component health',`${format(health)}/100`,health],['Failure risk',`${format(risk)}%`,Math.max(5,100-risk)],['Priority asset health',`${format(lowestHealth?.component_health_score||0)}/100`,lowestHealth?.component_health_score||0]],actions:[`Plan an engineering review for ${healthName}, including vibration, temperature, and lubrication evidence.`,'Use the estimated RUL only to prioritise inspection; confirm condition with validated field and SCADA data.']};
  return {...base,focus:'Executive operational performance',metric:`${format(energy)} MWh`,summary:`The latest ${base.period} fleet record shows ${format(energy)} MWh of generation, ${format(availability)}% availability, and ${format(wind)} m/s average wind. The analysis highlights the operational factors that most affect the selected report.`,drivers:[['Generation',`${format(energy)} MWh`,82],['Availability',`${format(availability)}%`,availability],['Component health',`${format(health)}/100`,health]],actions:['Review the production, reliability, and health signals together before setting the next operational priority.','Drill into the affected turbine profile for location-specific evidence.']};
};

const showAnalysis=async(card:HTMLElement)=>{
  const name=card.querySelector('strong')?.textContent||'Default report';
  const overlay=document.createElement('section');
  overlay.className='report-ai-overlay';
  overlay.innerHTML='<main><p class="eyebrow">AI OPERATIONAL ANALYSIS</p><h1>Preparing report analysis...</h1><p>Reading the active fleet telemetry and operational indicators.</p></main>';
  document.body.append(overlay);
  try{
    const auth=JSON.parse(localStorage.getItem('zetdc-auth')||'{}');
    const headers={Authorization:`Bearer ${auth.t}`};
    const [readings,assets]=await Promise.all([
      fetch(`${api}/readings?days=30`,{headers}).then(response=>response.json()),
      fetch(`${api}/turbines`,{headers}).then(response=>response.json()),
    ]);
    const analysis=reportAnalysis(name,readings,assets);
    overlay.innerHTML=`<main><header><div><p class="eyebrow">AI OPERATIONAL ANALYSIS</p><h1>${name}</h1><p>${analysis.summary}</p></div><button>Close</button></header><section class="ai-summary"><div><small>Current report measure</small><strong>${analysis.metric}</strong><span>${analysis.focus}</span></div><div><small>Data window</small><strong>${analysis.period}</strong><span>8-point measured wind-mast dataset</span></div><div><small>Analysis confidence</small><strong>${analysis.health>=80?'Moderate':'Review required'}</strong><span>Telemetry-based decision support</span></div></section><section class="ai-breakdown"><div class="ai-chart"><h3>Operational breakdown</h3>${analysis.drivers.map(([label,value,score]:any)=>`<div><span>${label}</span><i><em style="width:${Math.max(4,Math.min(100,score))}%"></em></i><b>${value}</b></div>`).join('')}</div><div class="ai-actions"><h3>AI-recommended actions</h3><ol>${analysis.actions.map((action:string)=>`<li>${action}</li>`).join('')}</ol><p>Interpretation uses supplied mast measurements; generation remains a configured estimate pending turbine SCADA.</p></div></section></main>`;
    overlay.querySelector('button')!.onclick=()=>overlay.remove();
  }catch{
    overlay.innerHTML='<main><h1>Analysis unavailable</h1><p>The report analysis could not read the active fleet telemetry.</p><button>Close</button></main>';
    overlay.querySelector('button')!.onclick=()=>overlay.remove();
  }
};

document.addEventListener('click',event=>{
  const card=(event.target as HTMLElement).closest<HTMLElement>('.default-report-card');
  if(!card||window.location.pathname!=='/reports')return;
  event.preventDefault();
  event.stopImmediatePropagation();
  showAnalysis(card);
},true);
