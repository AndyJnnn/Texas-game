// Unlimited Texas Hold'em: one human, three heuristic opponents.
const BB = 20;
const SB = 10;
const SUITS = ["s", "h", "d", "c"];
const SUIT_GLYPH = { s: "♠", h: "♥", d: "♦", c: "♣" };
const NEXT_STREET = { preflop: "flop", flop: "turn", turn: "river" };
const STREET_NAME = { preflop: "翻牌前", flop: "翻牌", turn: "转牌", river: "河牌" };

const G = {
  players: [],
  board: [],
  deck: [],
  dealer: 3,
  sbIndex: -1,
  bbIndex: -1,
  street: "preflop",
  currentBet: 0,
  minRaise: BB,
  lastFull: 0,
  actor: -1,
  reveal: false,
  phase: "idle",
  log: [],
  result: "",
  lastPot: 0,
  winnerIdx: [],
  handNo: 0,
  timer: 0,
  queue: [],
  sync: false,
};

function rankName(r) {
  return { 14: "A", 13: "K", 12: "Q", 11: "J" }[r] || String(r);
}

function handName(score) {
  if (!score) return "";
  const n = rankName;
  switch (score[0]) {
    case 8:
      return score[1] === 14 ? "皇家同花顺" : score[1] === 5 ? "同花顺 A 到 5" : `同花顺 ${n(score[1])} 高`;
    case 7: return `四条 ${n(score[1])}`;
    case 6: return `葫芦 ${n(score[1])} 带 ${n(score[2])}`;
    case 5: return `同花 ${n(score[1])} 高`;
    case 4: return score[1] === 5 ? "顺子 A 到 5" : `顺子 ${n(score[1])} 高`;
    case 3: return `三条 ${n(score[1])}`;
    case 2: return `两对 ${n(score[1])} 和 ${n(score[2])}`;
    case 1: return `一对 ${n(score[1])}`;
    default: return `高牌 ${n(score[1])}`;
  }
}

function score5(cards) {
  const ranks = cards.map((c) => c.r).sort((a, b) => b - a);
  const flush = cards.every((c) => c.s === cards[0].s);
  const count = new Map();
  for (const r of ranks) count.set(r, (count.get(r) || 0) + 1);
  const groups = [...count.entries()].sort((a, b) => b[1] - a[1] || b[0] - a[0]);
  const uniq = [...new Set(ranks)];
  let straightHi = 0;
  if (uniq.length === 5) {
    if (uniq[0] - uniq[4] === 4) straightHi = uniq[0];
    else if (uniq[0] === 14 && uniq[1] === 5 && uniq[4] === 2) straightHi = 5;
  }
  if (flush && straightHi) return [8, straightHi];
  if (groups[0][1] === 4) return [7, groups[0][0], groups[1][0]];
  if (groups[0][1] === 3 && groups[1][1] === 2) return [6, groups[0][0], groups[1][0]];
  if (flush) return [5, ...ranks];
  if (straightHi) return [4, straightHi];
  if (groups[0][1] === 3) return [3, groups[0][0], ...groups.slice(1).map((g) => g[0])];
  if (groups[0][1] === 2 && groups[1][1] === 2) return [2, groups[0][0], groups[1][0], groups[2][0]];
  if (groups[0][1] === 2) return [1, groups[0][0], ...groups.slice(1).map((g) => g[0])];
  return [0, ...ranks];
}

function cmpScore(a, b) {
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const d = (i < a.length ? a[i] : 0) - (i < b.length ? b[i] : 0);
    if (d) return d;
  }
  return 0;
}

function bestOf(cards) {
  let best = null;
  const buf = [];
  const n = cards.length;
  function rec(start, left) {
    if (left === 0) {
      const s = score5(buf);
      if (!best || cmpScore(s, best) > 0) best = s.slice();
      return;
    }
    for (let i = start; i <= n - left; i++) {
      buf.push(cards[i]);
      rec(i + 1, left - 1);
      buf.pop();
    }
  }
  if (n >= 5) rec(0, 5);
  return best;
}

function makeDeck() {
  const d = [];
  for (const s of SUITS) for (let r = 2; r <= 14; r++) d.push({ r, s });
  return d;
}

function shuffle(deck) {
  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  return deck;
}

function freshPlayers() {
  const spec = [
    { name: "你", isHuman: true, looseness: 0 },
    { name: "阿豪", isHuman: false, looseness: 10 },
    { name: "小北", isHuman: false, looseness: 0 },
    { name: "老K", isHuman: false, looseness: -8 },
  ];
  G.players = spec.map((s) => ({
    ...s,
    stack: 1000,
    hole: [],
    folded: false,
    allIn: false,
    bet: 0,
    contributed: 0,
    inHand: false,
    needsAction: false,
    canRaise: true,
  }));
}

function nextIndex(from, pred) {
  const n = G.players.length;
  for (let k = 1; k <= n; k++) {
    const i = (from + k) % n;
    if (pred(G.players[i], i)) return i;
  }
  return -1;
}

