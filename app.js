/* ===========================================================
   피아스코 온라인 테이블 — app.js
   =========================================================== */
import { firebaseConfig } from "./firebase-config.js";

// ?demo=1 로 열면 Firebase 대신 브라우저 메모리에서 도는 연습 모드로 붙습니다.
const DEMO = new URLSearchParams(location.search).has("demo");
const CDN = "https://www.gstatic.com/firebasejs/10.12.5/";
const [FA, FU, FS] = DEMO
  ? await Promise.all([import("./mock-firebase.js"), import("./mock-firebase.js"), import("./mock-firebase.js")])
  : await Promise.all([
    import(CDN + "firebase-app.js"),
    import(CDN + "firebase-auth.js"),
    import(CDN + "firebase-firestore.js")
  ]);
const { initializeApp } = FA;
const { getAuth, GoogleAuthProvider, signInWithPopup, onAuthStateChanged, signOut } = FU;
const {
  getFirestore, doc, collection, setDoc, getDoc, updateDoc, deleteDoc, onSnapshot,
  addDoc, query, orderBy, limit, serverTimestamp, runTransaction, getDocs
} = FS;
import { DEFAULT_PLAYSET, blankPlayset, TABLE_LABEL } from "./playsets.js";
import { PHASE_RULES, TILT_TABLE, AFTERMATH_BLACK, AFTERMATH_WHITE, aftermathFor } from "./rulebook.js";

/* ── 짧은 도구들 ─────────────────────────────────────── */
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const d6 = () => 1 + Math.floor(Math.random() * 6);
const show = (id, on) => $(id).classList.toggle("hidden", !on);
let toastTimer;
function toast(msg) {
  const t = $("toast"); t.textContent = msg; t.classList.remove("hidden");
  clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.add("hidden"), 2600);
}
const PIPS = { 1: [4], 2: [0, 8], 3: [0, 4, 8], 4: [0, 2, 6, 8], 5: [0, 2, 4, 6, 8], 6: [0, 2, 3, 5, 6, 8] };
function blank(color, cls = "small") {
  return `<span class="die ${color} ${cls}">${"<i></i>".repeat(9)}</span>`;
}
function die(v, color, cls = "") {
  let cells = "";
  const on = PIPS[v] || [];
  for (let i = 0; i < 9; i++) cells += `<i class="${on.includes(i) ? "on" : ""}"></i>`;
  return `<span class="die ${color} ${cls}">${cells}</span>`;
}

/* ── 상태 ────────────────────────────────────────────── */
const S = {
  uid: null, user: null, nick: "",
  code: null, room: null, players: [], logs: [],
  unsub: [], sheetBuilt: false, ruleTab: null
};
const PHASES = [
  ["setup", "준비"], ["act1", "제1막"], ["tilt", "비틀기"], ["act2", "제2막"], ["aftermath", "후기"], ["end", "끝"]
];
let db, auth;

/* ===========================================================
   1. Firebase 연결
   =========================================================== */
function resolveConfig() {
  if (DEMO) return { apiKey: "demo", projectId: "demo" };
  if (firebaseConfig && firebaseConfig.apiKey && firebaseConfig.projectId) return firebaseConfig;
  try {
    const saved = JSON.parse(localStorage.getItem("fiasco.cfg") || "null");
    if (saved && saved.apiKey && saved.projectId) return saved;
  } catch { }
  return null;
}

function boot() {
  document.getElementById("app").classList.remove("booting");
  const cfg = resolveConfig();
  if (!cfg) { show("screen-config", true); return; }
  try {
    const app = initializeApp(cfg);
    auth = getAuth(app); db = getFirestore(app);
  } catch (e) {
    show("screen-config", true);
    $("cfg-msg").textContent = "연결에 실패했습니다: " + e.message;
    return;
  }
  onAuthStateChanged(auth, async (u) => {
    if (u) {
      S.uid = u.uid; S.user = u;
      $("me-photo").src = u.photoURL || "";
      $("me-name").textContent = u.displayName || "이름 없음";
      show("me-chip", true);
      show("screen-auth", false);
      if (DEMO) { await seedDemo(); enterRoom("DEMO"); return; }
      const url = new URL(location.href);
      const c = (url.searchParams.get("room") || "").toUpperCase();
      $("new-nick").value = $("join-nick").value = u.displayName || "";
      if (c.length === 4) {
        $("join-code").value = c;
        const snap = await getDoc(doc(db, "rooms", c));
        if (snap.exists() && (snap.data().seats || []).includes(u.uid)) { S.code = c; enterRoom(c); return; }
      }
      show("screen-lobby", true);
      renderMyRooms();
    } else {
      S.uid = null; show("me-chip", false); show("screen-lobby", false);
      show("screen-room", false); show("screen-auth", true);
    }
  });
}

$("cfg-save").addEventListener("click", () => {
  try {
    const raw = $("cfg-input").value.trim().replace(/^const\s+firebaseConfig\s*=\s*/, "").replace(/;$/, "");
    // 따옴표 없는 키도 받아 줍니다.
    const obj = Function('"use strict";return (' + raw + ")")();
    if (!obj.apiKey || !obj.projectId) throw new Error("apiKey와 projectId가 필요합니다.");
    localStorage.setItem("fiasco.cfg", JSON.stringify(obj));
    location.reload();
  } catch (e) { $("cfg-msg").textContent = "읽지 못했습니다: " + e.message; }
});

$("btn-google").addEventListener("click", async () => {
  $("auth-msg").textContent = "";
  try { await signInWithPopup(auth, new GoogleAuthProvider()); }
  catch (e) { $("auth-msg").textContent = "로그인하지 못했습니다: " + e.code; }
});
$("btn-signout").addEventListener("click", async () => { detach(); await signOut(auth); location.href = location.pathname; });

/* ===========================================================
   2. 방 만들기 / 들어가기
   =========================================================== */
const roomRef = () => doc(db, "rooms", S.code);
const playerRef = (uid) => doc(db, "rooms", S.code, "players", uid);
const logRef = () => collection(db, "rooms", S.code, "log");

function code4() {
  const A = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  return Array.from({ length: 4 }, () => A[Math.floor(Math.random() * A.length)]).join("");
}

$("btn-create").addEventListener("click", async () => {
  const nick = ($("new-nick").value || S.user.displayName || "이름 없음").trim();
  let code, tries = 0;
  do { code = code4(); tries++; } while ((await getDoc(doc(db, "rooms", code))).exists() && tries < 12);
  await setDoc(doc(db, "rooms", code), {
    code, host: S.uid, createdAt: serverTimestamp(),
    phase: "lobby", playset: DEFAULT_PLAYSET,
    seats: [S.uid], turnIndex: 0, maxSeats: 5,
    totalDice: 0, halfMark: 0,
    setupDice: [], links: [], pool: { white: 0, black: 0 },
    scene: null, tiltPool: [], tilt: [], tiltPickers: { black: null, white: null },
    alert: null
  });
  S.code = code;
  await joinSeat(nick);
  enterRoom(code);
});

$("btn-join").addEventListener("click", async () => {
  const code = ($("join-code").value || "").trim().toUpperCase();
  const nick = ($("join-nick").value || S.user.displayName || "이름 없음").trim();
  if (code.length !== 4) { $("lobby-msg").textContent = "방 코드는 네 글자입니다."; return; }
  const snap = await getDoc(doc(db, "rooms", code));
  if (!snap.exists()) { $("lobby-msg").textContent = "그런 방은 없습니다. 코드를 다시 확인해 주세요."; return; }
  S.code = code;
  const r = snap.data();
  if (!r.seats.includes(S.uid)) {
    if (r.phase !== "lobby") { $("lobby-msg").textContent = "이미 시작한 테이블이라 새로 앉을 수 없습니다."; return; }
    const cap = r.maxSeats || 5;
    if (r.seats.length >= cap) { $("lobby-msg").textContent = `자리가 다 찼습니다. 이 테이블은 ${cap}인으로 맞춰져 있습니다.`; return; }
  }
  await joinSeat(nick);
  enterRoom(code);
});

async function joinSeat(nick) {
  await runTransaction(db, async (tx) => {
    const rs = await tx.get(roomRef());
    const r = rs.data();
    const seats = [...r.seats];
    if (!seats.includes(S.uid)) seats.push(S.uid);
    tx.update(roomRef(), { seats });
  });
  const ps = await getDoc(playerRef(S.uid));
  const base = { uid: S.uid, name: nick, photo: S.user.photoURL || "" };
  if (!ps.exists()) {
    Object.assign(base, {
      char: { name: "", note: "", secret: "" },
      dice: { white: 0, black: 0 }, rolled: [], net: null
    });
  }
  await setDoc(playerRef(S.uid), base, { merge: true });
  await say(`${nick} 님이 ${ps.exists() ? "다시 들어왔습니다" : "자리에 앉았습니다"}.`, "sys");
}

