// --------- 1. Connect to the database (Supabase) ---------
// Copy these two values from your Supabase project (Connect button).
const SUPABASE_URL = "https://snzorbrurggqabacmpsf.supabase.co";
const SUPABASE_KEY = "sb_publishable_f1neNuOmHjQMbLcmVzEq3Q_SiwOi9qM";

const sb = supabase.createClient(SUPABASE_URL, SUPABASE_KEY);

// --------- 2. Grab the elements we need ---------
const authScreen = document.getElementById("auth-screen");
const chatScreen = document.getElementById("chat-screen");
const authForm = document.getElementById("auth-form");
const authMessage = document.getElementById("auth-message");
const displayName = document.getElementById("display-name");
const emailInput = document.getElementById("email");
const passwordInput = document.getElementById("password");
const signupBtn = document.getElementById("signup-btn");
const logoutBtn = document.getElementById("logout-btn");
const who = document.getElementById("who");
const messageList = document.getElementById("messages");
const messageForm = document.getElementById("message-form");
const messageInput = document.getElementById("message-input");

// --------- 3. What the app remembers while it runs ---------
let currentUser = null; // the logged-in user, or null
const names = {}; // user id -> display name
let channel = null; // the realtime connection (used in Part 4)
let presenceChannel = null;

// --------- 4. Sign up, log in, log out ---------
async function signUp() {
  const name = displayName.value.trim();
  if (name.length < 2) {
    authMessage.textContent = "Enter a display name (2 to 24 characters).";
    return;
  }

  authMessage.textContent = "Creating your account...";
  const { data, error } = await sb.auth.signUp({
    email: emailInput.value.trim(),
    password: passwordInput.value,
    options: { data: { display_name: name } },
  });

  if (error) {
    authMessage.textContent = error.message;
  } else if (!data.session) {
    authMessage.textContent = "Check your email to confirm your account.";
  } else {
    authMessage.textContent = "";
  }
}

async function logIn() {
  authMessage.textContent = "Logging in...";
  const { error } = await sb.auth.signInWithPassword({
    email: emailInput.value.trim(),
    password: passwordInput.value,
  });
  authMessage.textContent = error ? error.message : "";
}

authForm.addEventListener("submit", (event) => {
  event.preventDefault(); // stop the page from reloading
  logIn();
});

signupBtn.addEventListener("click", () => {
  if (authForm.reportValidity()) signUp();
});

logoutBtn.addEventListener("click", () => sb.auth.signOut());

// --------- 5. React when the login state changes ---------
sb.auth.onAuthStateChange((event, session) => {
  const user = session ? session.user : null;

  // setTimeout lets Supabase finish its own work before we call it again
  setTimeout(() => {
    if (user && (!currentUser || currentUser.id !== user.id)) startChat(user);
    if (!user && currentUser) stopChat();
  }, 0);
});

// --------- 6. Start and stop the chat room ---------
async function startChat(user) {
  currentUser = user;
  authScreen.hidden = true;
  chatScreen.hidden = false;
  restoreLiptus();
  who.textContent = "Loading...";
  
  await loadNames();
  who.textContent = names[user.id] || "Signed in";
  await loadMessages();
  listenForNewMessages();
  startPresence(user);
  await loadCover();
  listenForCover();
  startTyping();
  messageInput.focus();
}

function stopChat() {
  currentUser = null;
  stopPresence();
  if (coverChannel) sb.removeChannel(coverChannel);
  if (typingChannel) sb.removeChannel(typingChannel);
  coverChannel = typingChannel = null;
  if (channel) sb.removeChannel(channel);
  channel = null;
  messageList.innerHTML = "";
  passwordInput.value = "";
  chatScreen.hidden = true;
  authScreen.hidden = false;
}

