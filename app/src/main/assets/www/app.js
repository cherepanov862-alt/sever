'use strict';
/* =====================================================================
   Севермакс — пульт для предпускового подогревателя 5000 4-mini.
   SMS-команды по руководству пользователя:
     K           — запуск (по умолчанию 30 минут)       → HEATER ON OK!
     K*XXX       — запуск на XXX минут, однократно (K*040)
     G           — остановка                            → HEATER OFF OK!
     C           — статус работы
     NFPZ*XX     — температура нагрева (или CGPZ*XX, зависит от прошивки), без запуска
     XHPZ*ВЕРХ*НИЗ — пороги режима догрева, затем K       → XHPZ OK!
     XHPZ OFF    — отключить режим догрева
     TJSQ*код*A  — привязка номера (слоты A, B, C, D)   → ADDAUTH OK!
   ===================================================================== */

const $ = id => document.getElementById(id);
const isApp = !!(window.Android && typeof window.Android.sendSms === 'function');
const DONATE_NUMBER = '+79132814135';
const RESTART_PAUSE = 3 * 60 * 1000;

const ERR = {
  'E-01': ['Ненормальное напряжение', 'Проверьте напряжение аккумулятора.'],
  'E-02': ['Неисправность нагнетателя', 'Проверьте жгуты на обрывы и замыкания, работу вентилятора, загрязнение и свободный ход. При необходимости замените.'],
  'E-03': ['Неисправность топливного насоса', 'Проверьте жгуты на обрывы и замыкания, выполните проверку топливного насоса. При необходимости замените.'],
  'E-04': ['Неисправность жидкостного насоса', 'Проверьте жгуты, выполните проверку насоса, почистите насосную часть помпы. При необходимости замените.'],
  'E-05': ['Срыв пламени', 'Если часто (больше 10 раз): забор воздуха и отвод выхлопных газов, топливная система, насос-дозатор, штифт накала.'],
  'E-06': ['Неисправность датчика пламени', 'Проверьте жгуты и сопротивление датчика пламени. При необходимости замените.'],
  'E-07': ['Неисправность штифта накала', 'Проверьте жгуты на обрывы и замыкания, выполните проверку штифта накала. При необходимости замените.'],
  'E-08': ['Сбой вторичного запуска', 'Если часто (больше 5 раз): забор воздуха и отвод выхлопных газов, топливная система, насос-дозатор, штифт накала.'],
  'E-09': ['Неисправность датчика температуры жидкости', 'Проверьте жгуты и сопротивление датчика. При необходимости замените.'],
  'E-10': ['Перегрев корпуса подогревателя', 'Проверьте жгуты и сопротивление датчика пламени. При необходимости замените.'],
  'E-11': ['Перегрев охлаждающей жидкости', 'Проверьте уровень и качество антифриза, удалите воздух из контура, проверьте циркуляционный насос и датчик температуры (E-09).'],
  'E-12': ['Нет связи брелока с салонным пультом', 'Проверьте антенну салонного пульта, привязку брелока и расстояние — не более 100 м прямой видимости.']
};

/* ---------------- Хранилище ---------------- */
const store = {
  get(k, d){ try{ const v = localStorage.getItem('smx_' + k); return v === null ? d : JSON.parse(v); }catch(e){ return d; } },
  set(k, v){ try{ localStorage.setItem('smx_' + k, JSON.stringify(v)); return true; }catch(e){ toast('Не хватает памяти для сохранения', true); return false; } }
};

let settings = Object.assign({ number:'', fw:'NFPZ', authCode:'123456' }, store.get('settings', {}));
let car      = Object.assign({ brand:'', model:'', plate:'' }, store.get('car', {}));
let heater   = Object.assign({ mode:'unknown', ts:0, until:0, code:'', boostArmed:false, lastStop:0, lastRun:30, csq:null }, store.get('heater', {}));
let journal  = store.get('journal', []);
let lastReply = store.get('lastReply', null);
let chain = null;
let jFilter = 'all';

function saveSettings(){ store.set('settings', settings); if(isApp && Android.setHeaterNumber) Android.setHeaterNumber(settings.number || ''); }
function saveHeater(){ store.set('heater', heater); }
function saveJournal(){ if(journal.length > 300) journal = journal.slice(-300); store.set('journal', journal); }