function potSize() {
  return G.players.reduce((sum, p) => sum + p.contributed, 0);
}

function minRaiseTo() {
  return Math.max(G.lastFull + G.minRaise, G.currentBet + 1);
}

function commit(p, amount) {
  const n = Math.trunc(amount);
  const pay = Math.min(p.stack, n > 0 ? n : 0);
  p.stack -= pay;
  p.bet += pay;
  p.contributed += pay;
  if (p.stack === 0 && pay > 0) p.allIn = true;
  return pay;
}

function say(msg) {
  G.log.push(msg);
  if (G.log.length > 40) G.log.shift();
}

function oddWinner(winners) {
  const ids = new Set(winners);
  for (let k = 1; k <= G.players.length; k++) {
    const i = (G.dealer + k) % G.players.length;
    if (ids.has(G.players[i])) return G.players[i];
  }
  return winners[0];
}

function settle(showdown) {
  const awards = G.players.map(() => 0);
  const levels = [...new Set(G.players.map((p) => p.contributed).filter((c) => c > 0))].sort((a, b) => a - b);
  let prev = 0;
  for (const level of levels) {
    const nPayers = G.players.filter((p) => p.contributed >= level).length;
    const size = (level - prev) * nPayers;
    prev = level;
    if (size <= 0) continue;
    let winners = G.players.filter((p) => p.inHand && !p.folded && p.contributed >= level);
    if (!winners.length) continue;
    if (showdown && winners.length > 1) {
      const scored = winners.map((p) => ({ p, s: bestOf(p.hole.concat(G.board)) }));
      const top = scored.reduce((m, x) => (cmpScore(x.s, m) > 0 ? x.s : m), scored[0].s);
      winners = scored.filter((x) => cmpScore(x.s, top) === 0).map((x) => x.p);
    }
    const share = Math.floor(size / winners.length);
    let rem = size - share * winners.length;
    for (const w of winners) {
      w.stack += share;
      awards[G.players.indexOf(w)] += share;
    }
    if (rem) {
      const w = oddWinner(winners);
      w.stack += rem;
      awards[G.players.indexOf(w)] += rem;
    }
  }
  return awards;
}

function announce(awards) {
  const won = [];
  awards.forEach((n, i) => { if (n > 0) won.push({ n, i, name: G.players[i].name }); });
  G.winnerIdx = won.map((x) => x.i);
  if (!won.length) G.result = "这手没有赢家";
  else if (won.length > 1 && won.every((x) => x.n === won[0].n)) {
    G.result = `${won.map((x) => x.name).join("、")} 平分底池，各得 ${won[0].n}`;
  } else G.result = won.map((x) => `${x.name} 赢得 ${x.n}`).join("，");
  say(G.result);
}

function finishHand(showdown) {
  clearTimeout(G.timer);
  G.reveal = showdown;
  G.lastPot = potSize();
  const awards = settle(showdown);
  for (const p of G.players) {
    p.bet = 0;
    p.contributed = 0;
  }
  announce(awards);
  G.phase = "over";
  G.actor = -1;
  render();
}

function legalize(p, d) {
  const toCall = Math.max(0, G.currentBet - p.bet);
  const maxTo = p.bet + p.stack;
  const minTo = minRaiseTo();
  if (d.type === "fold") return toCall === 0 ? { type: "check" } : { type: "fold" };
  if (d.type === "check") return toCall === 0 ? d : { type: "call" };
  if (d.type === "call") return toCall === 0 ? { type: "check" } : { type: "call" };
  if (d.type === "raise") {
    if (!p.canRaise || p.stack <= toCall) return toCall === 0 ? { type: "check" } : { type: "call" };
    if (maxTo <= G.currentBet) return toCall === 0 ? { type: "check" } : { type: "call" };
    let to = Math.floor(d.to);
    if (maxTo < minTo) return { type: "raise", to: maxTo };
    if (to < minTo) to = minTo;
    if (to > maxTo) to = maxTo;
    return { type: "raise", to };
  }
  return toCall === 0 ? { type: "check" } : { type: "fold" };
}

function apply(i, d) {
  const p = G.players[i];
  if (d.type === "fold") {
    p.folded = true;
    p.needsAction = false;
    say(`${p.name} 弃牌`);
    return;
  }
  if (d.type === "check") {
    p.needsAction = false;
    say(`${p.name} 过牌`);
    return;
  }
  if (d.type === "call") {
    const need = Math.min(Math.max(0, G.currentBet - p.bet), p.stack);
    commit(p, need);
    p.needsAction = false;
    say(p.allIn ? `${p.name} 全下 ${need}` : `${p.name} 跟注 ${need}`);
    return;
  }
  const prev = G.currentBet;
  const opening = prev === 0;
  commit(p, d.to - p.bet);
  const actual = p.bet;
  const increment = actual - prev;
  const full = increment >= G.minRaise && actual >= G.lastFull + G.minRaise;
  if (actual > prev && full) {
    G.minRaise = increment;
    G.lastFull = actual;
    G.currentBet = actual;
    for (const o of G.players) {
      if (o === p || o.folded || !o.inHand || o.allIn) continue;
      o.needsAction = true;
      o.canRaise = true;
    }
  } else if (actual > prev) {
    G.currentBet = actual;
    for (const o of G.players) {
      if (o === p || o.folded || !o.inHand || o.allIn) continue;
      if (o.bet < G.currentBet) {
        const already = !o.needsAction;
        o.needsAction = true;
        if (already) o.canRaise = false;
      }
    }
  }
  p.needsAction = false;
  const verb = p.allIn ? (opening ? "全下" : "全下到") : opening ? "下注" : "加注到";
  say(`${p.name} ${verb} ${actual}`);
}