/* ── 내 테이블 목록 (이 브라우저에 저장) ─────────────── */
const ROOMS_KEY = "fiasco.myrooms";
function readRooms() {
  try { return JSON.parse(localStorage.getItem(ROOMS_KEY) || "[]"); } catch { return []; }
}
function rememberRoom(code) {
  if (DEMO) return;
  const list = readRooms().filter(r => r.code !== code);
  list.unshift({ code, at: Date.now() });
  localStorage.setItem(ROOMS_KEY, JSON.stringify(list.slice(0, 12)));
}
function forgetRoom(code) {
  localStorage.setItem(ROOMS_KEY, JSON.stringify(readRooms().filter(r => r.code !== code)));
  renderMyRooms();
}
const PHASE_LABEL = {
  lobby: "사람 모으는 중", setup: "준비", act1: "제1막",
  tilt: "비틀기", act2: "제2막", aftermath: "후기", end: "끝난 판"
};
async function renderMyRooms() {
  const box = $("myrooms"); if (!box) return;
  const list = readRooms();
  if (!list.length) {
    box.innerHTML = `<p class="hint">아직 들어갔던 테이블이 없습니다. 위에서 방을 열거나 코드로 들어가세요.</p>`;
    return;
  }
  box.innerHTML = `<p class="hint">불러오는 중…</p>`;
  const rows = [];
  for (const item of list) {
    try {
      const snap = await getDoc(doc(db, "rooms", item.code));
      if (!snap.exists()) { rows.push({ code: item.code, gone: true }); continue; }
      const r = snap.data();
      rows.push({
        code: item.code, phase: r.phase, n: (r.seats || []).length,
        cap: r.maxSeats || 5, mine: (r.seats || []).includes(S.uid), host: r.host === S.uid
      });
    } catch { rows.push({ code: item.code, gone: true }); }
  }
  box.innerHTML = rows.map(r => r.gone
    ? `<div class="room-row"><span class="mono">${r.code}</span>
        <span class="muted small">없어진 방</span>
        <button class="btn ghost small" data-forget="${r.code}">목록에서 지우기</button></div>`
    : `<div class="room-row"><span class="mono">${r.code}</span>
        <span class="small">${PHASE_LABEL[r.phase] || r.phase} · ${r.n}/${r.cap}인${r.host ? " · 내가 진행자" : ""}</span>
        <span class="room-actions">
          <button class="btn small" data-enter="${r.code}">${r.mine ? "이어서 들어가기" : "들어가기"}</button>
          <button class="btn ghost small" data-forget="${r.code}">지우기</button>
        </span></div>`).join("");
  box.querySelectorAll("[data-enter]").forEach(b => b.onclick = async () => {
    S.code = b.dataset.enter;
    const snap = await getDoc(doc(db, "rooms", S.code));
    if (!snap.exists()) { toast("없어진 방입니다."); forgetRoom(S.code); return; }
    if (!(snap.data().seats || []).includes(S.uid)) {
      const cap = snap.data().maxSeats || 5;
      if (snap.data().phase !== "lobby") return toast("이미 시작한 테이블이라 새로 앉을 수 없습니다.");
      if ((snap.data().seats || []).length >= cap) return toast("자리가 다 찼습니다.");
      await joinSeat(S.user.displayName || "이름 없음");
    }
    enterRoom(S.code);
  });
  box.querySelectorAll("[data-forget]").forEach(b => b.onclick = () => forgetRoom(b.dataset.forget));
}

/* ── 방 나가서 목록으로 ─────────────────────────────── */
function backToList() {
  detach();
  S.room = null; S.players = []; S.logs = []; S.code = null; S.sheetBuilt = false; S.ruleTab = null;
  show("screen-room", false);
  show("room-code-chip", false);
  show("btn-tolist", false);
  if (!DEMO) history.replaceState(null, "", location.pathname);
  show("screen-lobby", true);
  renderMyRooms();
}
$("btn-tolist").addEventListener("click", backToList);

function detach() { S.unsub.forEach(u => { try { u(); } catch { } }); S.unsub = []; }

function enterRoom(code) {
  S.code = code; S.sheetBuilt = false;
  if (!DEMO) history.replaceState(null, "", `?room=${code}`);
  show("screen-lobby", false); show("screen-room", true);
  $("room-code-chip").textContent = `방 ${code}`;
  show("room-code-chip", true);
  show("btn-tolist", !DEMO);
  rememberRoom(code);
  detach();
  S.unsub.push(onSnapshot(roomRef(), (s) => { S.room = s.data(); render(); }));
  S.unsub.push(onSnapshot(collection(db, "rooms", code, "players"), (s) => {
    S.players = s.docs.map(d => d.data()); render();
  }));
  S.unsub.push(onSnapshot(query(logRef(), orderBy("at", "desc"), limit(80)), (s) => {
    S.logs = s.docs.map(d => d.data()).reverse(); renderLog();
  }));
}

async function say(text, type = "say") {
  await addDoc(logRef(), { text, type, uid: S.uid, name: myName(), at: serverTimestamp() });
}
const myName = () => (S.players.find(p => p.uid === S.uid)?.name) || S.user?.displayName || "누군가";
const byUid = (uid) => S.players.find(p => p.uid === uid) || { name: "빈 자리", dice: { white: 0, black: 0 } };
const me = () => S.players.find(p => p.uid === S.uid) || null;
const isHost = () => S.room && S.room.host === S.uid;
const seatOf = (uid) => (S.room?.seats || []).indexOf(uid);
const isMyTurn = () => S.room && S.room.seats[S.room.turnIndex] === S.uid;
const turnUid = () => S.room?.seats[S.room.turnIndex];
const poolTotal = () => (S.room?.pool.white || 0) + (S.room?.pool.black || 0);

/* ── 연습 모드 ──────────────────────────────────────── */
async function seedDemo() {
  const users = FA.DEMO_USERS;
  if ((await getDoc(doc(db, "rooms", "DEMO"))).exists()) return;
  await setDoc(doc(db, "rooms", "DEMO"), {
    code: "DEMO", host: users[0].uid, createdAt: serverTimestamp(),
    phase: "lobby", playset: DEFAULT_PLAYSET,
    seats: users.map(u => u.uid), turnIndex: 0,
    totalDice: 0, halfMark: 0,
    setupDice: [], links: [], pool: { white: 0, black: 0 },
    scene: null, tiltPool: [], tilt: [], tiltPickers: { black: null, white: null },
    alert: null
  });
  for (const u of users) {
    await setDoc(doc(db, "rooms", "DEMO", "players", u.uid), {
      uid: u.uid, name: u.displayName, photo: "",
      char: { name: "", note: "", secret: "" },
      dice: { white: 0, black: 0 }, rolled: [], net: null
    });
  }
  await addDoc(collection(db, "rooms", "DEMO", "log"), {
    text: "연습 모드입니다. 위쪽 이름을 눌러 네 사람의 시점을 오가며 혼자 진행해 볼 수 있습니다.",
    type: "sys", uid: users[0].uid, name: "안내", at: serverTimestamp()
  });
}

function renderDemoBar() {
  if (!DEMO) return;
  if (!$("demo-bar")) {
    const bar = document.createElement("div");
    bar.id = "demo-bar"; bar.className = "demo-bar";
    document.querySelector(".topbar").insertAdjacentElement("afterend", bar);
  }
  const turn = turnUid();
  $("demo-bar").innerHTML = `<span class="demo-tag">연습</span>
    <span class="muted small">지금 보는 사람</span>` +
    FA.DEMO_USERS.map(u => `<button class="btn small ${u.uid === S.uid ? "primary" : ""}" data-u="${u.uid}">
      ${esc(u.displayName)}${u.uid === turn ? " ●" : ""}</button>`).join("") +
    `<button class="btn ghost small" id="demo-reset">처음부터</button>`;
  $("demo-bar").querySelectorAll("[data-u]").forEach(b => b.onclick = () => {
    const u = FU.switchUser(b.dataset.u);
    S.uid = u.uid; S.user = u; S.sheetBuilt = false;
    $("me-name").textContent = u.displayName;
    render();
  });
  $("demo-reset").onclick = () => { FS.resetAll?.(); location.reload(); };
}

/* ===========================================================
   3. 그리기
   =========================================================== */
function render() {
  if (!S.room) return;
  renderPhaseStrip();
  renderTable();
  renderMySheet();
  renderLinksBoard();
  renderTilt();
  renderAction();
  renderRules();
  renderHost();
  renderDemoBar();
}

