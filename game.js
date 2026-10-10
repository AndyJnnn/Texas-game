// Page for local play and for a room hosted by server.js.
let mode = "local";
let view = null;
let lobby = null;
let aim = null;
let note = "";
let ws = null;
let connecting = false;
let seatPick = 4;
let draftName = "你";

function snapshot() {
  if (mode === "online") return view;
  if (!Engine.G.players.length || Engine.G.phase === "setup") return null;
  return Engine.viewFor(0);
}

function matchStatus(S) {
  if (mode === "online") return S.status;
  return Engine.tableStatus();
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

let audioOn = true;
try { audioOn = localStorage.getItem("poker-sound") !== "0"; } catch { audioOn = true; }
let actx = null;
let noiseBuf = null;
let lastSound = "";

function audio() {
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) return null;
  if (!actx) actx = new AC();
  return actx;
}

function burst(ctx, t, dur, peak, freq) {
  if (!noiseBuf) {
    noiseBuf = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
    const data = noiseBuf.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
  }
  const src = ctx.createBufferSource();
  src.buffer = noiseBuf;
  const filter = ctx.createBiquadFilter();
  filter.type = "bandpass";
  filter.frequency.value = freq;
  filter.Q.value = 0.8;
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(peak, t + 0.008);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  src.connect(filter);
  filter.connect(g);
  g.connect(ctx.destination);
  src.start(t);
  src.stop(t + dur + 0.02);
}

function tone(ctx, t, freq, dur, type, peak) {
  const o = ctx.createOscillator();
  o.type = type;
  o.frequency.setValueAtTime(freq, t);
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(peak, t + 0.012);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  o.connect(g);
  g.connect(ctx.destination);
  o.start(t);
  o.stop(t + dur + 0.02);
}

// ponytail: short synthesized cues, not samples. Ceiling: thin clinks. Upgrade: recorded chips and cards.
function playCue(cue) {
  if (!audioOn || typeof window === "undefined") return;
  const ctx = audio();
  if (!ctx) return;
  const run = () => {
    const t = ctx.currentTime + 0.01;
    if (cue === "tick" || cue === "chip") {
      burst(ctx, t, 0.05, 0.08, 1900);
      tone(ctx, t, cue === "tick" ? 1800 : 980, 0.07, "triangle", 0.04);
    } else if (cue === "check") {
      burst(ctx, t, 0.04, 0.07, 420);
      burst(ctx, t + 0.09, 0.04, 0.06, 360);
    } else if (cue === "fold") {
      burst(ctx, t, 0.12, 0.05, 240);
      tone(ctx, t, 180, 0.14, "sine", 0.04);
    } else if (cue === "allin") {
      burst(ctx, t, 0.06, 0.1, 1600);
      burst(ctx, t + 0.06, 0.06, 0.09, 2100);
      tone(ctx, t, 140, 0.22, "sawtooth", 0.03);
    } else if (cue === "card") {
      burst(ctx, t, 0.045, 0.07, 2800);
    } else if (cue === "deal") {
      burst(ctx, t, 0.04, 0.06, 2400);
      burst(ctx, t + 0.06, 0.04, 0.06, 3000);
      burst(ctx, t + 0.12, 0.04, 0.05, 2200);
    } else if (cue === "win") {
      [523, 659, 784, 1046].forEach((f, i) => tone(ctx, t + i * 0.08, f, 0.16, "triangle", 0.05));
    } else if (cue === "item") {
      tone(ctx, t, 880, 0.12, "sine", 0.05);
      tone(ctx, t + 0.1, 1320, 0.16, "sine", 0.04);
    } else if (cue === "refund") {
      tone(ctx, t, 660, 0.1, "triangle", 0.05);
      tone(ctx, t + 0.08, 990, 0.14, "triangle", 0.04);
    } else if (cue === "peek") {
      tone(ctx, t, 1560, 0.12, "sine", 0.03);
    } else if (cue === "swap") {
      burst(ctx, t, 0.05, 0.06, 1800);
      burst(ctx, t + 0.07, 0.05, 0.06, 2600);
    }
  };
  if (ctx.state === "suspended") ctx.resume().then(run);
  else run();
}

