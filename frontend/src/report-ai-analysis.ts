import './report-ai-analysis.css';

const api='/api';
const sum=(rows:any[],key:string)=>rows.reduce((total,row)=>total+Number(row[key]||0),0);
const average=(rows:any[],key:string)=>rows.length?sum(rows,key)/rows.length:0;
const format=(value:number,digits=1)=>value.toLocaleString('en-US',{maximumFractionDigits:digits});

const reportAnalysis=(name:string,rows:any[],assets:any[])=>{
  const dates=rows.map(row=>row.timestamp).sort();
  const latestDate=dates[dates.length-1];
  const current=rows.filter(row=>row.timestamp===latestDate);
  const availability=average(current,'availability_pct');
  const wind=average(current,'wind_speed');
  const minimum=current.length?Math.min(...current.map(row=>Number(row.wind_speed_min??row.wind_speed??0))):0;
  const maximum=current.length?Math.max(...current.map(row=>Number(row.wind_speed_max??row.wind_speed??0))):0;
  const direction=average(current,'wind_direction');
  const temperature=average(current,'temperature');
  const quality=average(current,'data_quality_pct');
  const top=[...current].sort((a,b)=>Number(b.wind_speed||0)-Number(a.wind_speed||0))[0];
  const byId=new Map(assets.map(asset=>[asset.id,asset]));
  const topName=byId.get(top?.turbine_id)?.name||'Leading wind point';
  const base={period:latestDate?.slice(0,10)||'latest reporting period',availability,wind,minimum,maximum,direction,temperature,quality,topName,health:quality};
  const lower=name.toLowerCase();
  if(/temperature|humidity|pressure|density|environment/.test(lower))return {...base,focus:'Environmental wind context',metric:`${format(temperature)} °C`,summary:`The latest source window records ${format(temperature)} °C average temperature alongside ${format(wind)} m/s average wind.`,drivers:[['Average temperature',`${format(temperature)} °C`,70],['Average wind',`${format(wind)} m/s`,Math.min(100,wind/8*100)],['Data quality',`${format(quality)}%`,quality]],actions:['Review environmental conditions alongside wind observations when comparing sites.','Confirm sensor quality before using short source windows for planning.']};
  if(/availability|quality|coverage|record/.test(lower))return {...base,focus:'Measurement coverage',metric:`${format(availability)}%`,summary:`Logger availability for ${base.period} was ${format(availability)}%, with average data quality of ${format(quality)}%.`,drivers:[['Logger availability',`${format(availability)}%`,availability],['Data quality',`${format(quality)}%`,quality],['Average wind',`${format(wind)} m/s`,Math.min(100,wind/8*100)]],actions:['Investigate wind points with incomplete source coverage.','Confirm timestamp continuity before publishing comparisons.']};
  return {...base,focus:'Wind resource assessment',metric:`${format(wind)} m/s`,summary:`Average wind speed for ${base.period} was ${format(wind)} m/s, spanning ${format(minimum)}–${format(maximum)} m/s. ${topName} recorded the highest latest wind value.`,drivers:[['Average wind speed',`${format(wind)} m/s`,Math.min(100,wind/8*100)],['Measured wind range',`${format(minimum)}–${format(maximum)} m/s`,80],['Wind direction',`${format(direction)}°`,Math.min(100,direction/3.6)]],actions:['Compare mean wind and measured ranges across wind points before selecting follow-up sites.','Use longer source windows to confirm whether the latest wind pattern persists.']};
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
    overlay.innerHTML=`<main><header><div><p class="eyebrow">AI WIND ANALYSIS</p><h1>${name}</h1><p>${analysis.summary}</p></div><button>Close</button></header><section class="ai-summary"><div><small>Current report measure</small><strong>${analysis.metric}</strong><span>${analysis.focus}</span></div><div><small>Data window</small><strong>${analysis.period}</strong><span>8-point measured wind-mast dataset</span></div><div><small>Analysis confidence</small><strong>${analysis.health>=80?'Moderate':'Review required'}</strong><span>Measurement-based decision support</span></div></section><section class="ai-breakdown"><div class="ai-chart"><h3>Wind-data breakdown</h3>${analysis.drivers.map(([label,value,score]:any)=>`<div><span>${label}</span><i><em style="width:${Math.max(4,Math.min(100,score))}%"></em></i><b>${value}</b></div>`).join('')}</div><div class="ai-actions"><h3>Recommended actions</h3><ol>${analysis.actions.map((action:string)=>`<li>${action}</li>`).join('')}</ol><p>Interpretation uses supplied wind-mast measurements and environmental source channels.</p></div></section></main>`;
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
