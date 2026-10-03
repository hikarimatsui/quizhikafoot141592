'use strict';
/* =========================================================
   QRクイズ 参加者画面（スマホ）
   ========================================================= */

const ROOM_PREFIX = 'ghquiz-v1-';
const SHAPES = ['▲', '◆', '●', '■'];

const app = document.getElementById('app');
const banner = document.getElementById('banner');
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const sec = ms => (ms / 1000).toFixed(2);
const store = {
  get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* noop */ } },
};
const cleanRoom = s => String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6);

let room = cleanRoom(new URLSearchParams(location.search).get('room'));
let myId = null;
let myName = store.get('ghquiz-name') || '';
let peer = null, conn = null, joined = false;
let retry = 0, retryTimer = null;
let curQ = null, qT0 = 0, qTimer = null, answered = false, pending = null;

function newId() {
  if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
  return 'p' + Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
}

function showBanner(msg) { banner.textContent = msg; banner.classList.add('show'); }
function hideBanner() { banner.classList.remove('show'); }

// ---- 画面: 参加 ----
function renderJoin(err) {
  joined = false;
  app.innerHTML = `
  <div class="p-wrap">
    <h1 class="logo">QUIZ</h1>
    <form id="f" class="join">
      ${room ? `<div class="room">ルーム <b>${esc(room)}</b></div>`
             : `<input id="room" placeholder="ルームコード（6文字）" maxlength="6" autocapitalize="characters" autocomplete="off" required>`}
      <input id="name" placeholder="ニックネーム" maxlength="16" value="${esc(myName)}" autocomplete="nickname" required>
      <button class="btn big" type="submit">参加する</button>
      <p class="err">${esc(err || '')}</p>
    </form>
  </div>`;
  document.getElementById('f').onsubmit = e => {
    e.preventDefault();
    const r = document.getElementById('room');
    if (r) room = cleanRoom(r.value);
    myName = document.getElementById('name').value.trim().slice(0, 16);
    if (!room || !myName) return;
    store.set('ghquiz-name', myName);
    start();
  };
}

// ---- 接続 ----
function start() {
  myId = store.get('ghquiz-id-' + room);
  if (!myId) { myId = newId(); store.set('ghquiz-id-' + room, myId); }
  retry = 0;
  app.innerHTML = `<div class="p-wrap"><div class="spinner"></div><p>接続中…</p></div>`;
  if (!peer || peer.destroyed) {
    peer = new Peer();
    peer.on('open', connect);
    peer.on('error', onPeerError);
    peer.on('disconnected', () => { if (!peer.destroyed) setTimeout(() => peer.reconnect(), 1000); });
  } else if (peer.open) {
    connect();
  }
}

function connect() {
  clearTimeout(retryTimer);
  if (conn) { try { conn.close(); } catch (e) { /* noop */ } }
  const c = peer.connect(ROOM_PREFIX + room, { reliable: true });
  conn = c;
  const to = setTimeout(() => { if (conn === c && !c.open) lost(); }, 10000);
  c.on('open', () => {
    clearTimeout(to);
    retry = 0;
    c.send({ t: 'join', id: myId, name: myName });
  });
  c.on('data', onMsg);
  c.on('close', () => { if (conn === c) lost(); });
  c.on('error', () => { if (conn === c) lost(); });
}

function lost() {
  if (joined) showBanner('再接続中…');
  scheduleRetry();
}

function scheduleRetry() {
  clearTimeout(retryTimer);
  retry++;
  retryTimer = setTimeout(() => {
    if (peer && peer.open) connect();
    else if (peer && !peer.destroyed && peer.disconnected) peer.reconnect();
  }, Math.min(1000 * retry, 5000));
}

function onPeerError(e) {
  console.warn(e);
  if (e.type === 'peer-unavailable') {
    if (!joined && retry >= 3) {
      clearTimeout(retryTimer);
      renderJoin('ルームが見つかりません。コードを確認するか、司会者画面が開いているか確認してください');
      return;
    }
    scheduleRetry();
    return;
  }
  if (e.type === 'browser-incompatible') {
    renderJoin('このブラウザは対応していません。Safari または Chrome でお試しください');
    return;
  }
  scheduleRetry();
}

// 画面に戻ったら、最新の状態を司会者から取り直す
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible' || !joined) return;
  if (conn && conn.open) {
    try { conn.send({ t: 'join', id: myId, name: myName }); } catch (e) { lost(); }
  } else {
    retry = 0;
    showBanner('再接続中…');
    scheduleRetry();
  }
});

// 生存確認：3秒ごとに ping を送り、9秒以上何も届かなければ接続し直す
let lastRx = Date.now();
setInterval(() => {
  if (!joined || !conn) return;
  if (conn.open) { try { conn.send({ t: 'ping' }); } catch (e) { /* noop */ } }
  if (Date.now() - lastRx > 9000) {
    lastRx = Date.now();
    lost();
  }
}, 3000);