// --------- 7. Show one message on the screen ---------
function showMessage(msg) {
  // Skip it if it is already on the screen (this matters in Part 4)
  if (messageList.querySelector('[data-id="' + msg.id + '"]')) return;

  const isMine = msg.user_id === currentUser.id;
  const item = document.createElement("li");
  item.className = isMine ? "message mine" : "message";
  item.dataset.id = msg.id;

  const author = document.createElement("span");
  author.className = "author";
  author.textContent = names[msg.user_id] || "Unknown";

  const text = document.createElement("p");
  // textContent (not innerHTML) keeps the page safe from injected HTML
  text.textContent = msg.content;

  const time = document.createElement("time");
  time.textContent = new Date(msg.created_at).toLocaleTimeString([], {
    hour: "numeric",
    minute: "2-digit",
  });

  item.dataset.img = msg.image_path || "";
  item.append(author);
  if (msg.image_path) {
    const img = document.createElement("img");
    img.className = "chat-image";
    img.loading = "lazy";
    img.alt = "Photo from " + author.textContent;
    img.src = imageUrl(msg.image_path);
    img.addEventListener("click", () => openLightbox(img.src));
    item.append(img);
  }
  if (msg.content) item.append(text);
  item.append(time);
  if (isMine) {
    const unsendBtn = document.createElement("button");
    unsendBtn.type = "button";
    unsendBtn.className = "unsend-btn";
    unsendBtn.textContent = "Unsend";

    unsendBtn.addEventListener("click", () => {
      unsendMessage(msg.id, unsendBtn);
    });

    item.appendChild(unsendBtn);
  }
  messageList.appendChild(item);
  messageList.scrollTop = messageList.scrollHeight;
}

// --------- 8. Send a message (text and/or photo) ---------
messageForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const content = messageInput.value.trim();
  if (!content && !pendingImage) return;
  if (content.startsWith("/") && !pendingImage) {
    messageInput.value = "";
    handleCommand(content);
    return;
  }
  const sendBtn = messageForm.querySelector('button[type="submit"]');
  sendBtn.disabled = true;
  try {
    let image_path = null;
    if (pendingImage) {
      previewStatus.textContent = "Uploading...";
      image_path = await uploadImage(pendingImage, "chat");
    }
    const { data, error } = await sb
      .from("messages")
      .insert({ content: content || null, image_path })
      .select()
      .single();
    if (error) throw error;
    messageInput.value = "";
    clearPreview();
    showMessage(data);
  } catch (e) {
    previewStatus.textContent = "Failed. Try again.";
    alert("Could not send: " + e.message);
  }
  sendBtn.disabled = false;
});

// --------- 9. Read data from the database (SELECT) ---------
async function loadNames() {
  const { data, error } = await sb
    .from("profiles")
    .select("id, display_name");
  if (error) return console.error(error);

  data.forEach((p) => {
    names[p.id] = p.display_name;
  });
}

async function loadMessages() {
  const { data, error } = await sb
    .from("messages")
    .select("id, user_id, content, image_path, created_at")
    .order("created_at", { ascending: false })
    .limit(50);

  if (error) return console.error(error);

  messageList.innerHTML = "";
  data.reverse().forEach(showMessage);
}

async function unsendMessage(messageId, button) {
  if (!currentUser || !messageId) return;

  button.disabled = true;
  button.textContent = "Unsending...";

  const { error } = await sb
    .from("messages")
    .delete()
    .eq("id", messageId)
    .eq("user_id", currentUser.id);

  if (error) {
    console.error(error);
    button.disabled = false;
    button.textContent = "Unsend";
    alert("Could not unsend message: " + error.message);
    return;
  }

  const li = messageList.querySelector('[data-id="' + messageId + '"]');
  if (li && li.dataset.img) sb.storage.from(IMG_BUCKET).remove([li.dataset.img]);
  removeMessage(messageId);
}

// --------- 10. Get new messages instantly (Realtime) ---------
async function nameFor(userId) {
  if (!names[userId]) {
    const { data } = await sb
      .from("profiles")
      .select("display_name")
      .eq("id", userId)
      .single();
    names[userId] = data ? data.display_name : "Unknown";
  }
  return names[userId];
}

function listenForNewMessages() {
  if (channel) sb.removeChannel(channel);

  channel = sb
    .channel("class-chat")
    .on(
      "postgres_changes",
      { event: "INSERT", schema: "public", table: "messages" },
      async (payload) => {
        await nameFor(payload.new.user_id);
        showMessage(payload.new);
        if (payload.new.user_id !== currentUser.id) petReact();
      }
    )
    .on(
      "postgres_changes",
      { event: "DELETE", schema: "public", table: "messages" },
      (payload) => removeMessage(payload.old.id)
    )
    .subscribe();
}