function renderPhaseStrip() {
  const cur = S.room.phase;
  if (cur === "lobby") {
    $("phase-strip").innerHTML = `<div class="phase-step on">사람 모으는 중 — ${S.room.seats.length}명</div>`;
    return;
  }
  const i = PHASES.findIndex(p => p[0] === cur);
  $("phase-strip").innerHTML = PHASES.map(([k, label], j) =>
    `<div class="phase-step ${j === i ? "on" : j < i ? "done" : ""}">${label}</div>`).join("");
}

function renderTable() {
  const ring = $("table-ring");
  const seats = S.room.seats;
  const N = seats.length;
  let html = "";
  seats.forEach((uid, i) => {
    const a = (-90 + i * 360 / N) * Math.PI / 180;
    const x = 50 + 37 * Math.cos(a), y = 50 + 39 * Math.sin(a);
    const p = byUid(uid);
    const isTurn = S.room.phase !== "lobby" && turnUid() === uid;
    const w = p.dice?.white || 0, b = p.dice?.black || 0;
    const cap = (n, c) => Array(Math.min(n, 6)).fill(blank(c)).join("") + (n > 6 ? `<span class="muted small">+${n - 6}</span>` : "");
    const dice = cap(w, "white") + cap(b, "black");
    html += `<div class="seat ${isTurn ? "is-turn" : ""} ${uid === S.uid ? "is-me" : ""}" style="left:${x}%;top:${y}%">
      <div class="seat-no">자리 ${i + 1}${uid === S.room.host ? " · 진행자" : ""}</div>
      <div class="seat-name">${esc(p.name)}</div>
      ${p.char?.name ? `<div class="seat-char">${esc(p.char.name)}</div>` : `<div class="muted small">캐릭터 없음</div>`}
      <div class="seat-dice">${dice || '<span class="muted small">주사위 0</span>'}</div>
    </div>`;
  });
  if (S.room.phase !== "lobby" && S.room.links?.length === N) {
    S.room.links.forEach((lk, i) => {
      const a = (-90 + (i + 0.5) * 360 / N) * Math.PI / 180;
      const x = 50 + 37 * Math.cos(a), y = 50 + 39 * Math.sin(a);
      const rel = textOf("rel", lk.rel.cat, lk.rel.el);
      const det = lk.det.table ? textOf(lk.det.table, lk.det.cat, lk.det.el) : null;
      html += `<div class="link-chip" data-link="${i}" role="button" tabindex="0">
        <div class="lk-rel">${rel ? esc(rel) : '<span class="lk-empty">관계 —</span>'}</div>
        <div class="lk-det">${det ? esc(det) : '<span class="lk-empty">세부 —</span>'}</div>
      </div>`;
    });
  }
  ring.innerHTML = html;
  ring.querySelectorAll(".link-chip").forEach(el =>
    el.addEventListener("click", () => openLinkModal(+el.dataset.link)));

  // 가운데 주사위 무더기
  const pv = $("pool-view");
  if (S.room.phase === "setup") {
    const left = S.room.setupDice.filter(d => !d.by);
    pv.innerHTML = left.map(d => die(d.v, d.color, "small")).join("");
    $("pool-label").textContent = `남은 준비 주사위 ${left.length}개`;
  } else if (S.room.phase === "tilt" && S.room.tiltPool?.length) {
    pv.innerHTML = S.room.tiltPool.map(d => die(d.v, d.color, "small")).join("");
    $("pool-label").textContent = `비틀기용 주사위 ${S.room.tiltPool.filter(d => !d.by).length}개 남음`;
  } else {
    const w = S.room.pool.white, b = S.room.pool.black;
    pv.innerHTML = Array(Math.min(w, 12)).fill(blank("white")).join("") + Array(Math.min(b, 12)).fill(blank("black")).join("");
    $("pool-label").textContent = S.room.phase === "lobby" ? "아직 시작 전" : `가운데 흰색 ${w} · 검은색 ${b}`;
  }
}

function textOf(table, cat, el) {
  const ps = S.room.playset;
  if (!ps || !ps[table]) return null;
  if (cat && el) return `${ps[table][cat - 1].name} — ${ps[table][cat - 1].els[el - 1]}`;
  if (cat) return `${ps[table][cat - 1].name} — ?`;
  if (el) return `? — 요소 ${el}`;
  return null;
}

/* ── 내 캐릭터 시트 ─────────────────────────────────── */
function renderMySheet() {
  const p = me(); if (!p) return;
  const box = $("my-sheet");
  if (!S.sheetBuilt) {
    box.innerHTML = `
      <label class="field"><span>캐릭터 이름</span><input id="ch-name" maxlength="24" placeholder="예: 야간 알바 정우"></label>
      <label class="field"><span>한 줄 소개 · 상황</span><textarea id="ch-note" rows="2" maxlength="200" placeholder="지금 무엇을 원하고, 무엇이 걸려 있는지"></textarea></label>
      <label class="field"><span>나만 보는 비밀</span><textarea id="ch-secret" rows="2" maxlength="200" placeholder="아직 아무에게도 말하지 않은 것"></textarea></label>
      <p class="hint">비밀 칸은 화면에 나만 보이지만 데이터베이스에는 저장됩니다. 정말 숨기고 싶다면 종이에 적어 두세요.</p>`;
    ["ch-name", "ch-note", "ch-secret"].forEach(id =>
      $(id).addEventListener("change", saveSheet));
    S.sheetBuilt = true;
  }
  const set = (id, v) => { const e = $(id); if (e && document.activeElement !== e && e.value !== (v || "")) e.value = v || ""; };
  set("ch-name", p.char?.name); set("ch-note", p.char?.note); set("ch-secret", p.char?.secret);
  const mw = p.dice.white, mb = p.dice.black;
  $("my-dice").innerHTML = (mw + mb)
    ? Array(mw).fill(blank("white")).join("") + Array(mb).fill(blank("black")).join("")
    : `<span class="muted small">주사위 없음</span>`;
}
async function saveSheet() {
  await updateDoc(playerRef(S.uid), {
    char: { name: $("ch-name").value.trim(), note: $("ch-note").value.trim(), secret: $("ch-secret").value.trim() }
  });
}

/* ── 관계 보드 ──────────────────────────────────────── */
const SLOTS = [
  ["rel.cat", "관계 분류"], ["rel.el", "관계 요소"],
  ["det.cat", "세부 분류"], ["det.el", "세부 요소"]
];

function renderLinksBoard() {
  const box = $("links-board");
  if (S.room.phase === "lobby") {
    box.innerHTML = `<p class="hint">테이블이 시작되면 옆자리 사람과 맺을 관계가 여기에 생깁니다. 3~5명이 모이면 진행자가 시작할 수 있습니다.</p>`;
    $("setup-progress").textContent = "";
    return;
  }
  const N = S.room.seats.length;
  box.innerHTML = (S.room.links || []).map((lk, i) => {
    const a = byUid(S.room.seats[i]).name, b = byUid(S.room.seats[(i + 1) % N]).name;
    const cells = SLOTS.map(([path, label]) => {
      const [t, k] = path.split(".");
      const v = lk[t][k];
      const table = t === "rel" ? "rel" : lk.det.table;
      let txt = "비어 있음";
      if (v) {
        if (k === "cat") txt = table ? S.room.playset[table][v - 1].name : `분류 ${v}`;
        else {
          const c = lk[t].cat;
          txt = (table && c) ? S.room.playset[table][c - 1].els[v - 1] : `요소 ${v}`;
        }
      }
      const tag = t === "det" && lk.det.table ? `${TABLE_LABEL[lk.det.table]} ${label.replace("세부 ", "")}` : label;
      return `<button class="slot ${v ? "filled" : "empty"}" data-link="${i}" data-path="${path}" ${S.room.phase !== "setup" ? "disabled" : ""}>
        <span class="slot-k">${tag}</span><span class="slot-v">${esc(txt)}</span></button>`;
    }).join("");
    return `<div class="link-row"><div class="link-who">${esc(a)} ↔ ${esc(b)}</div><div class="slot-grid">${cells}</div></div>`;
  }).join("");
  box.querySelectorAll(".slot").forEach(el => el.addEventListener("click", () =>
    openSlotPicker(+el.dataset.link, el.dataset.path)));

  if (S.room.phase === "setup") {
    const left = S.room.setupDice.filter(d => !d.by).length;
    $("setup-progress").textContent = `주사위 ${S.room.setupDice.length - left} / ${S.room.setupDice.length} 사용`;
  } else $("setup-progress").textContent = "";
}