// ---- 受信 ----
let shown = false; // 待機画面以外を表示済みか
function onMsg(d) {
  if (!d || typeof d !== 'object') return;
  lastRx = Date.now();
  if (d.t !== 'pong' && d.t !== 'welcome') shown = true;
  switch (d.t) {
    case 'pong': break;
    case 'welcome':
      joined = true;
      hideBanner();
      myName = d.name;
      // ゲーム進行中は続けて現在の状態が届くため、表示中の画面を上書きしない
      if (!d.phase || d.phase === 'lobby' || !shown) renderWaiting(d);
      break;
    case 'question': startQ(d); break;
    case 'answered':
      pending = null;
      renderAnswered(d.choice);
      break;
    case 'result': renderResult(d); break;
    case 'end': renderEnd(d); break;
    case 'error': renderJoin(d.msg); break;
  }
}

function header() {
  return `<div class="p-name">${esc(myName)}</div>`;
}

function renderWaiting(d) {
  stopTimer();
  app.innerHTML = `
  <div class="p-wrap">
    ${header()}
    <h2>参加しました</h2>
    <p>司会者の画面をご覧ください。<br>まもなく問題が始まります。</p>
    ${d.score ? `<p class="p-score">現在 ${d.score}pt　${d.rank}位</p>` : ''}
    <div class="dots"><i></i><i></i><i></i></div>
  </div>`;
}

function stopTimer() { clearInterval(qTimer); qTimer = null; }

function startQ(d) {
  curQ = d;
  answered = false;
  qT0 = performance.now() - (d.offset || 0);
  if (pending && pending.q === d.q) { sendAnswer(pending.choice, pending.ms); return; }
  pending = null;
  const limit = d.limit * 1000;
  app.innerHTML = `
  <div class="p-q">
    <div class="p-head"><span>Q${d.q + 1} / ${d.n}</span><span id="left">${d.limit}</span></div>
    <div class="bar"><i id="bar" style="width:${Math.max(0, (limit - (d.offset || 0)) / limit * 100)}%"></i></div>
    <div class="p-text">${esc(d.text)}</div>
    <div class="p-choices n${d.choices.length}">
      ${d.choices.map((c, i) => `<button class="ch c${i}" data-i="${i}"><span class="sh">${SHAPES[i]}</span><span class="tx">${esc(c)}</span></button>`).join('')}
    </div>
  </div>`;
  app.querySelectorAll('.ch').forEach(b => {
    b.addEventListener('click', () => choose(Number(b.dataset.i)));
  });
  stopTimer();
  qTimer = setInterval(() => {
    const left = Math.max(0, limit - (performance.now() - qT0));
    const l = document.getElementById('left');
    const bar = document.getElementById('bar');
    if (l) l.textContent = Math.ceil(left / 1000);
    if (bar) bar.style.width = (left / limit * 100) + '%';
    if (left <= 0) {
      stopTimer();
      if (!answered) renderTimeUp();
    }
  }, 100);
}

function choose(i) {
  if (answered || !curQ) return;
  answered = true;
  if (navigator.vibrate) navigator.vibrate(30);
  sendAnswer(i, performance.now() - qT0);
}

function sendAnswer(choice, ms) {
  pending = { q: curQ.q, choice, ms };
  if (conn && conn.open) conn.send({ t: 'answer', q: curQ.q, choice, ms });
  else showBanner('再接続中… 回答は接続後に送信されます');
  renderAnswered(choice);
}

function renderAnswered(choice) {
  answered = true;
  stopTimer();
  const txt = curQ && curQ.choices ? curQ.choices[choice] : '';
  app.innerHTML = `
  <div class="p-wrap">
    ${header()}
    <h2>回答しました</h2>
    <div class="picked c${choice}"><span class="sh">${SHAPES[choice] || ''}</span>${esc(txt)}</div>
    <p>結果発表をお待ちください</p>
    <div class="dots"><i></i><i></i><i></i></div>
  </div>`;
}

function renderTimeUp() {
  app.innerHTML = `
  <div class="p-wrap">
    ${header()}
    <h2>時間切れ</h2>
    <p>結果発表をお待ちください</p>
  </div>`;
}

function renderResult(d) {
  stopTimer();
  pending = null;
  const cls = !d.answered ? 'none' : d.correct ? 'ok' : 'ng';
  const head = !d.answered ? '未回答' : d.correct ? '正解！' : '不正解';
  app.innerHTML = `
  <div class="p-wrap result ${cls}">
    ${header()}
    <div class="res-head">${head}</div>
    ${d.isTop ? '<div class="res-top">★ このターン最速正解！</div>' : ''}
    ${d.correct ? `<div class="res-pt">+${d.points}pt</div><div class="res-ms">回答時間 ${sec(d.ms)}秒</div>` : ''}
    ${!d.correct ? `<div class="res-ans">正解は「${esc(d.answerText)}」</div>` : ''}
    <div class="res-rank"><b>${d.rank}</b>位 / ${d.of}人</div>
    <div class="res-score">合計 ${d.score}pt</div>
  </div>`;
}

function renderEnd(d) {
  stopTimer();
  app.innerHTML = `
  <div class="p-wrap result final">
    ${header()}
    <div class="res-head">最終結果</div>
    <div class="res-rank big"><b>${d.rank}</b>位 / ${d.of}人</div>
    <div class="res-score">${d.score}pt（${d.correct} / ${d.n}問 正解）</div>
    <p>ご参加ありがとうございました</p>
  </div>`;
}

renderJoin();
