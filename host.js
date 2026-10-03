'use strict';
/* =========================================================
   QRクイズ 司会者画面
   司会者のブラウザがゲームサーバー役となり、参加者のスマホと
   WebRTC (PeerJS) で直接通信します。
   ========================================================= */

// ---- 設定 ----
const ROOM_PREFIX = 'ghquiz-v1-';
const SCORE_MAX = 1000;   // 0秒で正解した場合の得点
const SCORE_MIN = 500;    // 制限時間ぎりぎりで正解した場合の得点
const GRACE_MS = 1000;    // 通信遅延の猶予（制限時間後もこの時間だけ受付）
const SHAPES = ['▲', '◆', '●', '■'];

// ---- 状態 ----
const S = {
  peer: null,
  room: '',
  quiz: null,
  players: new Map(),   // id -> player
  qi: -1,
  phase: 'setup',       // setup | lobby | question | reveal | ranking | final
  answers: new Map(),   // id -> {choice, ms, correct, points}
  qStartAt: 0,
  tick: null,
  turn: null,
};

const app = document.getElementById('app');
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const sec = ms => (ms / 1000).toFixed(2);
const cur = () => S.quiz.questions[S.qi];
const total = () => S.quiz.questions.length;
const HEARTBEAT_TIMEOUT = 10000; // この時間 応答がない参加者はオフライン扱い
const onlinePlayers = () => [...S.players.values()].filter(p => p.online);

// 応答が途絶えた参加者をオフライン扱いにし、「全員回答で自動締切」が止まらないようにする
setInterval(() => {
  let changed = false;
  for (const p of S.players.values()) {
    if (p.online && Date.now() - (p.lastSeen || 0) > HEARTBEAT_TIMEOUT) { p.online = false; changed = true; }
  }
  if (!changed) return;
  refreshLive();
  if (S.phase === 'question') {
    const on = onlinePlayers();
    if (on.length && on.every(x => S.answers.has(x.id))) closeQuestion();
  }
}, 3000);

const SAMPLE = {
  title: 'サンプルクイズ',
  defaultTime: 20,
  questions: [
    { text: '日本で一番高い山はどれ？', choices: ['北岳', '富士山', '奥穂高岳', '槍ヶ岳'], answer: 2 },
    { text: '水の化学式はどれ？', choices: ['H2O', 'CO2', 'O2', 'NaCl'], answer: 1, time: 10 },
  ],
};

// ---- 問題ファイル検証 ----
function validateQuiz(q) {
  if (!q || !Array.isArray(q.questions) || q.questions.length === 0) throw new Error('questions 配列がありません');
  q.questions.forEach((x, i) => {
    const n = i + 1;
    if (!x.text) throw new Error(`${n}問目: text がありません`);
    if (!Array.isArray(x.choices) || x.choices.length < 2 || x.choices.length > 4) throw new Error(`${n}問目: choices は2〜4個にしてください`);
    const a = Number(x.answer);
    if (!(a >= 1 && a <= x.choices.length)) throw new Error(`${n}問目: answer は 1〜${x.choices.length} の番号で指定してください`);
    x._a = a - 1;
    x.time = Number(x.time) || Number(q.defaultTime) || 20;
  });
  return q;
}

async function init() {
  let msg = '';
  try {
    const r = await fetch('questions.json', { cache: 'no-store' });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    S.quiz = validateQuiz(await r.json());
  } catch (e) {
    msg = `questions.json を読み込めなかったため、サンプル問題を使用します（${e.message}）`;
    S.quiz = validateQuiz(JSON.parse(JSON.stringify(SAMPLE)));
  }
  renderSetup(msg);
}

// ---- 画面: 準備 ----
function renderSetup(msg) {
  S.phase = 'setup';
  app.innerHTML = `
  <div class="center-screen">
    <h1 class="logo">${esc(S.quiz.title || 'クイズ')}</h1>
    <p class="sub">全${total()}問</p>
    ${msg ? `<p class="note">${esc(msg)}</p>` : ''}
    <button id="create" class="btn big">ルームを作成</button>
    <label class="file-btn">別の問題ファイル（JSON）を読み込む
      <input type="file" id="file" accept=".json,application/json">
    </label>
    <p id="err" class="err"></p>
  </div>`;
  document.getElementById('create').onclick = createRoom;
  document.getElementById('file').onchange = async e => {
    const f = e.target.files[0];
    if (!f) return;
    try {
      S.quiz = validateQuiz(JSON.parse(await f.text()));
      renderSetup(`${f.name} を読み込みました`);
    } catch (err) {
      document.getElementById('err').textContent = '読み込みエラー: ' + err.message;
    }
  };
}