/* ── 비틀기 카드 ────────────────────────────────────── */
function renderTilt() {
  const on = ["tilt", "act2", "aftermath", "end"].includes(S.room.phase);
  show("tilt-card", on);
  if (!on) return;
  const t = S.room.tilt || [];
  $("tilt-board").innerHTML = t.length === 0
    ? `<p class="hint">아직 비틀기 요소가 정해지지 않았습니다.</p>`
    : t.map((x, i) => {
      const txt = textOf("tilt", x.cat, x.el);
      return `<div class="tilt-el"><div class="te-k">비틀기 ${i + 1} · 선택 ${esc(byUid(x.owner).name)}</div>
        <div class="te-v">${txt ? esc(txt) : "고르는 중…"}</div></div>`;
    }).join("");
}

/* ── 룰 참조 ────────────────────────────────────────── */
const RULE_TABS = [
  ["setup", "준비"], ["act1", "제1막"], ["tilt", "비틀기"], ["act2", "제2막"],
  ["aftermath", "후기"], ["tiltTable", "비틀기 표"], ["afterTable", "후기 표"]
];
function currentRulePhase() {
  const p = S.room?.phase;
  if (!p || p === "lobby") return "setup";
  if (p === "end") return "aftermath";
  return p;
}
function renderRules() {
  const auto = currentRulePhase();
  const cur = S.ruleTab || auto;
  $("rules-hint").textContent = S.ruleTab && S.ruleTab !== auto
    ? "다른 단계를 보는 중" : "지금 단계";
  $("rules-tabs").innerHTML = RULE_TABS.map(([k, label]) =>
    `<button class="rule-tab ${k === cur ? "on" : ""} ${k === auto ? "now" : ""}" data-k="${k}">${label}</button>`).join("");
  $("rules-tabs").querySelectorAll(".rule-tab").forEach(b => b.onclick = () => {
    S.ruleTab = (b.dataset.k === auto) ? null : b.dataset.k;
    renderRules();
  });

  const box = $("rules-body");
  if (cur === "tiltTable") { box.innerHTML = tiltTableHTML(); return; }
  if (cur === "afterTable") { box.innerHTML = afterTableHTML(); return; }
  const r = PHASE_RULES[cur];
  box.innerHTML = `<ol class="rule-steps">${r.steps.map(x => `<li>${x}</li>`).join("")}</ol>
    <p class="hint">${r.tip}</p>`;
}
function tiltTableHTML() {
  const t = S.room?.playset?.tilt || TILT_TABLE;
  return `<p class="hint">비틀기 요소를 고를 때 주사위 눈 1~6이 아래 순서에 대응합니다.</p>
    ${t.map((c, i) => `<div class="rule-tbl">
      <div class="rule-tbl-h">${i + 1}. ${esc(c.name)}</div>
      <ol class="rule-tbl-l">${c.els.map(e => `<li>${esc(e)}</li>`).join("")}</ol></div>`).join("")}`;
}
function afterTableHTML() {
  const rows = (arr, name) => `<div class="rule-tbl">
    <div class="rule-tbl-h">${name}이 높을 때</div>
    ${arr.map(r => `<div class="after-row"><span class="after-k">${name} ${r.min === r.max ? r.min : r.max > 900 ? r.min + " 이상" : r.min + "~" + r.max}</span>
      <span><b>${esc(r.title)}</b> ${esc(r.text)}</span></div>`).join("")}</div>`;
  return `<div class="after-row zero"><span class="after-k">0</span>
      <span><b>우주 최악의 상황</b> 죽지는 않을 것입니다. 차라리 죽는 게 이보다 나으니까요. 처음 떠오르는 “최악”보다 더 어둡고 비참한 것이 분명 있습니다.</span></div>
    ${rows(AFTERMATH_BLACK, "검은색")}${rows(AFTERMATH_WHITE, "흰색")}`;
}

/* ── 기록 ───────────────────────────────────────────── */
function renderLog() {
  $("log").innerHTML = S.logs.map(l => {
    if (l.type === "sys") return `<div class="log-line sys">${esc(l.text)}</div>`;
    if (l.type === "alarm") return `<div class="log-line alarm">${esc(l.text)}</div>`;
    return `<div class="log-line"><span class="who">${esc(l.name)}</span> · ${esc(l.text)}</div>`;
  }).join("");
  $("log").scrollTop = $("log").scrollHeight;
}
$("chat-send").addEventListener("click", sendChat);
$("chat-input").addEventListener("keydown", e => { if (e.key === "Enter") sendChat(); });
async function sendChat() {
  const v = $("chat-input").value.trim(); if (!v) return;
  $("chat-input").value = ""; await say(v);
}
/* ===========================================================
   4. 단계별 행동 패널
   =========================================================== */
