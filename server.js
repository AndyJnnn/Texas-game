// One room on this computer. Run: node server.js
const crypto = require("crypto");
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");
const Engine = require("./engine.js");

const PORT = 8787;
const FILES = {
  "/": "index.html",
  "/index.html": "index.html",
  "/engine.js": "engine.js",
  "/game.js": "game.js",
  "/style.css": "style.css",
  "/faces/you.png": "faces/you.png",
  "/faces/hao.webp": "faces/hao.webp",
  "/faces/bei.webp": "faces/bei.webp",
  "/faces/k.webp": "faces/k.webp",
  "/faces/mei.webp": "faces/mei.webp",
  "/faces/pair.webp": "faces/pair.webp",
};
const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".png": "image/png",
  ".webp": "image/webp",
};
const ALPH = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

const room = { code: "", seats: 4, host: null, members: [], started: false };
const gone = new WeakSet();

function lanURLs() {
  const urls = [`http://127.0.0.1:${PORT}`];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const x of list || []) {
      if ((x.family === "IPv4" || x.family === 4) && !x.internal) urls.push(`http://${x.address}:${PORT}`);
    }
  }
  return urls;
}

function roomCode() {
  let s = "";
  for (let i = 0; i < 4; i++) s += ALPH[crypto.randomInt(ALPH.length)];
  return s;
}

function cleanName(s) {
  const t = String(s || "").trim().slice(0, 8);
  return t || "玩家";
}

function sendFrame(socket, text) {
  if (!socket || socket.destroyed) return;
  const data = Buffer.from(text);
  let header;
  if (data.length < 126) {
    header = Buffer.alloc(2);
    header[0] = 0x81;
    header[1] = data.length;
  } else {
    header = Buffer.alloc(4);
    header[0] = 0x81;
    header[1] = 126;
    header.writeUInt16BE(data.length, 2);
  }
  try { socket.write(Buffer.concat([header, data])); }
  catch { /* the seat is already leaving */ }
}

function reply(socket, obj) { sendFrame(socket, JSON.stringify(obj)); }