/* ---------------- Утилиты ---------------- */
function esc(s){ return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
const pad = n => String(n).padStart(2, '0');
function hhmm(ts){ const d = new Date(ts); return pad(d.getHours()) + ':' + pad(d.getMinutes()); }
function dayLabel(ts){
  const d = new Date(ts); d.setHours(0,0,0,0);
  const t = new Date(); t.setHours(0,0,0,0);
  const diff = Math.round((t - d) / 86400000);
  if(diff === 0) return 'Сегодня'; if(diff === 1) return 'Вчера';
  return pad(d.getDate()) + '.' + pad(d.getMonth() + 1) + '.' + d.getFullYear();
}
function when(ts){ const l = dayLabel(ts); return (l === 'Сегодня' ? '' : l + ', ') + hhmm(ts); }
function fmtNumber(n){
  const d = String(n || '').replace(/\D/g, '');
  if(d.length === 11 && (d[0] === '7' || d[0] === '8')) return '+7 ' + d.slice(1,4) + ' ' + d.slice(4,7) + '-' + d.slice(7,9) + '-' + d.slice(9);
  return n;
}
let toastT;
function toast(msg, bad){
  const t = $('toast'); t.textContent = msg; t.classList.toggle('bad', !!bad); t.classList.add('show');
  clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove('show'), bad ? 3800 : 2200);
}
function copyText(text, msg){
  const done = () => toast(msg || 'Скопировано');
  if(isApp && Android.copyText){ Android.copyText(text); done(); return; }
  if(navigator.clipboard && navigator.clipboard.writeText){ navigator.clipboard.writeText(text).then(done, () => fallbackCopy(text, done)); }
  else fallbackCopy(text, done);
}
function fallbackCopy(text, done){
  const ta = document.createElement('textarea'); ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
  document.body.appendChild(ta); ta.select();
  try{ document.execCommand('copy'); done(); }catch(e){ toast(text); }
  ta.remove();
}

/* ---------------- Нижний лист / диалоги ---------------- */
let sheetResolve = null;
function openSheet(html){
  $('sheet').innerHTML = '<div class="grab"></div>' + html;
  $('sheetBg').classList.add('show');
}
function closeSheet(result){
  $('sheetBg').classList.remove('show');
  $('sheet').innerHTML = '';
  const r = sheetResolve; sheetResolve = null;
  if(r) r(result);
}
$('sheetBg').addEventListener('click', e => { if(e.target === $('sheetBg')) closeSheet(false); });

function ask(o){
  return new Promise(res => {
    openSheet(`<h3>${esc(o.title)}</h3><p>${esc(o.text)}</p>
      <button class="btn btn-solid" style="--c:${o.color || 'var(--heat)'}" onclick="closeSheet(true)">${esc(o.ok || 'OK')}</button>
      ${o.cancel === false ? '' : `<button class="btn btn-ghost" style="margin-top:8px" onclick="closeSheet(false)">${esc(o.cancel || 'Отмена')}</button>`}`);
    sheetResolve = res;
  });
}
function askText(o){
  return new Promise(res => {
    openSheet(`<h3>${esc(o.title)}</h3>
      <div class="field"><input class="input" id="askInput" placeholder="${esc(o.placeholder || '')}" value="${esc(o.value || '')}"></div>
      <button class="btn btn-solid" onclick="closeSheet(document.getElementById('askInput').value.trim())">${esc(o.ok || 'Готово')}</button>
      <button class="btn btn-ghost" style="margin-top:8px" onclick="closeSheet(null)">Отмена</button>`);
    sheetResolve = v => res(v === false ? null : v);
    setTimeout(() => { const i = $('askInput'); if(i) i.focus(); }, 60);
  });
}

/* ---------------- Вкладки и кнопка «Назад» ---------------- */
let currentTab = 'v-control';
function switchTab(id){
  currentTab = id;
  document.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t.dataset.view === id));
  document.querySelectorAll('.view').forEach(v => v.classList.toggle('active', v.id === id));
  window.scrollTo(0, 0);
  if(id === 'v-journal'){ $('errDot').hidden = true; store.set('errSeen', Date.now()); }
}
window.handleBack = function(){
  if($('sheetBg').classList.contains('show')){ closeSheet(false); return true; }
  if(currentTab !== 'v-control'){ switchTab('v-control'); return true; }
  return false;
};

/* ---------------- Отправка SMS ---------------- */
const CMD = {
  start: () => 'K',
  startFor: m => 'K*' + String(m).padStart(3, '0'),
  stop: () => 'G',
  status: () => 'C',
  temp: t => settings.fw + '*' + t,
  boost: (hi, lo) => 'XHPZ*' + hi + '*' + lo,
  boostOff: () => 'XHPZ OFF',
  bind: (code, slot) => 'TJSQ*' + code + '*' + slot
};

let seq = 0;
function newId(){ return Date.now().toString(36) + '-' + (++seq); }

