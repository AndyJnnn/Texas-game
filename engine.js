// Shared hold'em rules for the page and the room server.
const BB = 20;
const SB = 10;
const CHIP = 5;
const SUITS = ["s", "h", "d", "c"];
const SUIT_GLYPH = { s: "♠", h: "♥", d: "♦", c: "♣" };
const NEXT_STREET = { preflop: "flop", flop: "turn", turn: "river" };
const STREET_NAME = { preflop: "翻牌前", flop: "翻牌", turn: "转牌", river: "河牌" };
const BOTS = [
  { name: "阿豪", looseness: 10 },
  { name: "小北", looseness: 0 },
  { name: "老K", looseness: -8 },
  { name: "阿梅", looseness: 6 },
  { name: "老周", looseness: -4 },
  { name: "小南", looseness: 2 },
];
const ITEMS = ["peek", "swap", "exchange", "refund"];
const ITEM_NAME = { peek: "望牌", swap: "换牌", exchange: "交换", refund: "半退" };
const ITEM_COST = 100;

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
  phase: "setup",
  log: [],
  result: "",
  lastPot: 0,
  winnerIdx: [],
  handNo: 0,
  timer: 0,
  queue: [],
  sync: false,
  seatCount: 4,
};

let notify = () => {};
function setListener(fn) { notify = typeof fn === "function" ? fn : () => {}; }
function render() { notify(); }

function rankName(r) {
  return { 14: "A", 13: "K", 12: "Q", 11: "J" }[r] || String(r);
}