function acceptKey(key) {
  return crypto.createHash("sha1").update(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").digest("base64");
}

function findMember(socket) {
  return room.members.find((m) => m.socket === socket) || null;
}

function sendLobby() {
  for (const m of room.members) {
    reply(m.socket, {
      type: "lobby",
      code: room.code,
      urls: lanURLs(),
      members: room.members.map((x) => ({ name: x.name, seat: x.seat })),
      host: m === room.host,
      you: m.seat,
      seats: room.seats,
    });
  }
}

function pushState() {
  if (!room.started) return;
  for (const m of room.members) {
    const body = Engine.viewFor(m.seat);
    body.type = "state";
    body.host = m === room.host;
    reply(m.socket, body);
  }
}

function closeRoom(message) {
  const rest = room.members.slice();
  room.members = [];
  room.host = null;
  room.code = "";
  room.started = false;
  room.seats = 4;
  Engine.setListener(() => {});
  Engine.G.players = [];
  Engine.G.phase = "setup";
  for (const m of rest) reply(m.socket, { type: "closed", message });
}

function freeSeat() {
  const taken = new Set(room.members.map((m) => m.seat));
  let seat = 0;
  while (taken.has(seat)) seat++;
  return seat;
}

function drop(socket) {
  const member = findMember(socket);
  if (!member) return;
  room.members = room.members.filter((m) => m !== member);
  if (!room.started) {
    if (member === room.host || !room.members.length) closeRoom("房间已关闭");
    else sendLobby();
    return;
  }
  if (member === room.host) room.host = room.members[0] || null;
  Engine.handoff(member.seat);
  if (!room.members.length) {
    room.code = "";
    room.started = false;
    room.host = null;
    Engine.setListener(() => {});
    Engine.G.players = [];
    Engine.G.phase = "setup";
  }
}

function fillSpecs() {
  const bySeat = new Map(room.members.map((m) => [m.seat, m]));
  const used = new Set(room.members.map((m) => m.name));
  let botI = 0;
  const specs = [];
  for (let i = 0; i < room.seats; i++) {
    const m = bySeat.get(i);
    if (m) specs.push({ name: m.name, isHuman: true, looseness: 0 });
    else {
      while (botI < Engine.BOTS.length && used.has(Engine.BOTS[botI].name)) botI++;
      const b = Engine.BOTS[botI++] || Engine.BOTS[0];
      used.add(b.name);
      specs.push({ name: b.name, isHuman: false, looseness: b.looseness });
    }
  }
  return specs;
}

function onMessage(socket, msg) {
  if (!msg || typeof msg.type !== "string") return;
  const member = findMember(socket);
  if (msg.type === "create") {
    if (room.members.length) return reply(socket, { type: "error", message: "已经有一桌了" });
    const seats = Math.min(7, Math.max(4, msg.seats | 0));
    room.code = roomCode();
    room.seats = seats;
    room.started = false;
    const host = { socket, name: cleanName(msg.name), seat: 0 };
    room.members = [host];
    room.host = host;
    sendLobby();
    return;
  }
  if (msg.type === "join") {
    const code = String(msg.code || "").trim().toUpperCase();
    if (!room.code || code !== room.code) return reply(socket, { type: "error", message: "房间号不对" });
    if (room.started) return reply(socket, { type: "error", message: "这桌已经开始了" });
    if (room.members.length >= room.seats) return reply(socket, { type: "error", message: "座位满了" });
    if (member) return sendLobby();
    room.members.push({ socket, name: cleanName(msg.name), seat: freeSeat() });
    sendLobby();
    return;
  }
  if (!member) return reply(socket, { type: "error", message: "还没入座" });
  if (msg.type === "seats") {
    if (member !== room.host || room.started) return reply(socket, { type: "error", message: "现在不能改人数" });
    const n = msg.n | 0;
    if (n < room.members.length || n < 4 || n > 7) return reply(socket, { type: "error", message: "人数不对" });
    room.seats = n;
    sendLobby();
    return;
  }
  if (msg.type === "start") {
    if (member !== room.host) return reply(socket, { type: "error", message: "只有房主可以开始" });
    if (room.started) return reply(socket, { type: "error", message: "已经开始了" });
    Engine.loadTable(fillSpecs());
    room.started = true;
    Engine.setListener(pushState);
    Engine.startHand();
    return;
  }
  if (!room.started) return reply(socket, { type: "error", message: "还没开始" });
  if (msg.type === "buy") {
    const err = Engine.buy(member.seat);
    if (err) reply(socket, { type: "error", message: err });
    return;
  }
  if (msg.type === "item") {
    const err = Engine.useItem(member.seat, msg.target | 0, msg.hole | 0);
    if (err) reply(socket, { type: "error", message: err });
    return;
  }
  if (msg.type === "next") {
    if (Engine.G.phase !== "over") return reply(socket, { type: "error", message: "这手还没结束" });
    if (Engine.G.players.filter((p) => p.stack > 0).length < 2) return reply(socket, { type: "error", message: "这桌结束了" });
    Engine.startHand();
    return;
  }
  if (msg.type === "restart") {
    if (member !== room.host) return reply(socket, { type: "error", message: "只有房主可以重开" });
    if (Engine.G.players.filter((p) => p.stack > 0).length >= 2) return reply(socket, { type: "error", message: "这桌还没结束" });
    room.started = false;
    Engine.setListener(() => {});
    Engine.G.players = [];
    Engine.G.phase = "idle";
    Engine.G.log = [];
    sendLobby();
    return;
  }
  if (msg.type === "act") {
    const g = Engine.G;
    const p = g.players[member.seat];
    if (g.phase !== "betting" || g.actor !== member.seat || !p || !p.isHuman) {
      return reply(socket, { type: "error", message: "还没轮到你" });
    }
    if (msg.action === "fold") Engine.perform(member.seat, { type: "fold" });
    else if (msg.action === "check") Engine.perform(member.seat, { type: "check" });
    else if (msg.action === "call") Engine.perform(member.seat, { type: "call" });
    else if (msg.action === "raise") Engine.perform(member.seat, { type: "raise", to: msg.to });
    else if (msg.action === "allin") {
      if (p.canRaise && p.bet + p.stack > g.currentBet) Engine.perform(member.seat, { type: "raise", to: p.bet + p.stack });
      else Engine.perform(member.seat, { type: "call" });
    }
  }
}

function attach(socket, head) {
  let buf = head && head.length ? Buffer.from(head) : Buffer.alloc(0);
  const finish = () => {
    if (gone.has(socket)) return;
    gone.add(socket);
    drop(socket);
  };
  socket.on("data", (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    while (buf.length >= 2) {
      const opcode = buf[0] & 0x0f;
      const masked = (buf[1] & 0x80) !== 0;
      let len = buf[1] & 0x7f;
      let off = 2;
      if (len === 126) {
        if (buf.length < 4) return;
        len = buf.readUInt16BE(2);
        off = 4;
      } else if (len === 127) {
        if (buf.length < 10) return;
        len = Number(buf.readBigUInt64BE(2));
        off = 10;
      }
      const maskLen = masked ? 4 : 0;
      if (buf.length < off + maskLen + len) return;
      let payload = buf.subarray(off + maskLen, off + maskLen + len);
      if (masked) {
        const mask = buf.subarray(off, off + 4);
        payload = Buffer.from(payload);
        for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4];
      }
      buf = buf.subarray(off + maskLen + len);
      if (opcode === 8) { socket.end(); return; }
      if (opcode === 9) {
        const pong = Buffer.alloc(2);
        pong[0] = 0x8a;
        pong[1] = 0;
        try { socket.write(pong); } catch { /* ignore */ }
        continue;
      }
      if (opcode !== 1) continue;
      let msg;
      try { msg = JSON.parse(payload.toString()); }
      catch { continue; }
      onMessage(socket, msg);
    }
  });
  socket.on("close", finish);
  socket.on("error", finish);
}

const server = http.createServer((req, res) => {
  const url = (req.url || "/").split("?")[0];
  const file = FILES[url];
  if (!file) {
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("not found");
    return;
  }
  const body = fs.readFileSync(path.join(__dirname, file));
  res.writeHead(200, { "Content-Type": TYPES[path.extname(file)] || "text/plain" });
  res.end(body);
});

server.on("upgrade", (req, socket, head) => {
  if ((req.url || "").split("?")[0] !== "/ws") { socket.destroy(); return; }
  const key = req.headers["sec-websocket-key"];
  if (!key) { socket.destroy(); return; }
  socket.write(
    "HTTP/1.1 101 Switching Protocols\r\n" +
    "Upgrade: websocket\r\n" +
    "Connection: Upgrade\r\n" +
    "Sec-WebSocket-Accept: " + acceptKey(key) + "\r\n\r\n"
  );
  attach(socket, head);
});

server.listen(PORT, () => {
  for (const url of lanURLs()) console.log(url);
});