function dealHoles() {
  const order = [];
  for (let k = 1; k <= G.players.length; k++) {
    const i = (G.dealer + k) % G.players.length;
    if (G.players[i].inHand) order.push(i);
  }
  for (let round = 0; round < 2; round++) {
    for (const i of order) G.players[i].hole.push(G.deck.pop());
  }
}

function dealBoard(n) {
  G.deck.pop();
  for (let i = 0; i < n; i++) G.board.push(G.deck.pop());
}

function beginBetting() {
  const live = G.players.filter((p) => p.inHand && !p.folded);
  if (live.length <= 1) return finishHand(false);
  for (const p of G.players) {
    const can = p.inHand && !p.folded && !p.allIn;
    p.needsAction = can;
    p.canRaise = can;
  }
  const actors = G.players.filter((p) => p.needsAction);
  if (actors.length === 0 || (actors.length === 1 && actors[0].bet >= G.currentBet)) return onRoundEnd();
  const from = G.street === "preflop" ? G.bbIndex : G.dealer;
  G.actor = nextIndex(from, (p) => p.needsAction);
  if (G.actor < 0) return onRoundEnd();
  prompt();
}

function onRoundEnd() {
  if (G.players.filter((p) => p.inHand && !p.folded).length <= 1) return finishHand(false);
  G.phase = "deal";
  G.actor = -1;
  render();
  if (G.street === "river") {
    later(() => finishHand(true), 700);
    return;
  }
  later(() => {
    for (const p of G.players) p.bet = 0;
    G.currentBet = 0;
    G.minRaise = BB;
    G.lastFull = 0;
    G.street = NEXT_STREET[G.street];
    dealBoard(G.street === "flop" ? 3 : 1);
    say(STREET_NAME[G.street]);
    beginBetting();
  }, 650);
}

function later(fn, ms) {
  clearTimeout(G.timer);
  if (G.sync) {
    G.queue.push(fn);
    return;
  }
  G.timer = setTimeout(fn, ms);
}

function flush() {
  let guard = 0;
  while (G.queue.length) {
    if (++guard > 5000) throw new Error("betting did not end");
    G.queue.shift()();
  }
}

function prompt() {
  const p = G.players[G.actor];
  G.phase = "betting";
  render();
  if (p.isHuman) return;
  later(() => {
    if (G.phase !== "betting" || G.players[G.actor] !== p) return;
    perform(G.actor, aiDecide(p));
  }, 700);
}

function perform(i, raw) {
  apply(i, legalize(G.players[i], raw));
  if (G.players.filter((p) => p.inHand && !p.folded).length <= 1) return finishHand(false);
  const next = nextIndex(i, (p) => p.needsAction);
  if (next < 0) return onRoundEnd();
  G.actor = next;
  prompt();
}

function tableStatus() {
  const alive = G.players.filter((p) => p.stack > 0);
  if (!G.players[0] || G.players[0].stack <= 0) return "bust";
  if (alive.length < 2) return "win";
  return "continue";
}

function resetTable() {
  clearTimeout(G.timer);
  freshPlayers();
  G.board = [];
  G.dealer = 3;
  G.handNo = 0;
  G.log = [];
  G.phase = "idle";
  G.street = "preflop";
  G.currentBet = 0;
  G.minRaise = BB;
  G.lastFull = 0;
  G.reveal = false;
  G.result = "";
  G.winnerIdx = [];
  G.actor = -1;
  G.queue = [];
  G.sync = false;
}