function cueFor(line) {
  if (!line) return "";
  if (line.includes("弃牌")) return "fold";
  if (line.includes("过牌")) return "check";
  if (line.includes("全下")) return "allin";
  if (line.includes("跟注") || line.includes("下注") || line.includes("加注")) return "chip";
  if (line === "翻牌" || line === "转牌" || line === "河牌" || line.includes("换了一张")) return "card";
  if (line.includes("交换了")) return "swap";
  if (line.includes("使用了望牌")) return "peek";
  if (line.includes("半退")) return "refund";
  if (line.includes("花费")) return "item";
  if (line.includes("赢得") || line.includes("平分")) return "win";
  if (line.includes("庄家")) return "deal";
  return "";
}

function syncSound(lines) {
  const line = lines.length ? lines[lines.length - 1] : "";
  if (line === lastSound) return;
  lastSound = line;
  const cue = cueFor(line);
  if (cue) playCue(cue);
}

const FACE = {
  you: ["faces/you.png", "30% 18%"],
  阿豪: ["faces/hao.webp", "50% 22%"],
  小北: ["faces/bei.webp", "50% 42%"],
  老K: ["faces/k.webp", "50% 18%"],
  阿梅: ["faces/mei.webp", "50% 28%"],
  老周: ["faces/pair.webp", "18% 42%"],
  小南: ["faces/pair.webp", "82% 58%"],
};
const GUESTS = [FACE.阿豪, FACE.小北, FACE.老K, FACE.阿梅];

function lookFor(name, isHuman) {
  if (isHuman) return FACE.you;
  if (FACE[name]) return FACE[name];
  let n = 0;
  for (const ch of String(name)) n += ch.charCodeAt(0);
  return GUESTS[n % GUESTS.length];
}

function portrait(p) {
  const [src, pos] = lookFor(p.name, p.isHuman);
  return `<div class="bust" aria-hidden="true"><img src="${src}" alt="" style="object-position:${pos}"></div>`;
}

function canNet() {
  return location.protocol === "http:" || location.protocol === "https:";
}

function send(obj) {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj));
}

function connect(hello) {
  if (connecting || (ws && ws.readyState === 1)) {
    if (ws && ws.readyState === 1) hello();
    return;
  }
  connecting = true;
  note = "";
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  const sock = new WebSocket(`${proto}//${location.host}/ws`);
  ws = sock;
  sock.onopen = () => { connecting = false; hello(); };
  sock.onmessage = (ev) => {
    let msg;
    try { msg = JSON.parse(ev.data); } catch { return; }
    if (msg.type === "lobby") {
      mode = "online";
      lobby = msg;
      view = null;
      aim = null;
      render();
    } else if (msg.type === "state") {
      mode = "online";
      lobby = null;
      view = msg;
      render();
    } else if (msg.type === "error") {
      note = msg.message || "不行";
      render();
    } else if (msg.type === "closed") {
      note = msg.message || "房间已关闭";
      ws = null;
      showSetup();
    }
  };
  sock.onclose = () => {
    connecting = false;
    if (ws !== sock) return;
    ws = null;
    if (mode === "online") {
      note = "连接断了";
      showSetup();
    }
  };
}

function showSetup() {
  mode = "local";
  aim = null;
  lobby = null;
  view = null;
  Engine.G.phase = "setup";
  Engine.G.players = [];
  Engine.G.log = [];
  Engine.G.handNo = 0;
  Engine.G.result = "";
  Engine.G.board = [];
  render();
}

function cardHTML(card, holeIndex, pickable) {
  const red = card.s === "h" || card.s === "d";
  const suit = Engine.SUIT_GLYPH[card.s];
  const r = Engine.rankName(card.r);
  const ten = r === "10" ? " ten" : "";
  const hole = holeIndex == null ? "" : ` data-hole="${holeIndex}"`;
  const pick = pickable ? " pickable" : "";
  return `<div class="card${red ? " red" : ""}${ten}${pick}"${hole} role="img" aria-label="${r}${suit}"><span class="rk">${r}</span><span class="su">${suit}</span><span class="pip">${suit}</span></div>`;
}