function sendCommand(cmd, label){
  if(!settings.number){
    switchTab('v-control'); renderSetup(true);
    toast('Сначала укажите номер SIM подогревателя', true);
    setTimeout(() => $('setupNumber').focus(), 100);
    return null;
  }
  const id = newId();
  addEntry({ id, dir:'out', title:label, cmd, status:'wait', ts:Date.now() });
  if(isApp){
    Android.sendSms(settings.number, cmd, id);
  } else {
    setTimeout(() => window.onSmsStatus(id, true, 'Демо'), 500);
    setTimeout(() => demoReply(cmd), 1800);
  }
  return id;
}

/** Вызывается приложением после попытки отправки SMS. */
window.onSmsStatus = function(id, ok, msg){
  const e = journal.find(x => x.id === id);
  if(e){ e.status = ok ? 'ok' : 'fail'; if(!ok) e.note = msg; saveJournal(); renderJournal(); }
  if(!ok){
    toast('SMS не отправлено: ' + msg, true);
    if(chain && chain.srcId === id) cancelChain();
    return;
  }
  if(e) afterSent(e.cmd, e.ts);
  if(chain && chain.srcId === id && chain.afterSent){
    const c = chain;
    c.timer = setTimeout(() => runChain(c), c.delay);
  }
};

function afterSent(cmd, ts){
  if(cmd === 'K' || /^K\*\d+$/.test(cmd)){
    heater.lastRun = cmd === 'K' ? 30 : parseInt(cmd.slice(2), 10);
    heater.mode = 'starting'; heater.ts = ts;
  } else if(cmd === 'G'){
    heater.mode = 'stopping'; heater.ts = ts; heater.lastStop = ts;
  } else if(cmd === 'XHPZ OFF'){
    heater.boostArmed = false;
  }
  saveHeater(); renderState();
}

/* ---------------- Цепочки из двух команд ---------------- */
function startChain(c){
  cancelChain();
  chain = c;
  if(c.timeout) c.to = setTimeout(() => chainTimeout(c), c.timeout);
  renderChain();
}
function runChain(c){
  if(chain !== c) return;
  clearTimeout(c.to); clearTimeout(c.timer);
  chain = null; renderChain();
  sendCommand(c.cmd, c.label);
}
function cancelChain(){
  if(chain){ clearTimeout(chain.to); clearTimeout(chain.timer); }
  chain = null; renderChain();
}
async function chainTimeout(c){
  if(chain !== c) return;
  const go = await ask({ title:'Ответ не пришёл', text:'Подогреватель пока не подтвердил настройку. Отправить команду запуска K всё равно?', ok:'Отправить K', cancel:'Не отправлять' });
  if(go) runChain(c); else if(chain === c) cancelChain();
}
function renderChain(){
  ['temp', 'boost'].forEach(w => {
    const box = $('chain-' + w);
    box.innerHTML = (chain && chain.where === w)
      ? `<div class="chain"><div class="spin"></div><div>${esc(chain.text)}</div><a onclick="cancelChain()">Отменить</a></div>` : '';
  });
}

/* ---------------- Действия кнопок ---------------- */
async function guardStart(){
  const left = RESTART_PAUSE - (Date.now() - (heater.lastStop || 0));
  if(left <= 0) return true;
  const s = Math.ceil(left / 1000), m = Math.floor(s / 60), r = s % 60;
  const t = [m ? m + ' мин' : '', r ? r + ' с' : ''].filter(Boolean).join(' ');
  return ask({ title:'Рано для повторного запуска', text:`После выключения подогреватель можно запустить не раньше чем через 3 минуты. Осталось ${t}.`, ok:'Всё равно отправить', cancel:'Подождать' });
}
async function actStart(){ if(await guardStart()) sendCommand(CMD.start(), 'Запуск'); }
function actStop(){ sendCommand(CMD.stop(), 'Остановка'); }
function actStatus(){ sendCommand(CMD.status(), 'Запрос статуса'); }
async function actStartFor(){
  const m = +$('durRange').value;
  if(await guardStart()) sendCommand(CMD.startFor(m), 'Запуск на ' + m + ' мин');
}
function actSetTemp(){
  const t = +$('tempRange').value;
  sendCommand(CMD.temp(t), 'Температура ' + t + '°C');
}
async function actSetTempStart(){
  const t = +$('tempRange').value;
  if(!await guardStart()) return;
  const id = sendCommand(CMD.temp(t), 'Температура ' + t + '°C');
  if(id) startChain({ srcId:id, afterSent:true, delay:5000, cmd:'K', label:'Запуск', where:'temp',
    text:'Температура ' + t + '°C отправлена — через несколько секунд отправим K' });
}
async function actBoost(){
  const hi = +$('hiRange').value, lo = +$('loRange').value;
  if(hi - lo < 10){ toast('Разница между порогами должна быть не меньше 10°C', true); return; }
  if(!await guardStart()) return;
  const id = sendCommand(CMD.boost(hi, lo), 'Догрев ' + lo + '…' + hi + '°C');
  if(id) startChain({ srcId:id, waitReply:/XHPZ\s*OK/i, timeout:120000, cmd:'K', label:'Запуск в режиме догрева', where:'boost',
    text:'Ждём ответ «XHPZ OK!», затем отправим K' });
}
function actBoostOff(){ sendCommand(CMD.boostOff(), 'Догрев выключен'); }
function actBind(slot){
  const code = ($('authInput').value || '').trim();
  if(!/^\d{4,8}$/.test(code)){ toast('Код привязки — от 4 до 8 цифр', true); return; }
  settings.authCode = code; saveSettings();
  sendCommand(CMD.bind(code, slot), 'Привязка номера, слот ' + slot);
}