function startHand() {
  clearTimeout(G.timer);
  if (G.players.filter((p) => p.stack > 0).length < 2) {
    G.phase = "over";
    render();
    return;
  }
  G.dealer = nextIndex(G.dealer, (p) => p.stack > 0);
  G.board = [];
  G.reveal = false;
  G.result = "";
  G.winnerIdx = [];
  G.log = [];
  G.handNo += 1;
  for (const p of G.players) {
    p.hole = [];
    p.folded = p.stack <= 0;
    p.allIn = false;
    p.bet = 0;
    p.contributed = 0;
    p.inHand = p.stack > 0;
    p.needsAction = false;
    p.canRaise = true;
  }
  G.deck = shuffle(makeDeck());
  const seated = G.players.filter((p) => p.inHand).length;
  if (seated === 2) {
    G.sbIndex = G.dealer;
    G.bbIndex = nextIndex(G.dealer, (p) => p.inHand);
  } else {
    G.sbIndex = nextIndex(G.dealer, (p) => p.inHand);
    G.bbIndex = nextIndex(G.sbIndex, (p) => p.inHand);
  }
  commit(G.players[G.sbIndex], SB);
  commit(G.players[G.bbIndex], BB);
  const bbBet = G.players[G.bbIndex].bet;
  G.currentBet = Math.max(G.players[G.sbIndex].bet, bbBet);
  G.minRaise = BB;
  G.lastFull = bbBet >= BB ? bbBet : 0;
  G.street = "preflop";
  dealHoles();
  say(`第 ${G.handNo} 手，庄家 ${G.players[G.dealer].name}`);
  beginBetting();
  if (G.sync) flush();
}

// ponytail: chen + made-hand buckets, not equity. Ceiling: misplays draws and blockers. Upgrade: Monte Carlo vs a range.
function chen(hole) {
  const [hi, lo] = [...hole].sort((a, b) => b.r - a.r);
  const face = { 14: 10, 13: 8, 12: 7, 11: 6 };
  let s = face[hi.r] ?? hi.r / 2;
  if (hi.r === lo.r) return Math.max(5, s * 2);
  if (hi.s === lo.s) s += 2;
  const gap = hi.r - lo.r - 1;
  if (gap === 1) s -= 1;
  else if (gap === 2) s -= 2;
  else if (gap === 3) s -= 4;
  else if (gap >= 4) s -= 5;
  if (gap <= 1 && hi.r < 12) s += 1;
  return s;
}

function drawInfo(hole, board) {
  const cards = hole.concat(board);
  let flushDraw = false;
  for (const s of SUITS) {
    if (cards.filter((c) => c.s === s).length === 4 && hole.some((c) => c.s === s)) flushDraw = true;
  }
  const set = new Set(cards.map((c) => c.r));
  if (set.has(14)) set.add(1);
  const rs = [...set].sort((a, b) => a - b);
  let oesd = false;
  let gut = false;
  for (let i = 0; i < rs.length; i++) {
    let run = 1;
    for (let j = i + 1; j < rs.length && rs[j] === rs[j - 1] + 1; j++) run++;
    if (run >= 4) {
      const start = rs[i];
      const end = start + run - 1;
      if (start > 1 && end < 14) oesd = true;
      else gut = true;
    }
  }
  for (let hi = 5; hi <= 14; hi++) {
    const w = [hi - 4, hi - 3, hi - 2, hi - 1, hi];
    const miss = w.filter((r) => !set.has(r));
    if (miss.length === 1 && miss[0] !== w[0] && miss[0] !== w[4]) gut = true;
  }
  return { flushDraw, oesd, gut };
}

function postMetric(p) {
  const score = bestOf(p.hole.concat(G.board));
  const cat = score[0];
  const base = [6, 34, 58, 74, 82, 90, 98, 108, 120][cat];
  let m = base + Math.min(8, ((score[1] || 0) - 6) / 2);
  if (cat === 1) {
    const top = Math.max(...G.board.map((c) => c.r));
    if (score[1] > top) m += 22;
    else if (score[1] === top) m += 14;
    else if (score[1] < top - 4) m -= 10;
  }
  const d = drawInfo(p.hole, G.board);
  if (cat < 5 && d.flushDraw) m += 16;
  if (cat < 4 && d.oesd) m += 14;
  else if (cat < 4 && d.gut) m += 6;
  return m;
}

function presetAmount(kind, p) {
  const minTo = minRaiseTo();
  const maxTo = p.bet + p.stack;
  const toCall = Math.max(0, G.currentBet - p.bet);
  const pot = potSize();
  let to = minTo;
  if (kind === "half") to = G.currentBet + Math.floor((pot + toCall) / 2);
  else if (kind === "pot") to = G.currentBet + pot + toCall;
  else if (kind === "all") to = maxTo;
  if (to < minTo) to = minTo;
  if (to > maxTo) to = maxTo;
  return to;
}

function raiseBounds(p) {
  const maxTo = p.bet + p.stack;
  const minTo = minRaiseTo();
  return { minTo, maxTo, ok: p.canRaise && maxTo >= minTo && maxTo > G.currentBet };
}