function cardBack() {
  return `<div class="card back" aria-hidden="true"></div>`;
}

function cardRow(p, i, S) {
  if (!p.inHand || !p.hole.length) return `<div class="cards"></div>`;
  const mine = i === S.you;
  if (!mine && p.folded) return `<div class="cards dim">${p.hole.map(cardBack).join("")}</div>`;
  const dim = mine && p.folded ? " dim" : "";
  const html = p.hole.map((c, k) => {
    if (!c) return cardBack();
    const pick = aim === "hole" && mine;
    return cardHTML(c, pick ? k : null, pick);
  }).join("");
  return `<div class="cards${dim}">${html}</div>`;
}

function tags(i, S) {
  let html = "";
  if (i === S.dealer) html += `<span class="tag dealer">庄</span>`;
  if (i === S.sbIndex) html += `<span class="tag">小盲</span>`;
  if (i === S.bbIndex) html += `<span class="tag">大盲</span>`;
  return html;
}

function statusText(p) {
  if (!p.inHand) return "出局";
  if (p.folded) return "弃牌";
  if (p.allIn) return "全下";
  return "";
}

function validTarget(S, i) {
  if (i === S.you) return false;
  const p = S.players[i];
  return !!(p && p.inHand && !p.folded && p.hole.length >= 2);
}

function chipMarkup(amount, pt) {
  const piles = Engine.chipPiles(amount);
  if (!piles.length) return "";
  const dx = 50 - pt.x;
  const dy = 48 - pt.y;
  let style;
  if (Math.abs(dx) > Math.abs(dy)) {
    style = dx > 0
      ? "left:calc(100% + 0.25rem);top:38%;transform:translate(0,-50%)"
      : "right:calc(100% + 0.25rem);top:38%;left:auto;transform:translate(0,-50%)";
  } else if (dy < 0) {
    style = "left:50%;bottom:calc(100% + 0.15rem);transform:translate(-50%,0)";
  } else {
    style = "left:50%;top:calc(100% + 0.15rem);transform:translate(-50%,0)";
  }
  const html = piles.map((pile) => {
    const shown = Math.min(pile.count, 4);
    let discs = "";
    for (let i = 0; i < shown; i++) discs += `<i style="--i:${i}"></i>`;
    const badge = pile.count > 1 ? `<em>${pile.count}</em>` : "";
    return `<span class="pile d${pile.d}" style="--n:${shown}">${discs}<b>${pile.d}</b>${badge}</span>`;
  }).join("");
  return `<div class="chips" style="${style}" aria-hidden="true">${html}</div>`;
}

function seatHTML(i, S) {
  const p = S.players[i];
  const n = S.players.length;
  const visual = (i - S.you + n) % n;
  const pt = Engine.seatPoint(visual, n);
  const pick = aim === "seat" && validTarget(S, i);
  const cls = [
    "seat",
    i === S.you ? "you" : "foe",
    i === S.actor && S.phase === "betting" ? "active" : "",
    p.folded ? "folded" : "",
    S.phase === "over" && S.winnerIdx.includes(i) ? "winner" : "",
    pick ? "pick" : "",
  ].filter(Boolean).join(" ");
  const st = statusText(p);
  const bet = p.bet > 0 ? `本轮 ${p.bet}` : "";
  const press = pick ? ` role="button" tabindex="0"` : "";
  return `<div class="${cls}" data-seat="${i}" style="left:${pt.x}%;top:${pt.y}%"${press}>
    ${cardRow(p, i, S)}
    ${portrait(p)}
    <p class="who"><span class="nm">${esc(p.name)}</span>${tags(i, S)}</p>
    <p class="stack">${p.stack}${st ? `<span class="st">${esc(st)}</span>` : ""}</p>
    ${chipMarkup(p.stack, pt)}
    <p class="bet">${bet}</p>
  </div>`;
}

