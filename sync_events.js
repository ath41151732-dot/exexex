// sync_events_poll.js — Firestore 동기화(계정별) 폴링 버전
// 실시간 onSnapshot을 쓰지 않고 N초마다 getDoc 해서 반영합니다.

import { getAuth, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import { getFirestore, doc, getDoc, setDoc, serverTimestamp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

console.log("[sync-poll] loaded");
const auth = getAuth();
const db   = getFirestore();

let pollTimer = null;
let isApplyingRemote = false;
let lastSavedJson = null;

function getLocalEvents(){ try { return Array.isArray(window.EVENTS_USER) ? window.EVENTS_USER : []; } catch { return []; } }
function setLocalEvents(arr){
  try {
    window.EVENTS_USER = Array.isArray(arr) ? arr : [];
    if (typeof window.saveUserEvents === "function") window.saveUserEvents();
    if (typeof window.render === "function" && window.current) window.render(window.current);
  } catch(e){ console.warn("[sync-poll] setLocalEvents error", e); }
}
async function cloudSave(reason="localChange"){
  const u = auth.currentUser; if (!u) return;
  const events = getLocalEvents();
  const json = JSON.stringify(events);
  if (json === lastSavedJson) return;
  await setDoc(doc(db, "users", u.uid), { email: u.email, events, updatedAt: serverTimestamp() }, { merge: true });
  lastSavedJson = json;
  console.log("[sync-poll] saved", events.length, "events; reason:", reason);
}
async function loadOnce(u){
  const snap = await getDoc(doc(db, "users", u.uid));
  if (snap.exists()){
    const events = Array.isArray(snap.data().events) ? snap.data().events : [];
    const remoteJSON = JSON.stringify(events);
    if (remoteJSON !== lastSavedJson){
      isApplyingRemote = true; setLocalEvents(events); isApplyingRemote = false;
      lastSavedJson = remoteJSON;
      console.log("[sync-poll] applied remote update", events.length);
    }
  } else {
    await setDoc(doc(db, "users", u.uid), { email: u.email, events: [], createdAt: serverTimestamp(), updatedAt: serverTimestamp() }, { merge: true });
    const local = getLocalEvents();
    if (local.length) await cloudSave("initialUpload");
    console.log("[sync-poll] created user doc");
  }
}
function hookSave(){
  const orig = window.saveUserEvents;
  if (typeof orig === "function" && !orig.__cloudHooked){
    function wrapped(){ const r = orig.apply(this, arguments); if (!isApplyingRemote) cloudSave().catch(console.warn); return r; }
    wrapped.__cloudHooked = true; window.saveUserEvents = wrapped;
    console.log("[sync-poll] saveUserEvents hooked");
  }
}
function startPolling(u){
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = setInterval(()=> loadOnce(u).catch(()=>{}), 5000); // 5초마다
  window.addEventListener("beforeunload", ()=> { try { cloudSave("unload"); } catch {} });
}

onAuthStateChanged(auth, async (user)=>{
  if (!user){ if (pollTimer) clearInterval(pollTimer); pollTimer=null; console.log("[sync-poll] signed out"); return; }
  try { hookSave(); } catch {}
  await loadOnce(user);
  startPolling(user);
});
window.phhsSyncSave = ()=> cloudSave("manual");
