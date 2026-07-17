(() => {
  const english = !/^de(?:-|$)/iu.test(navigator.language || '')
  const locale = english ? 'en-US' : 'de-CH'
  const copy = english ? {
    live:'Live · anonymously aggregated',refresh:'Refresh',eyebrow:'Private product statistics',title:'Where FaNotes<br><em>is making an impact.</em>',lead:'Website, downloads, and app launches at a glance — without profiles, cookies, or device identifiers.',days7:'7 days',days30:'30 days',days90:'90 days',all:'All time',websiteViews:'Website sessions',downloads:'Downloads',desktopOpens:'Desktop app launches',webOpens:'Web app launches',development:'Development',activity:'Activity in the selected period',websiteShort:'Website',desktopShort:'Desktop',webShort:'Web app',noData:'No data in this period yet.',origin:'Origin',countries:'Countries',countryHint:'Country codes only, no IP addresses',distribution:'Distribution',downloadTypes:'Download types',usage:'Usage',appStarts:'App launches',anonymousTitle:'Truly anonymous',anonymousText:'Only daily totals by country, platform, and version are stored. No IP address, cookie, device ID, or individual raw event is written to the statistics file.',daily:'DAILY AGGREGATES',errorTitle:'Statistics unavailable',today:'today',collecting:'Collecting since {date}',country:'Country',website:'Website',desktop:'Desktop',web:'Web app',unknown:'Unknown',installer:'Windows installer',windowsPortable:'Windows portable',appimage:'Linux AppImage',linuxPortable:'Linux portable',linux:'Linux',windows:'Windows',version:'Version',total:'Total',
  } : {
    live:'Live · anonym aggregiert',refresh:'Aktualisieren',eyebrow:'Private Produktstatistik',title:'Was FaNotes<br><em>gerade erreicht.</em>',lead:'Website, Downloads und App-Starts auf einen Blick – ohne Profile, Cookies oder Gerätekennungen.',days7:'7 Tage',days30:'30 Tage',days90:'90 Tage',all:'Gesamt',websiteViews:'Website-Sitzungen',downloads:'Downloads',desktopOpens:'Desktop-App-Starts',webOpens:'Web-App-Starts',development:'Entwicklung',activity:'Aktivität im gewählten Zeitraum',websiteShort:'Website',desktopShort:'Desktop',webShort:'Web-App',noData:'Noch keine Daten in diesem Zeitraum.',origin:'Herkunft',countries:'Länder',countryHint:'Nur Ländercodes, keine IP-Adressen',distribution:'Verteilung',downloadTypes:'Download-Typen',usage:'Nutzung',appStarts:'App-Starts',anonymousTitle:'Tatsächlich anonym',anonymousText:'Gespeichert werden ausschließlich tägliche Summen nach Land, Plattform und Version. Keine IP-Adresse, kein Cookie, keine Geräte-ID und kein einzelnes Rohereignis landet in der Statistikdatei.',daily:'DAILY AGGREGATES',errorTitle:'Statistik nicht erreichbar',today:'heute',collecting:'Erfassung seit {date}',country:'Land',website:'Website',desktop:'Desktop',web:'Web-App',unknown:'Unbekannt',installer:'Windows Installer',windowsPortable:'Windows Portable',appimage:'Linux AppImage',linuxPortable:'Linux Portable',linux:'Linux',windows:'Windows',version:'Version',total:'Gesamt',
  }
  document.documentElement.lang = english ? 'en' : 'de-CH'
  document.querySelectorAll('[data-copy]').forEach((element) => {
    const value = copy[element.dataset.copy]
    if (value) value.includes('<') ? element.innerHTML = value : element.textContent = value
  })

  const number = new Intl.NumberFormat(locale)
  const shortDate = new Intl.DateTimeFormat(locale, { day:'2-digit', month:'short' })
  const longDate = new Intl.DateTimeFormat(locale, { dateStyle:'medium' })
  const displayNames = typeof Intl.DisplayNames === 'function' ? new Intl.DisplayNames([locale], { type:'region' }) : null
  const metricKeys = ['websiteViews','downloads','desktopAppOpens','webAppOpens']
  const colors = { websiteViews:'#a795ff',downloads:'#68d9bf',desktopAppOpens:'#eab078',webAppOpens:'#82aaff' }
  let summary = null
  let selectedDays = 30

  const counters = () => ({ websiteViews:0,downloads:0,desktopAppOpens:0,webAppOpens:0 })
  const sumRows = (rows) => rows.reduce((total,row) => { metricKeys.forEach((key) => { total[key] += Number(row[key]) || 0 }); return total }, counters())
  const selectedRows = () => selectedDays === 'all' ? summary.series : summary.series.slice(-selectedDays)
  const labelForArtifact = (key) => ({ 'windows-installer':copy.installer,'windows-portable':copy.windowsPortable,appimage:copy.appimage,portable:copy.linuxPortable })[key] || key

  const renderBreakdown = (container, entries, label) => {
    container.replaceChildren()
    const maximum = Math.max(1,...entries.map(([,value]) => value))
    if (!entries.length) { const empty=document.createElement('small');empty.textContent=copy.noData;container.append(empty);return }
    entries.forEach(([key,value]) => {
      const row=document.createElement('div');row.className='breakdown-row'
      const name=document.createElement('span');name.textContent=label(key)
      const bar=document.createElement('i');bar.style.setProperty('--share',`${Math.max(2,value/maximum*100)}%`)
      const count=document.createElement('b');count.textContent=number.format(value)
      row.append(name,bar,count);container.append(row)
    })
  }

  const renderCountries = () => {
    const container=document.querySelector('[data-countries]');container.replaceChildren()
    const header=document.createElement('div');header.className='country-row header';[copy.country,copy.website,copy.downloads,copy.desktop,copy.web].forEach((value)=>{const span=document.createElement('span');span.textContent=value;header.append(span)});container.append(header)
    const rows=summary.countries.slice(0,12)
    if (!rows.length) { const empty=document.createElement('div');empty.className='chart-empty';empty.textContent=copy.noData;container.append(empty);return }
    rows.forEach((row)=>{
      const element=document.createElement('div');element.className='country-row'
      const name=document.createElement('span');name.className='country-name';const code=document.createElement('i');code.textContent=row.country;const title=document.createElement('b');title.textContent=row.country==='ZZ'?copy.unknown:(displayNames?.of(row.country)||row.country);name.append(code,title);element.append(name)
      ;['websiteViews','downloads','desktopAppOpens','webAppOpens'].forEach((key)=>{const value=document.createElement('span');value.textContent=number.format(row[key]);element.append(value)})
      container.append(element)
    })
  }

  const renderChart = (rows) => {
    const container=document.querySelector('[data-chart]');container.replaceChildren()
    if (!rows.length || !metricKeys.some((key)=>rows.some((row)=>row[key]>0))) { const empty=document.createElement('div');empty.className='chart-empty';empty.textContent=copy.noData;container.append(empty);return }
    const ns='http://www.w3.org/2000/svg';const svg=document.createElementNS(ns,'svg');svg.setAttribute('viewBox','0 0 1000 260');svg.setAttribute('preserveAspectRatio','none')
    const maximum=Math.max(1,...rows.flatMap((row)=>metricKeys.map((key)=>row[key]||0)))
    metricKeys.forEach((key)=>{
      const points=rows.map((row,index)=>`${rows.length===1?500:index/(rows.length-1)*1000},${248-(row[key]||0)/maximum*230}`).join(' ')
      const line=document.createElementNS(ns,'polyline');line.setAttribute('points',points);line.setAttribute('stroke',colors[key]);svg.append(line)
      if(rows.length<=14) rows.forEach((row,index)=>{const circle=document.createElementNS(ns,'circle');circle.setAttribute('cx',String(rows.length===1?500:index/(rows.length-1)*1000));circle.setAttribute('cy',String(248-(row[key]||0)/maximum*230));circle.setAttribute('r','3.5');circle.setAttribute('fill',colors[key]);svg.append(circle)})
    });container.append(svg)
    const labels=document.createElement('div');labels.className='chart-labels';const indices=[0,Math.floor((rows.length-1)/2),rows.length-1];[...new Set(indices)].forEach((index)=>{const span=document.createElement('span');span.textContent=shortDate.format(new Date(`${rows[index].date}T12:00:00Z`));labels.append(span)});container.after(labels)
  }

  const render = () => {
    const rows=selectedRows();const values=selectedDays==='all'?summary.totals:sumRows(rows)
    metricKeys.forEach((key)=>{document.querySelector(`[data-metric="${key}"]`).textContent=number.format(values[key]);document.querySelector(`[data-today="${key}"]`).textContent=`${number.format(summary.today[key])} ${copy.today}`})
    document.querySelectorAll('[data-days]').forEach((button)=>button.classList.toggle('active',String(button.dataset.days)===String(selectedDays)))
    document.querySelectorAll('.chart-labels').forEach((element)=>element.remove());renderChart(rows);renderCountries()
    renderBreakdown(document.querySelector('[data-downloads]'),Object.entries(summary.downloadsByArtifact).sort((a,b)=>b[1]-a[1]),labelForArtifact)
    renderBreakdown(document.querySelector('[data-platforms]'),Object.entries(summary.appOpensByPlatform).sort((a,b)=>b[1]-a[1]),(key)=>copy[key]||key)
    const versions=document.querySelector('[data-versions]');versions.replaceChildren();Object.entries(summary.appOpensByVersion).sort((a,b)=>b[1]-a[1]).slice(0,8).forEach(([version,count])=>{const item=document.createElement('span');item.textContent=`${copy.version} ${version} · ${number.format(count)}`;versions.append(item)})
    document.querySelector('[data-collecting]').textContent=copy.collecting.replace('{date}',longDate.format(new Date(summary.collectingSince)))
  }

  const load = async () => {
    const button=document.querySelector('[data-refresh]');button.classList.add('loading');document.querySelector('[data-error]').hidden=true
    try { const response=await fetch('/api/v1/analytics/summary',{headers:{Accept:'application/json'},cache:'no-store'});if(!response.ok)throw new Error(`HTTP ${response.status}`);summary=await response.json();render() }
    catch(error){document.querySelector('[data-error]').hidden=false;document.querySelector('[data-error-message]').textContent=error instanceof Error?error.message:String(error)}
    finally{button.classList.remove('loading')}
  }
  document.querySelectorAll('[data-days]').forEach((button)=>button.addEventListener('click',()=>{selectedDays=button.dataset.days==='all'?'all':Number(button.dataset.days);if(summary)render()}))
  document.querySelector('[data-refresh]').addEventListener('click',()=>void load())
  void load()
})()