function removeMessage(id) {
  const item = messageList.querySelector('[data-id="' + id + '"]');
  if (item) item.remove();
}

// --------- 11. API: a private weather bot (GET) ---------
const GEO_URL = "https://geocoding-api.open-meteo.com/v1/search";
const WEATHER_URL = "https://api.open-meteo.com/v1/forecast";


async function getTimeZone(city) {
  const url = GEO_URL + "?name=" + encodeURIComponent(city) + "&count=1";

  const response = await fetch(url);
  if (!response.ok) throw new Error("City lookup failed");

  const data = await response.json();

  if (!data.results || data.results.length === 0) {
    throw new Error("City not found");
  }

  const timeZone = data.results[0].timezone;

  if (!timeZone) throw new Error("Time zone unavailable");

  return timeZone;
}

function describeWeather(code) {
  if (code === 0) return "clear sky";
  if (code <= 3) return "partly cloudy";
  if (code <= 48) return "foggy";
  if (code <= 57) return "drizzle";
  if (code <= 67) return "rain";
  if (code <= 77) return "snow";
  if (code <= 82) return "rain showers";
  if (code <= 86) return "snow showers";
  return "thunderstorm";
}


function startPresence(user) {
  if (presenceChannel) {
    sb.removeChannel(presenceChannel);
  }

  presenceChannel = sb.channel("online-users", {
    config: {
      presence: { key: user.id }
    }
  });

  presenceChannel
    .on("presence", { event: "sync" }, renderOnlineUsers)
    .subscribe(async (status) => {
      if (status === "SUBSCRIBED") {
        await presenceChannel.track({
          user_id: user.id,
          display_name:
            names[user.id] ||
            user.user_metadata?.display_name ||
            "Signed in"
        });
      }
    });
}

function renderOnlineUsers() {
  if (!presenceChannel) return;

  const state = presenceChannel.presenceState();
  const onlineUsers = document.getElementById("online-users");
  const onlineCount = document.getElementById("online-count");

  // One entry per user, even if they have multiple tabs open.
  const users = new Map();

  for (const [userId, sessions] of Object.entries(state)) {
    if (sessions.length > 0) {
      users.set(
        userId,
        sessions[0].display_name || names[userId] || "Signed in"
      );
    }
  }

  onlineUsers.replaceChildren();

  for (const [userId, displayName] of users) {
    const item = document.createElement("li");
    item.textContent =
      displayName + (userId === currentUser?.id ? " (You)" : "");
    onlineUsers.appendChild(item);
  }

  onlineCount.textContent = users.size;
}

function stopPresence() {
  if (presenceChannel) {
    sb.removeChannel(presenceChannel);
    presenceChannel = null;
  }

  const onlineUsers = document.getElementById("online-users");
  const onlineCount = document.getElementById("online-count");

  onlineUsers.replaceChildren();
  onlineCount.textContent = "0";
}

async function getWeather(city) {
  // Request 1: turn the city name into latitude and longitude
  const geoUrl = GEO_URL + "?name=" + encodeURIComponent(city) + "&count=1";
  const geoResponse = await fetch(geoUrl);
  if (!geoResponse.ok) throw new Error("Geocoding failed");
  const geoData = await geoResponse.json();

  if (!geoData.results) {
    return "Sorry, I could not find a city named \"" + city + "\".";
  }
  const place = geoData.results[0];

  // Request 2: ask for the current weather at those coordinates
  const weatherUrl =
    WEATHER_URL +
    "?latitude=" + place.latitude +
    "&longitude=" + place.longitude +
    "&current=temperature_2m,weather_code,wind_speed_10m";
  const weatherResponse = await fetch(weatherUrl);
  if (!weatherResponse.ok) throw new Error("Weather failed");
  const weatherData = await weatherResponse.json();
  const now = weatherData.current;

  return (
    place.name + ", " + place.country + ": " +
    now.temperature_2m + " degrees C, " +
    describeWeather(now.weather_code) + ", wind " +
    now.wind_speed_10m + " km/h"
  );
}