function centerHTML(S) {
  const slots = [];
  for (let i = 0; i < 5; i++) slots.push(S.board[i] ? cardHTML(S.board[i]) : `<div class="slot"></div>`);
  const line = S.phase === "over" ? S.result : Engine.STREET_NAME[S.street];
  return `<div class="center"><p class="pot">底池 ${S.pot}</p><div class="board">${slots.join("")}</div><p class="street">${esc(line || "")}</p></div>`;
}

function yourHandText(S) {
  const p = S.players[S.you];
  if (!p) return "";
  if (!p.inHand) return "你已出局";
  if (!p.hole.length || !p.hole[0] || !p.hole[1]) return "";
  if (p.folded) return "你已弃牌";
  if (S.board.length >= 3) return `你的牌力：${Engine.handName(Engine.bestOf(p.hole.concat(S.board)))}`;
  return Engine.holeText(p.hole);
}

function countButtons(act, current, min) {
  let html = `<div class="row">`;
  for (let n = 4; n <= 7; n++) {
    const on = n === current ? "primary" : "";
    const dis = n < min ? " disabled" : "";
    html += `<button type="button" class="${on}" data-act="${act}" data-n="${n}"${dis}>${n} 人</button>`;
  }
  return html + `</div>`;
}

function renderSetup() {
  const table = document.getElementById("table");
  let net = `<p class="wait">联机请先在这台电脑运行 node server.js，再用它显示的地址打开。</p>`;
  if (canNet()) {
    net = `<div class="row">
      <label>名字 <input id="myname" maxlength="8" autocomplete="nickname" value="${esc(draftName)}"></label>
      <button type="button" data-act="create">创建房间</button>
    </div>
    <div class="row">
      <label>房间号 <input id="roomcode" maxlength="4" autocapitalize="characters"></label>
      <button type="button" data-act="join">加入房间</button>
    </div>`;
  }
  const err = note ? `<p class="banner">${esc(note)}</p>` : "";
  table.innerHTML = `<div class="felt"><div class="setup">
    <p>选几个人。你坐在下方，空位由电脑补上。</p>
    ${countButtons("count", seatPick, 4)}
    <div class="row"><button type="button" class="primary" data-act="local">本地对局</button></div>
    ${net}
    ${err}
  </div></div>`;
  document.getElementById("meta").textContent = "";
  document.querySelector(".sub").textContent = `无限注 · 小盲 ${Engine.SB} / 大盲 ${Engine.BB}`;
  document.getElementById("rank").textContent = "";
  document.getElementById("log").replaceChildren();
  document.getElementById("controls").replaceChildren();
  document.getElementById("live").textContent = note || "";
}

function renderLobby() {
  const L = lobby;
  const urls = (L.urls || []).map((u) => `<li>${esc(u)}</li>`).join("");
  const members = (L.members || []).map((m) => `<li>${esc(m.name)}</li>`).join("");
  const host = L.host ? `${countButtons("seats", L.seats, (L.members || []).length)}<button type="button" class="primary" data-act="start">开始</button>` : `<p class="wait">等待房主开始</p>`;
  const err = note ? `<p class="banner">${esc(note)}</p>` : "";
  document.getElementById("table").innerHTML = `<div class="felt"><div class="setup">
    <p>房间号 <strong>${esc(L.code || "")}</strong></p>
    <p>朋友打开下面的地址，填写房间号后入座。</p>
    <ul class="urls">${urls}</ul>
    <ol class="members">${members}</ol>
    ${host}
    ${err}
  </div></div>`;
  document.getElementById("meta").textContent = "等待开始";
  document.querySelector(".sub").textContent = `无限注 · ${L.seats} 人 · 小盲 ${Engine.SB} / 大盲 ${Engine.BB}`;
  document.getElementById("rank").textContent = "";
  document.getElementById("log").replaceChildren();
  document.getElementById("controls").replaceChildren();
  document.getElementById("live").textContent = note || `房间号 ${L.code || ""}`;
}

const DENOMS = [5, 10, 20, 50, 100];
let wager = null;

function wagerKey(S) {
  return `${S.handNo}:${S.street}:${S.actor}`;
}