function randomCode() {
  const cs = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let s = '';
  for (let i = 0; i < 6; i++) s += cs[Math.floor(Math.random() * cs.length)];
  return s;
}

function createRoom() {
  const btn = document.getElementById('create');
  if (btn) { btn.disabled = true; btn.textContent = '接続中…'; }
  const code = randomCode();
  const peer = new Peer(ROOM_PREFIX + code);
  peer.on('open', () => {
    if (S.peer) return; // 再接続時
    S.peer = peer;
    S.room = code;
    renderLobby();
  });
  peer.on('connection', handleConn);
  peer.on('disconnected', () => { if (!peer.destroyed) setTimeout(() => peer.reconnect(), 1000); });
  peer.on('error', err => {
    console.error(err);
    if (!S.peer) {
      peer.destroy();
      if (err.type === 'unavailable-id') return createRoom();
      const e = document.getElementById('err');
      if (e) e.textContent = '接続できませんでした: ' + err.type;
      if (btn) { btn.disabled = false; btn.textContent = 'ルームを作成'; }
    } else {
      toast('通信エラー: ' + err.type);
    }
  });
}

// ---- 通信 ----
function handleConn(conn) {
  conn.on('data', d => onMsg(conn, d));
  conn.on('close', () => onClose(conn));
  conn.on('error', () => onClose(conn));
}

function onClose(conn) {
  for (const p of S.players.values()) {
    if (p.conn === conn) { p.online = false; p.conn = null; }
  }
  refreshLive();
}

function send(p, msg) {
  if (p.conn && p.conn.open) {
    try { p.conn.send(msg); } catch (e) { console.warn(e); }
  }
}
function broadcast(fn) {
  for (const p of S.players.values()) send(p, typeof fn === 'function' ? fn(p) : fn);
}

function cleanName(n) {
  return String(n || '').replace(/\s+/g, ' ').trim().slice(0, 16) || 'ゲスト';
}
function uniqueName(base) {
  const names = new Set([...S.players.values()].map(p => p.name));
  if (!names.has(base)) return base;
  let i = 2;
  while (names.has(`${base}(${i})`)) i++;
  return `${base}(${i})`;
}

function onMsg(conn, d) {
  if (!d || typeof d !== 'object') return;

  // 生存確認：何か受信したら最終受信時刻を更新
  const known = conn._pid && S.players.get(conn._pid);
  if (known && known.conn === conn) {
    known.lastSeen = Date.now();
    if (!known.online) { known.online = true; refreshLive(); }
  }
  if (d.t === 'ping') { try { conn.send({ t: 'pong' }); } catch (e) { /* noop */ } return; }

  if (d.t === 'join') {
    const id = String(d.id || '').slice(0, 64);
    if (!id) return;
    let p = S.players.get(id);
    if (!p) {
      if (S.phase === 'final') { conn.send({ t: 'error', msg: 'ゲームは終了しています' }); return; }
      p = { id, name: uniqueName(cleanName(d.name)), score: 0, correct: 0, timeSum: 0, rank: null, prevRank: null, online: true, conn, lastPoints: 0 };
      S.players.set(id, p);
    }
    if (p.conn && p.conn !== conn) { try { p.conn.close(); } catch (e) { /* noop */ } }
    conn._pid = id;
    p.conn = conn;
    p.online = true;
    p.lastSeen = Date.now();
    send(p, { t: 'welcome', phase: S.phase, name: p.name, score: p.score, rank: p.rank, of: S.players.size, title: S.quiz.title });
    // 途中参加・再接続時に現在の状態を送る
    if (S.phase === 'question') {
      const a = S.answers.get(id);
      send(p, a ? { t: 'answered', q: S.qi, choice: a.choice } : questionMsg(Date.now() - S.qStartAt));
    } else if (S.phase === 'reveal' || S.phase === 'ranking') {
      send(p, resultMsg(p));
    } else if (S.phase === 'final') {
      send(p, endMsg(p));
    }
    refreshLive();
    return;
  }

  if (d.t === 'answer') {
    const p = S.players.get(conn._pid);
    if (!p || S.phase !== 'question' || d.q !== S.qi || S.answers.has(p.id)) return;
    const q = cur();
    const limit = q.time * 1000;
    const hostEl = Date.now() - S.qStartAt;
    if (hostEl > limit + GRACE_MS) return;
    const choice = Number(d.choice);
    if (!(Number.isInteger(choice) && choice >= 0 && choice < q.choices.length)) return;
    let ms = Number(d.ms);
    if (!Number.isFinite(ms)) ms = hostEl;
    ms = Math.max(0, Math.min(ms, hostEl, limit));
    const correct = choice === q._a;
    const points = correct ? Math.round(SCORE_MAX - (SCORE_MAX - SCORE_MIN) * (ms / limit)) : 0;
    S.answers.set(p.id, { choice, ms, correct, points });
    send(p, { t: 'answered', q: S.qi, choice });
    refreshLive();
    const on = onlinePlayers();
    if (on.length && on.every(x => S.answers.has(x.id))) closeQuestion();
  }
}