/* ---------------- Разбор ответов подогревателя ---------------- */
const KEY_NAMES = { 'UP TEM':'Верхний порог', 'DOWN TEM':'Нижний порог', 'CSQ':'Сигнал GSM', 'TEM':'Температура', 'TEMP':'Температура',
  'VOL':'Напряжение', 'VOLT':'Напряжение', 'VOLTAGE':'Напряжение', 'TIME':'Время', 'RUN TIME':'Время работы', 'MODE':'Режим' };
function parsePairs(text){
  const out = [];
  text.split(/\r?\n/).forEach(line => {
    const m = line.match(/^\s*([A-Za-zА-Яа-я][A-Za-zА-Яа-я0-9 ._\-/]{0,20}?)\s*[:=]\s*(.+?)\s*$/);
    if(!m) return;
    const key = m[1].trim().toUpperCase();
    const val = m[2].replace(/dC\b/g, '°C').replace(/\s+/g, ' ');
    out.push({ key, name: KEY_NAMES[key] || m[1].trim(), val });
  });
  return out;
}
function csqBars(csq){ if(csq == null || csq === 99) return -1; return csq >= 20 ? 4 : csq >= 15 ? 3 : csq >= 10 ? 2 : csq >= 2 ? 1 : 0; }

function parseReply(body, ts){
  const text = String(body || '').trim();
  if(!text) return;
  ts = ts || Date.now();
  const pairs = parsePairs(text);
  const csqPair = pairs.find(p => p.key === 'CSQ');
  if(csqPair){ const n = parseInt(csqPair.val, 10); if(!isNaN(n)) heater.csq = n; }

  let level = 'ok', title = 'Ответ подогревателя', rec = '';
  const em = text.match(/\bE-?(0[1-9]|1[0-2])\b/i);
  if(em){
    const code = 'E-' + em[1];
    level = 'err'; title = code + ' · ' + ERR[code][0]; rec = ERR[code][1];
    heater.mode = 'err'; heater.code = code; heater.ts = ts;
  } else if(/HEATER\s*ON\s*OK/i.test(text)){
    title = heater.boostArmed ? 'Запущен в режиме догрева' : 'Подогреватель запущен';
    heater.mode = heater.boostArmed ? 'boost' : 'on'; heater.ts = ts;
    heater.until = heater.boostArmed ? 0 : ts + (heater.lastRun || 30) * 60000;
  } else if(/HEATER\s*OFF\s*OK/i.test(text)){
    title = 'Подогреватель остановлен';
    if(heater.mode === 'boost') heater.boostArmed = false;
    heater.mode = 'off'; heater.ts = ts; heater.lastStop = ts;
  } else if(/XHPZ\s*OK/i.test(text)){
    title = 'Режим догрева настроен'; heater.boostArmed = true;
  } else if(/ADDAUTH\s*OK/i.test(text)){
    title = 'Номер привязан к подогревателю';
  }

  addEntry({ id:newId(), dir:'in', title, raw:text, rec, level, ts });
  lastReply = { text, ts, pairs, title, level }; store.set('lastReply', lastReply);
  saveHeater(); renderState(); renderReply();

  if(level === 'err'){
    toast(title, true);
    if(currentTab !== 'v-journal') $('errDot').hidden = false;
  }
  if(chain && chain.waitReply && chain.waitReply.test(text)) runChain(chain);
}

/** Приложение сообщает, что пришли новые SMS от подогревателя. */
window.pullInbox = function(){
  if(!isApp || !Android.takeInbox) return;
  let arr = [];
  try{ arr = JSON.parse(Android.takeInbox() || '[]'); }catch(e){}
  arr.forEach(m => parseReply(m.body, m.ts));
};