async function handleCommand(text) {
  const words = text.trim().split(/\s+/);
  const command = words[0].toLowerCase();

  if (command === "/time") {
    const city = words.slice(1).join(" ") || "Manila";

    try {
      const timeZone = await getTimeZone(city);

      const time = new Intl.DateTimeFormat("en-PH", {
        timeZone: timeZone,
        dateStyle: "full",
        timeStyle: "long"
      }).format(new Date());

      showBotMessage("Current time in " + city + ": " + time);
    } catch (error) {
      console.error(error);
      showBotMessage("Could not find the time zone for " + city + ".");
    }

    return;
  }

  if (command !== "/weather") {
    showBotMessage("Unknown command. Try: /weather Manila or /time Tokyo");
    return;
  }

  const city = words.slice(1).join(" ").trim();

  if (city === "") {
    showBotMessage("Try it like this: /weather Manila");
    return;
  }

  try {
    showBotMessage(await getWeather(city));
  } catch (error) {
    console.error(error);
    showBotMessage("The weather service is not answering right now.");
  }
}

function showBotMessage(text) {
  const item = document.createElement("li");
  item.className = "message bot";

  const author = document.createElement("span");
  author.className = "author";
  author.textContent = "WeatherBot (only you can see this)";

  const body = document.createElement("p");
  body.textContent = text;

  item.append(author, body);
  messageList.appendChild(item);
  messageList.scrollTop = messageList.scrollHeight;
}

// --------- 13. Photos, shared cover, typing, screenshot shield ---------
const IMG_BUCKET = "chat-images";
const messagesArea = document.getElementById("messages");
const emojiToggle = document.getElementById("emoji-toggle");
const emojiPicker = document.getElementById("emoji-picker");
const photoPicker = document.getElementById("photo-picker");
const photoPreview = document.getElementById("photo-preview");
const previewImg = document.getElementById("preview-img");
const previewStatus = document.getElementById("preview-status");
const backgroundPicker = document.getElementById("background-picker");
let pendingImage = null;
let coverChannel = null;
let typingChannel = null;

const imageUrl = (path) => sb.storage.from(IMG_BUCKET).getPublicUrl(path).data.publicUrl;

function checkImage(file) {
  if (!["image/jpeg", "image/png", "image/webp"].includes(file.type)) return "Please choose a JPG, PNG or WebP image.";
  if (file.size > 8 * 1024 * 1024) return "Image must be smaller than 8 MB.";
  return null;
}