function renderAction() {
  const r = S.room, box = $("action-panel"), banner = $("turn-banner");
  const N = r.seats.length;

  if (r.phase === "lobby") {
    banner.innerHTML = `<b>${N}명</b> 앉았습니다. 코드 <b>${r.code}</b>를 알려 주세요.`;
    const cap = r.maxSeats || 5;
    const seatList = r.seats.map((uid, i) => {
      const p = byUid(uid);
      return `<div class="seat-row">
        <span class="mono small">${i + 1}</span>
        <span class="seat-row-name">${esc(p.name)}${uid === r.host ? " · 진행자" : ""}${uid === S.uid ? " (나)" : ""}</span>
        ${isHost() ? `<span class="seat-row-btns">
          <button class="btn ghost small" data-mv="${i}" data-d="-1" ${i === 0 ? "disabled" : ""}>↑</button>
          <button class="btn ghost small" data-mv="${i}" data-d="1" ${i === N - 1 ? "disabled" : ""}>↓</button>
          <button class="btn ghost small" data-kick="${uid}" ${uid === S.uid ? "disabled" : ""}>내보내기</button>
        </span>` : ""}
      </div>`;
    }).join("");

    box.innerHTML = `<h4>시작 전 확인</h4>
      <p class="hint">룰북 기준은 <b>3~5인</b>입니다. 사람마다 6면체 주사위 4개를 쓰며 여기서는 자동으로 준비됩니다.
      순서는 <b>가장 작은 동네에서 태어난 사람부터 시계 방향</b>으로 정하는 것이 원래 규칙이니, 진행자가 아래에서 자리를 옮겨 맞춰 주세요.</p>
      <div class="section-label">자리와 순서 — 지금 ${N}명 / 정원 ${cap}명</div>
      <div class="seat-list">${seatList}</div>
      ${isHost() ? `
        <div class="section-label">정원 정하기</div>
        <div class="row">${[2, 3, 4, 5].map(n =>
          `<button class="btn small ${n === cap ? "primary" : ""}" data-cap="${n}" ${n < N ? "disabled" : ""}>${n}인</button>`).join("")}
          <span class="muted small">정원보다 많이 들어올 수 없습니다.</span></div>
        <div class="row" style="margin-top:12px">
          <button class="btn primary" id="a-start" ${N < 2 || N > cap ? "disabled" : ""}>준비 단계 시작</button>
          <button class="btn" id="a-shuffle">자리 섞기</button>
          <button class="btn ghost" id="a-playset">플레이세트 바꾸기</button>
        </div>
        ${N < 2 ? `<p class="msg">최소 두 명은 있어야 시작할 수 있습니다.</p>`
          : N === 2 ? `<p class="hint">2인은 룰북에 없는 변형입니다. 두 사람 사이에 관계가 두 개 생기고, 주사위 8개로 진행됩니다.</p>` : ""}`
        : `<p class="hint">진행자가 시작하기를 기다리는 중입니다.</p>`}`;
    if (isHost()) {
      $("a-start").onclick = startSetup;
      $("a-shuffle").onclick = shuffleSeats;
      $("a-playset").onclick = openPlaysetModal;
      box.querySelectorAll("[data-cap]").forEach(b => b.onclick = () => setCap(+b.dataset.cap));
      box.querySelectorAll("[data-mv]").forEach(b => b.onclick = () => moveSeat(+b.dataset.mv, +b.dataset.d));
      box.querySelectorAll("[data-kick]").forEach(b => b.onclick = () => kickPlayer(b.dataset.kick));
    }
    return;
  }

  const tp = byUid(turnUid());
  const mine = isMyTurn();

  if (r.phase === "setup") {
    const left = r.setupDice.filter(d => !d.by).length;
    banner.innerHTML = left > 0
      ? `지금은 <b>${esc(tp.name)}</b> 님 차례입니다. 주사위 하나를 골라 칸 하나를 채우세요.`
      : `주사위를 다 썼습니다. 이제 캐릭터를 정하고 제1막으로 넘어갑니다.`;
    box.innerHTML = `<h4>준비 — 관계와 세부사항 엮기</h4>
      <p class="hint">차례가 오면 <b>관계 보드</b>의 빈 칸을 눌러 주사위 하나를 놓습니다. 한 번에 하나씩, 쓴 주사위는 사라집니다.
      옆 사람과의 관계는 반드시 하나씩 생기고, 관계마다 <b>욕망·장소·물건</b> 중 하나가 붙습니다.
      마지막 한 개는 집은 사람이 눈을 마음대로 정할 수 있습니다.</p>
      ${left === 0 ? `<p class="hint"><b>캐릭터를 만드세요.</b> 얽힌 요소를 보고 이름과 상황을 오른쪽 시트에 적습니다. 너무 구체적일 필요는 없습니다 — 플레이하며 키워 나갑니다.</p>
        ${isHost() ? `<button class="btn primary" id="a-act1">제1막 시작</button>` : `<p class="hint">진행자가 제1막을 열기를 기다립니다.</p>`}` : ""}`;
    if (left === 0 && isHost()) $("a-act1").onclick = startAct1;
    return;
  }

  if (r.phase === "act1" || r.phase === "act2") {
    const act = r.phase === "act1" ? 1 : 2;
    banner.innerHTML = r.scene
      ? `<b>${esc(byUid(r.scene.owner).name)}</b> 님의 장면 — ${r.scene.mode === "establish" ? "설정" : "해결"}을 골랐습니다.`
      : `지금은 <b>${esc(tp.name)}</b> 님 차례입니다.`;

    if (!r.scene) {
      box.innerHTML = `<h4>제${act}막 — 장면 만들기</h4>
        <p class="hint"><b>설정</b>을 고르면 장면·등장인물·사건을 내가 정하고, 결말은 남이 정합니다.
        <b>해결</b>을 고르면 장면은 남이 차려 주고, 내 캐릭터에게 좋은 결말인지 나쁜 결말인지를 내가 정합니다.
        ${act === 1 ? "제1막에서 받은 주사위는 <b>남에게 줍니다.</b>" : "제2막에서 받은 주사위는 <b>내가 가집니다.</b>"}</p>
        ${mine ? `<div class="row">
          <button class="btn primary" id="sc-est">설정 — 내가 차린다</button>
          <button class="btn" id="sc-res">해결 — 내가 끝을 정한다</button></div>`
          : `<p class="hint">${esc(tp.name)} 님이 장면을 고르는 중입니다.</p>`}`;
      if (mine) {
        $("sc-est").onclick = () => beginScene("establish");
        $("sc-res").onclick = () => beginScene("resolve");
      }
      return;
    }

    // 장면 진행 중 → 결과 판정
    const owner = r.scene.owner === S.uid;
    const decider = r.scene.mode === "establish" ? !owner : owner;
    const last = r.phase === "act2" && poolTotal() === 1;
    // 가운데에서 다 떨어진 색은 고를 수 없습니다. 단 마지막 한 개는 어느 색이든 됩니다.
    const outW = r.pool.white <= 0 && poolTotal() > 1;
    const outB = r.pool.black <= 0 && poolTotal() > 1;
    box.innerHTML = `<h4>장면 결과 정하기</h4>
      <p class="hint">${r.scene.mode === "establish"
        ? `장면을 차린 사람은 <b>${esc(byUid(r.scene.owner).name)}</b>. 결말은 <b>다른 사람들</b>이 정합니다.`
        : `장면은 다른 사람들이 차려 주고, 결말은 <b>${esc(byUid(r.scene.owner).name)}</b> 님이 정합니다.`}
        ${last ? "<br><b>마지막 한 개입니다. 흰색이든 검은색이든 자유롭게 고르세요.</b>" : ""}
        ${outW ? "<br>가운데에 흰 주사위가 다 떨어졌습니다. 남은 검은색으로만 끝낼 수 있습니다." : ""}
        ${outB ? "<br>가운데에 검은 주사위가 다 떨어졌습니다. 남은 흰색으로만 끝낼 수 있습니다." : ""}</p>
      <div class="row">
        <button class="btn tone-white" id="out-white" ${decider && !outW ? "" : "disabled"}>좋게 끝났다 — 흰색</button>
        <button class="btn tone-black" id="out-black" ${decider && !outB ? "" : "disabled"}>나쁘게 끝났다 — 검은색</button>
        ${owner ? `<button class="btn ghost small" id="sc-cancel">장면 취소</button>` : ""}
      </div>
      ${decider ? "" : `<p class="hint">지금은 결말을 정할 차례가 아닙니다.</p>`}`;
    if (decider && !outW) $("out-white").onclick = () => pickOutcome("white");
    if (decider && !outB) $("out-black").onclick = () => pickOutcome("black");
    if (owner) $("sc-cancel").onclick = () => updateDoc(roomRef(), { scene: null });
    return;
  }

  if (r.phase === "tilt") { renderTiltPhase(box, banner); return; }

  if (r.phase === "aftermath") { renderAftermath(box, banner); return; }

  if (r.phase === "end") {
    banner.innerHTML = `테이블이 끝났습니다. 수고하셨습니다.`;
    box.innerHTML = `<h4>후기까지 끝</h4>
      <p class="hint">모두의 결말이 나왔습니다. 기록을 위로 올려 보며 어떻게 엉망이 되었는지 되짚어 보세요.</p>
      ${isHost() ? `<button class="btn" id="a-reset">같은 사람들로 새 판 열기</button>` : ""}`;
    if (isHost()) $("a-reset").onclick = resetTable;
    return;
  }
}

/* ── 비틀기 단계 ────────────────────────────────────── */
function renderTiltPhase(box, banner) {
  const r = S.room;
  const rolledAll = S.players.every(p => (p.rolled || []).length > 0 || (p.dice.white + p.dice.black) === 0);
  banner.innerHTML = `제1막이 끝났습니다. 주사위를 굴려 누가 비틀기 요소를 고를지 정합니다.`;

  const scores = S.players.slice().sort((a, b) => seatOf(a.uid) - seatOf(b.uid)).map(p => {
    const n = p.net;
    const faces = (p.rolled || []).map(d => die(d.v, d.color, "small")).join("");
    return `<div class="score-row"><span>${esc(p.name)} ${faces}</span>
      <span class="score-net">${n ? (n.color === "tie" ? "무승부 0" : `${n.color === "black" ? "검은색" : "흰색"} ${n.value}`) : "아직 안 굴림"}</span></div>`;
  }).join("");

  const iRolled = (me()?.rolled || []).length > 0;
  const picks = r.tiltPickers || {};
  const iPick = [picks.black, picks.white].includes(S.uid);
  const mySlot = picks.black === S.uid ? 0 : picks.white === S.uid ? 1 : -1;

  box.innerHTML = `<h4>비틀기</h4>
    <p class="hint">받은 주사위를 굴려 색깔별로 합을 낸 뒤, <b>큰 쪽 − 작은 쪽</b>이 내 결과입니다.
    검은색에서 가장 높은 사람과 흰색에서 가장 높은 사람이 각각 비틀기 요소를 하나씩 고릅니다.</p>
    <div style="margin:10px 0">${scores}</div>
    ${!iRolled && (me()?.dice.white + me()?.dice.black) > 0
      ? `<button class="btn primary" id="t-roll">내 주사위 굴리기</button>` : ""}
    ${rolledAll && isHost() && !picks.black && !picks.white
      ? `<button class="btn primary" id="t-decide">고를 두 사람 확정</button>` : ""}
    ${picks.black || picks.white ? `<p class="hint">검은색 대표: <b>${esc(byUid(picks.black).name)}</b> · 흰색 대표: <b>${esc(byUid(picks.white).name)}</b></p>` : ""}
    ${(picks.black || picks.white) && isHost() && !(r.tiltPool || []).length
      ? `<button class="btn primary" id="t-pool">남은 주사위 굴리기</button>` : ""}
    ${iPick && (r.tiltPool || []).length ? `<div class="row" style="margin-top:10px">
        <button class="btn" id="t-cat">내 비틀기 — 분류 고르기</button>
        <button class="btn" id="t-el">내 비틀기 — 요소 고르기</button></div>` : ""}
    ${(r.tilt || []).length === 2 && r.tilt.every(t => t.cat && t.el) && isHost()
      ? `<button class="btn primary" id="t-act2" style="margin-top:10px">제2막 시작</button>` : ""}
    <p class="hint">잠시 쉬어 가도 좋습니다. 여기가 딱 중간입니다.</p>`;

  if ($("t-roll")) $("t-roll").onclick = rollMine;
  if ($("t-decide")) $("t-decide").onclick = decidePickers;
  if ($("t-pool")) $("t-pool").onclick = rollTiltPool;
  if ($("t-cat")) $("t-cat").onclick = () => openTiltPicker(mySlot, "cat");
  if ($("t-el")) $("t-el").onclick = () => openTiltPicker(mySlot, "el");
  if ($("t-act2")) $("t-act2").onclick = startAct2;
}