function demoReply(cmd){
  const m = cmd.match(/^XHPZ\*(\d+)\*(\d+)$/);
  if(m) return parseReply(`XHPZ OK!\nUP TEM: ${m[1]}dC\nDOWN TEM: ${m[2]}dC\nCSQ: 20`);
  if(cmd === 'K' || /^K\*/.test(cmd)) return parseReply('HEATER ON OK!\nCSQ: 22');
  if(cmd === 'G') return parseReply('HEATER OFF OK!\nCSQ: 22');
  if(cmd === 'C') return parseReply('(демо) пример ответа\nTEM: 34dC\nCSQ: 21');
  if(/^TJSQ/.test(cmd)) return parseReply('ADDAUTH OK!');
}

/* ---------------- Журнал ---------------- */
function addEntry(e){ journal.push(e); saveJournal(); renderJournal(); }
function renderJournal(){
  const list = journal.filter(e => jFilter === 'all' || (jFilter === 'err' ? (e.level === 'err' || e.status === 'fail') : e.dir === jFilter)).slice().reverse();
  if(!list.length){
    $('jlist').innerHTML = `<div class="empty">${journal.length ? 'Нет записей с этим фильтром.' : 'Здесь появятся отправленные команды и ответы подогревателя.'}</div>`;
    return;
  }
  const icOut = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M12 19V5M6 11l6-6 6 6"/></svg>';
  const icIn  = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M12 5v14M6 13l6 6 6-6"/></svg>';
  const icErr = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M12 7v6M12 17h.01"/></svg>';
  let html = '', lastDay = '';
  list.forEach(e => {
    const d = dayLabel(e.ts);
    if(d !== lastDay){ html += `<div class="jday">${d}</div>`; lastDay = d; }
    const isErr = e.level === 'err' || e.status === 'fail';
    let meta = hhmm(e.ts);
    if(e.dir === 'out'){
      meta += ` · <span class="mono">${esc(e.cmd)}</span>`;
      meta += e.status === 'ok' ? ' · <span class="st ok">отправлено</span>'
            : e.status === 'fail' ? ` · <span class="st fail">не отправлено${e.note ? ': ' + esc(e.note) : ''}</span>`
            : ' · <span class="st wait">отправляется…</span>';
    }
    html += `<div class="je ${e.dir}${isErr ? ' err' : ''}">
      <div class="je-ic">${isErr ? icErr : e.dir === 'out' ? icOut : icIn}</div>
      <div class="je-body"><div class="je-t">${esc(e.title)}</div><div class="je-m">${meta}</div>
      ${e.rec ? `<div class="je-rec">${esc(e.rec)}</div>` : ''}
      ${e.raw ? `<div class="je-raw">${esc(e.raw)}</div>` : ''}</div></div>`;
  });
  $('jlist').innerHTML = html;
}
async function clearJournal(){
  if(!journal.length) return;
  if(await ask({ title:'Очистить журнал?', text:'Все записи о командах и ответах будут удалены.', ok:'Очистить', cancel:'Отмена', color:'var(--bad)' })){
    journal = []; saveJournal(); renderJournal(); toast('Журнал очищен');
  }
}
$('filters').addEventListener('click', e => {
  const b = e.target.closest('button'); if(!b) return;
  jFilter = b.dataset.f;
  document.querySelectorAll('#filters button').forEach(x => x.classList.toggle('on', x === b));
  renderJournal();
});
function renderCodes(){
  $('codeList').innerHTML = Object.keys(ERR).map(k => `<div class="code-row"><b>${k}</b>${esc(ERR[k][0])}<p>${esc(ERR[k][1])}</p></div>`).join('');
}

