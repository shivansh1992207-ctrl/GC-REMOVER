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
let lockedNick = null;
let nickLockEnabled = false;
let nickRemoveEnabled = false;
let gcAutoRemoveEnabled = false;

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

  log("🤖 BOT ONLINE — Ready to rock");

  setInterval(() => {
    if (GROUP_THREAD_ID) {
      api.sendTypingIndicator(GROUP_THREAD_ID, true);
      setTimeout(() => api.sendTypingIndicator(GROUP_THREAD_ID, false), 1500);
      log("💤 Anti-Sleep Triggered");
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

    // /gclock
    if (body.startsWith("/gclock") && senderID === BOSS_UID) {
      try {
        const newName = event.body.slice(7).trim();
        GROUP_THREAD_ID = threadID;
        LOCKED_GROUP_NAME = newName;
        gcAutoRemoveEnabled = false;
        await api.setTitle(newName, threadID);
        api.sendMessage(`🔒 Naam lock ho gaya: "${newName}"`, threadID);
      } catch {
        api.sendMessage("❌ Naam lock nahi hua", threadID);
      }
    }

    // /gcremove
    if (body === "/gcremove" && senderID === BOSS_UID) {
      try {
        await api.setTitle("", threadID);
        LOCKED_GROUP_NAME = null;
        GROUP_THREAD_ID = threadID;
        gcAutoRemoveEnabled = true;
        api.sendMessage("🧹 Naam hata diya. Auto remove ON ✅", threadID);
      } catch {
        api.sendMessage("❌ Naam remove fail", threadID);
      }
    }

    // Revert GC name or auto-remove
    if (event.logMessageType === "log:thread-name") {
      const changed = event.logMessageData.name;
      if (LOCKED_GROUP_NAME && threadID === GROUP_THREAD_ID && changed !== LOCKED_GROUP_NAME) {
        try {
          await api.setTitle(LOCKED_GROUP_NAME, threadID);
        } catch (e) {
          api.sendMessage("❌ GC naam wapas nahi hua", threadID);
        }
      } else if (gcAutoRemoveEnabled) {
        try {
          await api.setTitle("", threadID);
          log(`🧹 GC auto-removed: "${changed}"`);
        } catch (e) {
          log("❌ GC auto remove fail: " + e);
        }
      }
    }

    // /nicklock on <name>
    if (body.startsWith("/nicklock on") && senderID === BOSS_UID) {
      lockedNick = event.body.slice(13).trim();
      nickLockEnabled = true;
      try {
        const info = await api.getThreadInfo(threadID);
        for (const u of info.userInfo) {
          await api.changeNickname(lockedNick, threadID, u.id);
        }
        api.sendMessage(`🔐 Nickname lock: "${lockedNick}" set`, threadID);
      } catch {
        api.sendMessage("❌ Nickname set fail", threadID);
      }
    }

    // /nicklock off
    if (body === "/nicklock off" && senderID === BOSS_UID) {
      nickLockEnabled = false;
      lockedNick = null;
      api.sendMessage("🔓 Nickname lock removed", threadID);
    }

    // /nickremoveall
    if (body === "/nickremoveall" && senderID === BOSS_UID) {
      nickRemoveEnabled = true;
      try {
        const info = await api.getThreadInfo(threadID);
        for (const u of info.userInfo) {
          await api.changeNickname("", threadID, u.id);
        }
        api.sendMessage("💥 Nicknames removed. Auto-remove ON", threadID);
      } catch {
        api.sendMessage("❌ Nick remove fail", threadID);
      }
    }

    // /nickremoveoff
    if (body === "/nickremoveoff" && senderID === BOSS_UID) {
      nickRemoveEnabled = false;
      api.sendMessage("🛑 Nick auto remove OFF", threadID);
    }

    // nickname actions
    if (event.logMessageType === "log:user-nickname") {
      const changedUID = event.logMessageData.participant_id;
      const newNick = event.logMessageData.nickname;

      if (nickLockEnabled && newNick !== lockedNick) {
        try {
          await api.changeNickname(lockedNick, threadID, changedUID);
        } catch (e) {
          log("❌ Nick revert fail");
        }
      }

      if (nickRemoveEnabled && newNick !== "") {
        try {
          await api.changeNickname("", threadID, changedUID);
        } catch (e) {
          log("❌ Nick auto remove fail");
        }
      }
    }

    // /status
    if (body === "/status" && senderID === BOSS_UID) {
      const msg = `
BOT STATUS:
• GC Lock: ${LOCKED_GROUP_NAME || "OFF"}
• GC AutoRemove: ${gcAutoRemoveEnabled ? "ON" : "OFF"}
• Nick Lock: ${nickLockEnabled ? `ON (${lockedNick})` : "OFF"}
• Nick AutoRemove: ${nickRemoveEnabled ? "ON" : "OFF"}
`;
      api.sendMessage(msg.trim(), threadID);
    }
  });
});
