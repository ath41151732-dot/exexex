// sync_events.js — Firestore 동기화(계정별). auth.js 이후 로드 필수.
import { getAuth, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import {
  getFirestore, doc, getDoc, setDoc, onSnapshot, serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

console.log("[sync] loaded (compat)");

const auth = getAuth();          // 기본 앱 사용 (auth.js에서 initializeApp 이미 실행됨)
const db   = getFirestore();     // 기본 앱 사용

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
  }catch(e){ console.warn("[sync] setLocalEvents error", e); }
}

// ---- 클라우드 저장/불러오기 ----
async function cloudSave(){
  const u = auth.currentUser; if (!u) return;
  const ref = doc(db, "users", u.uid);
  const events = getLocalEvents();
  await setDoc(ref, {
    email: u.email,
    events: events,
    updatedAt: serverTimestamp()
  }, { merge: true });
  console.log("[sync] saved", events.length, "events");
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
      console.log("[sync] loaded", data.events.length, "events from cloud");
    } else {
      console.log("[sync] no events field yet");
      if (getLocalEvents().length) await cloudSave();
    }
  } else {
    await setDoc(ref, { email: auth.currentUser.email, events: [], createdAt: serverTimestamp(), updatedAt: serverTimestamp() });
    if (getLocalEvents().length) await cloudSave();
    console.log("[sync] created user doc");
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
    console.log("[sync] saveUserEvents hooked");
  }
}

// ---- 로그인 상태 관찰 ----
onAuthStateChanged(auth, async (user)=>{
  if (typeof unsub === "function"){ unsub(); unsub = null; }
  if (!user){ console.log("[sync] signed out — stop syncing"); return; }

  try { hookSave(); } catch(e){ console.warn("[sync] hookSave error", e); }

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
        console.log("[sync] applied remote update", data.events.length);
      }
    }
  });
  console.log("[sync] realtime subscription started");
});