function ensureWager(S, me, b) {
  const key = wagerKey(S);
  if (!wager || wager.key !== key) wager = { key, counts: Engine.chipCounts(b.minTo - me.bet) };
  return wager;
}

function boundsOf(S, p) {
  const minRaw = Math.max(S.lastFull + S.minRaise, S.currentBet + 1);
  const maxRaw = p.bet + p.stack;
  const toCall = Math.max(0, S.currentBet - p.bet);
  const minTo = Engine.snapRaise(minRaw, minRaw, maxRaw);
  const maxTo = Engine.snapRaise(maxRaw, minRaw, maxRaw);
  const ok = p.canRaise && maxRaw >= minRaw && maxTo % Engine.CHIP === 0 && maxTo >= minTo && maxTo > S.currentBet;
  return { minTo, maxTo, toCall, ok };
}

function refundButton(S) {
  if (S.item !== "refund") return "";
  return `<button type="button" data-act="refund"${S.canRefund ? "" : " disabled"}>半退</button>`;
}

function buyButton(S) {
  if (!S.lost) return "";
  const me = S.players[S.you];
  if (!S.canBuy && !(me && me.stack >= Engine.ITEM_COST)) return "";
  return `<button type="button" data-act="buy"${S.canBuy ? "" : " disabled"}>抽一张 100</button>`;
}

function renderControls(S) {
  const el = document.getElementById("controls");
  const me = S.players[S.you];
  const st = matchStatus(S);
  let html = note ? `<p class="banner">${esc(note)}</p>` : "";
  if (S.phase === "over") {
    if (st === "bust") html += `<p class="banner">筹码输光了</p>${refundButton(S)}`;
    else if (st === "win") html += `<p class="banner">你赢下了这桌</p>${refundButton(S)}`;
    else if (st === "out") html += `<p class="banner">你已出局，牌局还在继续</p>${refundButton(S)}<button type="button" class="primary" data-act="next">下一手</button>`;
    else html += `${refundButton(S)}<button type="button" class="primary" data-act="next">下一手</button>${buyButton(S)}`;
    if (st === "bust" || st === "win") {
      if (mode === "online" && !S.host) html += `<p class="wait">等待房主重开</p>`;
      else html += `<button type="button" class="primary" data-act="restart">${st === "win" ? "再来一桌" : "重新开始"}</button>`;
    }
    el.innerHTML = html;
    return;
  }
  const actor = S.actor >= 0 ? S.players[S.actor] : null;
  const myTurn = S.phase === "betting" && S.actor === S.you && me;
  if (myTurn && (S.item === "peek" || S.item === "exchange" || S.item === "swap")) {
    const label = Engine.ITEM_NAME[S.item];
    if (S.item === "swap" && S.street !== "preflop") html += `<button type="button" disabled>换牌（仅翻牌前）</button>`;
    else if (aim) html += `<button type="button" data-act="cancel">取消${label}</button>`;
    else html += `<button type="button" data-act="item">${label}</button>`;
  }
  if (!myTurn) {
    let text = "发牌中";
    if (S.phase === "deal" && S.street === "river") text = "摊牌中";
    else if (actor && S.actor !== S.you) text = `${me && me.folded ? "你已弃牌，" : ""}等待${actor.name}`;
    html += `<p class="wait">${esc(text)}</p>`;
    el.innerHTML = html;
    return;
  }
  if (aim === "seat") html += `<p class="wait">请选择一名还在牌局中的对手</p>`;
  if (aim === "hole") html += `<p class="wait">请选择一张自己的底牌</p>`;
  const b = boundsOf(S, me);
  if (b.toCall > 0) html += `<button type="button" class="danger" data-act="fold">弃牌</button>`;
  if (b.toCall === 0) html += `<button type="button" class="primary" data-act="check">过牌</button>`;
  else if (me.stack <= b.toCall) html += `<button type="button" class="primary" data-act="call">全下 ${me.stack}</button>`;
  else html += `<button type="button" class="primary" data-act="call">跟注 ${b.toCall}</button>`;
  if (me.canRaise && me.stack > b.toCall && !b.ok) html += `<button type="button" data-act="allin">全下 ${me.stack}</button>`;
  if (b.ok) {
    const opening = S.currentBet === 0;
    const w = ensureWager(S, me, b);
    const to = me.bet + Engine.chipTotal(w.counts);
    const tray = DENOMS.map((d) => `<button type="button" class="bet-chip d${d}" data-act="addchip" data-d="${d}" aria-label="放入 ${d}">${d}</button>`).join("");
    const mix = DENOMS.map((d) => {
      const n = w.counts[d] || 0;
      const badge = n > 0 ? `<em>${n}</em>` : "";
      const canBreak = n > 0 && d !== 5;
      const canMerge = !!Engine.mergeOne(w.counts, d);
      return `<div class="mix">
        <button type="button" class="bet-chip d${d}" data-act="subchip" data-d="${d}" aria-label="收回 ${d}">${d}${badge}</button>
        <span class="ops">
          <button type="button" data-act="break" data-d="${d}"${canBreak ? "" : " disabled"}>拆</button>
          <button type="button" data-act="merge" data-d="${d}"${canMerge ? "" : " disabled"}>合</button>
        </span>
      </div>`;
    }).join("");
    html += `<div class="raisebox">
      <p class="raise-amt">${opening ? "下注" : "加注到"} <strong>${to}</strong></p>
      <div class="chiptray">${tray}</div>
      <div class="chipmix">${mix}</div>
      <div class="ops">
        <button type="button" data-act="preset" data-kind="min">最小</button>
        <button type="button" data-act="preset" data-kind="half">半池</button>
        <button type="button" data-act="preset" data-kind="pot">底池</button>
        <button type="button" data-act="preset" data-kind="all">全下</button>
        <button type="button" class="primary" data-act="raise">确认</button>
      </div>
    </div>`;
  }
  el.innerHTML = html;
}