function questionMsg(offset) {
  const q = cur();
  return { t: 'question', q: S.qi, n: total(), text: q.text, choices: q.choices, limit: q.time, offset: Math.max(0, offset || 0) };
}

function resultMsg(p) {
  const q = cur();
  const a = S.answers.get(p.id);
  const top = S.turn && S.turn.fastest[0];
  return {
    t: 'result', q: S.qi, n: total(),
    answered: !!a, choice: a ? a.choice : null, correct: !!(a && a.correct),
    points: a ? a.points : 0, ms: a ? a.ms : null,
    score: p.score, rank: p.rank, of: S.players.size,
    answer: q._a, answerText: q.choices[q._a],
    isTop: !!(top && top.p === p),
  };
}

function endMsg(p) {
  return { t: 'end', score: p.score, rank: p.rank, of: S.players.size, correct: p.correct, n: total() };
}

// ---- 進行 ----
function startQuestion(i) {
  S.qi = i;
  S.phase = 'question';
  S.answers = new Map();
  S.turn = null;
  S.qStartAt = Date.now();
  broadcast(questionMsg(0));
  renderQuestion();
  clearInterval(S.tick);
  S.tick = setInterval(() => {
    const q = cur();
    const limit = q.time * 1000;
    const el = Date.now() - S.qStartAt;
    const left = Math.max(0, limit - el);
    const t = document.getElementById('timer');
    const bar = document.getElementById('bar');
    if (t) t.textContent = Math.ceil(left / 1000);
    if (bar) bar.style.width = (left / limit * 100) + '%';
    if (el >= limit + GRACE_MS) closeQuestion();
  }, 100);
}

function closeQuestion() {
  if (S.phase !== 'question') return;
  clearInterval(S.tick);
  S.phase = 'reveal';
  const q = cur();
  for (const p of S.players.values()) {
    p.prevRank = p.rank;
    const a = S.answers.get(p.id);
    p.lastPoints = a ? a.points : 0;
    if (a) {
      p.score += a.points;
      if (a.correct) { p.correct++; p.timeSum += a.ms; }
    }
  }
  computeRanks();
  const counts = q.choices.map(() => 0);
  for (const a of S.answers.values()) counts[a.choice]++;
  const fastest = [...S.answers.entries()]
    .filter(([, a]) => a.correct)
    .sort((x, y) => x[1].ms - y[1].ms)
    .map(([id, a]) => ({ p: S.players.get(id), ...a }));
  S.turn = { counts, fastest, answered: S.answers.size };
  broadcast(p => resultMsg(p));
  renderReveal();
}

function sortedPlayers() {
  return [...S.players.values()].sort((a, b) =>
    b.score - a.score || a.timeSum - b.timeSum || a.name.localeCompare(b.name, 'ja'));
}

// 同点の場合は「正解時の合計回答時間」が短い方を上位とする
function computeRanks() {
  const list = sortedPlayers();
  list.forEach((p, i) => {
    const prev = list[i - 1];
    p.rank = (prev && prev.score === p.score && prev.timeSum === p.timeSum) ? prev.rank : i + 1;
  });
}

function next() {
  if (S.phase === 'lobby') { if (S.players.size) startQuestion(0); }
  else if (S.phase === 'question') closeQuestion();
  else if (S.phase === 'reveal') renderRanking();
  else if (S.phase === 'ranking') {
    if (S.qi + 1 < total()) startQuestion(S.qi + 1);
    else finish();
  }
}