async function compressImage(file, maxSide) {
  const bmp = await createImageBitmap(file);
  const scale = Math.min(1, maxSide / Math.max(bmp.width, bmp.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(bmp.width * scale);
  canvas.height = Math.round(bmp.height * scale);
  canvas.getContext("2d").drawImage(bmp, 0, 0, canvas.width, canvas.height);
  return new Promise((ok, fail) =>
    canvas.toBlob((b) => (b ? ok(b) : fail(new Error("Could not process image"))), "image/jpeg", 0.82));
}

async function uploadImage(file, folder) {
  const blob = await compressImage(file, folder === "covers" ? 1600 : 1280);
  const path = folder + "/" + currentUser.id + "/" + Date.now() + ".jpg";
  const { error } = await sb.storage.from(IMG_BUCKET).upload(path, blob, { contentType: "image/jpeg" });
  if (error) throw error;
  return path;
}

function clearPreview() {
  pendingImage = null;
  if (previewImg.src) URL.revokeObjectURL(previewImg.src);
  previewImg.removeAttribute("src");
  photoPreview.hidden = true;
  photoPicker.value = "";
}

photoPicker.addEventListener("change", () => {
  const file = photoPicker.files[0];
  if (!file) return;
  const problem = checkImage(file);
  if (problem) { alert(problem); photoPicker.value = ""; return; }
  pendingImage = file;
  previewImg.src = URL.createObjectURL(file);
  previewStatus.textContent = "Ready to send";
  photoPreview.hidden = false;
});
document.getElementById("preview-cancel").addEventListener("click", clearPreview);

function openLightbox(src) {
  const box = document.createElement("div");
  box.className = "lightbox";
  const img = document.createElement("img");
  img.src = src;
  box.append(img);
  box.addEventListener("click", () => box.remove());
  document.body.append(box);
}

// Shared cover photo: stored in app_settings, synced to everyone in realtime.
function applyCover(path) {
  if (path) messagesArea.style.setProperty("--chat-background-image", 'url("' + imageUrl(path) + '")');
  else messagesArea.style.removeProperty("--chat-background-image");
}
async function loadCover() {
  const { data } = await sb.from("app_settings").select("cover_path").eq("id", 1).maybeSingle();
  applyCover(data && data.cover_path);
}
function listenForCover() {
  coverChannel = sb
    .channel("app-settings")
    .on("postgres_changes", { event: "UPDATE", schema: "public", table: "app_settings" },
      (payload) => applyCover(payload.new.cover_path))
    .subscribe();
}
async function saveCover(path) {
  const { error } = await sb.from("app_settings")
    .update({ cover_path: path, updated_by: currentUser.id, updated_at: new Date().toISOString() })
    .eq("id", 1);
  if (error) throw error;
  applyCover(path);
}
backgroundPicker.addEventListener("change", async () => {
  const file = backgroundPicker.files[0];
  backgroundPicker.value = "";
  if (!file) return;
  const problem = checkImage(file);
  if (problem) return alert(problem);
  try { await saveCover(await uploadImage(file, "covers")); }
  catch (e) { alert("Could not change the cover: " + e.message); }
});
document.getElementById("clear-background").addEventListener("click", () =>
  saveCover(null).catch((e) => alert("Could not reset the cover: " + e.message)));

// Typing indicator (broadcast only, nothing is saved)
const typingEl = document.getElementById("typing-indicator");
const typers = new Map();
let lastTyped = 0;
function startTyping() {
  typingChannel = sb.channel("typing")
    .on("broadcast", { event: "typing" }, ({ payload }) => {
      if (!currentUser || payload.id === currentUser.id) return;
      const old = typers.get(payload.id);
      if (old) clearTimeout(old.t);
      typers.set(payload.id, { name: payload.name, t: setTimeout(() => { typers.delete(payload.id); renderTyping(); }, 3000) });
      renderTyping();
    })
    .subscribe();
}
function renderTyping() {
  const n = [...typers.values()].map((v) => v.name);
  typingEl.textContent = n.length ? n.join(", ") + (n.length > 1 ? " are" : " is") + " typing..." : "";
}
messageInput.addEventListener("input", () => {
  if (!typingChannel || Date.now() - lastTyped < 1500) return;
  lastTyped = Date.now();
  typingChannel.send({ type: "broadcast", event: "typing",
    payload: { id: currentUser.id, name: names[currentUser.id] || "Someone" } });
});

// Screenshot shield (best effort only: browsers cannot truly block screenshots)
const shield = () => chatScreen.classList.add("shielded");
const unshield = () => chatScreen.classList.remove("shielded");
document.addEventListener("visibilitychange", () => (document.hidden ? shield() : unshield()));
window.addEventListener("blur", shield);
window.addEventListener("focus", unshield);
document.addEventListener("keyup", (e) => {
  if (e.key === "PrintScreen") {
    shield();
    try { navigator.clipboard.writeText(" "); } catch (_) {}
    setTimeout(unshield, 1500);
  }
});
document.addEventListener("contextmenu", (e) => { if (chatScreen.contains(e.target)) e.preventDefault(); });

emojiToggle?.addEventListener("click", () => {
  const opening = emojiPicker.hidden;
  emojiPicker.hidden = !opening;
  emojiToggle.setAttribute("aria-expanded", String(opening));
});

document.querySelectorAll(".emoji-choice").forEach((button) => {
  button.addEventListener("click", () => {
    const emoji = button.textContent.trim();
    const start = messageInput.selectionStart ?? messageInput.value.length;
    const end = messageInput.selectionEnd ?? messageInput.value.length;
    messageInput.value = messageInput.value.slice(0, start) + emoji + messageInput.value.slice(end);
    messageInput.focus();
    const cursor = start + emoji.length;
    messageInput.setSelectionRange(cursor, cursor);
  });
});

// --------- 14. Liptus: draggable, touch-friendly pet cat ---------
const liptus = document.getElementById("liptus");
const liptusStage = document.getElementById("liptus-stage");
let liptusDragging = false;
let liptusMoved = false;
let liptusStartX = 0;
let liptusStartY = 0;
let liptusLeft = 12;
let liptusTop = 8;
let liptusPointerOffsetX = 0;
let liptusPointerOffsetY = 0;

function placeLiptus(left, top) {
  if (!liptusStage || !liptus || !liptus.offsetWidth) return;
  const maxLeft = Math.max(0, liptusStage.clientWidth - liptus.offsetWidth);
  const maxTop = Math.max(0, liptusStage.clientHeight - liptus.offsetHeight);
  liptusLeft = Math.min(maxLeft, Math.max(0, left));
  liptusTop = Math.min(maxTop, Math.max(0, top));
  liptus.style.left = `${liptusLeft}px`;
  liptus.style.top = `${liptusTop}px`;
  try {
    localStorage.setItem("liptus-pos", JSON.stringify([liptusLeft / Math.max(1, maxLeft), liptusTop / Math.max(1, maxTop)]));
  } catch (e) {}
}

liptus?.addEventListener("pointerdown", (event) => {
  if (event.button !== undefined && event.button !== 0) return;
  liptusDragging = true;
  liptusMoved = false;
  const rect = liptus.getBoundingClientRect();
  const stageRect = liptusStage.getBoundingClientRect();
  liptusPointerOffsetX = event.clientX - rect.left;
  liptusPointerOffsetY = event.clientY - rect.top;
  liptusStartX = event.clientX;
  liptusStartY = event.clientY;
  liptus.setPointerCapture?.(event.pointerId);
  liptus.classList.add("being-dragged");
  event.preventDefault();
});

liptus?.addEventListener("pointermove", (event) => {
  if (!liptusDragging) return;
  if (Math.abs(event.clientX - liptusStartX) + Math.abs(event.clientY - liptusStartY) > 5) {
    liptusMoved = true;
  }
  const stageRect = liptusStage.getBoundingClientRect();
  placeLiptus(
    event.clientX - stageRect.left - liptusPointerOffsetX,
    event.clientY - stageRect.top - liptusPointerOffsetY
  );
});

function finishLiptusDrag() {
  if (!liptusDragging) return;
  liptusDragging = false;
  liptus.classList.remove("being-dragged");
  if (!liptusMoved) {
    liptus.classList.add("purring");
    liptus.querySelector(".liptus-hint").textContent = "purr~ 💕";
    window.setTimeout(() => {
      liptus.classList.remove("purring");
      liptus.querySelector(".liptus-hint").textContent = "pet me!";
    }, 1100);
  }
}
liptus?.addEventListener("pointerup", finishLiptusDrag);
liptus?.addEventListener("pointercancel", finishLiptusDrag);
liptus?.addEventListener("lostpointercapture", finishLiptusDrag);
liptus?.addEventListener("keydown", (event) => {
  if (event.key === "Enter" || event.key === " ") {
    event.preventDefault();
    liptus.classList.add("purring");
    liptus.querySelector(".liptus-hint").textContent = "purr~ 💕";
    window.setTimeout(() => {
      liptus.classList.remove("purring");
      liptus.querySelector(".liptus-hint").textContent = "pet me!";
    }, 1100);
  }
});
window.addEventListener("resize", () => placeLiptus(liptusLeft, liptusTop));

function restoreLiptus() {
  try {
    const p = JSON.parse(localStorage.getItem("liptus-pos") || "null");
    if (!p) return;
    placeLiptus(p[0] * (liptusStage.clientWidth - liptus.offsetWidth), p[1] * (liptusStage.clientHeight - liptus.offsetHeight));
  } catch (e) {}
}
function petReact() {
  const hint = liptus.querySelector(".liptus-hint");
  liptus.classList.add("purring");
  hint.textContent = "new message!";
  window.setTimeout(() => { liptus.classList.remove("purring"); hint.textContent = "pet me!"; }, 1100);
}