function render() {
  if (typeof document === "undefined") return;
  if (mode === "online" && lobby && !view) return renderLobby();
  const S = snapshot();
  if (!S) return renderSetup();
  if (S.phase !== "betting") aim = null;
  const n = S.players.length;
  const seats = S.players.map((_, i) => seatHTML(i, S)).join("");
  document.getElementById("table").innerHTML = `<div class="felt" data-n="${n}">${seats}${centerHTML(S)}</div>`;
  document.getElementById("meta").textContent = S.handNo ? `第 ${S.handNo} 手` : "";
  document.querySelector(".sub").textContent = `无限注 · ${n} 人 · 小盲 ${Engine.SB} / 大盲 ${Engine.BB}`;
  const item = S.item ? `道具：${Engine.ITEM_NAME[S.item]}` : "";
  document.getElementById("rank").textContent = [yourHandText(S), item].filter(Boolean).join(" · ");
  const log = document.getElementById("log");
  log.replaceChildren();
  for (const line of S.log.slice(-6)) {
    const li = document.createElement("li");
    li.textContent = line;
    log.appendChild(li);
  }
  document.getElementById("live").textContent = note || S.log[S.log.length - 1] || "";
  renderControls(S);
  syncSound(S.log);
}

function localAct(raw) {
  const err = raw;
  if (err) { note = err; render(); }
}

function playItem(target, hole) {
  aim = null;
  if (mode === "online") send({ type: "item", target, hole });
  else localAct(Engine.useItem(0, target, hole));
}