/* ── 후기 단계 ──────────────────────────────────────── */
function renderAftermath(box, banner) {
  const r = S.room;
  const p = me();
  const iRolled = (p?.rolled || []).length > 0;
  const myLeft = p ? p.dice.white + p.dice.black : 0;
  const withDice = S.players.filter(x => x.dice.white + x.dice.black > 0);
  const tp = byUid(turnUid());
  banner.innerHTML = withDice.length
    ? `몽타주 — 지금은 <b>${esc(tp.name)}</b> 님 차례입니다.`
    : `모든 주사위가 떨어졌습니다.`;

  const scores = S.players.slice().sort((a, b) => seatOf(a.uid) - seatOf(b.uid)).map(x => {
    const n = x.net;
    const faces = (x.rolled || []).map(d => die(d.v, d.color, "small")).join("");
    const af = n ? aftermathFor(n.color, n.value) : null;
    return `<div class="score-row"><span>${esc(x.name)} ${faces} <span class="muted small">남은 ${x.dice.white + x.dice.black}개</span></span>
      <span class="score-net">${af ? `${af.label} · ${esc(af.title)}` : "아직 안 굴림"}</span></div>`;
  }).join("");

  box.innerHTML = `<h4>후기</h4>
    <p class="hint">제 몫이 된 주사위를 모두 굴려 비틀기와 같은 방식으로 합을 냅니다. 그 숫자와 색을 <b>룰북의 후기 표</b>에서 찾아 캐릭터의 결말을 확인하세요.
    그다음 주사위를 하나씩 무더기로 보내며 이렇게 말합니다 — “이것은 [내 캐릭터]입니다. [무엇을 하고 있습니다].”</p>
    <div style="margin:10px 0">${scores}</div>
    ${p && p.net ? (() => { const a = aftermathFor(p.net.color, p.net.value);
      return `<div class="verdict"><div class="verdict-k">내 결말 · ${a.label}</div>
        <div class="verdict-t">${esc(a.title)}</div><p class="verdict-x">${esc(a.text)}</p></div>`; })() : ""}
    ${!iRolled && myLeft > 0 ? `<button class="btn primary" id="af-roll">내 주사위 굴리기</button>` : ""}
    ${iRolled && myLeft > 0 && isMyTurn() ? `
      <label class="field"><span>이번 한 컷</span>
        <input id="af-beat" maxlength="140" placeholder="이것은 …입니다. …하고 있습니다."></label>
      <button class="btn primary" id="af-drop">말하고 주사위 하나 내려놓기</button>` : ""}
    ${withDice.length === 0 && isHost() ? `<button class="btn primary" id="af-end">테이블 마무리</button>` : ""}`;

  if ($("af-roll")) $("af-roll").onclick = rollMine;
  if ($("af-drop")) $("af-drop").onclick = dropDie;
  if ($("af-end")) $("af-end").onclick = () => updateDoc(roomRef(), { phase: "end" });
}

/* ── 진행자 도구 ────────────────────────────────────── */
function renderHost() {
  show("host-card", isHost());
  if (!isHost()) return;
  $("host-tools").innerHTML = `
    <button class="btn small" id="h-next">다음 차례로 넘기기</button>
    <button class="btn small" id="h-playset">플레이세트 보기</button>
    <button class="btn small" id="h-link">초대 링크 복사</button>
    <button class="btn small danger" id="h-reset">판 초기화</button>`;
  $("h-next").onclick = async () => {
    await updateDoc(roomRef(), { turnIndex: (S.room.turnIndex + 1) % S.room.seats.length, scene: null });
    say("진행자가 차례를 넘겼습니다.", "sys");
  };
  $("h-playset").onclick = openPlaysetModal;
  $("h-link").onclick = () => {
    navigator.clipboard.writeText(location.origin + location.pathname + "?room=" + S.code);
    toast("초대 링크를 복사했습니다.");
  };
  $("h-reset").onclick = resetTable;
}

/* ===========================================================
   5. 규칙 처리
   =========================================================== */
async function shuffleSeats() {
  const s = [...S.room.seats];
  for (let i = s.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1));[s[i], s[j]] = [s[j], s[i]]; }
  await updateDoc(roomRef(), { seats: s });
  say("자리를 섞었습니다.", "sys");
}

async function setCap(n) {
  if (n < S.room.seats.length) return toast("이미 앉은 사람보다 적게 줄일 수 없습니다.");
  await updateDoc(roomRef(), { maxSeats: n });
  say(`정원을 ${n}인으로 맞췄습니다.`, "sys");
}

async function moveSeat(i, d) {
  const seats = [...S.room.seats];
  const j = i + d;
  if (j < 0 || j >= seats.length) return;
  [seats[i], seats[j]] = [seats[j], seats[i]];
  await updateDoc(roomRef(), { seats });
}

async function kickPlayer(uid) {
  if (uid === S.uid) return toast("자기 자신은 내보낼 수 없습니다.");
  const name = byUid(uid).name;
  if (!confirm(`${name} 님을 자리에서 내보냅니다. 계속할까요?`)) return;
  await updateDoc(roomRef(), { seats: S.room.seats.filter(u => u !== uid) });
  try { await deleteDoc(playerRef(uid)); } catch { }
  say(`${name} 님이 자리에서 빠졌습니다.`, "sys");
}

async function startSetup() {
  const N = S.room.seats.length;
  if (N < 2 || N > 5) return toast("2~5인까지 시작할 수 있습니다. 룰북 기준은 3~5인입니다.");
  const total = N * 4;
  const setupDice = [];
  for (let i = 0; i < total; i++) setupDice.push({ i, color: i < total / 2 ? "white" : "black", v: d6(), by: null });
  // 2인이면 두 사람 사이에 관계가 두 개 생깁니다(원탁의 양쪽 변).
  const links = Array.from({ length: N }, () => ({ rel: { cat: null, el: null }, det: { table: null, cat: null, el: null } }));
  await updateDoc(roomRef(), {
    phase: "setup", setupDice, links, turnIndex: 0,
    totalDice: total, halfMark: total / 2, pool: { white: 0, black: 0 }, scene: null
  });
  say(`준비 시작. 주사위 ${total}개를 가운데 굴렸습니다.`, "sys");
}

async function assignSlot(linkIdx, path, dieIdx, forcedValue, detTable) {
  const [t, k] = path.split(".");
  await runTransaction(db, async (tx) => {
    const rs = await tx.get(roomRef()); const r = rs.data();
    if (r.phase !== "setup") throw new Error("지금은 준비 단계가 아닙니다.");
    if (r.seats[r.turnIndex] !== S.uid) throw new Error("아직 차례가 아닙니다.");
    const dice = r.setupDice.map(d => ({ ...d }));
    const d = dice[dieIdx];
    if (!d || d.by) throw new Error("이미 쓴 주사위입니다.");
    const links = r.links.map(l => ({ rel: { ...l.rel }, det: { ...l.det } }));
    if (links[linkIdx][t][k]) throw new Error("이미 채워진 칸입니다.");
    const remaining = dice.filter(x => !x.by).length;
    const value = (remaining === 1 && forcedValue) ? forcedValue : d.v;
    d.by = S.uid; d.v = value;
    if (t === "det" && detTable) links[linkIdx].det.table = detTable;
    links[linkIdx][t][k] = value;
    tx.update(roomRef(), { setupDice: dice, links, turnIndex: (r.turnIndex + 1) % r.seats.length });
  }).then(() => {
    const N = S.room.seats.length;
    const a = byUid(S.room.seats[linkIdx]).name, b = byUid(S.room.seats[(linkIdx + 1) % N]).name;
    say(`${a} ↔ ${b} 의 ${SLOTS.find(x => x[0] === path)[1]}을(를) 놓았습니다.`, "sys");
  }).catch(e => toast(e.message));
}

async function startAct1() {
  // 쓴 주사위를 모두 가운데로 되돌립니다. 절반은 흰색, 절반은 검은색.
  const half = S.room.totalDice / 2;
  await updateDoc(roomRef(), {
    phase: "act1", turnIndex: 0, scene: null,
    pool: { white: half, black: half }
  });
  say(`제1막을 시작합니다. 가운데에 흰색 ${half}개, 검은색 ${half}개.`, "sys");
}

async function beginScene(mode) {
  await updateDoc(roomRef(), { scene: { owner: S.uid, mode } });
  say(mode === "establish" ? "장면을 설정합니다." : "장면 해결을 맡습니다. 누가 차려 주세요.");
}