function finish() {
  S.phase = 'final';
  computeRanks();
  broadcast(p => endMsg(p));
  renderFinal();
}

// ---- 画面: ロビー ----
function joinUrl() {
  try { return new URL('play.html?room=' + S.room, location.href).href; }
  catch (e) { return 'play.html?room=' + S.room; }
}

function renderLobby() {
  S.phase = 'lobby';
  const url = joinUrl();
  app.innerHTML = `
  <div class="lobby">
    <div class="lobby-left">
      <h1 class="title">${esc(S.quiz.title || 'クイズ')}</h1>
      <p class="sub">スマホでQRコードを読み取って参加</p>
      <div id="qr" class="qr"></div>
      <div class="code">ルームコード <b>${S.room}</b></div>
      <div class="url">${esc(url)}</div>
    </div>
    <div class="lobby-right">
      <div class="count"><span id="pcount">0</span> 人 参加中</div>
      <div id="plist" class="chips"></div>
      <button id="next" class="btn big" disabled>ゲーム開始</button>
      <p class="hint">全${total()}問　Space キーでも進行できます</p>
    </div>
  </div>`;
  new QRCode(document.getElementById('qr'), { text: url, width: 340, height: 340, correctLevel: QRCode.CorrectLevel.M });
  document.getElementById('next').onclick = next;
  refreshLive();
}

function refreshLive() {
  if (S.phase === 'lobby') {
    const list = document.getElementById('plist');
    if (!list) return;
    const ps = [...S.players.values()];
    document.getElementById('pcount').textContent = ps.filter(p => p.online).length;
    list.innerHTML = ps.map(p => `<span class="chip ${p.online ? '' : 'off'}">${esc(p.name)}</span>`).join('');
    document.getElementById('next').disabled = ps.length === 0;
  } else if (S.phase === 'question') {
    const c = document.getElementById('acount');
    if (c) c.textContent = `${S.answers.size} / ${onlinePlayers().length}`;
  }
}

// ---- 画面: 出題 ----
function choiceHtml(q, opt = {}) {
  return `<div class="choices n${q.choices.length}">` + q.choices.map((c, i) => {
    const cls = opt.reveal ? (i === q._a ? 'right' : 'dim') : '';
    const cnt = opt.counts ? `<span class="cnt">${opt.counts[i]}人</span>` : '';
    return `<div class="choice c${i} ${cls}"><span class="sh">${SHAPES[i]}</span><span class="tx">${esc(c)}</span>${cnt}</div>`;
  }).join('') + '</div>';
}

function renderQuestion() {
  const q = cur();
  app.innerHTML = `
  <div class="stage">
    <div class="topbar">
      <span class="qno">Q${S.qi + 1} / ${total()}</span>
      <span class="ans">回答 <b id="acount">0 / ${onlinePlayers().length}</b></span>
      <span class="room-sm">ルーム ${S.room}</span>
    </div>
    <div class="qtext">${esc(q.text)}</div>
    <div class="timer-row"><div id="timer" class="timer">${q.time}</div><div class="bar"><i id="bar" style="width:100%"></i></div></div>
    ${choiceHtml(q)}
    <div class="actions"><button id="next" class="btn ghost">締め切る</button></div>
  </div>`;
  document.getElementById('next').onclick = next;
  refreshLive();
}

// ---- 画面: 正解発表とトップ正解者 ----
function renderReveal() {
  const q = cur();
  const { counts, fastest, answered } = S.turn;
  const top = fastest[0];
  const rate = answered ? Math.round(fastest.length / answered * 100) : 0;
  const runners = fastest.slice(1, 5).map((f, i) =>
    `<li><span class="r">${i + 2}</span><span class="nm">${esc(f.p.name)}</span><span class="tm">${sec(f.ms)}秒</span><span class="pt">+${f.points}</span></li>`).join('');
  app.innerHTML = `
  <div class="stage">
    <div class="topbar">
      <span class="qno">Q${S.qi + 1} / ${total()}　正解発表</span>
      <span class="ans">正解率 <b>${rate}%</b>（${fastest.length} / ${answered}人）</span>
      <span class="room-sm">ルーム ${S.room}</span>
    </div>
    <div class="qtext small">${esc(q.text)}</div>
    ${choiceHtml(q, { reveal: true, counts })}
    <div class="top-card">
      <div class="label">このターンのトップ正解者</div>
      ${top
        ? `<div class="top-name">★ ${esc(top.p.name)}</div><div class="top-meta">${sec(top.ms)}秒　+${top.points}pt</div>`
        : `<div class="top-name none">正解者なし</div>`}
      ${runners ? `<ol class="runners">${runners}</ol>` : ''}
    </div>
    <div class="actions"><button id="next" class="btn">現在の順位を見る</button></div>
  </div>`;
  document.getElementById('next').onclick = next;
}