/* ---------------- Состояние на главном экране ---------------- */
function renderState(){
  const pill = $('statePill'); let cls = '', txt = 'Нет данных — нажмите «Статус»';
  const now = Date.now();
  switch(heater.mode){
    case 'starting': cls = 'wait'; txt = 'Запуск отправлен, ждём ответ'; break;
    case 'stopping': cls = 'wait'; txt = 'Остановка отправлена'; break;
    case 'on':
      if(heater.until && heater.until > now){ cls = 'on'; txt = 'Работает · примерно до ' + hhmm(heater.until); }
      else { txt = 'Вероятно, выключился по таймеру'; }
      break;
    case 'boost': cls = 'boost'; txt = 'Режим догрева'; break;
    case 'off': txt = 'Выключен · ' + when(heater.ts); break;
    case 'err': cls = 'err'; txt = 'Ошибка ' + heater.code; break;
  }
  pill.className = 'pill ' + cls; $('stateText').textContent = txt;
  const bars = csqBars(heater.csq);
  $('signalPill').hidden = bars < 0;
  if(bars >= 0) document.querySelectorAll('#signalBars b').forEach((b, i) => b.classList.toggle('on', i < bars));
}
function renderReply(){
  const box = $('replyBox');
  if(!lastReply){ box.innerHTML = '<div class="empty">Ответов пока нет. Нажмите «Обновить», чтобы запросить статус (SMS «C»).</div>'; return; }
  const kv = lastReply.pairs.length ? `<div class="kv">${lastReply.pairs.map(p => `<div><b>${esc(p.val)}</b><span>${esc(p.name)}</span></div>`).join('')}</div>` : '';
  box.innerHTML = `<div class="sub" style="margin-top:4px;${lastReply.level === 'err' ? 'color:#FF8A80;font-weight:700' : ''}">${esc(lastReply.title)} · ${when(lastReply.ts)}</div>${kv}<div class="raw">${esc(lastReply.text)}</div>`;
}
function renderSetup(force){ $('setupCard').hidden = !(force || !settings.number); }
function saveSetupNumber(){
  const v = $('setupNumber').value.trim();
  if(String(v).replace(/\D/g, '').length < 10){ toast('Похоже, номер неполный', true); return; }
  settings.number = v; saveSettings(); $('numberInput').value = v; renderSetup(false); toast('Номер сохранён');
}

/* ---------------- Ползунки ---------------- */
function fill(el){ el.style.setProperty('--p', ((el.value - el.min) / (el.max - el.min) * 100) + '%'); }
function updDur(){ const v = $('durRange').value; $('durVal').textContent = v; $('durBtn').textContent = v; $('durCmd').textContent = CMD.startFor(v); fill($('durRange')); store.set('dur', +v); }
function updTemp(){ const v = $('tempRange').value; $('tempVal').textContent = v; $('tempCmd').textContent = CMD.temp(v); fill($('tempRange')); store.set('temp', +v); }
function updBoost(src){
  let hi = +$('hiRange').value, lo = +$('loRange').value;
  if(hi - lo < 10){  // двигаем второй ползунок, чтобы разница оставалась ≥ 10°C
    if(src === 'hi'){ lo = Math.max(30, hi - 10); if(hi - lo < 10) hi = lo + 10; }
    else { hi = Math.min(90, lo + 10); if(hi - lo < 10) lo = hi - 10; }
    $('hiRange').value = hi; $('loRange').value = lo;
  }
  fill($('hiRange')); fill($('loRange'));
  const pos = v => ((v - 30) / 60 * 100);
  $('bandFill').style.left = pos(lo) + '%'; $('bandFill').style.width = (pos(hi) - pos(lo)) + '%';
  $('bandLo').textContent = lo + '°'; $('bandHi').textContent = hi + '°';
  $('bandLo').style.left = `calc(${pos(lo)}% + 2px)`; $('bandLo').style.right = '';
  $('bandHi').style.right = `calc(${100 - pos(hi)}% + 2px)`;
  $('boostCmd').textContent = CMD.boost(hi, lo);
  store.set('boost', { hi, lo });
}

/* ---------------- Автомобиль ---------------- */
const norm = s => String(s).toLowerCase().replace(/ё/g, 'е');
const BRANDS = Object.keys(CARS);
function renderCar(){
  $('brandText').textContent = car.brand || 'Выберите марку'; $('brandText').className = car.brand ? '' : 'ph';
  $('modelText').textContent = car.model || 'Выберите модель'; $('modelText').className = car.model ? '' : 'ph';
  $('plateInput').value = car.plate || '';
  const name = [car.brand, car.model].filter(Boolean).join(' ');
  const hasPhoto = !!store.get('photo', null);
  $('heroCar').innerHTML = name ? esc(name) + (hasPhoto ? '' : '<small>Нажмите, чтобы добавить фото</small>')
                                : 'Выберите автомобиль<small>и добавьте фото — нажмите сюда</small>';
  $('heroPlate').hidden = !car.plate; $('heroPlate').textContent = car.plate || '';
}
function renderPhoto(){
  const p = store.get('photo', null);
  $('heroImg').hidden = !p; $('heroPh').hidden = !!p;
  if(p) $('heroImg').src = p; else $('heroImg').removeAttribute('src');
  $('photoDel').hidden = !p; $('photoBtnText').textContent = p ? 'Заменить' : 'Добавить фото';
}
$('photoInput').addEventListener('change', e => {
  const file = e.target.files && e.target.files[0]; e.target.value = '';
  if(!file) return;
  const reader = new FileReader();
  reader.onload = ev => {
    const img = new Image();
    img.onload = () => {
      const max = 1280, k = Math.min(1, max / Math.max(img.width, img.height));
      const c = document.createElement('canvas'); c.width = Math.round(img.width * k); c.height = Math.round(img.height * k);
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      if(store.set('photo', c.toDataURL('image/jpeg', 0.8))){ renderPhoto(); renderCar(); toast('Фото сохранено'); }
    };
    img.onerror = () => toast('Не удалось открыть изображение', true);
    img.src = ev.target.result;
  };
  reader.readAsDataURL(file);
});
async function removePhoto(){
  if(await ask({ title:'Удалить фото?', text:'На главном экране снова будет рисунок машины.', ok:'Удалить', color:'var(--bad)' })){
    try{ localStorage.removeItem('smx_photo'); }catch(e){}
    renderPhoto(); renderCar();
  }
}
$('plateInput').addEventListener('input', e => { car.plate = e.target.value.toUpperCase(); store.set('car', car); renderCar(); });