function pickOutcome(color) {
  const r = S.room;
  if (r.phase === "act1") {
    // 제1막: 받은 주사위를 남에게 줍니다.
    const others = r.seats.filter(u => u !== r.scene.owner);
    openModal("누구에게 줄까요?", `
      <p class="hint">제1막에서는 장면의 결과로 받은 주사위를 <b>다른 사람에게</b> 줍니다.
      ${color === "white" ? "흰색은 좋게 끝났다는 뜻입니다." : "검은색은 나쁘게 끝났다는 뜻입니다."}</p>
      <div class="opt-list">${others.map(u => `<button class="opt" data-u="${u}">
        ${die(color === "white" ? 5 : 2, color, "small")}<span>${esc(byUid(u).name)}</span></button>`).join("")}</div>`);
    $("modal-body").querySelectorAll(".opt").forEach(b =>
      b.addEventListener("click", () => { closeModal(); resolveScene(color, b.dataset.u); }));
  } else {
    resolveScene(color, r.scene.owner);
  }
}

async function resolveScene(color, toUid) {
  try {
    await runTransaction(db, async (tx) => {
      const rs = await tx.get(roomRef()); const r = rs.data();
      const pr = playerRef(toUid); const ps = await tx.get(pr);
      if (!r.scene) throw new Error("진행 중인 장면이 없습니다.");
      const pool = { ...r.pool };
      const total = pool.white + pool.black;
      if (total <= 0) throw new Error("가운데에 주사위가 없습니다.");
      let take = color;
      if (pool[take] <= 0) {
        if (total > 1) throw new Error(`${color === "white" ? "흰색" : "검은색"} 주사위가 가운데에 없습니다. 남은 색으로 골라 주세요.`);
        take = color === "white" ? "black" : "white";  // 마지막 한 개는 어느 색이든 가능
      }
      pool[take] -= 1;
      const dice = { ...ps.data().dice }; dice[color] += 1;
      const patch = { pool, scene: null, turnIndex: (r.turnIndex + 1) % r.seats.length };
      const left = pool.white + pool.black;
      if (r.phase === "act1" && left <= r.halfMark) patch.phase = "tilt";
      if (r.phase === "act2" && left <= 0) patch.phase = "aftermath";
      tx.update(pr, { dice });
      tx.update(roomRef(), patch);
    });
    const c = color === "white" ? "흰색(좋은 결말)" : "검은색(나쁜 결말)";
    await say(`장면이 ${c}으로 끝났고 주사위는 ${byUid(toUid).name} 님에게 갔습니다.`, "sys");
  } catch (e) { toast(e.message); }
}

async function rollMine() {
  const p = me();
  const rolled = [
    ...Array(p.dice.white).fill("white"),
    ...Array(p.dice.black).fill("black")
  ].map(color => ({ color, v: d6() }));
  const sw = rolled.filter(d => d.color === "white").reduce((a, b) => a + b.v, 0);
  const sb = rolled.filter(d => d.color === "black").reduce((a, b) => a + b.v, 0);
  const diff = sb - sw;
  const net = diff === 0 ? { color: "tie", value: 0 } : { color: diff > 0 ? "black" : "white", value: Math.abs(diff) };
  await updateDoc(playerRef(S.uid), { rolled, net });
  const label = net.color === "tie" ? "무승부 0" : `${net.color === "black" ? "검은색" : "흰색"} ${net.value}`;
  const tail = S.room.phase === "aftermath" ? ` · 후기 표: ${aftermathFor(net.color, net.value).title}` : "";
  await say(`주사위를 굴렸습니다 — 흰색 합 ${sw}, 검은색 합 ${sb} → ${label}${tail}`, "sys");
}

async function decidePickers() {
  const best = (c) => S.players
    .filter(p => p.net && p.net.color === c)
    .sort((a, b) => b.net.value - a.net.value)[0];
  const b = best("black") || S.players[0];
  let w = best("white");
  if (!w || w.uid === b.uid) w = S.players.find(p => p.uid !== b.uid) || b;
  await updateDoc(roomRef(), {
    tiltPickers: { black: b.uid, white: w.uid },
    tilt: [{ owner: b.uid, cat: null, el: null }, { owner: w.uid, cat: null, el: null }]
  });
  say(`비틀기 요소는 ${b.name} 님과 ${w.name} 님이 고릅니다.`, "sys");
}

async function rollTiltPool() {
  const r = S.room;
  const pool = [
    ...Array(r.pool.white).fill("white"),
    ...Array(r.pool.black).fill("black")
  ].map((color, i) => ({ i, color, v: d6(), by: null }));
  await updateDoc(roomRef(), { tiltPool: pool });
  say("가운데 남은 주사위를 모두 굴렸습니다.", "sys");
}

async function assignTilt(slot, key, dieIdx) {
  await runTransaction(db, async (tx) => {
    const rs = await tx.get(roomRef()); const r = rs.data();
    const pool = r.tiltPool.map(d => ({ ...d }));
    if (!pool[dieIdx] || pool[dieIdx].by) throw new Error("이미 쓴 주사위입니다.");
    const tilt = r.tilt.map(t => ({ ...t }));
    if (tilt[slot].owner !== S.uid) throw new Error("내가 고르는 자리가 아닙니다.");
    if (tilt[slot][key]) throw new Error("이미 골랐습니다.");
    pool[dieIdx].by = S.uid;
    tilt[slot][key] = pool[dieIdx].v;
    tx.update(roomRef(), { tiltPool: pool, tilt });
  }).catch(e => toast(e.message));
}

async function startAct2() {
  const clear = S.players.map(p => updateDoc(playerRef(p.uid), { rolled: [], net: null }));
  await Promise.all(clear);
  await updateDoc(roomRef(), { phase: "act2", turnIndex: 0, scene: null, tiltPool: [] });
  say("제2막을 시작합니다. 이제 받은 주사위는 자기가 가집니다.", "sys");
}

async function dropDie() {
  const p = me();
  const beat = ($("af-beat")?.value || "").trim();
  if (!beat) return toast("한 컷을 적고 눌러 주세요.");
  const dice = { ...p.dice };
  if (dice.white > 0) dice.white--; else if (dice.black > 0) dice.black--; else return;
  await updateDoc(playerRef(S.uid), { dice });
  await say(beat);
  // 주사위가 남은 다음 사람에게 차례를 넘깁니다.
  const seats = S.room.seats;
  const counts = {}; S.players.forEach(x => counts[x.uid] = x.dice.white + x.dice.black);
  counts[S.uid] = dice.white + dice.black;
  let idx = S.room.turnIndex;
  for (let k = 1; k <= seats.length; k++) {
    const j = (S.room.turnIndex + k) % seats.length;
    if ((counts[seats[j]] || 0) > 0) { idx = j; break; }
  }
  await updateDoc(roomRef(), { turnIndex: idx });
}

async function resetTable() {
  if (!confirm("지금 판을 지우고 처음(사람 모으는 중)으로 돌아갑니다. 계속할까요?")) return;
  await Promise.all(S.players.map(p => updateDoc(playerRef(p.uid), {
    dice: { white: 0, black: 0 }, rolled: [], net: null, char: { name: "", note: "", secret: "" }
  })));
  await updateDoc(roomRef(), {
    phase: "lobby", setupDice: [], links: [], pool: { white: 0, black: 0 },
    scene: null, tilt: [], tiltPool: [], tiltPickers: { black: null, white: null }, turnIndex: 0,
    alert: null
  });
  S.sheetBuilt = false;
  say("진행자가 판을 초기화했습니다.", "sys");
}

/* ===========================================================
   6. 모달들
   =========================================================== */
function openModal(title, html) {
  $("modal-title").textContent = title;
  $("modal-body").innerHTML = html;
  show("modal", true);
}
function closeModal() { show("modal", false); }
$("modal-close").addEventListener("click", closeModal);
$("modal").addEventListener("click", e => { if (e.target.id === "modal") closeModal(); });

/* 관계 칩을 눌렀을 때 — 그 관계의 전체 내용 보기 */
function openLinkModal(i) {
  const r = S.room, N = r.seats.length;
  const lk = r.links[i];
  const a = byUid(r.seats[i]).name, b = byUid(r.seats[(i + 1) % N]).name;
  const rel = textOf("rel", lk.rel.cat, lk.rel.el) || "아직 비어 있습니다";
  const det = lk.det.table ? (textOf(lk.det.table, lk.det.cat, lk.det.el) || "고르는 중") : "아직 비어 있습니다";
  openModal(`${a} ↔ ${b}`, `
    <div class="section-label">관계</div><p>${esc(rel)}</p>
    <div class="section-label">${lk.det.table ? TABLE_LABEL[lk.det.table] : "세부사항"}</div><p>${esc(det)}</p>
    ${r.phase === "setup" ? `<p class="hint">준비 단계에서는 오른쪽 관계 보드의 칸을 눌러 채웁니다.</p>` : ""}`);
}