function aiDecide(p) {
  const toCall = Math.max(0, G.currentBet - p.bet);
  const pot = Math.max(1, potSize());
  const bounds = raiseBounds(p);
  const want = (kind) => ({ type: "raise", to: presetAmount(kind, p) });
  if (G.street === "preflop") {
    const c = chen(p.hole) + (p.looseness || 0) / 4 + (Math.random() - 0.5) * 1.2;
    if (toCall === 0) {
      if (c >= 12 && bounds.ok) return want(c >= 16 ? "pot" : "half");
      if (c >= 8 && bounds.ok && Math.random() < 0.55) return want("half");
      return { type: "check" };
    }
    if (c >= 14 && bounds.ok && Math.random() < 0.75) return want("pot");
    if (c >= 10 && bounds.ok && toCall <= BB * 4 && Math.random() < 0.4) return want("half");
    if (c >= 8 || (c >= 5 && toCall <= BB)) return { type: "call" };
    if (p.hole[0].r === p.hole[1].r && toCall <= BB * 5) return { type: "call" };
    if (toCall >= p.stack && c >= 11) return { type: "call" };
    return { type: "fold" };
  }
  const m = postMetric(p) + (p.looseness || 0) + (Math.random() - 0.5) * 8;
  if (toCall === 0) {
    if (m >= 70 && bounds.ok) return want("pot");
    if (m >= 52 && bounds.ok) return want("half");
    if (m >= 40 && bounds.ok && Math.random() < 0.4) return want("half");
    if (m < 22 && bounds.ok && Math.random() < 0.08) return want("half");
    return { type: "check" };
  }
  const price = toCall / (pot + toCall);
  if (m >= 90 && bounds.ok) return want("pot");
  if (m >= 70 && bounds.ok && Math.random() < 0.6) return want("pot");
  if (m >= 48) return { type: "call" };
  if (m >= 34 && price <= 0.35) return { type: "call" };
  if (m >= 26 && price <= 0.22) return { type: "call" };
  if (toCall >= p.stack && m >= 60) return { type: "call" };
  return { type: "fold" };
}

function cardHTML(card) {
  const red = card.s === "h" || card.s === "d";
  const suit = SUIT_GLYPH[card.s];
  const r = rankName(card.r);
  const ten = r === "10" ? " ten" : "";
  return `<div class="card${red ? " red" : ""}${ten}" role="img" aria-label="${r}${suit}"><span class="rk">${r}</span><span class="su">${suit}</span><span class="pip">${suit}</span></div>`;
}

function cardBack() {
  return `<div class="card back" aria-hidden="true"></div>`;
}

function cardRow(p) {
  if (!p.inHand || !p.hole.length) return `<div class="cards"></div>`;
  if (!p.isHuman && p.folded) return `<div class="cards dim">${p.hole.map(cardBack).join("")}</div>`;
  const dim = p.isHuman && p.folded ? " dim" : "";
  const face = p.isHuman || (G.reveal && !p.folded);
  const html = face ? p.hole.map(cardHTML).join("") : p.hole.map(cardBack).join("");
  return `<div class="cards${dim}">${html}</div>`;
}

function tags(i) {
  let html = "";
  if (i === G.dealer) html += `<span class="tag dealer">庄</span>`;
  if (i === G.sbIndex) html += `<span class="tag">小盲</span>`;
  if (i === G.bbIndex) html += `<span class="tag">大盲</span>`;
  return html;
}

function statusText(p) {
  if (!p.inHand) return "出局";
  if (p.folded) return "弃牌";
  if (p.allIn) return "全下";
  return "";
}

function seatHTML(i) {
  const p = G.players[i];
  const cls = [
    "seat",
    i === G.actor && G.phase === "betting" ? "active" : "",
    p.folded ? "folded" : "",
    G.phase === "over" && G.winnerIdx.includes(i) ? "winner" : "",
  ].filter(Boolean).join(" ");
  const st = statusText(p);
  const bet = p.bet > 0 ? `本轮 ${p.bet}` : "";
  return `<div class="${cls}" data-seat="${i}">
    ${cardRow(p)}
    <p class="who"><span class="nm">${p.name}</span>${tags(i)}</p>
    <p class="stack">${p.stack}${st ? `<span class="st">${st}</span>` : ""}</p>
    <p class="bet">${bet}</p>
  </div>`;
}

function centerHTML() {
  const slots = [];
  for (let i = 0; i < 5; i++) slots.push(G.board[i] ? cardHTML(G.board[i]) : `<div class="slot"></div>`);
  const pot = G.phase === "over" ? G.lastPot : potSize();
  const line = G.phase === "over" ? G.result : STREET_NAME[G.street];
  return `<div class="center"><p class="pot">底池 ${pot}</p><div class="board">${slots.join("")}</div><p class="street">${line}</p></div>`;
}

function yourHandText() {
  const p = G.players[0];
  if (!p || !p.hole.length) return "";
  if (!p.inHand) return "你已出局";
  if (p.folded) return "你已弃牌";
  if (G.board.length >= 3) return `你的牌力：${handName(bestOf(p.hole.concat(G.board)))}`;
  if (p.hole[0].r === p.hole[1].r) return `你的底牌：一对 ${rankName(p.hole[0].r)}`;
  const hi = [...p.hole].sort((a, b) => b.r - a.r);
  const suited = p.hole[0].s === p.hole[1].s ? " 同花" : "";
  return `你的底牌：${rankName(hi[0].r)} ${rankName(hi[1].r)}${suited}`;
}

