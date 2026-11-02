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
  who.textContent = "Loading...";
  
  await loadNames();
  who.textContent = names[user.id] || "Signed in";
  await loadMessages();
  listenForNewMessages();
  startPresence(user);
  messageInput.focus();
}

function stopChat() {
  currentUser = null;
  stopPresence();
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

  item.append(author, text, time);
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

// --------- 8. Send a message to the database (INSERT) ---------
messageForm.addEventListener("submit", async (event) => {
  event.preventDefault();

  const content = messageInput.value.trim();
  if (content === "") return;
  messageInput.value = "";

  //Commands such as /weather stay on your screen. They  are not saved.
  if (content.startsWith("/")) {
    handleCommand(content);
    return;
  }
  
  // We send ONLY the text. The database fills in who sent it.
  const { data, error } = await sb
    .from("messages")
    .insert({ content: content })
    .select()
    .single();

  if (error) {
    alert("Could not send: " + error.message);
    messageInput.value = content;
    return;
  }
  showMessage(data);
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
    .select("id, user_id, content, created_at")
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

// --------- 13. Chat background picker (local to each device/browser) ---------
const backgroundPicker = document.getElementById("background-picker");
const clearBackgroundBtn = document.getElementById("clear-background");
const messagesArea = document.getElementById("messages");
const emojiToggle = document.getElementById("emoji-toggle");
const emojiPicker = document.getElementById("emoji-picker");

// Use a data URL so the selected image stays on this device and is not uploaded
// to Supabase. Each friend can choose their own background.
try {
  const savedBackground = localStorage.getItem("mengorio-chat-background");
  if (savedBackground) messagesArea.style.setProperty("--chat-background-image", `url("${savedBackground}")`);
} catch (error) {
  console.info("Background preference storage is unavailable in this browser.");
}

backgroundPicker?.addEventListener("change", () => {
  const file = backgroundPicker.files?.[0];
  if (!file) return;
  if (!file.type.startsWith("image/")) {
    alert("Please choose an image file.");
    backgroundPicker.value = "";
    return;
  }
  // Keep the upload modest so localStorage limits are less likely to be reached.
  if (file.size > 3 * 1024 * 1024) {
    alert("Please choose an image smaller than 3 MB for the chat background.");
    backgroundPicker.value = "";
    return;
  }
  const reader = new FileReader();
  reader.onload = () => {
    const dataUrl = String(reader.result);
    messagesArea.style.setProperty("--chat-background-image", `url("${dataUrl}")`);
    try {
      localStorage.setItem("mengorio-chat-background", dataUrl);
    } catch (error) {
      alert("The background is set for this session, but this browser could not save it for next time.");
    }
  };
  reader.readAsDataURL(file);
});

clearBackgroundBtn?.addEventListener("click", () => {
  messagesArea.style.removeProperty("--chat-background-image");
  try { localStorage.removeItem("mengorio-chat-background"); } catch (error) {}
  if (backgroundPicker) backgroundPicker.value = "";
});

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
  if (!liptusStage || !liptus) return;
  const maxLeft = Math.max(0, liptusStage.clientWidth - liptus.offsetWidth);
  const maxTop = Math.max(0, liptusStage.clientHeight - liptus.offsetHeight);
  liptusLeft = Math.min(maxLeft, Math.max(0, left));
  liptusTop = Math.min(maxTop, Math.max(0, top));
  liptus.style.left = `${liptusLeft}px`;
  liptus.style.top = `${liptusTop}px`;
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