function openBrandPicker(){
  openSheet(`<div class="sheet-head"><h3>Марка автомобиля</h3><button class="x" onclick="closeSheet(false)" aria-label="Закрыть">✕</button></div>
    <div class="field" style="margin-top:12px"><input class="input" id="pickSearch" placeholder="Поиск: Тойота, Лада, Haval, Camry…" autocomplete="off"></div>
    <div class="pick-list" id="pickList"></div>`);
  $('pickSearch').addEventListener('input', e => renderBrandList(e.target.value));
  renderBrandList('');
}
function renderBrandList(q){
  q = norm(q.trim());
  const item = (b, i) => `<button class="pick${b === car.brand ? ' sel' : ''}" onclick="pickBrand(${i})">${esc(b)}<small>${CARS[b].length} мод.</small></button>`;
  let html = '';
  if(!q){
    html += '<div class="pick-group">Популярные</div>' + CAR_POPULAR.filter(b => CARS[b]).map(b => item(b, BRANDS.indexOf(b))).join('');
    html += '<div class="pick-group">Все марки</div>' + BRANDS.map(b => b).sort((a, b) => a.localeCompare(b, 'ru'))
      .map(b => item(b, BRANDS.indexOf(b))).join('');
  } else {
    const brands = BRANDS.filter(b => norm(b).includes(q) || norm(CAR_ALIASES[b] || '').includes(q));
    html += brands.map(b => item(b, BRANDS.indexOf(b))).join('');
    const models = [];
    BRANDS.forEach((b, bi) => CARS[b].forEach((m, mi) => { if(models.length < 40 && norm(m).includes(q)) models.push([b, m, bi, mi]); }));
    if(models.length) html += '<div class="pick-group">Модели</div>' + models.map(([b, m, bi, mi]) =>
      `<button class="pick" onclick="pickBrandModel(${bi},${mi})">${esc(m)}<small>${esc(b)}</small></button>`).join('');
    if(!brands.length && !models.length) html += '<div class="empty">Ничего не найдено</div>';
  }
  html += '<button class="pick add" onclick="customBrand()">+ Другая марка</button>';
  $('pickList').innerHTML = html;
}
function pickBrand(i){
  const b = BRANDS[i];
  if(car.brand !== b){ car.brand = b; car.model = ''; }
  store.set('car', car); renderCar(); closeSheet(true);
  setTimeout(openModelPicker, 120);
}
function pickBrandModel(bi, mi){
  car.brand = BRANDS[bi]; car.model = CARS[car.brand][mi];
  store.set('car', car); renderCar(); closeSheet(true); toast(car.brand + ' ' + car.model);
}
async function customBrand(){
  closeSheet(false);
  const b = await askText({ title:'Марка автомобиля', placeholder:'Например: Hummer', value:'' });
  if(!b) return;
  car.brand = b; car.model = ''; store.set('car', car); renderCar();
  const m = await askText({ title:'Модель ' + b, placeholder:'Например: H2' });
  if(m){ car.model = m; store.set('car', car); renderCar(); }
}
function openModelPicker(){
  if(!car.brand){ openBrandPicker(); return; }
  const models = CARS[car.brand] || [];
  openSheet(`<div class="sheet-head"><h3>${esc(car.brand)}: модель</h3><button class="x" onclick="closeSheet(false)" aria-label="Закрыть">✕</button></div>
    ${models.length > 8 ? '<div class="field" style="margin-top:12px"><input class="input" id="pickSearch" placeholder="Поиск модели" autocomplete="off"></div>' : ''}
    <div class="pick-list" id="pickList"></div>`);
  const draw = q => {
    q = norm(q.trim());
    $('pickList').innerHTML = models.map((m, i) => [m, i]).filter(([m]) => !q || norm(m).includes(q))
      .map(([m, i]) => `<button class="pick${m === car.model ? ' sel' : ''}" onclick="pickModel(${i})">${esc(m)}</button>`).join('')
      + '<button class="pick add" onclick="customModel()">+ Своя модель</button>';
  };
  if($('pickSearch')) $('pickSearch').addEventListener('input', e => draw(e.target.value));
  draw('');
}
function pickModel(i){ car.model = CARS[car.brand][i]; store.set('car', car); renderCar(); closeSheet(true); toast(car.brand + ' ' + car.model); }
async function customModel(){
  closeSheet(false);
  const m = await askText({ title:'Модель ' + car.brand, placeholder:'Название модели', value: car.model });
  if(m){ car.model = m; store.set('car', car); renderCar(); }
}