function render() {
  if (typeof document === "undefined") return;
  const table = document.getElementById("table");
  if (!table || !G.players.length) return;
  table.innerHTML = `<div class="felt">${seatHTML(1)}${seatHTML(2)}${seatHTML(3)}${centerHTML()}${seatHTML(0)}</div>`;
  document.getElementById("meta").textContent = G.handNo ? `第 ${G.handNo} 手` : "";
  document.getElementById("rank").textContent = yourHandText();
  const log = document.getElementById("log");
  log.replaceChildren();
  for (const line of G.log.slice(-6)) {
    const li = document.createElement("li");
    li.textContent = line;
    log.appendChild(li);
  }
  document.getElementById("live").textContent = G.log[G.log.length - 1] || "";
  renderControls();
}

function renderControls() {
  const el = document.getElementById("controls");
  if (G.phase === "over") {
    const st = tableStatus();
    if (st === "bust") {
      el.innerHTML = `<p class="banner">筹码输光了</p><button type="button" class="primary" data-act="restart">重新开始</button>`;
    } else if (st === "win") {
      el.innerHTML = `<p class="banner">你赢下了这桌</p><button type="button" class="primary" data-act="restart">再来一桌</button>`;
    } else {
      el.innerHTML = `<button type="button" class="primary" data-act="next">下一手</button>`;
    }
    return;
  }
  const actor = G.actor >= 0 ? G.players[G.actor] : null;
  if (G.phase !== "betting" || !actor || !actor.isHuman) {
    const me = G.players[0];
    let text = "发牌中";
    if (G.phase === "deal" && G.street === "river") text = "摊牌中";
    else if (actor && !actor.isHuman) text = `${me && me.folded ? "你已弃牌，" : ""}等待${actor.name}`;
    el.innerHTML = `<p class="wait">${text}</p>`;
    return;
  }
  const toCall = Math.max(0, G.currentBet - actor.bet);
  const bounds = raiseBounds(actor);
  let html = "";
  if (toCall > 0) html += `<button type="button" class="danger" data-act="fold">弃牌</button>`;
  if (toCall === 0) html += `<button type="button" class="primary" data-act="check">过牌</button>`;
  else if (actor.stack <= toCall) html += `<button type="button" class="primary" data-act="call">全下 ${actor.stack}</button>`;
  else html += `<button type="button" class="primary" data-act="call">跟注 ${toCall}</button>`;
  if (actor.canRaise && actor.stack > toCall && !bounds.ok) {
    html += `<button type="button" data-act="allin">全下 ${actor.stack}</button>`;
  }
  if (bounds.ok) {
    const opening = G.currentBet === 0;
    const value = presetAmount("half", actor);
    html += `<div class="raisebox">
      <label>${opening ? "下注" : "加注到"} <strong id="raise-amt">${value}</strong>
        <input id="raise" type="range" min="${bounds.minTo}" max="${bounds.maxTo}" step="1" value="${value}" aria-label="${opening ? "下注金额" : "加注金额"}">
      </label>
      <button type="button" data-preset="min">最小</button>
      <button type="button" data-preset="half">半池</button>
      <button type="button" data-preset="pot">底池</button>
      <button type="button" data-preset="all">全下</button>
      <button type="button" data-act="raise">确认</button>
    </div>`;
  }
  el.innerHTML = html;
  const slider = document.getElementById("raise");
  const out = document.getElementById("raise-amt");
  if (!slider) return;
  slider.addEventListener("input", () => { out.textContent = slider.value; });
  el.querySelectorAll("[data-preset]").forEach((btn) => {
    btn.addEventListener("click", () => {
      slider.value = String(presetAmount(btn.dataset.preset, actor));
      out.textContent = slider.value;
    });
  });
}

function onAct(act) {
  if (act === "next") {
    if (G.phase !== "over" || tableStatus() !== "continue") return;
    startHand();
    return;
  }
  if (act === "restart") {
    if (G.phase !== "over") return;
    resetTable();
    startHand();
    return;
  }
  if (G.phase !== "betting" || G.actor < 0 || !G.players[G.actor].isHuman) return;
  const p = G.players[G.actor];
  if (act === "fold") perform(G.actor, { type: "fold" });
  else if (act === "check") perform(G.actor, { type: "check" });
  else if (act === "call" || act === "allin") {
    if (act === "allin" && p.canRaise && p.bet + p.stack > G.currentBet) perform(G.actor, { type: "raise", to: p.bet + p.stack });
    else perform(G.actor, { type: "call" });
  } else if (act === "raise") {
    const slider = document.getElementById("raise");
    if (!slider) return;
    perform(G.actor, { type: "raise", to: Number(slider.value) });
  }
}

