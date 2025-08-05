const ws3 = require("ws3-fca");
const login = typeof ws3 === "function" ? ws3 : (ws3.default || ws3.login || ws3);
const fs = require("fs");
const path = require("path");

const uid = process.argv[2];
const userDir = path.join(__dirname, "users", uid);
const appStatePath = path.join(userDir, "appstate.json");
const adminPath = path.join(userDir, "admin.txt");
const logPath = path.join(userDir, "logs.txt");

function log(msg) {
  const line = `[${new Date().toLocaleTimeString()}] ${msg}`;
  console.log(line);
  fs.appendFileSync(logPath, line + "\n");
}

let appState;
try {
  const raw = fs.readFileSync(appStatePath, "utf-8");
  if (!raw.trim()) throw new Error("File is empty");
  appState = JSON.parse(raw);
} catch (err) {
  log("❌ appstate.json is invalid or empty.");
  process.exit(1);
}

let BOSS_UID;
try {
  BOSS_UID = fs.readFileSync(adminPath, "utf-8").trim();
  if (!BOSS_UID) throw new Error("UID missing");
} catch (err) {
  log("❌ admin.txt is invalid or empty.");
  process.exit(1);
}

let GROUP_THREAD_ID = null;
let LOCKED_GROUP_NAME = null;
let nickLockEnabled = false;
let nickRemoveEnabled = false;
let nickRemoveAllMode = false;
let originalNicknames = {};

const loginOptions = {
  appState,
  userAgent:
    "Mozilla/5.0 (iPhone; CPU iPhone OS 15_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 FBAV/400.0.0.0.0",
};

login(loginOptions, (err, api) => {
  if (err) return log("❌ [LOGIN FAILED]: " + err);

  api.setOptions({
    listenEvents: true,
    selfListen: true,
    updatePresence: true,
  });

  log("🤖 BOT ONLINE 🔥 — Ready to lock and rock!");

  setInterval(() => {
    if (GROUP_THREAD_ID) {
      api.sendTypingIndicator(GROUP_THREAD_ID, true);
      setTimeout(() => api.sendTypingIndicator(GROUP_THREAD_ID, false), 1500);
      log("💤 Bot is active... still alive ✅");
    }
  }, 300000);

  setInterval(() => {
    try {
      const newAppState = api.getAppState();
      fs.writeFileSync(appStatePath, JSON.stringify(newAppState, null, 2));
      log("💾 Appstate saved ✅");
    } catch (e) {
      log("❌ Appstate save failed: " + e);
    }
  }, 600000);

  api.listenMqtt(async (err, event) => {
    if (err) return log("❌ Listen error: " + err);

    const senderID = event.senderID;
    const threadID = event.threadID;
    const body = (event.body || "").toLowerCase();

    if (event.type === "message") {
      log(`📩 ${senderID}: ${event.body} (Group: ${threadID})`);
    }

    // 🔒 /gclock
    if (event.type === "message" && body.startsWith("/gclock")) {
      if (senderID !== BOSS_UID)
        return api.sendMessage("⛔ Tu boss nahi hai 😤", threadID);

      try {
        const newName = event.body.slice(7).trim();
        GROUP_THREAD_ID = threadID;

        if (newName.length > 0) {
          await api.setTitle(newName, threadID);
          LOCKED_GROUP_NAME = newName;
          api.sendMessage(`🔒 Naam lock ho gaya: "${LOCKED_GROUP_NAME}"`, threadID);
        } else {
          const info = await api.getThreadInfo(threadID);
          LOCKED_GROUP_NAME = info.name;
          api.sendMessage(`🔒 Current naam lock kiya gaya: "${LOCKED_GROUP_NAME}"`, threadID);
        }
      } catch (e) {
        api.sendMessage("❌ Naam lock nahi hua 😩", threadID);
        log("❌ [GCLOCK ERROR]: " + e);
      }
    }

    // 🔁 GC Name Revert
    if (event.logMessageType === "log:thread-name" && threadID === GROUP_THREAD_ID) {
      const changedName = event.logMessageData.name;
      if (LOCKED_GROUP_NAME && changedName !== LOCKED_GROUP_NAME) {
        try {
          await api.setTitle(LOCKED_GROUP_NAME, threadID);
          api.sendMessage(`⚠️ Naam wapas kiya: "${LOCKED_GROUP_NAME}"`, threadID);
        } catch (e) {
          api.sendMessage("❌ Wapas set nahi hua, admin rights do! 😭", threadID);
        }
      }
    }

    // 💣 /nickremoveall
    if (event.type === "message" && body === "/nickremoveall") {
      if (senderID !== BOSS_UID) return;

      try {
        const info = await api.getThreadInfo(threadID);
        for (const u of info.userInfo) {
          await api.changeNickname("", threadID, u.id);
        }
        nickRemoveAllMode = true;
        api.sendMessage("💥 Sabke nicknames hata diye gaye! 🔒 Auto remove active ✅", threadID);
        log("🔥 All nicknames removed, nickRemoveAllMode = true");
      } catch (err) {
        api.sendMessage("❌ Nickname remove fail 😵", threadID);
        log("❌ [NICKREMOVEALL ERROR]: " + err);
      }
    }

    // 🚫 Block future nickname changes if nickRemoveAllMode is ON
    if (nickRemoveAllMode && event.logMessageType === "log:user-nickname") {
      const changedUID = event.logMessageData.participant_id;
      const currentNick = event.logMessageData.nickname;

      if (currentNick && currentNick.trim() !== "") {
        try {
          await api.changeNickname("", threadID, changedUID);
          log(`🚫 [Auto-Block] Removed nickname of ${changedUID}: "${currentNick}"`);
        } catch (err) {
          log("❌ [Auto-Block Nick Remove Failed]: " + err);
        }
      }
    }
  });
});