/* ---------------- Настройки ---------------- */
function setFw(fw){
  settings.fw = fw; saveSettings();
  $('fwNFPZ').classList.toggle('on', fw === 'NFPZ'); $('fwCGPZ').classList.toggle('on', fw === 'CGPZ');
  updTemp(); renderCmdList();
}
function renderCmdList(){
  const rows = [
    ['K', 'Запуск (30 мин)'], ['K*040', 'Запуск на 40 минут'], ['G', 'Остановка'], ['C', 'Статус работы'],
    [settings.fw + '*65', 'Температура 65°C'], ['XHPZ*90*30', 'Догрев 30…90°C, затем K'],
    ['XHPZ OFF', 'Выключить догрев'], ['TJSQ*123456*A', 'Привязка номера, слоты A–D']
  ];
  $('cmdList').innerHTML = rows.map(r => `<div class="cmd-item" onclick="copyText('${r[0]}','Скопировано: ${r[0]}')"><b class="mono">${r[0]}</b><span>${r[1]}</span></div>`).join('');
}
$('numberInput').addEventListener('change', e => {
  settings.number = e.target.value.trim(); saveSettings(); renderSetup(false);
  $('setupNumber').value = settings.number; toast(settings.number ? 'Номер сохранён' : 'Номер удалён');
});

/* ---------------- Донат ---------------- */
function copyDonate(){ copyText(DONATE_NUMBER, 'Номер скопирован: ' + fmtNumber(DONATE_NUMBER)); }
function openDonate(){
  openSheet(`<div class="sheet-head"><h3>Поддержи разработку</h3><button class="x" onclick="closeSheet(false)" aria-label="Закрыть">✕</button></div>
    <p>Приложение бесплатное и без рекламы. Если оно помогает вам зимой — поддержите автора переводом по номеру телефона через СБП в любом банке.</p>
    <div class="donate-num" style="text-align:center">${fmtNumber(DONATE_NUMBER)}</div>
    <button class="btn btn-solid" style="--c:#FF6B61" onclick="copyDonate()">Скопировать номер</button>
    <button class="btn btn-ghost" style="margin-top:8px" onclick="closeSheet(false)">Закрыть</button>`);
}

/* ---------------- Запуск ---------------- */
(function init(){
  $('demoBar').hidden = isApp;
  const nModels = BRANDS.reduce((n, b) => n + CARS[b].length, 0);
  $('carDbHint').textContent = `В базе ${BRANDS.length} марок и ${nModels} моделей: отечественные, японские, корейские, китайские, европейские и американские. Если вашей модели нет — введите её вручную.`;
  $('permBtn').hidden = !(isApp && Android.openAppSettings);
  if(isApp && Android.appVersion) $('aboutText').textContent = 'Севермакс ' + Android.appVersion() + ' · пульт для подогревателя 5000 4-mini';

  $('numberInput').value = settings.number; $('setupNumber').value = settings.number; $('authInput').value = settings.authCode;
  if(isApp && Android.setHeaterNumber) Android.setHeaterNumber(settings.number || '');

  $('durRange').value = store.get('dur', 40); $('tempRange').value = store.get('temp', 65);
  const b = store.get('boost', { hi:90, lo:30 }); $('hiRange').value = b.hi; $('loRange').value = b.lo;
  $('durRange').addEventListener('input', updDur); $('tempRange').addEventListener('input', updTemp);
  $('hiRange').addEventListener('input', () => updBoost('hi')); $('loRange').addEventListener('input', () => updBoost('lo'));

  setFw(settings.fw === 'CGPZ' ? 'CGPZ' : 'NFPZ');
  updDur(); updBoost('hi');
  renderSetup(false); renderCar(); renderPhoto(); renderState(); renderReply(); renderJournal(); renderCodes(); renderChain();

  const lastErr = journal.slice().reverse().find(e => e.level === 'err');
  if(lastErr && lastErr.ts > store.get('errSeen', 0)) $('errDot').hidden = false;

  window.pullInbox();
  setInterval(renderState, 30000);
})();