function handName(score) {
  if (!score) return "";
  const n = rankName;
  switch (score[0]) {
    case 8: return score[1] === 14 ? "皇家同花顺" : score[1] === 5 ? "同花顺 A 到 5" : `同花顺 ${n(score[1])} 高`;
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

function holeText(hole) {
  if (!hole || hole.length < 2 || !hole[0] || !hole[1]) return "";
  if (hole[0].r === hole[1].r) return `你的底牌：一对 ${rankName(hole[0].r)}`;
  const hi = [...hole].sort((a, b) => b.r - a.r);
  const suited = hole[0].s === hole[1].s ? " 同花" : "";
  return `你的底牌：${rankName(hi[0].r)} ${rankName(hi[1].r)}${suited}`;
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

function blank(s) {
  return {
    name: s.name,
    isHuman: !!s.isHuman,
    looseness: s.looseness || 0,
    stack: 1000,
    hole: [],
    folded: false,
    allIn: false,
    bet: 0,
    contributed: 0,
    inHand: false,
    needsAction: false,
    canRaise: true,
    item: null,
    boughtThisGap: false,
    usedItemThisGap: false,
    lastLoss: 0,
    stackAtStart: 1000,
    peekIndex: null,
    peekBy: -1,
  };
}

function freshPlayers(n = 4) {
  const count = Math.min(7, Math.max(4, n | 0));
  G.seatCount = count;
  const spec = [{ name: "你", isHuman: true, looseness: 0 }, ...BOTS.slice(0, count - 1)];
  G.players = spec.map(blank);
  G.dealer = count - 1;
}

function loadTable(specs) {
  G.players = specs.map(blank);
  G.seatCount = G.players.length;
  G.dealer = G.players.length - 1;
  G.handNo = 0;
  G.board = [];
  G.log = [];
  G.phase = "idle";
  G.result = "";
  G.winnerIdx = [];
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

function snapRaise(to, minTo, maxTo) {
  if (maxTo < minTo) return maxTo;
  const minChip = Math.ceil(minTo / CHIP) * CHIP;
  const maxChip = Math.floor(maxTo / CHIP) * CHIP;
  if (maxChip < minChip) return maxTo;
  let n = Math.round(to / CHIP) * CHIP;
  if (!Number.isFinite(n)) n = minChip;
  if (n < minChip) n = minChip;
  if (n > maxChip) n = maxChip;
  return n;
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

function copyCard(c) { return c ? { r: c.r, s: c.s } : null; }

function shownHole(p, you) {
  if (!p.hole.length) return [];
  if (G.players[you] === p || (G.reveal && !p.folded)) return p.hole.map(copyCard);
  if (p.peekBy === you && p.peekIndex != null) return p.hole.map((c, k) => (k === p.peekIndex ? copyCard(c) : null));
  return p.hole.map(() => null);
}

function lostHand(p) {
  return !!(p && p.inHand && (p.folded || p.lastLoss > 0));
}

function canBuy(p) {
  if (!p || !p.isHuman || G.phase !== "over" || !lostHand(p)) return false;
  if (p.item || p.boughtThisGap || p.usedItemThisGap) return false;
  return p.stack >= ITEM_COST;
}

function chipPiles(n) {
  const piles = [];
  let left = Math.max(0, n | 0);
  for (const d of [100, 50, 20, 10, 5]) {
    const count = Math.floor(left / d);
    if (count) piles.push({ d, count });
    left -= count * d;
  }
  return piles;
}

function chipCounts(n) {
  const counts = { 5: 0, 10: 0, 20: 0, 50: 0, 100: 0 };
  for (const pile of chipPiles(n)) counts[pile.d] = pile.count;
  return counts;
}

function chipTotal(counts) {
  return [100, 50, 20, 10, 5].reduce((sum, d) => sum + d * (counts[d] || 0), 0);
}

const BREAK = { 100: { 50: 2 }, 50: { 20: 2, 10: 1 }, 20: { 10: 2 }, 10: { 5: 2 } };

function copyCounts(counts) {
  return { 5: counts[5] || 0, 10: counts[10] || 0, 20: counts[20] || 0, 50: counts[50] || 0, 100: counts[100] || 0 };
}

function breakOne(counts, d) {
  const into = BREAK[d];
  if (!into || !(counts[d] > 0)) return null;
  const next = copyCounts(counts);
  next[d] -= 1;
  for (const k of Object.keys(into)) next[k] += into[k];
  return next;
}

function mergeOne(counts, d) {
  const into = BREAK[d];
  if (!into) return null;
  const next = copyCounts(counts);
  for (const k of Object.keys(into)) {
    if (next[k] < into[k]) return null;
    next[k] -= into[k];
  }
  next[d] += 1;
  return next;
}

function buy(i) {
  const p = G.players[i];
  if (!canBuy(p)) return "现在不能买";
  p.stack -= ITEM_COST;
  p.item = ITEMS[Math.floor(Math.random() * ITEMS.length)];
  p.boughtThisGap = true;
  say(`${p.name} 花费 ${ITEM_COST}，获得 ${ITEM_NAME[p.item]}`);
  render();
  return "";
}

function useRefund(i) {
  const p = G.players[i];
  if (!p || p.item !== "refund") return "没有半退";
  if (G.phase !== "over") return "这手还没结算";
  const back = Math.min(80, Math.floor((p.lastLoss || 0) / 2));
  if (back <= 0) return "这手没有可退的亏损";
  p.stack += back;
  p.item = null;
  p.usedItemThisGap = true;
  say(`${p.name} 半退 ${back}`);
  render();
  return "";
}

function usePeek(i, target) {
  const p = G.players[i];
  const t = G.players[target];
  if (!p || p.item !== "peek") return "没有望牌";
  if (G.phase !== "betting" || G.actor !== i) return "还没轮到你";
  if (!t || target === i || !t.inHand || t.folded || t.hole.length < 2) return "不能看这个人";
  t.peekIndex = Math.floor(Math.random() * t.hole.length);
  t.peekBy = i;
  p.item = null;
  say(`${p.name} 对 ${t.name} 使用了望牌`);
  render();
  return "";
}

function useSwap(i, holeIndex) {
  const p = G.players[i];
  if (!p || p.item !== "swap") return "没有换牌";
  if (G.phase !== "betting" || G.actor !== i) return "还没轮到你";
  if (G.street !== "preflop") return "只能在翻牌前换牌";
  if (holeIndex !== 0 && holeIndex !== 1) return "选一张底牌";
  if (!G.deck.length) return "牌堆空了";
  p.hole[holeIndex] = G.deck.pop();
  p.item = null;
  say(`${p.name} 换了一张底牌`);
  render();
  return "";
}

function clearPeek(p) {
  p.peekIndex = null;
  p.peekBy = -1;
}

function useExchange(i, target) {
  const p = G.players[i];
  const t = G.players[target];
  if (!p || p.item !== "exchange") return "没有交换";
  if (G.phase !== "betting" || G.actor !== i) return "还没轮到你";
  if (!t || target === i || !t.inHand || t.folded || t.hole.length < 2 || p.hole.length < 2) return "不能和这个人交换";
  const tmp = p.hole;
  p.hole = t.hole;
  t.hole = tmp;
  clearPeek(p);
  clearPeek(t);
  p.item = null;
  say(`${p.name} 与 ${t.name} 交换了底牌`);
  render();
  return "";
}

function useItem(i, target, holeIndex) {
  const p = G.players[i];
  if (!p || !p.item) return "没有道具";
  if (p.item === "refund") return useRefund(i);
  if (p.item === "peek") return usePeek(i, target);
  if (p.item === "swap") return useSwap(i, holeIndex);
  if (p.item === "exchange") return useExchange(i, target);
  return "没有这张牌";
}

function handoff(i) {
  const p = G.players[i];
  if (!p || !p.isHuman) return;
  const used = new Set(G.players.filter((_, j) => j !== i).map((x) => x.name));
  const bot = BOTS.find((b) => !used.has(b.name)) || BOTS[0];
  p.isHuman = false;
  p.name = bot.name;
  p.looseness = bot.looseness;
  p.item = null;
  say(`${bot.name} 接手了这个座位`);
  if (G.phase === "betting" && G.actor === i) perform(i, aiDecide(p));
  else render();
}

function legalize(p, d) {
  const toCall = Math.max(0, G.currentBet - p.bet);
  const maxTo = p.bet + p.stack;
  const minTo = minRaiseTo();
  if (!d || d.type === "fold") return toCall === 0 ? { type: "check" } : { type: "fold" };
  if (d.type === "check") return toCall === 0 ? d : { type: "call" };
  if (d.type === "call") return toCall === 0 ? { type: "check" } : { type: "call" };
  if (d.type === "raise") {
    if (!p.canRaise || p.stack <= toCall) return toCall === 0 ? { type: "check" } : { type: "call" };
    if (maxTo <= G.currentBet) return toCall === 0 ? { type: "check" } : { type: "call" };
    let to = Math.floor(d.to);
    if (!Number.isFinite(to)) to = minTo;
    return { type: "raise", to: snapRaise(to, minTo, maxTo) };
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
  const to = snapRaise(d.to, minRaiseTo(), p.bet + p.stack);
  commit(p, to - p.bet);
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
  if (!p || p.isHuman) return;
  later(() => {
    if (G.phase !== "betting" || G.players[G.actor] !== p) return;
    perform(G.actor, aiDecide(p));
  }, 700);
}

function perform(i, raw) {
  apply(i, legalize(G.players[i], raw));
  if (G.players.filter((p) => p.inHand && !p.folded).length <= 1) return endHand(false);
  const next = nextIndex(i, (p) => p.needsAction);
  if (next < 0) return onRoundEnd();
  G.actor = next;
  prompt();
}

function endHand(showdown) {
  clearTimeout(G.timer);
  G.reveal = showdown;
  G.lastPot = potSize();
  const awards = settle(showdown);
  for (const p of G.players) {
    p.bet = 0;
    p.contributed = 0;
    p.lastLoss = Math.max(0, (p.stackAtStart || 0) - p.stack);
  }
  announce(awards);
  G.phase = "over";
  G.actor = -1;
  render();
}

function onRoundEnd() {
  if (G.players.filter((p) => p.inHand && !p.folded).length <= 1) return endHand(false);
  G.phase = "deal";
  G.actor = -1;
  render();
  if (G.street === "river") {
    later(() => endHand(true), 700);
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

function beginBetting() {
  const live = G.players.filter((p) => p.inHand && !p.folded);
  if (live.length <= 1) return endHand(false);
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

function startHand() {
  clearTimeout(G.timer);
  G.phase = "deal";
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
    p.boughtThisGap = false;
    p.usedItemThisGap = false;
    p.stackAtStart = p.stack;
    clearPeek(p);
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

function tableStatus() {
  const alive = G.players.filter((p) => p.stack > 0);
  if (!G.players[0] || G.players[0].stack <= 0) return "bust";
  if (alive.length < 2) return "win";
  return "continue";
}

function statusFor(you) {
  const alive = G.players.filter((p) => p.stack > 0);
  const me = G.players[you];
  if (alive.length < 2) return me && me.stack > 0 ? "win" : "bust";
  if (!me || me.stack <= 0) return "out";
  return "continue";
}

function viewFor(you) {
  const me = G.players[you];
  return {
    you,
    phase: G.phase,
    street: G.street,
    board: G.board.map(copyCard),
    dealer: G.dealer,
    sbIndex: G.sbIndex,
    bbIndex: G.bbIndex,
    actor: G.actor,
    currentBet: G.currentBet,
    minRaise: G.minRaise,
    lastFull: G.lastFull,
    pot: G.phase === "over" ? G.lastPot : potSize(),
    reveal: G.reveal,
    result: G.result,
    winnerIdx: G.winnerIdx.slice(),
    handNo: G.handNo,
    log: G.log.slice(-8),
    seatCount: G.players.length,
    item: me ? me.item : null,
    lastLoss: me ? me.lastLoss : 0,
    canBuy: !!(me && canBuy(me)),
    lost: !!(me && lostHand(me)),
    canRefund: !!(me && me.item === "refund" && G.phase === "over" && Math.floor((me.lastLoss || 0) / 2) > 0),
    status: statusFor(you),
    players: G.players.map((p) => ({
      name: p.name,
      stack: p.stack,
      bet: p.bet,
      folded: p.folded,
      allIn: p.allIn,
      inHand: p.inHand,
      isHuman: p.isHuman,
      canRaise: p.canRaise,
      hole: shownHole(p, you),
    })),
  };
}

function seatPoint(visual, n) {
  const t = (visual * 2 * Math.PI) / n;
  return { x: 50 - 36 * Math.sin(t), y: 48 + 34 * Math.cos(t) };
}

function quoteRaise(kind, view, p) {
  const minTo = Math.max(view.lastFull + view.minRaise, view.currentBet + 1);
  const maxTo = p.bet + p.stack;
  const toCall = Math.max(0, view.currentBet - p.bet);
  let to = minTo;
  if (kind === "half") to = view.currentBet + Math.floor((view.pot + toCall) / 2);
  else if (kind === "pot") to = view.currentBet + view.pot + toCall;
  else if (kind === "all") to = maxTo;
  return snapRaise(to, minTo, maxTo);
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
  return quoteRaise(kind, {
    lastFull: G.lastFull,
    minRaise: G.minRaise,
    currentBet: G.currentBet,
    pot: potSize(),
  }, p);
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

function selfCheck() {
  const assert = (cond, msg) => { if (!cond) throw new Error(msg || "assert"); };
  const C = (r, s) => ({ r, s });
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
  assert(holeText([C(14, "c"), C(13, "c")]) === "你的底牌：A K 同花", "hole suited");
  assert(holeText([C(9, "s"), C(9, "h")]) === "你的底牌：一对 9", "hole pair");
  assert(chen([C(14, "s"), C(14, "h")]) === 20, "AA");
  assert(chen([C(14, "s"), C(13, "s")]) === 12, "AKs");
  assert(chen([C(7, "s"), C(2, "h")]) < 0, "72o");

  freshPlayers(7);
  assert(G.players.length === 7 && G.players[6].name === "小南", "7 seats");
  assert(G.players.reduce((s, p) => s + p.stack, 0) === 7000, "7 stacks");

  freshPlayers();
  const P = G.players;
  P.forEach((p) => { p.inHand = true; p.needsAction = false; p.canRaise = false; p.stack = 1000; p.bet = 0; p.contributed = 0; });
  G.currentBet = 20; G.minRaise = 20; G.lastFull = 20;
  P[0].bet = 20; P[0].contributed = 20; P[0].stack = 980;
  apply(0, { type: "raise", to: 60 });
  assert(G.currentBet === 60 && G.minRaise === 40 && G.lastFull === 60, "min raise updates");
  assert(P[1].needsAction && P[1].canRaise && P[0].needsAction === false, "raise reopens");
  assert(P[0].stack === 940, "raise chips");
  P[0].bet = 20; P[0].contributed = 20; P[0].stack = 980; P[0].canRaise = true;
  G.currentBet = 20; G.minRaise = 20; G.lastFull = 20;
  apply(0, { type: "raise", to: 47 });
  assert(G.currentBet === 45 && P[0].stack === 955, "raise snaps to a 5 chip");

  freshPlayers();
  G.players.forEach((p) => { p.inHand = true; p.needsAction = false; p.canRaise = true; });
  G.currentBet = 100; G.minRaise = 100; G.lastFull = 100;
  const Q = G.players;
  Q[0].bet = 100; Q[0].contributed = 100; Q[0].stack = 900; Q[0].needsAction = false;
  Q[1].bet = 100; Q[1].contributed = 100; Q[1].stack = 900; Q[1].needsAction = false;
  Q[2].bet = 0; Q[2].contributed = 0; Q[2].stack = 150; Q[2].needsAction = true;
  Q[3].bet = 0; Q[3].contributed = 0; Q[3].stack = 1000; Q[3].needsAction = true; Q[3].canRaise = true;
  const bank = () => G.players.reduce((s, p) => s + p.stack + p.contributed, 0);
  const beforeShort = bank();
  apply(2, { type: "raise", to: 150 });
  assert(G.currentBet === 150 && G.lastFull === 100 && G.minRaise === 100, "short all-in");
  assert(minRaiseTo() === 200, "next full raise is to 200");
  assert(Q[0].needsAction && Q[0].canRaise === false && Q[1].canRaise === false, "short all-in does not reopen");
  assert(Q[3].canRaise && Q[3].needsAction && Q[2].allIn, "players still to act may raise");
  assert(bank() === beforeShort, "chips conserved on short all-in");

  freshPlayers();
  const F = G.players;
  F.forEach((p) => { p.inHand = true; p.folded = false; p.stack = 1000; p.contributed = 0; p.bet = 0; });
  commit(F[1], 10);
  commit(F[2], 20);
  F[0].folded = true; F[1].folded = true; F[3].folded = true;
  const foldAwards = settle(false);
  assert(foldAwards[2] === 30 && F[2].stack === 1010, "big blind wins the blinds");
  assert(F.reduce((s, p) => s + p.stack, 0) === 4000, "fold pot conserved");

  freshPlayers();
  const Sp = G.players;
  function put(i, n, folded) {
    Sp[i].stack = 1000 - n; Sp[i].contributed = n; Sp[i].inHand = true; Sp[i].folded = folded;
  }
  put(0, 200, true); put(1, 200, false); put(2, 80, false);
  Sp[3].inHand = false; Sp[3].folded = true; Sp[3].contributed = 0;
  G.board = [C(14, "h"), C(7, "c"), C(2, "d"), C(9, "s"), C(3, "c")];
  Sp[1].hole = [C(13, "h"), C(12, "d")];
  Sp[2].hole = [C(14, "s"), C(13, "d")];
  G.dealer = 0;
  const side = settle(true);
  assert(side[2] === 240 && side[1] === 240 && side[0] === 0, "side pot");
  assert(Sp.reduce((s, p) => s + p.stack, 0) === 4000, "side pot conserved");

  freshPlayers();
  const O = G.players;
  O.forEach((p, i) => {
    const n = i < 3 ? 11 : 0;
    p.stack = 1000 - n; p.contributed = n; p.inHand = i < 3; p.folded = i === 0 || i === 3;
  });
  G.board = [C(2, "d"), C(3, "c"), C(7, "h"), C(9, "s"), C(4, "d")];
  O[1].hole = [C(12, "c"), C(11, "d")];
  O[2].hole = [C(12, "d"), C(11, "c")];
  G.dealer = 0;
  const odd = settle(true);
  assert(odd[1] === 17 && odd[2] === 16 && odd[0] === 0, "odd chip");
  assert(O.reduce((s, p) => s + p.stack, 0) === 4000, "split conserved");

  const piles = chipPiles(980);
  assert(piles.map((p) => p.d + "x" + p.count).join(",") === "100x9,50x1,20x1,10x1", "chip piles");
  assert(chipPiles(1000).length === 1 && chipPiles(1000)[0].count === 10, "hundreds only");
  assert(chipPiles(4).length === 0 && chipPiles(0).length === 0, "no chip under 5");
  const hundred = chipCounts(100);
  const broken = breakOne(hundred, 100);
  assert(broken[50] === 2 && broken[100] === 0 && chipTotal(broken) === 100, "break a 100");
  const merged = mergeOne(broken, 100);
  assert(merged[100] === 1 && chipTotal(merged) === 100, "merge back to 100");
  const fifty = breakOne(chipCounts(50), 50);
  assert(fifty[20] === 2 && fifty[10] === 1 && chipTotal(fifty) === 50, "break a 50");
  assert(breakOne(chipCounts(5), 5) === null && mergeOne(chipCounts(5), 10) === null, "cannot convert a lone 5");

  freshPlayers();
  G.phase = "over";
  G.players[0].stack = 1000;
  G.players[0].item = null;
  G.players[0].boughtThisGap = false;
  G.players[0].usedItemThisGap = false;
  G.players[0].inHand = true;
  G.players[0].folded = true;
  G.players[0].lastLoss = 0;
  assert(canBuy(G.players[0]), "fold counts as a loss");
  assert(buy(0) === "", "buy ok");
  assert(G.players[0].stack === 900, "buy costs 100");
  assert(G.players.reduce((s, p) => s + p.stack, 0) === 3900, "buy leaves the table");
  assert(ITEMS.includes(G.players[0].item), "got an item");
  const held = G.players[0].item;
  assert(buy(0) !== "" && G.players[0].stack === 900 && G.players[0].item === held, "second buy same gap");
  G.players[0].boughtThisGap = false;
  assert(buy(0) !== "" && G.players[0].stack === 900 && G.players[0].item === held, "cannot buy while holding");
  G.players[0].stack = 99;
  G.players[0].item = null;
  G.players[0].boughtThisGap = false;
  assert(!canBuy(G.players[0]), "need 100");
  G.players[0].stack = 1000;
  G.players[0].folded = false;
  G.players[0].lastLoss = 0;
  assert(!canBuy(G.players[0]), "winner cannot buy");
  G.players[0].inHand = false;
  G.players[0].folded = true;
  assert(!canBuy(G.players[0]), "sitting out cannot buy");

  freshPlayers();
  G.phase = "over";
  G.players[0].item = "refund";
  G.players[0].lastLoss = 200;
  G.players[0].stack = 800;
  G.players[0].inHand = true;
  G.players[0].folded = true;
  G.players[0].usedItemThisGap = false;
  assert(useRefund(0) === "" && G.players[0].stack === 880 && !G.players[0].item, "refund caps at 80");
  assert(!canBuy(G.players[0]), "cannot buy after refund on the same screen");
  G.players[0].item = "refund";
  G.players[0].lastLoss = 0;
  G.players[0].usedItemThisGap = false;
  assert(useRefund(0) !== "" && G.players[0].item === "refund", "no refund without a loss");

  freshPlayers();
  G.phase = "betting";
  G.actor = 0;
  G.street = "preflop";
  G.deck = [{ r: 14, s: "c" }];
  G.players[0].item = "swap";
  G.players[0].hole = [{ r: 2, s: "s" }, { r: 3, s: "h" }];
  assert(useItem(0, -1, 0) === "" && G.players[0].hole[0].r === 14 && !G.players[0].item, "swap used");
  G.phase = "over";
  G.players[0].stack = 1000;
  G.players[0].inHand = true;
  G.players[0].folded = true;
  G.players[0].boughtThisGap = false;
  G.players[0].usedItemThisGap = false;
  assert(canBuy(G.players[0]), "can buy after the item was used");

  freshPlayers();
  G.phase = "betting";
  G.street = "flop";
  G.actor = 0;
  G.players[0].item = "exchange";
  G.players[0].inHand = true;
  G.players[1].inHand = true;
  G.players[0].hole = [C(14, "s"), C(13, "s")];
  G.players[1].hole = [C(2, "h"), C(3, "d")];
  G.players[1].peekIndex = 0;
  G.players[1].peekBy = 0;
  assert(useExchange(0, 1) === "", "exchange");
  assert(G.players[0].hole[0].r === 2 && G.players[1].hole[0].r === 14, "holes swapped");
  assert(G.players[0].peekIndex == null && G.players[1].peekBy === -1, "peek cleared");
  assert(!G.players[0].item, "exchange consumed");

  freshPlayers();
  G.players[0].hole = [C(14, "s"), C(13, "h")];
  G.players[1].hole = [C(2, "d"), C(3, "c")];
  G.players[1].inHand = true;
  let v = viewFor(0);
  assert(v.players[0].hole[0].r === 14, "own hole");
  assert(v.players[1].hole[0] === null && v.players[1].hole[1] === null, "hidden hole");
  G.players[1].peekIndex = 1;
  G.players[1].peekBy = 0;
  v = viewFor(0);
  assert(v.players[1].hole[1].r === 3 && v.players[1].hole[0] === null, "peek one card");
  assert(viewFor(2).players[1].hole[1] === null, "peek is private");

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
      assert(stacks === 4000, `leak hand ${h}: ${G.players.map((p) => p.stack).join(",")}`);
      assert(G.phase === "over", `stuck hand ${h} ${G.phase}`);
      assert(G.players.every((p) => p.stack >= 0 && Number.isFinite(p.stack)), "negative stack");
      assert(G.queue.length === 0, "timer queue leaked");
    }
  } finally {
    G.sync = false;
    G.queue = [];
  }
  G.players[0].isHuman = true;
  G.players[0].stack = Math.max(G.players[0].stack, 100);
  G.players[0].item = null;
  G.players[0].inHand = true;
  G.players[0].folded = true;
  G.players[0].boughtThisGap = false;
  G.players[0].usedItemThisGap = false;
  G.phase = "over";
  assert(canBuy(G.players[0]), "can buy again next settlement");
}

const api = {
  G, BB, SB, CHIP, BOTS, ITEM_NAME, ITEM_COST, SUIT_GLYPH, STREET_NAME,
  freshPlayers, loadTable, startHand, buy, useItem, useRefund, canBuy, chipPiles, chipCounts, chipTotal, breakOne, mergeOne, viewFor, handoff,
  setListener, selfCheck, perform, rankName, handName, holeText, bestOf, seatPoint, quoteRaise, snapRaise,
  tableStatus, statusFor,
};

if (typeof module !== "undefined" && module.exports) {
  module.exports = api;
  if (require.main === module) {
    selfCheck();
    console.log("selfCheck ok");
  }
} else {
  globalThis.Engine = api;
}