/* 준비 단계 — 칸에 주사위 놓기 */
function openSlotPicker(linkIdx, path) {
  const r = S.room;
  if (r.phase !== "setup") return;
  if (!isMyTurn()) return toast(`지금은 ${byUid(turnUid()).name} 님 차례입니다.`);
  const [t, k] = path.split(".");
  const lk = r.links[linkIdx];
  if (lk[t][k]) return toast("이미 채워진 칸입니다.");

  // 세부사항인데 표가 안 정해졌으면 먼저 고릅니다.
  if (t === "det" && !lk.det.table) {
    openModal("세부사항 종류 고르기", `
      <p class="hint">이 관계에 붙일 세부사항을 고르세요. 관계마다 하나씩 붙고, 테이블 전체에 <b>욕망·장소·물건</b>이 골고루 나오면 좋습니다.</p>
      <div class="opt-list">
        <button class="opt" data-t="need"><span class="num">욕</span><span><b>욕망</b> — 캐릭터의 채워지지 않은 무언가. 집착의 대상이 될 만한가?</span></button>
        <button class="opt" data-t="loc"><span class="num">장</span><span><b>장소</b> — 장면의 무대. 여러 캐릭터가 드나들 수 있는 곳인가?</span></button>
        <button class="opt" data-t="obj"><span class="num">물</span><span><b>물건</b> — 관계의 상징이자 동력. 두 사람 모두에게 똑같이 중요한가?</span></button>
      </div>`);
    $("modal-body").querySelectorAll(".opt").forEach(btn =>
      btn.addEventListener("click", () => dicePicker(linkIdx, path, btn.dataset.t)));
    return;
  }
  dicePicker(linkIdx, path, lk.det.table);
}

function dicePicker(linkIdx, path, detTable) {
  const r = S.room;
  const [t, k] = path.split(".");
  const lk = r.links[linkIdx];
  const table = t === "rel" ? "rel" : detTable;
  const left = r.setupDice.map((d, idx) => ({ ...d, idx })).filter(d => !d.by);
  const lastOne = left.length === 1;

  const preview = (v) => {
    if (k === "cat") return r.playset[table][v - 1].name;
    const c = lk[t].cat;
    return c ? r.playset[table][c - 1].els[v - 1] : `요소 ${v} — 분류가 정해지면 확정됩니다`;
  };

  const label = `${TABLE_LABEL[table]} ${k === "cat" ? "분류" : "요소"}`;
  let body = `<p class="hint">주사위 하나를 골라 <b>${label}</b> 칸에 놓습니다. 놓은 주사위는 무더기에서 사라집니다.</p>`;

  if (lastOne) {
    body += `<p class="hint"><b>마지막 한 개입니다.</b> 규칙에 따라 눈을 원하는 대로 정할 수 있습니다.</p>
      <div class="opt-list">${[1, 2, 3, 4, 5, 6].map(v =>
      `<button class="opt" data-die="${left[0].idx}" data-force="${v}">${die(v, left[0].color, "small")}<span>${esc(preview(v))}</span></button>`).join("")}</div>`;
  } else {
    // 준비 단계에서는 주사위 색이 아니라 눈만 쓰므로 같은 눈은 하나로 묶어 보여 줍니다.
    const byValue = new Map();
    left.forEach(d => { if (!byValue.has(d.v)) byValue.set(d.v, []); byValue.get(d.v).push(d); });
    body += `<div class="opt-list">${[...byValue.keys()].sort((a, b) => a - b).map(v => {
      const group = byValue.get(v);
      return `<button class="opt" data-die="${group[0].idx}">${die(v, group[0].color, "small")}
        <span>${esc(preview(v))}${group.length > 1 ? ` <span class="muted small">주사위 ${group.length}개</span>` : ""}</span></button>`;
    }).join("")}</div>`;
  }

  openModal(`${label} 정하기`, body);
  $("modal-body").querySelectorAll(".opt").forEach(btn => btn.addEventListener("click", () => {
    closeModal();
    assignSlot(linkIdx, path, +btn.dataset.die, btn.dataset.force ? +btn.dataset.force : null, detTable);
  }));
}

/* 비틀기 — 요소 고르기 */
function openTiltPicker(slot, key) {
  const r = S.room;
  if (slot < 0) return;
  if (r.tilt[slot][key]) return toast("이미 골랐습니다.");
  if (key === "el" && !r.tilt[slot].cat) return toast("분류를 먼저 고르면 요소가 무엇인지 보입니다.");
  const left = r.tiltPool.map((d, idx) => ({ ...d, idx })).filter(d => !d.by);
  if (!left.length) return toast("남은 주사위가 없습니다.");
  const preview = (v) => key === "cat" ? r.playset.tilt[v - 1].name : r.playset.tilt[r.tilt[slot].cat - 1].els[v - 1];
  const byValue = new Map();
  left.forEach(d => { if (!byValue.has(d.v)) byValue.set(d.v, d); });
  openModal(`비틀기 ${key === "cat" ? "분류" : "요소"} 고르기`, `
    <p class="hint">비틀기 요소는 제2막에서 누구든 자유롭게 장면에 끌어다 쓸 수 있습니다.</p>
    <div class="opt-list">${[...byValue.keys()].sort((a, b) => a - b).map(v => {
    const d = byValue.get(v);
    return `<button class="opt" data-die="${d.idx}">${die(v, d.color, "small")}<span>${esc(preview(v))}</span></button>`;
  }).join("")}</div>`);
  $("modal-body").querySelectorAll(".opt").forEach(b => b.addEventListener("click", () => {
    closeModal(); assignTilt(slot, key, +b.dataset.die);
  }));
}

/* 플레이세트 보기 · 바꾸기 */
function openPlaysetModal() {
  const ps = S.room.playset;
  const tables = ["rel", "need", "loc", "obj", "tilt"];
  const view = tables.map(t => `<div class="section-label">${TABLE_LABEL[t]}</div>
    <ol style="margin:0 0 10px 18px;padding:0;font-size:.85rem;line-height:1.6">
      ${ps[t].map(c => `<li><b>${esc(c.name)}</b> — ${c.els.map(esc).join(" / ")}</li>`).join("")}
    </ol>`).join("");
  openModal(`플레이세트 — ${ps.name}`, `
    <p class="hint">${esc(ps.tagline || "")}</p>
    ${isHost() ? `
      <div class="row">
        <button class="btn small" id="ps-export">지금 것 내려받기</button>
        <button class="btn small" id="ps-blank">빈 양식 불러오기</button>
      </div>
      <div class="section-label">JSON 붙여넣어 바꾸기</div>
      <textarea id="ps-json" class="mono" rows="6" placeholder='{"name":"...","rel":[...],"need":[...],"loc":[...],"obj":[...],"tilt":[...]}'></textarea>
      <div class="row" style="margin:8px 0 14px"><button class="btn primary small" id="ps-apply">이 플레이세트로 바꾸기</button>
      <span class="muted small">준비 단계 전에만 바꾸는 것을 권합니다.</span></div>` : ""}
    ${view}`);
  if (!isHost()) return;
  $("ps-export").onclick = () => {
    const blob = new Blob([JSON.stringify(ps, null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob); a.download = `${ps.name}.json`; a.click();
  };
  $("ps-blank").onclick = () => { $("ps-json").value = JSON.stringify(blankPlayset(), null, 2); };
  $("ps-apply").onclick = async () => {
    try {
      const obj = JSON.parse($("ps-json").value);
      for (const t of ["rel", "need", "loc", "obj", "tilt"]) {
        if (!Array.isArray(obj[t]) || obj[t].length !== 6) throw new Error(`${TABLE_LABEL[t]} 표에 분류 6개가 필요합니다.`);
        obj[t].forEach(c => { if (!Array.isArray(c.els) || c.els.length !== 6) throw new Error(`${TABLE_LABEL[t]}의 각 분류에는 요소 6개가 필요합니다.`); });
      }
      await updateDoc(roomRef(), { playset: obj });
      closeModal(); toast("플레이세트를 바꿨습니다.");
      say(`플레이세트를 '${obj.name}'(으)로 바꿨습니다.`, "sys");
    } catch (e) { toast("바꾸지 못했습니다: " + e.message); }
  };
}

/* 진행 순서 도움말 — 전 단계 한눈에 */
$("btn-rules").addEventListener("click", () => {
  openModal("진행 순서", ["setup", "act1", "tilt", "act2", "aftermath"].map(k => {
    const r = PHASE_RULES[k];
    return `<div class="section-label">${r.title}</div>
      <ol class="rule-steps">${r.steps.map(x => `<li>${x}</li>`).join("")}</ol>
      <p class="hint">${r.tip}</p>`;
  }).join("") + `<p class="hint">비틀기 표와 후기 표는 화면 왼쪽 아래 <b>룰 참조</b>에서 언제든 볼 수 있습니다.</p>`);
});

boot();
