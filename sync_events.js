
// sync_events_lp.js — Firestore 동기화 + Long‑Polling 우선 적용
// 학교/공용망에서 WebChannel이 막혀 400/transport errored가 뜰 때 사용하세요.

import { getAuth, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import {
  getApp
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import {
  initializeFirestore, doc, getDoc, setDoc, onSnapshot, serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

console.log("[sync-lp] loaded");

const app = getApp();
// Long-polling 자동 감지(필요 시 강제 전환). 일부 환경에서는 이 옵션이 필수입니다.
const db  = initializeFirestore(app, {
  experimentalAutoDetectLongPolling: true,
  // experimentalForceLongPolling: true,   // 위 옵션으로도 안 될 때 이 줄의 주석을 해제
  // useFetchStreams: false,               // 일부 구형 브라우저/프록시에서 필요하면 해제
});
const auth = getAuth();

let unsub = null;
let isApplyingRemote = false;

// ---- 로컬 상태 접근자 ----
function getLocalEvents(){
  try { return Array.isArray(window.EVENTS_USER) ? window.EVENTS_USER : []; }
  catch { return []; }
}
function setLocalEvents(arr){
  try {
    window.EVENTS_USER = Array.isArray(arr) ? arr : [];
    if (typeof window.saveUserEvents === "function") window.saveUserEvents();
    if (typeof window.render === "function" && window.current) window.render(window.current);
  }catch(e){ console.warn("[sync-lp] setLocalEvents error", e); }
}

// ---- 클라우드 저장/불러오기 ----
async function cloudSave(){
  const u = auth.currentUser; if (!u) return;
  const ref = doc(db, "users", u.uid);
  const events = getLocalEvents();
  await setDoc(ref, { email: u.email, events, updatedAt: serverTimestamp() }, { merge: true });
  console.log("[sync-lp] saved", events.length, "events");
}

async function cloudLoadOnce(uid){
  const ref = doc(db, "users", uid);
  const snap = await getDoc(ref);
  if (snap.exists()){
    const data = snap.data();
    if (Array.isArray(data.events)){
      isApplyingRemote = true;
      setLocalEvents(data.events);
      isApplyingRemote = false;
      console.log("[sync-lp] loaded", data.events.length, "events from cloud");
    } else if (getLocalEvents().length){
      await cloudSave();
    }
  } else {
    await setDoc(ref, { email: auth.currentUser.email, events: [], createdAt: serverTimestamp(), updatedAt: serverTimestamp() });
    if (getLocalEvents().length) await cloudSave();
    console.log("[sync-lp] created user doc");
  }
}

// ---- saveUserEvents 후킹 ----
function hookSave(){
  const orig = window.saveUserEvents;
  if (typeof orig === "function" && !orig.__cloudHooked){
    function wrapped(){
      const r = orig.apply(this, arguments);
      if (!isApplyingRemote) cloudSave().catch(console.warn);
      return r;
    }
    wrapped.__cloudHooked = true;
    window.saveUserEvents = wrapped;
    console.log("[sync-lp] saveUserEvents hooked");
  }
}

// ---- 로그인 상태 관찰 ----
onAuthStateChanged(auth, async (user)=>{
  if (typeof unsub === "function"){ unsub(); unsub = null; }
  if (!user){ console.log("[sync-lp] signed out — stop syncing"); return; }

  try { hookSave(); } catch(e){ console.warn("[sync-lp] hookSave error", e); }

  await cloudLoadOnce(user.uid);

  const ref = doc(db, "users", user.uid);
  unsub = onSnapshot(ref, (snap)=>{
    const data = snap.data(); if (!data) return;
    if (Array.isArray(data.events)){
      const localJSON  = JSON.stringify(getLocalEvents());
      const remoteJSON = JSON.stringify(data.events);
      if (localJSON !== remoteJSON){
        isApplyingRemote = true;
        setLocalEvents(data.events);
        isApplyingRemote = false;
        console.log("[sync-lp] applied remote update", data.events.length);
      }
    }
  });
  console.log("[sync-lp] realtime subscription started");
});
