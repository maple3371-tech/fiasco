/* ===========================================================
   mock-firebase.js — 연습 모드용 가짜 백엔드
   index.html?demo=1 로 열었을 때만 쓰입니다.
   진짜 Firebase 대신 브라우저 메모리에서만 돌아가므로
   새로고침하면 판이 사라집니다. 혼자 둘러보기 전용입니다.
   =========================================================== */

const DB = new Map();          // "rooms/DEMO/players/u1" → 데이터
const WATCH = [];              // onSnapshot 구독 목록
let clock = 0;                 // serverTimestamp 대용
let autoId = 0;

const clone = (v) => JSON.parse(JSON.stringify(v ?? null));
const snapOf = (path) => ({
  id: path.split("/").pop(),
  exists: () => DB.has(path),
  data: () => clone(DB.get(path))
});

function childrenOf(colPath) {
  const out = [];
  for (const key of DB.keys()) {
    if (key.startsWith(colPath + "/") && !key.slice(colPath.length + 1).includes("/")) out.push(key);
  }
  return out;
}

function emit() {
  for (const w of WATCH) {
    if (w.ref.kind === "doc") { w.cb(snapOf(w.ref.path)); continue; }
    let paths = childrenOf(w.ref.path);
    const [field, dir] = w.ref.order || [];
    if (field) paths.sort((a, b) => {
      const x = DB.get(a)[field] ?? 0, y = DB.get(b)[field] ?? 0;
      return dir === "desc" ? y - x : x - y;
    });
    if (w.ref.max) paths = paths.slice(0, w.ref.max);
    w.cb({ docs: paths.map(snapOf) });
  }
}

/* ── Firestore 대역 ─────────────────────────────────── */
export const getFirestore = () => ({ mock: true });
export const doc = (_db, ...seg) => ({ kind: "doc", path: seg.join("/") });
export const collection = (_db, ...seg) => ({ kind: "col", path: seg.join("/") });
export const query = (ref, ...ops) => {
  const q = { ...ref };
  for (const op of ops) {
    if (op.t === "order") q.order = [op.field, op.dir];
    if (op.t === "limit") q.max = op.n;
  }
  return q;
};
export const orderBy = (field, dir = "asc") => ({ t: "order", field, dir });
export const limit = (n) => ({ t: "limit", n });
export const serverTimestamp = () => ++clock;

export async function getDoc(ref) { return snapOf(ref.path); }
export async function getDocs(ref) { return { docs: childrenOf(ref.path).map(snapOf) }; }

export async function setDoc(ref, data, opts = {}) {
  const prev = opts.merge ? (DB.get(ref.path) || {}) : {};
  DB.set(ref.path, { ...prev, ...clone(data) });
  emit();
}
export async function updateDoc(ref, patch) {
  if (!DB.has(ref.path)) throw new Error("문서가 없습니다: " + ref.path);
  DB.set(ref.path, { ...DB.get(ref.path), ...clone(patch) });
  emit();
}
export async function deleteDoc(ref) { DB.delete(ref.path); emit(); }
export async function addDoc(ref, data) {
  const path = `${ref.path}/auto${String(++autoId).padStart(5, "0")}`;
  DB.set(path, clone(data));
  emit();
  return { id: path.split("/").pop() };
}
export function onSnapshot(ref, cb) {
  const w = { ref, cb };
  WATCH.push(w);
  cb(ref.kind === "doc" ? snapOf(ref.path) : { docs: childrenOf(ref.path).map(snapOf) });
  return () => { const i = WATCH.indexOf(w); if (i >= 0) WATCH.splice(i, 1); };
}
export async function runTransaction(_db, fn) {
  // 혼자 쓰는 모드라 충돌이 없으므로 바로 적용합니다.
  const pending = [];
  const tx = {
    get: async (ref) => snapOf(ref.path),
    update: (ref, patch) => pending.push([ref, patch]),
    set: (ref, data) => pending.push([ref, data])
  };
  await fn(tx);
  for (const [ref, patch] of pending) DB.set(ref.path, { ...(DB.get(ref.path) || {}), ...clone(patch) });
  emit();
}

/* ── Auth 대역 ──────────────────────────────────────── */
export const initializeApp = () => ({ mock: true });
export function GoogleAuthProvider() { }

export const DEMO_USERS = [
  { uid: "demo1", displayName: "정우", photoURL: "" },
  { uid: "demo2", displayName: "세림", photoURL: "" },
  { uid: "demo3", displayName: "가영", photoURL: "" },
  { uid: "demo4", displayName: "동혁", photoURL: "" }
];

let current = DEMO_USERS[0];
const authCbs = [];
export const getAuth = () => ({ get currentUser() { return current; } });
export function onAuthStateChanged(_auth, cb) { authCbs.push(cb); cb(current); return () => { }; }
export async function signInWithPopup() { authCbs.forEach(cb => cb(current)); return { user: current }; }
export async function signOut() { current = null; authCbs.forEach(cb => cb(null)); }

/* 연습 모드에서 시점을 바꿀 때 씁니다 (진짜 Firebase에는 없는 기능) */
export function switchUser(uid) {
  current = DEMO_USERS.find(u => u.uid === uid) || current;
  return current;
}
export function resetAll() { DB.clear(); WATCH.length = 0; clock = 0; autoId = 0; }