function boot() {
  try { selfCheck(); }
  catch (err) { console.error(err); }
  resetTable();
  startHand();
  document.body.addEventListener("click", (e) => {
    const preset = e.target.closest("[data-preset]");
    if (preset) return;
    const btn = e.target.closest("[data-act]");
    if (!btn) return;
    onAct(btn.dataset.act);
  });
  document.addEventListener("keydown", (e) => {
    if (e.repeat || e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.target instanceof HTMLInputElement && e.target.type !== "range") return;
    if (e.target instanceof HTMLInputElement && e.target.type === "range" && e.key !== "Enter") return;
    const key = e.key.toLowerCase();
    if (G.phase === "over" && (key === "enter" || key === " ")) {
      e.preventDefault();
      onAct(tableStatus() === "continue" ? "next" : "restart");
      return;
    }
    if (G.phase !== "betting" || G.actor < 0 || !G.players[G.actor].isHuman) return;
    if (e.target instanceof HTMLButtonElement && (e.key === "Enter" || e.key === " ")) return;
    if (key === "f") { e.preventDefault(); onAct("fold"); }
    else if (key === "c" || key === " ") {
      e.preventDefault();
      onAct(G.currentBet > G.players[G.actor].bet ? "call" : "check");
    } else if (e.key === "Enter" && document.getElementById("raise")) {
      e.preventDefault();
      onAct("raise");
    }
  });
}

function C(r, s) { return { r, s }; }