function onAct(act, btn) {
  note = "";
  if (act === "count") {
    const name = document.getElementById("myname");
    if (name) draftName = name.value;
    seatPick = Math.min(7, Math.max(4, Number(btn.dataset.n) || 4));
    render();
    return;
  }
  if (act === "local") {
    mode = "local";
    aim = null;
    lobby = null;
    view = null;
    Engine.freshPlayers(seatPick);
    Engine.startHand();
    return;
  }
  if (act === "create") {
    const name = document.getElementById("myname");
    connect(() => send({ type: "create", name: name ? name.value : "", seats: seatPick }));
    return;
  }
  if (act === "join") {
    const name = document.getElementById("myname");
    const code = document.getElementById("roomcode");
    connect(() => send({ type: "join", name: name ? name.value : "", code: code ? code.value : "" }));
    return;
  }
  if (act === "start") { send({ type: "start" }); return; }
  if (act === "seats") { send({ type: "seats", n: Number(btn.dataset.n) }); return; }
  if (act === "cancel") { aim = null; render(); return; }
  const S = snapshot();
  if (!S) return;
  if (act === "item") {
    aim = S.item === "swap" ? "hole" : "seat";
    render();
    return;
  }
  if (act === "buy") {
    if (mode === "online") send({ type: "buy" });
    else localAct(Engine.buy(0));
    return;
  }
  if (act === "refund") {
    if (mode === "online") send({ type: "item", target: -1, hole: -1 });
    else localAct(Engine.useItem(0, -1, -1));
    return;
  }
  if (act === "next") {
    if (S.phase !== "over") return;
    const st = matchStatus(S);
    if (st !== "continue" && st !== "out") return;
    if (mode === "online") send({ type: "next" });
    else Engine.startHand();
    return;
  }
  if (act === "restart") {
    if (S.phase !== "over") return;
    const st = matchStatus(S);
    if (st !== "bust" && st !== "win") return;
    if (mode === "online") {
      if (!S.host) return;
      send({ type: "restart" });
    } else showSetup();
    return;
  }
  if (S.phase !== "betting" || S.actor !== S.you) return;
  const me = S.players[S.you];
  let raw = null;
  if (act === "fold") raw = { type: "fold" };
  else if (act === "check") raw = { type: "check" };
  else if (act === "call") raw = { type: "call" };
  else if (act === "allin") {
    raw = me.canRaise && me.bet + me.stack > S.currentBet ? { type: "raise", to: me.bet + me.stack } : { type: "call" };
  } else if (act === "addchip" || act === "subchip" || act === "break" || act === "merge" || act === "preset") {
    const S = snapshot();
    if (!S || S.phase !== "betting" || S.actor !== S.you) return;
    const me = S.players[S.you];
    const b = boundsOf(S, me);
    if (!b.ok) return;
    const w = ensureWager(S, me, b);
    const d = Number(btn && btn.dataset.d);
    if (act === "preset") w.counts = Engine.chipCounts(Engine.quoteRaise(btn.dataset.kind, S, me) - me.bet);
    else if (act === "addchip") {
      if (me.bet + Engine.chipTotal(w.counts) + d > b.maxTo) note = "超出了";
      else { w.counts[d] += 1; playCue("tick"); }
    } else if (act === "subchip") {
      if (!w.counts[d]) return;
      if (me.bet + Engine.chipTotal(w.counts) - d < b.minTo) note = "不能低于最小加注";
      else { w.counts[d] -= 1; playCue("tick"); }
    } else if (act === "break") {
      const next = Engine.breakOne(w.counts, d);
      if (!next) note = "这张不能再拆";
      else w.counts = next;
    } else {
      const next = Engine.mergeOne(w.counts, d);
      if (!next) note = "凑不齐，不能合成";
      else w.counts = next;
    }
    render();
    return;
  } else if (act === "raise") {
    const S = snapshot();
    if (!S) return;
    const me = S.players[S.you];
    const b = boundsOf(S, me);
    const w = ensureWager(S, me, b);
    const to = me.bet + Engine.chipTotal(w.counts);
    if (to < b.minTo) { note = "还没到最小加注"; render(); return; }
    raw = { type: "raise", to };
  }
  if (!raw) return;
  if (mode === "online") send({ type: "act", action: raw.type, to: raw.to });
  else Engine.perform(0, raw);
}

function paintSound() {
  const btn = document.getElementById("sound");
  if (!btn) return;
  btn.textContent = audioOn ? "音效开" : "音效关";
  btn.setAttribute("aria-pressed", audioOn ? "true" : "false");
  btn.classList.toggle("primary", audioOn);
}

