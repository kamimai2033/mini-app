import {CASH_FIELDS,LABELS,yen,today,key,moneyInput,uuid,describe,processing} from './ledgerCore.js';

// Views shared with household-ledger v0.2.1; transport and device state are mini-app scoped.
export function mountLedger(root, transport) {

const $=s=>root.querySelector(s);
let STORAGE=transport.storagePrefix;
const state={month:today().slice(0,7),screen:'ledger',tab:'debit',search:'',showVoided:false,data:null,online:false,loggedIn:false,busy:false,refreshing:false,editing:null,replaces:null,storageError:false};
function h(tag,attrs={},...children){
  const n=document.createElement(tag);
  for(const [k,v] of Object.entries(attrs)){
    if(v===null||v===undefined) continue;
    if(k.startsWith('on')) n.addEventListener(k.slice(2).toLowerCase(),v);
    else if(k==='class') n.className=v;
    else if(k==='text') n.textContent=v;
    else if(k==='checked'||k==='disabled'||k==='hidden'||k==='selected') n[k]=v;
    else n.setAttribute(k,String(v));
  }
  for(const child of children.flat(Infinity)) if(child!==null&&child!==undefined) n.append(child instanceof Node?child:document.createTextNode(String(child)));
  return n;
}
function load(name,fallback){try {const raw=localStorage.getItem(STORAGE+name);return raw===null?fallback:JSON.parse(raw);}catch{state.storageError=true;return fallback;}}
let outbox=load('outbox',[]);
if(!Array.isArray(outbox)){state.storageError=true;outbox=[];}
function persist(items){
  if(state.storageError) throw new Error('端末保存を利用できません。ブラウザーの保存設定を確認してください。入力は閉じずに残してください。');
  try{localStorage.setItem(STORAGE+'outbox',JSON.stringify(items));outbox=items;}catch{throw new Error('端末への保存に失敗しました。入力は保存されていません。');}
}
function notice(message,error=false,source='action'){
  const target=$('#notice');target.hidden=!message;target.textContent=message;target.classList.toggle('error',error);target.dataset.source=source;
}
function clearNotice(source){if($('#notice').dataset.source===source)notice('');}
const errors={UNAUTHORIZED:'ログインが必要です。',ORIGIN_NOT_ALLOWED:'接続先のHTTPSアドレスとNASのWEB_ORIGINが一致していません。',LOGIN_RATE_LIMIT:'ログイン試行が続いています。1分ほど待って再試行してください。',INITIAL_SYNC_REQUIRED:'初回同期が必要です。GASの年度設定後に「同期」を押してください。',SETUP_REQUIRED:'GASの年度帳簿が未設定です。更新手順の setupLedgerYear を実行してください。',YEAR_NOT_CONFIGURED:'この年度の帳簿が未登録です。GASで年度を追加してください。',LOCAL_CONFLICT:'編集開始後に値が変わりました。最新の値と比較して再編集してください。',CONFLICT:'スプレッドシートの変更と競合しました。内容の確認が必要です。',ENTITY_PENDING:'この項目は送信待ちです。同期完了を待ってから編集してください。',ASSET_OVER_ALLOCATED:'充当額が資産の未回収元本を超えています。',INVALID_ASSET_LINK:'充当先の資産、取消状態、計上年度を確認してください。',SHEET_ROWS_MISSING:'スプレッドシートの行または年度が消えています。NASの保存値を保持して同期を停止しています。削除した行を戻してください。',INVALID_SHEET:'スプレッドシートの入力欄・ID・数式を確認してください。保存済みデータは保持しています。',INVALID_ENTITY:'入力値を確認してください。金額・日付・資産の関連付けに不整合があります。',INVALID_REQUEST:'入力形式を確認してください。',UNCERTAIN:'反映結果が未確定です。同じ内容の再照合が必要です。',TRANSPORT:'Googleとの通信に失敗しました。時間を置いて再試行します。',LOCAL_SYNC_ERROR:'NAS側で同期エラーが発生しました。データを保持して再試行します。',QUEUE_FULL:'送信待ちが上限に達しました。同期状況を確認してください。'};
function errorText(code){return errors[code]||`同期を完了できませんでした（${code}）。`;}
async function api(path,options={}){
  const controller=new AbortController(), timer=setTimeout(()=>controller.abort(),options.timeout||25000);
  try{
    const response=await transport.request(path,{credentials:'omit',redirect:'error',...options,signal:controller.signal,headers:{'Content-Type':'application/json',...(options.headers||{})}});
    let data;
    try{data=await response.json();if(!data||typeof data!=='object'||Array.isArray(data))throw new Error('Invalid API response');}
    catch(cause){
      if(cause.name==='AbortError')throw cause;
      const error=new Error(`NASのAPIから想定外の応答が返りました（HTTP ${response.status}）。接続先とリバースプロキシを確認してください。`);
      error.status=response.status;error.code='INVALID_API_RESPONSE';throw error;
    }
    if(!response.ok){const error=new Error(errorText(data.error||data.detail||`HTTP ${response.status}`));error.code=data.error||data.detail;error.status=response.status;throw error;}
    return data;
  }finally{clearTimeout(timer);}
}
function button(label,run,attrs={}){return h('button',{type:'button',onclick:run,...attrs},label);}
function dateTime(value){return value?new Date(value).toLocaleString('ja-JP',{timeZone:'Asia/Tokyo',month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit',second:'2-digit'}):'未取得';}
function line(label,value,cls=''){return h('div',{class:`mini-line ${cls}`},h('span',{},label),h('strong',{},value));}
function empty(title,message,action){return h('div',{class:'empty'},h('strong',{},title),h('p',{},message),action||null);}
function badge(text,kind=''){return h('span',{class:`tag ${kind}`},text);}
function currentEntry(entity){return state.data?.entries.find(e=>key(e.entity)===key(entity));}
function entryByKey(k){return state.data?.entries.find(e=>key(e.entity)===k);}
function setConnection(text,online){$('#connection').textContent=text;$('#connection').classList.toggle('online',online);}
function showApp(){ $('#login-panel').hidden=true;$('#application').hidden=false;$('#logout').hidden=!state.loggedIn;$('#reconnect').hidden=state.loggedIn; }
function showLogin(message=''){
  $('#login-panel').hidden=false;$('#application').hidden=true;$('#logout').hidden=true;$('#reconnect').hidden=true;
  if(message) $('#login-message').textContent=message;
  $('#open-offline').hidden=!load('cache.'+state.month,null);
}
function saveCache(data,month){try{localStorage.setItem(STORAGE+'cache.'+month,JSON.stringify(data));}catch{notice('NASから取得しましたが、端末への閲覧用保存ができませんでした。');}}
async function refresh(){
  outbox=load('outbox',[]);
  if(state.refreshing)return;
  if(!state.loggedIn){
    state.data=load('cache.'+state.month,null);state.online=false;showApp();render();
    notice('保存済み表示です。送信するには「再接続」からログインしてください。',false,'connection');return;
  }
  const month=state.month;state.refreshing=true;
  try{
    const data=await api('/api/ledger?month='+encodeURIComponent(month));
    state.loggedIn=true;state.online=true;saveCache(data,month);
    if(month===state.month){state.data=data;clearNotice('connection');showApp();render();}
  }catch(error){
    state.online=false;
    if(error.status===401){state.loggedIn=false;showLogin('アクセスキーでログインしてください。');setConnection('未ログイン',false);return;}
    const cached=load('cache.'+month,null);
    const reason=error.status?error.message+(error.code==='INVALID_API_RESPONSE'?'':`（HTTP ${error.status}）`):error.name==='AbortError'?'NASからの応答が時間内に届きませんでした。':'NASに接続できません。';
    if(month===state.month && cached){state.data=cached;showApp();render();notice(reason+' 保存済みの値を表示しています。新しい入力はこの端末の送信待ちに保存します。',true,'connection');}
    else if(month===state.month){state.data=null;showApp();render();notice(reason+' この月の保存済みデータもありません。',true,'connection');}
  }finally{state.refreshing=false;}
}
async function flush(){return withQueueLock(flushLocked).catch(error=>notice(error.message,true));}
async function flushLocked(){
  if(state.busy||!state.loggedIn||!navigator.onLine||state.storageError)return;
  state.busy=true;
  try{
    for(const item of [...outbox]){
      if(item.error)continue;
      try{
        await api('/api/ledger/operations',{method:'POST',body:JSON.stringify(item.command)});
        persist(outbox.filter(x=>x.command.operation_id!==item.command.operation_id));
      }catch(error){
        if(error.status===401){state.loggedIn=false;showLogin(error.message);break;}
        if(error.status && error.status<500){persist(outbox.map(x=>x.command.operation_id===item.command.operation_id?{...x,error:error.message}:x));}
        else break;
      }
    }
  }catch(error){notice(error.message,true);}
  finally{state.busy=false;await refresh();}
}
async function queue(entity,entry=null,replaces=null){return withQueueLock(()=>queueLocked(entity,entry,replaces));}
async function queueLocked(entity,entry=null,replaces=null){
  if(entry?.pending)throw new Error(errorText('ENTITY_PENDING'));
  if(outbox.some(x=>key(x.command.entity)===key(entity)&&x.command.operation_id!==replaces))throw new Error('この項目には端末の送信待ちがあります。同期状況を確認してください。');
  const item={command:{operation_id:uuid(),expected_revision:entry?.revision??null,entity},base:entry?.entity??null,created_at:new Date().toISOString()};
  persist([...outbox.filter(x=>x.command.operation_id!==replaces),item]);
  notice('端末に保存しました。NAS受付とSheets反映は同期状況で確認できます。');
  render();void flush();
}
function render(){
  const captions={ledger:'月次台帳',settlement:'精算・繰越',cash:'現金照合',assets:'固定資産台帳',sync:'同期状況'};
  $('#screen-caption').textContent=captions[state.screen];
  $('#page-title').textContent=state.screen==='assets'?`${state.month.slice(0,4)}年の固定資産`:`${state.month.slice(0,4)}年 ${Number(state.month.slice(5))}月`;
  root.querySelectorAll('[data-screen]').forEach(b=>b.setAttribute('aria-pressed',String(b.dataset.screen===state.screen)));
  $('#add').hidden=!['ledger','assets','settlement'].includes(state.screen);
  $('#add').textContent=state.screen==='assets'?'＋ 資産を登録':'＋ 明細を追加';
  $('#add').disabled=!state.data?.years.includes(state.month.slice(0,4));
  const pending=outbox.length+(state.data?.operations.filter(o=>o.state!=='applied').length||0);
  $('#sync-count').hidden=!pending;$('#sync-count').textContent=pending;
  setConnection(state.online?'NASに接続中':state.data?'保存済み表示':'接続できません',state.online);
  $('#freshness').replaceChildren(h('span',{},`最終取得 ${dateTime(state.data?.fetched_at)}${state.data?.provisional?' · NAS受付分を含む暫定集計':''}`),h('span',{},`端末の送信待ち ${outbox.length}件${outbox.length?'（集計はNAS受付分まで）':''}`));
  const content=$('#content');content.replaceChildren();
  if(!state.data){$('#metrics').hidden=true;content.append(empty('まだ取得できていません','接続を確認して「同期」を押してください。'));return;}
  if(state.storageError)notice('端末保存が利用できません。新しい入力を保存する前に、ブラウザーの保存設定を確認してください。',true,'status');
  else if(state.data.sync.error)notice(errorText(state.data.sync.error),true,'status');
  else if(!state.data.years.includes(state.month.slice(0,4)))notice(errorText('YEAR_NOT_CONFIGURED'),false,'status');
  else clearNotice('status');
  $('#metrics').hidden=state.screen==='assets'||state.screen==='sync';
  renderMetrics();
  if(state.screen==='assets')renderAssets(content);
  else if(state.screen==='sync')renderSync(content);
  else if(state.screen==='cash')renderCash(content);
  else renderLedger(content,state.screen==='settlement');
}
function renderMetrics(){
  const m=state.data.month;
  const values=[['予算',m.budget,'この月に用意する額'],['支出',m.spent,'借方の金額合計'],['残額',m.remaining,'予算 − 支出'],['貸方残',m.credit_remaining,'貸方合計 − 処理済み']];
  $('#metrics').replaceChildren(...values.map(([label,value,help],i)=>h('div',{class:'metric'},
    h('div',{class:'metric-label'},label,i===0?button('変更',()=>editMonth()):null),
    h('div',{class:'metric-value'+(value<0?' negative':'')},yen(value),h('small',{},'円')),h('div',{class:'muted'},help))));
}
function renderLedger(root,settlement=false){
  const m=state.data.month;
  const panel=h('div',{class:'panel'}),rail=h('aside',{class:'rail'});
  if(!settlement){
    const tabs=h('div',{class:'tabs',role:'tablist','aria-label':'月次台帳の区分'});
    [['debit','借方'],['credit','貸方'],['summary','摘要']].forEach(([k,label])=>tabs.append(button(label,()=>{state.tab=k;render();},{role:'tab','aria-selected':String(state.tab===k)})));
    panel.append(tabs);
  }
  if(state.tab==='summary'&&!settlement){panel.append(summaryPanel());root.append(panel);return;}
  const side=settlement?'credit':state.tab;
  let rows=settlement?[...m.debit.filter(r=>!['現金','ゲ','ゲンキン','cash',''].includes(r.entity.payment.trim().toLowerCase())),...m.credit]:m[side];
  if(settlement)rows=rows.filter(r=>!r.entity.processed&&!r.entity.voided);
  rows=rows.filter(r=>(state.showVoided||!r.entity.voided)&&(!state.search||`${r.entity.description} ${r.entity.category} ${r.entity.payment}`.toLowerCase().includes(state.search.toLowerCase())));
  const search=h('input',{type:'search',placeholder:'摘要・費目・決済を検索',value:state.search,'aria-label':'明細を検索',oninput:e=>{state.search=e.target.value;renderTableOnly();}});
  const toolbar=h('div',{class:'list-toolbar'},search,h('label',{},h('input',{type:'checkbox',checked:state.showVoided,onchange:e=>{state.showVoided=e.target.checked;render();}}),'取消も表示'),h('span',{},`${rows.length}件`));
  panel.append(toolbar);
  const holder=h('div',{id:'ledger-table'});panel.append(holder);
  function renderTableOnly(){
    let filtered=settlement?[...m.debit.filter(r=>!['現金','ゲ','ゲンキン','cash',''].includes(r.entity.payment.trim().toLowerCase())),...m.credit]:m[side];
    if(settlement)filtered=filtered.filter(r=>!r.entity.processed&&!r.entity.voided);
    filtered=filtered.filter(r=>(state.showVoided||!r.entity.voided)&&(!state.search||`${r.entity.description} ${r.entity.category} ${r.entity.payment}`.toLowerCase().includes(state.search.toLowerCase())));
    toolbar.lastChild.textContent=`${filtered.length}件`;holder.replaceChildren(transactionTable(filtered,settlement));
  }
  renderTableOnly();
  const week=h('div',{class:'panel'},h('h2',{},side==='credit'?'貸方週別':'週間統計'));
  for(const w of side==='credit'?m.credit_weeks:m.weeks){if(['other_month','unknown','carry'].includes(w.key)&&!w.total&&!w.paid)continue;week.append(line(w.label,`${yen(w.total)} 円`));}
  rail.append(week,h('div',{class:'panel'},h('h2',{},'精算を確認する'),line('貸方の入金済み',`${yen(m.credit_paid)} 円`),h('p',{},'処理は明細1件の全額単位です。精算しても支出に二重計上しません。'),button('精算・繰越を開く',()=>{state.screen='settlement';render();},{class:'quiet'})),
    h('div',{class:'panel'},h('h2',{},'同期'),h('p',{},state.data.sync.enabled?`NASが${state.data.sync.interval_seconds}秒ごとに確認します。画面を閉じても同期を続けます。`:'自動同期は無効です。「同期」で手動実行できます。'),button('同期状況を見る',()=>{state.screen='sync';render();},{class:'quiet'})));
  root.append(h('div',{class:'workspace'},panel,rail));
}
function transactionTable(rows,showSide=false){
  if(!rows.length)return empty('明細はありません','入力した内容はNASとスプレッドシートへ同期します。',button('＋ 明細を追加',()=>editTransaction(),{class:'primary',disabled:!state.data.years.includes(state.month.slice(0,4))}));
  const body=h('tbody');
  for(const row of rows){
    const e=row.entity,locked=Boolean(row.pending)||outbox.some(o=>key(o.command.entity)===key(e));
    const dateLabel=row.effective_date?`${Number(row.effective_date.slice(5,7))}/${Number(row.effective_date.slice(8))}`:'—';
    const checkbox=h('input',{type:'checkbox',checked:e.processed,disabled:locked||e.voided,'aria-label':`${e.description||e.category||'明細'}を処理済みにする`,onchange:async ev=>{try{await queue(processing(e,ev.target.checked,state.month),row);}catch(error){notice(error.message,true);render();}}});
    body.append(h('tr',{class:`${e.processed?'settled':''} ${e.voided?'voided':''}`},
      h('td',{},dateLabel,h('small',{},row.inherited?'直前から継承':!row.effective_date?'日付未確定':row.effective_date.slice(0,7)!==state.month?'別月の日付':''),row.carried?badge('繰越'):null),
      h('td',{},button(e.description||'（摘要なし）',()=>editTransaction(e,row),{class:'row-edit',disabled:locked}),h('small',{},`${showSide?(e.side==='debit'?'借方 · ':'貸方 · '):''}${e.category}`),e.asset_id?badge('資産への充当'):null),
      h('td',{class:`money ${e.amount<0?'negative':''}`},yen(e.amount)),h('td',{},e.payment||badge('未確定','warning')),
      h('td',{},h('label',{class:'processing'},checkbox,e.processed?'処理済み':'未処理'),row.pending?badge(row.pending==='applied'?'取得待ち':'NAS受付','warning'):null),
      h('td',{},button('履歴',()=>showHistory(e),{class:'quiet','aria-label':`${e.description||'明細'}の履歴`}))))
  }
  return h('div',{class:'table-wrap'},h('table',{},h('thead',{},h('tr',{},h('th',{},'日付'),h('th',{},'摘要 / 費目'),h('th',{class:'money'},'金額（円）'),h('th',{},'決済'),h('th',{},'処理'),h('th',{},''))),body));
}
function summaryPanel(){
  const m=state.data.month,s=m.settings;
  function block(title,children){return h('section',{class:'memo-block'},h('h2',{},title),children);}
  const settings=block('設定項目',[line('年次',state.month.slice(0,4)),line('月次',Number(state.month.slice(5))),line('予算額',yen(m.budget)),button('予算・現金実査を編集',editMonth,{class:'quiet'}),h('h3',{},'週間統計'),...m.weeks.filter(w=>w.key!=='carry').map(w=>line(w.label,yen(w.total)))]);
  const settlement=block('精算表',m.settlement.filter(w=>w.key!=='carry').map(w=>h('div',{},line(`${w.label} 未`,yen(w.total)),h('div',{class:'mini-line subline'},h('span',{},'内入金'),h('span',{},w.total===w.paid?badge('OK','ok'):null,' ',yen(w.paid))))));
  if(m.unknown_payment)settlement.append(h('p',{class:'muted'},`決済未確定 ${yen(m.unknown_payment)}円は対象額に含めていません。`));
  const totals=block('総計（処理用）',[...m.blocks.map((v,i)=>line(`p${i+1}`,yen(v))),line('執行済',yen(m.spent)),line('執行前',yen(m.remaining)),h('p',{class:'muted'},'p1～p3は40件ずつ、p4は121件目以降。')]);
  const cash=block('現金実査',[...CASH_FIELDS.map(k=>line(LABELS[k],yen(s[k]))),button('現金実査を編集',editMonth,{class:'quiet'})]);
  const credit=block('貸方合計',[line('貸方合計',yen(m.credit_total)),line('内）現金',yen(m.credit_by_payment.cash)),line('内）カード',yen(m.credit_by_payment.card)),line('内）その他',yen(m.credit_by_payment.other)),line('決済未確定',yen(m.credit_by_payment.unknown)),line('入金済み',yen(m.credit_paid))]);
  const creditWeek=block('貸方週別',m.credit_weeks.map(w=>line(w.label,`${yen(w.total)}（内入金 ${yen(w.paid)}）`)));
  return h('div',{class:'memo-grid'},settings,settlement,totals,cash,credit,creditWeek);
}
function renderCash(root){
  const s=state.data.month.settings;
  root.append(h('div',{class:'panel cash-layout'},h('h2',{},'実際に数えた現金を記録'),h('p',{class:'muted'},'空欄と0円を区別します。過不足から支出や予算を自動変更しません。'),
    h('div',{class:'cash-readings'},CASH_FIELDS.map(k=>h('div',{class:'cash-reading'},h('span',{},LABELS[k]),h('strong',{},yen(s[k]))))),
    line('照合用現金額（手入力）',yen(s.cash_expected)),line('月末確定との差額',yen(state.data.month.cash_difference)),line('確認日',s.cash_checked_on||'未記入'),h('p',{class:'muted'},s.cash_note||'確認メモはありません。'),button('現金実査を編集',editMonth,{class:'primary'})));
}
function renderAssets(root){
  root.append(h('p',{class:'muted asset-intro'},'一括購入した自己資金を、月の予算から少しずつ回収します。登録だけでは月次支出に加算しません。'));
  const left=h('section',{},h('div',{class:'column-heading'},h('h2',{},'借方'),h('span',{},'償却中'))),right=h('section',{},h('div',{class:'column-heading'},h('h2',{},'貸方'),h('span',{},'償却済み')));
  for(const item of state.data.assets){
    const a=item.entity;
    const card=h('article',{class:'asset-card'+(item.completed?' completed':'')},h('div',{class:'asset-top'},h('div',{},h('h3',{},a.name),h('span',{class:'muted'},`${a.acquired_date} 取得${item.carried?' · 前年度から継続':''}`)),a.voided?badge('取消'):item.pending?badge('NAS受付','warning'):badge(item.completed?'償却済み':'償却中',item.completed?'ok':'')),
      h('div',{class:'asset-values'},h('label',{},'取得額',h('strong',{},yen(a.cost))),h('label',{},'充当済',h('strong',{},yen(item.paid))),h('label',{},'未回収元本',h('strong',{},yen(item.remaining)))),a.note?h('p',{class:'muted'},a.note):null,
      h('div',{class:'asset-actions'},!a.voided&&!item.completed?button('予算から充当',()=>editAllocation(item),{class:'primary',disabled:!!item.pending}):null,button('編集',()=>editAsset(a,item),{disabled:!!item.pending}),button('充当履歴',()=>showAllocations(item))));
    (item.completed?right:left).append(card);
  }
  if(left.children.length===1)left.append(empty('償却中の資産はありません','新しく購入したものを登録できます。'));
  if(right.children.length===1)right.append(empty('完了した資産はありません','全額を充当すると、同じ資産がこちらへ移動します。'));
  root.append(h('div',{class:'asset-columns'},left,right));
}
const stateLabels={received:'NAS受付・送信待ち',sending:'Sheetsへ送信中',retryable:'再送待ち',uncertain:'反映結果が未確定',reconciling:'再照合中',conflict:'競合・要確認',rejected:'入力確認が必要',applied:'Sheets反映済み'};
function renderSync(root){
  const sync=state.data.sync;
  root.append(h('section',{class:'panel sync-panel'},h('h2',{},sync.enabled?'自動同期は有効です':'手動同期で運用中'),h('p',{class:'muted'},`最終試行 ${dateTime(sync.last_attempt)} / 最終成功 ${dateTime(sync.last_success)}${sync.running?' · 実行中':''}`),sync.error?h('p',{class:'error'},errorText(sync.error)):null,h('p',{class:'muted'},'NAS受付後も、Sheets反映が完了するまでは送信待ちとして保持します。競合は自動上書きしません。')));
  const local=h('section',{class:'panel sync-panel'},h('h2',{},`この端末の送信待ち · ${outbox.length}件`));
  outbox.forEach(item=>local.append(h('div',{class:'operation'},h('strong',{},item.command.entity.description||item.command.entity.name||item.command.entity.id),h('p',{class:item.error?'error':'muted'},item.error||'端末保存済み · NASからの受領応答を待っています。'),h('div',{class:'operation-actions'},button('再試行',()=>act(async()=>{await withQueueLock(()=>persist(outbox.map(x=>x.command.operation_id===item.command.operation_id?{...x,error:null}:x)));void flush();})),item.error?button('最新値と比較して再編集',()=>{state.replaces=item.command.operation_id;editEntity(item.command.entity,currentEntry(item.command.entity),item.command.operation_id);}):null))));
  root.append(local);
  const ops=h('section',{class:'panel sync-panel'},h('h2',{},'NAS受付・Sheets反映'));
  for(const op of state.data.operations){
    const e=op.payload.entity;
    const row=h('article',{class:'operation'},h('div',{class:'operation-head'},h('strong',{},e.description||e.name||e.id),badge(stateLabels[op.state]||op.state,op.state==='applied'?'ok':'warning')),h('p',{class:'muted'},`${dateTime(op.updated_at)} · 試行 ${op.attempts}回`));
    if(op.error_code)row.append(h('p',{class:'error'},errorText(op.error_code)));
    if(['conflict','rejected','uncertain'].includes(op.state)){
      const current=entryByKey(op.entity_key)?.entity;
      row.append(h('div',{class:'comparison'},[['編集前',op.base],['今回の入力',e],['最後に取得したSheets',current]].map(([title,entity])=>h('div',{},h('h3',{},title),h('pre',{},describe(entity))))));
      const actions=h('div',{class:'operation-actions'});
      if(op.state==='uncertain')actions.append(button('同じ操作を再照合',()=>act(async()=>{await api(`/api/ledger/operations/${op.operation_id}/reconcile`,{method:'POST',timeout:95000});await refresh();})));
      else actions.append(button('入力内容を再編集',()=>editEntity(e,currentEntry(e))),button('Sheetsの値を採用',()=>act(async()=>{await api(`/api/ledger/operations/${op.operation_id}/acknowledge`,{method:'POST'});await refresh();})));
      row.append(actions);
    }
    const details=h('details',{},h('summary',{},'操作ID'),h('code',{},op.operation_id));row.append(details);ops.append(row);
  }
  if(!state.data.operations.length)ops.append(h('p',{class:'muted'},'まだ操作履歴はありません。'));
  root.append(ops);
}
async function act(fn){try{await fn();}catch(e){notice(e.message,true);}}
function inputField(name,type,value,options={}){
  const input=h(type==='textarea'?'textarea':'input',{name,id:'field-'+name,...(type!=='textarea'?{type}:{}),...options});
  if(type==='checkbox')input.checked=!!value;else input.value=value??'';
  return h('label',{class:type==='checkbox'?'check-label':options.wide?'wide':''},type==='checkbox'?input:LABELS[name]||name,type==='checkbox'?LABELS[name]||name:input);
}
function selectField(name,value,options){
  const select=h('select',{name,id:'field-'+name});options.forEach(([v,l])=>select.append(h('option',{value:v,selected:v===value},l)));
  return h('label',{},LABELS[name]||name,select);
}
function openEditor(entity,entry,title,fields,replaces=null){
  state.editing={entity:structuredClone(entity),entry};state.replaces=replaces;
  $('#edit-title').textContent=title;$('#edit-fields').replaceChildren(...fields);$('#edit-error').textContent='';
  $('#edit-help').textContent='保存時はまず端末に記録し、NAS受付後にSheetsへ反映します。';
  $('#editor').showModal();
}
function editEntity(e,entry,replaces=null){if(e.kind==='transaction')editTransaction(e,entry,replaces);else if(e.kind==='asset')editAsset(e,entry,replaces);else editMonth(e,entry,replaces);}
function editTransaction(e=null,entry=null,replaces=null){
  e=e||{kind:'transaction',id:uuid(),month:state.month,side:state.tab==='credit'?'credit':'debit',date:today(),category:'',description:'',amount:0,payment:'現金',processed:false,settled_month:'',asset_id:'',voided:false};
  const assets=state.data.entries.filter(i=>i.entity.kind==='asset'&&!i.entity.voided).map(i=>[i.entity.id,i.entity.name]);
  const fields=[selectField('side',e.side,[['debit','借方'],['credit','貸方']]),inputField('month','month',e.month,{required:true}),inputField('date','date',e.date),inputField('amount','number',e.amount,{required:true,step:1,min:-1000000000000,max:1000000000000}),inputField('description','text',e.description,{maxlength:1000,wide:true}),inputField('category','text',e.category,{maxlength:100}),inputField('payment','text',e.payment,{maxlength:100,list:'payments'}),selectField('asset_id',e.asset_id,[['','資産への充当なし'],...assets]),inputField('settled_month','month',e.settled_month),inputField('processed','checkbox',e.processed),inputField('voided','checkbox',e.voided)];
  fields.push(h('datalist',{id:'payments'},['現金','カード','iD','ポイント','振込'].map(v=>h('option',{value:v}))));
  fields.push(h('p',{class:'muted wide'},'日付空欄は同じ側・計上月の直前明細から継承します。資産を選ぶと費目は「固定資産台帳に繰越」になります。精算月は処理した月を記録します。'));
  openEditor(e,entry,entry?'明細を編集':e.asset_id?'予算から資産へ充当':'明細を追加',fields,replaces);
}
function editAllocation(asset){editTransaction({kind:'transaction',id:uuid(),month:state.month,side:'debit',date:today(),category:'固定資産台帳に繰越',description:asset.entity.name,amount:Math.max(1,Math.min(asset.remaining,Math.max(0,state.data.month.remaining))),payment:'現金',processed:true,settled_month:state.month,asset_id:asset.entity.id,voided:false});}
function editAsset(e=null,entry=null,replaces=null){
  e=e||{kind:'asset',id:uuid(),year:state.month.slice(0,4),name:'',acquired_date:today(),cost:0,note:'',voided:false};
  openEditor(e,entry,entry?'固定資産を編集':'固定資産を登録',[inputField('name','text',e.name,{required:true,maxlength:100,wide:true}),inputField('acquired_date','date',e.acquired_date,{required:true}),inputField('cost','number',e.cost,{required:true,min:1,max:1000000000000,step:1}),inputField('note','textarea',e.note,{maxlength:1000,wide:true}),inputField('voided','checkbox',e.voided),h('p',{class:'muted wide'},'取得額を月次支出や貸方へ自動登録しません。充当済みの資産を取り消す場合は、先に充当明細を取り消してください。')],replaces);
}
function editMonth(e=null,entry=null,replaces=null){
  if(!state.data)return;
  // Event handlers may supply a MouseEvent; only explicit month entities count.
  if(e?.kind!=='month'){e=state.data.month.settings;entry=currentEntry(e);}
  openEditor(e,entry,'予算・現金実査',[inputField('budget','number',e.budget,{required:true,min:0,max:1000000000000,step:1}),...CASH_FIELDS.map(k=>inputField(k,'number',e[k],{step:1})),inputField('cash_expected','number',e.cash_expected,{step:1}),inputField('cash_checked_on','date',e.cash_checked_on),inputField('cash_note','textarea',e.cash_note,{maxlength:1000,wide:true})],replaces);
}
$('#edit-form').addEventListener('submit',async ev=>{
  ev.preventDefault();const {entity,entry}=state.editing,form=new FormData(ev.target),e={...entity};
  try{
    for(const field of ev.target.elements){
      if(!field.name||!(field.name in e))continue;
      if(field.type==='checkbox')e[field.name]=field.checked;
      else if(field.type==='number')e[field.name]=moneyInput(String(form.get(field.name)),entity.kind==='month'&&field.name!=='budget');
      else e[field.name]=String(form.get(field.name));
    }
    if(e.kind==='transaction'){
      if(e.asset_id){e.side='debit';e.category='固定資産台帳に繰越';}
      if(!e.processed)e.settled_month='';else if(!e.settled_month)e.settled_month=state.month>e.month?state.month:e.month;
    }
    await queue(e,entry,state.replaces);$('#editor').close();
  }catch(error){$('#edit-error').textContent=error.message;}
});
async function showHistory(e){
  $('#detail-title').textContent='変更履歴';$('#detail-content').replaceChildren(h('p',{class:'muted'},'読み込み中…'));$('#detail').showModal();
  try{const data=await api(`/api/ledger/history/${e.kind}/${encodeURIComponent(e.id)}`);$('#detail-content').replaceChildren(...data.history.map(item=>h('div',{class:'history-item'},h('time',{},dateTime(item.observed_at)),h('pre',{},describe(item.after.entity)))));if(!data.history.length)$('#detail-content').append(h('p',{},'取得済みの変更履歴はありません。'));}
  catch(error){$('#detail-content').replaceChildren(h('p',{class:'error'},error.message));}
}
function showAllocations(item){
  $('#detail-title').textContent=`${item.entity.name} · 充当履歴`;
  $('#detail-content').replaceChildren(...item.allocations.map(e=>h('div',{class:'history-item'},h('strong',{},`${e.month} · ${yen(e.amount)}円${e.voided?' · 取消':''}`),h('p',{class:'muted'},e.description),button('明細を編集',()=>{$('#detail').close();editTransaction(e,currentEntry(e));}),button('変更履歴',()=>{$('#detail').close();void showHistory(e);},{class:'quiet'}))));
  if(!item.allocations.length)$('#detail-content').append(h('p',{class:'muted'},'まだ充当していません。'));
  $('#detail-content').append(button('資産自体の変更履歴',()=>{$('#detail').close();void showHistory(item.entity);},{class:'quiet'}));$('#detail').showModal();
}
root.querySelectorAll('[data-close]').forEach(b=>b.addEventListener('click',()=>root.querySelector('#'+b.dataset.close).close()));
root.querySelectorAll('[data-screen]').forEach(b=>b.addEventListener('click',()=>{state.screen=b.dataset.screen;render();}));
$('#month').value=state.month;$('#month').addEventListener('change',async ev=>{if(!/^\d{4}-(0[1-9]|1[0-2])$/.test(ev.target.value))return;state.month=ev.target.value;state.data=null;notice('');await refresh();});
$('#add').addEventListener('click',()=>state.screen==='assets'?editAsset():editTransaction());
$('#sync-now').addEventListener('click',()=>act(async()=>{await flush();await api('/api/ledger/sync',{method:'POST'});notice('NASに同期を依頼しました。反映状況は自動で更新します。');setTimeout(refresh,1500);}));
$('#endpoint').value=transport.endpoint || 'https://ledger.home.misacanetworks.com';
$('#reconnect').addEventListener('click',()=>showLogin('現在のNASに再接続すると、保存した送信待ちを再送します。'));
$('#login-form').addEventListener('submit',async ev=>{
  ev.preventDefault();const input=$('#access-key'),save=ev.target.querySelector('button[type=submit]');
  if(save.disabled)return;save.disabled=true;
  try{
    await withQueueLock(async()=>{
      const next=new URL($('#endpoint').value).origin;
      if(next!==transport.endpoint && (outbox.length || state.data?.operations.some(o=>o.state!=='applied'&&!o.acknowledged)))throw new Error('送信待ちがあります。現在の接続先と同じNASで同期を完了してください。');
      await transport.connect($('#endpoint').value,input.value);
      STORAGE=transport.storagePrefix;outbox=load('outbox',[]);state.data=null;state.loggedIn=true;
    });
    input.value='';await refresh();await flush();
  }catch(error){$('#login-message').textContent=error instanceof TypeError ? 'NASに接続できません。HTTPSの名前解決と、NAS v0.3.0以降のmini-app配信元設定を確認してください。' : error.message;}
  finally{save.disabled=false;}
});
$('#logout').addEventListener('click',()=>act(async()=>{
  await withQueueLock(()=>{
    if(outbox.length)throw new Error('この端末に未送信の入力があります。現在の接続先で同期を完了してください。');
    transport.disconnect();state.loggedIn=false;state.online=false;state.data=null;
    showLogin('接続を解除しました。保存済み表示と履歴はこの端末に保持しています。');setConnection('未ログイン',false);
  });
}));
$('#open-offline').addEventListener('click',()=>{state.data=load('cache.'+state.month,null);state.online=false;showApp();render();notice('保存済み表示です。送信するには再接続・ログインが必要です。',false,'connection');});
async function resume(){
  if(!state.loggedIn)return;
  if(state.loggedIn)await flush();
}
window.addEventListener('online',()=>void resume());
window.addEventListener('focus',()=>{if(!$('#editor').open)void resume();});
document.addEventListener('visibilitychange',()=>{if(!document.hidden&&!$('#editor').open)void resume();});
setInterval(()=>{if(!document.hidden&&!$('#editor').open)void resume();},15000);
async function withQueueLock(work){
  if(!navigator.locks){throw new Error('このブラウザーでは安全な送信待ちの保存を利用できません。Edge・Chrome・Safariを更新してください。');}
  return navigator.locks.request('mini-ledger:'+STORAGE,async()=>{
    outbox=load('outbox',[]);
    if(!Array.isArray(outbox))throw new Error('端末の送信待ちを読み取れません。保存データは保持しています。');
    return work();
  });
}
window.addEventListener('storage',event=>{if(event.key===STORAGE+'outbox'){outbox=load('outbox',[]);if(state.data&&!$('#editor').open)render();}});
showLogin('家計簿のHTTPS接続先とアクセスキーを指定してください。キーは保存しません。');
setConnection('未ログイン',false);
}