function selfCheck() {
  const assert = (cond, msg) => { if (!cond) throw new Error(msg || "assert"); };
  const royal = bestOf([C(14, "h"), C(13, "h"), C(12, "h"), C(11, "h"), C(10, "h"), C(2, "s"), C(3, "s")]);
  assert(royal[0] === 8 && royal[1] === 14 && handName(royal) === "皇家同花顺", "royal");
  const wheel = score5([C(14, "s"), C(5, "h"), C(4, "d"), C(3, "c"), C(2, "s")]);
  const six = score5([C(6, "s"), C(5, "h"), C(4, "d"), C(3, "c"), C(2, "s")]);
  assert(wheel[0] === 4 && wheel[1] === 5, "wheel");
  assert(cmpScore(wheel, six) < 0, "wheel loses to six");
  const steel = score5([C(14, "h"), C(5, "h"), C(4, "h"), C(3, "h"), C(2, "h")]);
  assert(steel[0] === 8 && steel[1] === 5, "steel wheel");
  assert(cmpScore(royal, steel) > 0, "royal beats steel");
  const quads = score5([C(9, "s"), C(9, "h"), C(9, "d"), C(9, "c"), C(14, "s")]);
  assert(quads[0] === 7 && cmpScore(steel, quads) > 0, "straight flush beats quads");
  const boat = score5([C(14, "s"), C(14, "h"), C(14, "d"), C(13, "c"), C(13, "s")]);
  const flush = score5([C(14, "h"), C(13, "h"), C(12, "h"), C(9, "h"), C(3, "h")]);
  assert(boat[0] === 6 && flush[0] === 5 && cmpScore(boat, flush) > 0, "full house beats flush");
  const twoHi = score5([C(14, "s"), C(14, "h"), C(13, "s"), C(13, "h"), C(12, "d")]);
  const twoLo = score5([C(14, "d"), C(14, "c"), C(13, "d"), C(13, "c"), C(11, "s")]);
  assert(cmpScore(twoHi, twoLo) > 0, "two pair kicker");
  const pairedStraight = bestOf([C(9, "h"), C(8, "h"), C(7, "c"), C(7, "d"), C(6, "s"), C(5, "c"), C(2, "h")]);
  assert(pairedStraight[0] === 4 && pairedStraight[1] === 9, "straight on paired board");
  const aceFlush = bestOf([C(14, "h"), C(13, "h"), C(12, "h"), C(11, "h"), C(9, "h"), C(10, "s"), C(8, "c")]);
  assert(aceFlush[0] === 5 && aceFlush[1] === 14, "nut flush not straight");
  freshPlayers();
  G.players[0].inHand = true;
  G.board = [];
  G.players[0].hole = [C(14, "c"), C(13, "c")];
  assert(yourHandText() === "你的底牌：A K 同花", yourHandText());
  G.players[0].hole = [C(9, "s"), C(9, "h")];
  assert(yourHandText() === "你的底牌：一对 9", yourHandText());
  assert(chen([C(14, "s"), C(14, "h")]) === 20, "AA");
  assert(chen([C(14, "s"), C(13, "s")]) === 12, "AKs");
  assert(chen([C(7, "s"), C(2, "h")]) < 0, "72o");

  freshPlayers();
  const P = G.players;
  P.forEach((p) => { p.inHand = true; p.needsAction = false; p.canRaise = false; p.stack = 1000; p.bet = 0; p.contributed = 0; });
  G.currentBet = 20;
  G.minRaise = 20;
  G.lastFull = 20;
  P[0].bet = 20; P[0].contributed = 20; P[0].stack = 980;
  apply(0, { type: "raise", to: 60 });
  assert(G.currentBet === 60 && G.minRaise === 40 && G.lastFull === 60, "min raise updates");
  assert(P[1].needsAction && P[1].canRaise && P[0].needsAction === false, "raise reopens");
  assert(P[0].stack === 940, "raise chips");

  freshPlayers();
  G.players.forEach((p) => { p.inHand = true; p.needsAction = false; p.canRaise = true; });
  G.currentBet = 100;
  G.minRaise = 100;
  G.lastFull = 100;
  const Q = G.players;
  Q[0].bet = 100; Q[0].contributed = 100; Q[0].stack = 900; Q[0].needsAction = false;
  Q[1].bet = 100; Q[1].contributed = 100; Q[1].stack = 900; Q[1].needsAction = false;
  Q[2].bet = 0; Q[2].contributed = 0; Q[2].stack = 150; Q[2].needsAction = true;
  Q[3].bet = 0; Q[3].contributed = 0; Q[3].stack = 1000; Q[3].needsAction = true; Q[3].canRaise = true;
  const bank = () => G.players.reduce((s, p) => s + p.stack + p.contributed, 0);
  const beforeShort = bank();
  apply(2, { type: "raise", to: 150 });
  assert(G.currentBet === 150 && G.lastFull === 100 && G.minRaise === 100, "short all-in does not reset min raise");
  assert(minRaiseTo() === 200, "next full raise is to 200");
  assert(Q[0].needsAction && Q[0].canRaise === false && Q[1].canRaise === false, "short all-in does not reopen raising");
  assert(Q[3].canRaise && Q[3].needsAction && Q[2].allIn, "players still to act may raise");
  assert(bank() === beforeShort, "chips conserved on short all-in");

  freshPlayers();
  const F = G.players;
  F.forEach((p) => { p.inHand = true; p.folded = false; p.stack = 1000; p.contributed = 0; p.bet = 0; });
  commit(F[1], 10);
  commit(F[2], 20);
  F[0].folded = true;
  F[1].folded = true;
  F[3].folded = true;
  const foldAwards = settle(false);
  assert(foldAwards[2] === 30 && F[2].stack === 1010, "big blind wins the blinds");
  assert(F.reduce((s, p) => s + p.stack, 0) === 4000, "fold pot conserved");

  freshPlayers();
  const S = G.players;
  function put(i, n, folded) {
    S[i].stack = 1000 - n;
    S[i].contributed = n;
    S[i].inHand = true;
    S[i].folded = folded;
  }
  put(0, 200, true);
  put(1, 200, false);
  put(2, 80, false);
  S[3].inHand = false;
  S[3].folded = true;
  S[3].contributed = 0;
  G.board = [C(14, "h"), C(7, "c"), C(2, "d"), C(9, "s"), C(3, "c")];
  S[1].hole = [C(13, "h"), C(12, "d")];
  S[2].hole = [C(14, "s"), C(13, "d")];
  G.dealer = 0;
  const side = settle(true);
  assert(side[2] === 240 && side[1] === 240 && side[0] === 0, "side pot " + side.join(","));
  assert(S.reduce((s, p) => s + p.stack, 0) === 4000, "side pot conserved");

  freshPlayers();
  const O = G.players;
  O.forEach((p, i) => {
    const n = i < 3 ? 11 : 0;
    p.stack = 1000 - n;
    p.contributed = n;
    p.inHand = i < 3;
    p.folded = i === 0 || i === 3;
  });
  G.board = [C(2, "d"), C(3, "c"), C(7, "h"), C(9, "s"), C(4, "d")];
  O[1].hole = [C(12, "c"), C(11, "d")];
  O[2].hole = [C(12, "d"), C(11, "c")];
  G.dealer = 0;
  const odd = settle(true);
  assert(odd[1] === 17 && odd[2] === 16 && odd[0] === 0, "odd chip " + odd.join(","));
  assert(O.reduce((s, p) => s + p.stack, 0) === 4000, "split conserved");

  freshPlayers();
  G.players.forEach((p) => { p.isHuman = false; });
  G.dealer = 3;
  G.handNo = 0;
  G.sync = true;
  G.queue = [];
  try {
    for (let h = 0; h < 40; h++) {
      if (G.players.filter((p) => p.stack > 0).length < 2) break;
      startHand();
      const stacks = G.players.reduce((s, p) => s + p.stack, 0);
      assert(stacks === 4000, `leak hand ${h}: ${G.players.map((p) => p.stack).join(",")} | ${G.log.join(" / ")}`);
      assert(G.phase === "over", `stuck hand ${h} ${G.phase} ${G.street}`);
      assert(G.players.every((p) => p.stack >= 0 && Number.isFinite(p.stack)), "negative stack");
      assert(G.queue.length === 0, "timer queue leaked");
    }
  } finally {
    G.sync = false;
    G.queue = [];
  }
}

if (typeof window === "undefined") {
  selfCheck();
  console.log("selfCheck ok");
} else {
  window.addEventListener("DOMContentLoaded", boot);
}