function boot() {
  try { Engine.selfCheck(); }
  catch (err) { console.error(err); }
  Engine.setListener(render);
  paintSound();
  document.getElementById("sound").addEventListener("click", () => {
    audioOn = !audioOn;
    try { localStorage.setItem("poker-sound", audioOn ? "1" : "0"); } catch { /* private window */ }
    paintSound();
    if (audioOn) playCue("tick");
  });
  showSetup();
  document.body.addEventListener("click", (e) => {
    if (aim === "hole") {
      const hole = e.target.closest("[data-hole]");
      if (hole) { playItem(snapshot().you, Number(hole.dataset.hole)); return; }
    }
    if (aim === "seat") {
      const seat = e.target.closest("[data-seat]");
      if (seat) {
        const S = snapshot();
        const target = Number(seat.dataset.seat);
        if (S && validTarget(S, target)) playItem(target, null);
        return;
      }
    }
    const btn = e.target.closest("[data-act]");
    if (!btn || btn.disabled) return;
    onAct(btn.dataset.act, btn);
  });
  document.addEventListener("keydown", (e) => {
    if (e.repeat || e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.key === "Escape" && aim) { aim = null; render(); return; }
    if (aim === "seat" && (e.key === "Enter" || e.key === " ")) {
      const seat = e.target.closest && e.target.closest("[data-seat]");
      if (seat) {
        const S = snapshot();
        const target = Number(seat.dataset.seat);
        if (S && validTarget(S, target)) { e.preventDefault(); playItem(target, null); }
      }
    }
    const S = snapshot();
    if (!S) return;
    if (e.target instanceof HTMLInputElement && e.target.type !== "range") return;
    if (e.target instanceof HTMLInputElement && e.target.type === "range" && e.key !== "Enter") return;
    const key = e.key.toLowerCase();
    if (S.phase === "over" && (key === "enter" || key === " ")) {
      e.preventDefault();
      const st = matchStatus(S);
      onAct(st === "continue" || st === "out" ? "next" : "restart");
      return;
    }
    if (S.phase !== "betting" || S.actor !== S.you) return;
    if (e.target instanceof HTMLButtonElement && (e.key === "Enter" || e.key === " ")) return;
    const me = S.players[S.you];
    if (key === "f") { e.preventDefault(); onAct("fold"); }
    else if (key === "c" || key === " ") {
      e.preventDefault();
      onAct(S.currentBet > me.bet ? "call" : "check");
    } else if (e.key === "Enter" && document.querySelector("[data-act=raise]")) {
      e.preventDefault();
      onAct("raise");
    }
  });
}

function checkCues() {
  const cases = [
    ["阿豪 弃牌", "fold"],
    ["小北 过牌", "check"],
    ["老K 全下 100", "allin"],
    ["阿豪 全下到 200", "allin"],
    ["阿梅 跟注 20", "chip"],
    ["老周 下注 40", "chip"],
    ["小南 加注到 80", "chip"],
    ["翻牌", "card"],
    ["转牌", "card"],
    ["河牌", "card"],
    ["第 2 手，庄家 你", "deal"],
    ["你 赢得 40", "win"],
    ["你、阿豪 平分底池，各得 20", "win"],
    ["你 花费 100，获得 望牌", "item"],
    ["你 半退 40", "refund"],
    ["你 对 阿豪 使用了望牌", "peek"],
    ["你 换了一张底牌", "card"],
    ["你 与 小北 交换了底牌", "swap"],
    ["这手没有赢家", ""],
  ];
  for (const [line, want] of cases) {
    if (cueFor(line) !== want) throw new Error(`${line} -> ${cueFor(line)}`);
  }
  for (const name of ["你", "阿豪", "小北", "老K", "阿梅", "老周", "小南"]) {
    if (!portrait({ name, isHuman: name === "你" }).includes("faces/")) throw new Error(name);
  }
  if (lookFor("路人甲", false)[0] === lookFor("路人甲", true)[0]) throw new Error("human face");
  const seen = new Set();
  for (const name of ["你", "阿豪", "小北", "老K", "阿梅", "老周", "小南"]) {
    const face = lookFor(name, name === "你").join("|");
    if (seen.has(face)) throw new Error("same face " + name);
    seen.add(face);
  }
}

if (typeof window !== "undefined") window.addEventListener("DOMContentLoaded", boot);
else checkCues();
