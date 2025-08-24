// sync_events_lp.js — Firestore 동기화(계정별) + Long-Polling 우선
// 학교/공용망에서 WebChannel/HTTP2가 막혀 400 에러가 날 때 사용.
// 반드시 auth.js(= initializeApp) 이후에 로드하세요.

import { getApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import {
  initializeFirestore, doc, getDoc, setDoc, onSnapshot, serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { getAuth, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";

console.log("[sync-lp] loaded");

const app  = getApp();
const db   = initializeFirestore(app, {
  // 네트워크/프록시 환경에서 실시간 스트림이 막힐 때 롱폴링로 자동 전환
  experimentalAutoDetectLongPolling: true,
  // 필요하면 아래 두 줄 주석 해제해서 ‘강제’ 롱폴링
  // experimentalForceLongPolling: true,
  // useFetchStreams: false,
});
const auth = getAuth(app);

let unsub = null;
let isApplyingRemote = false;
let lastSavedJson = null; // 마지막으로 클라우드에 저장된 내용 스냅샷

// ===== 로컬 일정 접근 (네 사이트 전역 상태와 연동) =====
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

// ===== 클라우드 저장/불러오기 =====
async function cloudSave(reason="localChange"){
  const u = auth.currentUser; if (!u) return;
  const events = getLocalEvents();
  const json   = JSON.stringify(events);
  if (json === lastSavedJson) return; // 변경 없으면 스킵

  await setDoc(doc(db, "users", u.uid), {
    email: u.email,
    events,
    updatedAt: serverTimestamp()
  }, { merge: true });

  lastSavedJson = json;
  console.log("[sync-lp] saved", events.length, "events; reason:", reason);
}

async function cloudLoadOnce(user){
  const ref = doc(db, "users", user.uid);
  const snap = await getDoc(ref);

  if (snap.exists()){
    const data   = snap.data() || {};
    const events = Array.isArray(data.events) ? data.events : [];
    isApplyingRemote = true;
    setLocalEvents(events);
    isApplyingRemote = false;
    lastSavedJson = JSON.stringify(events);
    console.log("[sync-lp] loaded", events.length, "events from cloud");
  } else {
    // 사용자 문서가 없으면 생성
    await setDoc(ref, {
      email: user.email,
      events: [],
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp()
    }, { merge: true });

    // 로컬에 기존 일정이 있으면 첫 로그인에 업로드
    const local = getLocalEvents();
    if (local.length){
      await cloudSave("initialUpload");
    }
    console.log("[sync-lp] created user doc");
  }
}

// ===== saveUserEvents 후킹(로컬 저장 때마다 클라우드도 저장) =====
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
  } else {
    // 페이지 초기화 타이밍 때문에 아직 없을 수 있으니 1.5초 뒤 재시도
    setTimeout(()=>{
      const o2 = window.saveUserEvents;
      if (typeof o2 === "function" && !o2.__cloudHooked){
        function wrapped(){
          const r = o2.apply(this, arguments);
          if (!isApplyingRemote) cloudSave().catch(console.warn);
          return r;
        }
        wrapped.__cloudHooked = true;
        window.saveUserEvents = wrapped;
        console.log("[sync-lp] saveUserEvents hooked (retry)");
      }
    }, 1500);
  }
}

// ===== 로그인 상태 관찰: 로그인하면 동기화 시작 =====
onAuthStateChanged(auth, async (user)=>{
  if (typeof unsub === "function"){ unsub(); unsub = null; }

  if (!user){
    console.log("[sync-lp] signed out — stop syncing");
    return;
  }

  try { hookSave(); } catch(e){ console.warn("[sync-lp] hookSave error", e); }

  // 최초 로드 & 초기 업로드 처리
  await cloudLoadOnce(user);

  // 실시간 구독
  const ref = doc(db, "users", user.uid);
  unsub = onSnapshot(ref, (snap)=>{
    const data = snap.data(); if (!data) return;
    const remoteEvents = Array.isArray(data.events) ? data.events : [];
    const remoteJSON   = JSON.stringify(remoteEvents);
    if (remoteJSON !== lastSavedJson){
      isApplyingRemote = true;
      setLocalEvents(remoteEvents);
      isApplyingRemote = false;
      lastSavedJson = remoteJSON;
      console.log("[sync-lp] applied remote update", remoteEvents.length);
    }
  });
  console.log("[sync-lp] realtime subscription started");
});

// 수동 업로드가 필요할 때 콘솔에서 호출 가능
window.phhsSyncSave = ()=> cloudSave("manual");