// ---- 画面: 現在の順位 ----
function moveHtml(p) {
  if (p.prevRank == null) return S.qi > 0 ? '<span class="mv new">NEW</span>' : '<span class="mv"></span>';
  const d = p.prevRank - p.rank;
  if (d > 0) return `<span class="mv up">▲${d}</span>`;
  if (d < 0) return `<span class="mv down">▼${-d}</span>`;
  return '<span class="mv same">→</span>';
}

function renderRanking() {
  S.phase = 'ranking';
  const list = sortedPlayers();
  const last = S.qi + 1 >= total();
  app.innerHTML = `
  <div class="stage">
    <div class="topbar">
      <span class="qno">Q${S.qi + 1} / ${total()} 終了時点の順位</span>
      <span class="ans">参加 <b>${list.length}人</b></span>
      <span class="room-sm">ルーム ${S.room}</span>
    </div>
    <ol class="ranking ${list.length > 13 ? 'two-col' : ''}">
      ${list.map(p => `
        <li class="${p.rank <= 3 ? 'podium r' + p.rank : ''} ${p.online ? '' : 'off'}">
          <span class="rk">${p.rank}</span>
          <span class="nm">${esc(p.name)}</span>
          ${moveHtml(p)}
          <span class="gain">${p.lastPoints ? '+' + p.lastPoints : ''}</span>
          <span class="sc">${p.score}</span>
        </li>`).join('')}
    </ol>
    <div class="actions"><button id="next" class="btn">${last ? '最終結果へ' : '次の問題へ'}</button></div>
  </div>`;
  document.getElementById('next').onclick = next;
}

// ---- 画面: 最終結果 ----
function renderFinal() {
  const list = sortedPlayers();
  const pod = [list[1], list[0], list[2]];
  app.innerHTML = `
  <div class="stage">
    <h1 class="title center">最終結果</h1>
    <div class="podium-wrap">
      ${pod.map((p, i) => p ? `
        <div class="pod p${[2, 1, 3][i]}">
          <div class="pname">${esc(p.name)}</div>
          <div class="pscore">${p.score}pt</div>
          <div class="pbox">${p.rank}</div>
        </div>` : '<div class="pod empty"></div>').join('')}
    </div>
    <ol class="ranking compact ${list.length > 16 ? 'two-col' : ''}" start="4">
      ${list.slice(3).map(p => `<li><span class="rk">${p.rank}</span><span class="nm">${esc(p.name)}</span><span class="sc">${p.score}</span></li>`).join('')}
    </ol>
    <div class="actions">
      <button id="csv" class="btn ghost">結果をCSVで保存</button>
    </div>
  </div>`;
  document.getElementById('csv').onclick = downloadCsv;
}

function downloadCsv() {
  const rows = [['順位', '名前', '得点', '正解数', '正解時の合計回答秒']];
  for (const p of sortedPlayers()) rows.push([p.rank, p.name, p.score, p.correct, sec(p.timeSum)]);
  const csv = '﻿' + rows.map(r => r.map(v => `"${String(v).replace(/"/g, '""')}"`).join(',')).join('\r\n');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
  a.download = `quiz-result-${S.room}.csv`;
  a.click();
}

// ---- 共通 ----
function toast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.remove('show'), 3000);
}

document.addEventListener('keydown', e => {
  if (e.target.tagName === 'INPUT') return;
  if (e.code === 'Space' || e.code === 'Enter' || e.code === 'ArrowRight') {
    const b = document.getElementById('next');
    if (b && !b.disabled) { e.preventDefault(); next(); }
  }
});

window.addEventListener('beforeunload', e => {
  if (S.phase !== 'setup' && S.phase !== 'final') { e.preventDefault(); e.returnValue = ''; }
});

init();
