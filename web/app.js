const $ = id => document.getElementById(id);
let data, selected=null, lastGood=0;
const labels={working:'进行中',waiting:'等待材料',blocked:'有阻塞',review:'待审查',complete:'已交付',unknown:'未上报'};
const checks={pending:'待验证',running:'验证中',pass:'已通过',fail:'未通过',unknown:'未知',draft:'设计稿'};
const symbols={pending:'◷',running:'↻',pass:'✓',fail:'×',unknown:'?',draft:'◇'};
function el(tag, attrs={}, children=[]) {
  const node=document.createElement(tag);
  for(const [key,value] of Object.entries(attrs)) {
    if(key==='text') node.textContent=value;
    else if(key==='class') node.className=value;
    else if(key.startsWith('on')) node.addEventListener(key.slice(2),value);
    else node.setAttribute(key,value);
  }
  for(const child of [].concat(children)) if(child) node.append(typeof child==='string'?document.createTextNode(child):child);
  return node;
}
function date(value){return value?new Date(value).toLocaleTimeString('zh-CN',{hour12:false}):'未记录';}
function ago(value){if(!value)return'未记录';const n=Math.max(0,Math.floor((Date.now()-Date.parse(value))/1000));return n<60?`${n} 秒前`:n<3600?`${Math.floor(n/60)} 分钟前`:`${Math.floor(n/3600)} 小时前`;}
function text(id,value){$(id).textContent=value??'未记录';}
function evidence(path,label){return el('button',{class:'evidence-link',text:label||path,onclick:()=>openEvidence(path)});}
async function openEvidence(path){
  text('evidence-name',path);text('evidence-content','正在读取…');$('evidence-dialog').showModal();
  try{const r=await fetch('/api/file?path='+encodeURIComponent(path));const content=await r.text();text('evidence-content',r.ok?content:`无法读取 (${r.status})\n${content}`);}catch(e){text('evidence-content','连接失败：'+e.message);}
}
function card(agent){
  const report=agent.report;
  const status=report?.status||'unknown';
  const passed=(report?.validation||[]).filter(v=>v.status==='pass').length;
  return el('button',{class:`agent-card ${agent.name.startsWith('claude')?'claude':''} ${selected===agent.name?'selected':''}`,'aria-pressed':String(selected===agent.name),'aria-label':`${agent.name} ${agent.role}`,onclick:()=>{selected=agent.name;renderAgents();renderDetail();}},[
    el('div',{class:'card-top'},[el('span',{class:'agent-name',text:agent.name}),el('span',{class:'agent-kind',text:agent.name.startsWith('codex')?'CODEX':'CLAUDE'})]),
    el('div',{class:'agent-role',text:agent.role}),
    el('div',{class:'card-task',text:report?.task||'尚无任务报告；点击查看实时终端。'}),
    el('div',{class:'card-state'},[el('i',{class:'status-dot '+agent.activity.state}),el('span',{text:agent.activity.label})]),
    el('div',{class:'card-bottom'},[el('span',{class:'reported-state '+status,text:labels[status]||status}),el('span',{text:report?`检查 ${passed}/${report.validation?.length||0} · ${ago(report.updatedAt)}`:'等待结构化上报'})])
  ]);
}
function renderAgents(){
  const roots=data.agents.filter(a=>!a.parentId);
  const lanes=roots.map(root=>{
    const children=data.agents.filter(a=>a.parentId===root.id);
    return el('div',{class:'lane'},[el('div',{class:'lane-title',text:root.name.startsWith('codex')?'EXECUTION & AUDIT':'DESIGN & METHODOLOGY'}),card(root),children.length?el('div',{class:'children '+(children.length===1?'single':'')},children.map(card)):null]);
  });
  $('lanes').replaceChildren(...lanes);
}
function section(title,children){return el('section',{class:'detail-section'},[el('h3',{text:title}),...children]);}
function renderDetail(){
  const a=data.agents.find(a=>a.name===selected);if(!a)return;
  const r=a.report;
  const wasOpen=$('terminal-details')?.open;
  const scroll=$('terminal-output')?.scrollTop||0;
  text('detail-name',a.name);text('detail-pane',a.pane);
  const parts=[section('当前任务',[
    el('p',{class:'detail-task',text:r?.task||'等待 agent 上报任务'}),
    el('p',{class:'detail-summary',text:r?.summary||'可以先检查下方实时终端与最新文件。'}),
    el('p',{class:'report-source '+(r&&Date.now()-Date.parse(r.updatedAt)>900000?'stale':''),text:r?`${r.source==='agent-report'?'Agent 自报':'部署时读取资料建立 · 待 agent 更新'} · ${date(r.updatedAt)} · ${ago(r.updatedAt)}`:'任务语义尚未接入'})
  ])];
  if(r?.validation?.length)parts.push(section('正在验证什么',r.validation.map(v=>el('div',{class:'check'},[
    el('span',{class:'check-status '+v.status,text:symbols[v.status]||'?'}),el('div',{},[el('span',{text:v.name}),el('small',{text:checks[v.status]||v.status}),v.detail?el('small',{text:v.detail}):null,v.evidence?evidence(v.evidence,'↗ '+v.evidence.split('/').pop()):null])
  ]))));
  if(r?.dependsOn?.length)parts.push(section('任务依赖 · AGENT 自报',[el('div',{class:'depends'},r.dependsOn.map(name=>el('button',{text:'← '+name,onclick:()=>{selected=name;renderAgents();renderDetail();}})))]));
  if(r?.blockers?.length)parts.push(section('等待与阻塞',r.blockers.map(b=>el('p',{class:'blocker-line',text:'↳ '+b}))));
  const refs=[...new Set([...(r?.evidence||[]),...a.artifacts.map(f=>f.path)])].slice(0,6);
  parts.push(section('证据与最新产物',refs.length?refs.map(path=>{
    const artifact=a.artifacts.find(f=>f.path===path);
    return el('div',{class:'file-row'},[evidence(path,path.split('/').slice(-2).join('/')),el('small',{text:artifact?`文件更新 ${ago(artifact.updatedAt)} · ${(artifact.bytes/1024).toFixed(1)} KB`:'报告引用 · 点击核对原文'})]);
  }):[el('p',{class:'muted',text:'尚未发现报告文件；不代表该 agent 没有工作。'})]));
  const terminal=el('details',{id:'terminal-details'},[el('summary',{text:'展开实时终端 · 只读'}),el('p',{text:`采集 ${date(data.observedAt)} · 原生消息就绪状态：${a.status} · 排队消息：${a.pending}`}),el('pre',{class:'terminal',id:'terminal-output',text:a.captureError||a.terminal||'没有终端输出'})]);
  terminal.open=!!wasOpen;parts.push(terminal);
  $('detail-body').replaceChildren(...parts);
  if(wasOpen)$('terminal-output').scrollTop=scroll;
}
function render(){
  const research=data.research||{};
  text('metric-online',`${data.agents.filter(a=>a.online).length} / ${data.agents.length}`);
  selected??=data.agents?.[0]?.name??null;
  text('workspace-name',data.project||'—');
  text('metric-run',research.active_run||research.latest_run||'未上报');
  text('run-status',research.execution_status);
  text('metric-gpu',research.instance_state_live||'未知');
  text('gpu-time',`上报 ${date(research.instance_state_observed_at)} · ${ago(research.instance_state_observed_at)}`);
  text('metric-conclusion',research.scientific_status==='inconclusive'?'尚无定论':research.scientific_status||'未知');
  text('gate',`${research.phase||'—'} · Gate 0: ${research.gate_0||'未记录'}`);
  text('next-action',research.next_action||'未上报');
  text('blocker-count',(research.blockers||[]).length);
  $('blocker-panel').replaceChildren(el('ul',{},(research.blockers||[]).map(s=>el('li',{text:s}))));
  renderAgents();renderDetail();
  text('message-count',data.messages.length);
  const msgNames={queued:'排队中',injected:'已注入',acknowledged:'已确认收到',sending:'正在投递',uncertain:'投递待核实'};
  $('message-list').replaceChildren(...(data.messages.length?data.messages.slice(0,8).map(m=>el('div',{class:'message'},[
    el('div',{class:'message-head'},[el('span',{text:`${m.fromName} → ${m.toName}`}),el('span',{class:'message-status',text:msgNames[m.status]||m.status})]),
    el('p',{text:m.text||m.message||''}),el('small',{class:'muted',text:date(m.createdAt)})
  ])):[el('p',{class:'empty',text:'尚无 agent-dag 消息。历史 tmux / MCP 消息不会被伪造成新队列记录。'})]));
  const facts=[['研究阶段',research.phase],['云端任务',research.gpu_job_submitted?'已提交（研究状态文件）':'未提交（研究状态文件）'],['GPU 调度者',research.gpu_scheduler],['GPU 租约截止',research.gpu_budget_deadline],['活动 SSM 命令',research.active_ssm_command||'无'],['Gate 0 自动检查',research.gate_0_automated_status],['状态文件更新',`${date(data.researchUpdatedAt)} · ${ago(data.researchUpdatedAt)}`]];
  $('research-facts').replaceChildren(...facts.map(([key,value])=>el('div',{class:'fact'},[el('span',{text:key}),el('strong',{text:value??'未知'})])),el('div',{class:'file-row'},[evidence('research-state.yaml','↗ research-state.yaml'),research.resume_instructions?evidence(research.resume_instructions,' · 当前 checkpoint'):null]));
  text('source-time',`读取 ${date(data.observedAt)} · agent-dag + tmux + research files`);
}
async function poll(){
  try{
    const r=await fetch('/api/state');if(!r.ok)throw new Error('HTTP '+r.status);
    const next=await r.json();if(!next?.agents)throw new Error('状态尚未初始化');
    data=next;lastGood=Date.parse(data.observedAt)||0;
    const stale=Date.now()-lastGood>20000||!!data.collectionError;
    text('connection',stale?'数据已过期':data.errors?.length?'部分数据不可用':'实时连接');
    $('connection-dot').classList.toggle('disconnected',stale||!!data.errors?.length);
    text('last-refresh',`${date(data.observedAt)} · 5s refresh`);render();
  }catch(e){text('connection','连接中断 · 保留上次快照');$('connection-dot').classList.add('disconnected');text('last-refresh',lastGood?`最后成功 ${date(lastGood)}`:'等待服务');}
}
$('show-blockers').addEventListener('click',()=>{$('blocker-panel').hidden=!$('blocker-panel').hidden;});
$('close-evidence').addEventListener('click',()=>$('evidence-dialog').close());
poll();setInterval(poll,5000);
