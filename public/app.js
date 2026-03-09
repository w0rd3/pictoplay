(() => {
  // State
  let ws = null;
  let myId = null;
  let hostId = null;
  let gameKey = "";
  let isDrawer = false;
  let drawing = false;
  let currentColor = "#000000";
  let currentWidth = 4;
  let currentStroke = [];
  let hasGuessedCorrectly = false;
  let selectedRating = "pg";

  const RATING_LABELS = {
    pg: "PG",
    pg13: "PG-13",
    r: "R",
  };

  const RATING_DESCS = {
    pg: "Family-friendly fun — absurd and silly prompts",
    pg13: "Mildly spicy — embarrassing moments and innuendo",
    r: "Adults only — raunchy, crude, and unhinged",
  };

  // Elements
  const $ = (sel) => document.querySelector(sel);
  const screens = {
    lobby: $("#screen-lobby"),
    waiting: $("#screen-waiting"),
    game: $("#screen-game"),
  };

  // Screen management
  function showScreen(name) {
    Object.values(screens).forEach((s) => s.classList.remove("active"));
    screens[name].classList.add("active");
    if (name === "game") {
      // Defer canvas resize to next frame so browser has laid out the screen
      requestAnimationFrame(() => {
        resizeCanvas();
        clearCanvas();
      });
    }
  }

  // Generate random game key
  function generateKey() {
    const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
    let key = "";
    for (let i = 0; i < 5; i++) key += chars[Math.floor(Math.random() * chars.length)];
    return key;
  }

  // WebSocket connection
  function connect(key, name) {
    gameKey = key.toUpperCase();
    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    ws = new WebSocket(`${proto}//${location.host}/api/ws?key=${gameKey}`);

    ws.onopen = () => {
      ws.send(JSON.stringify({ type: "join", name }));
    };

    ws.onmessage = (e) => {
      const data = JSON.parse(e.data);
      handleMessage(data);
    };

    ws.onclose = () => {
      showScreen("lobby");
      $("#lobby-error").textContent = "Disconnected from server";
    };

    ws.onerror = () => {
      $("#lobby-error").textContent = "Connection failed";
    };
  }

  // Message handler
  function handleMessage(data) {
    switch (data.type) {
      case "joined":
        myId = data.playerId;
        hostId = data.hostId;
        $("#display-key").textContent = gameKey;
        if (data.rating) updateRatingBadge(data.rating);
        showScreen("waiting");
        break;

      case "rating":
        selectedRating = data.rating;
        updateRatingBadge(data.rating);
        break;

      case "players":
        hostId = data.hostId;
        updatePlayerList(data.players);
        updateScores(data.players);
        break;

      case "phase":
        handlePhase(data);
        break;

      case "word":
        // Only drawer receives this
        $("#word-display").textContent = data.word;
        $("#word-display").classList.add("drawer-prompt");
        break;

      case "draw":
        drawStroke(data.stroke);
        break;

      case "strokes":
        // Full stroke sync (for late joiners)
        data.strokes.forEach((s) => drawStroke(s));
        break;

      case "clear":
        clearCanvas();
        break;

      case "tick":
        updateTimer(data.timeLeft);
        if (data.hint) updateHint(data.hint);
        break;

      case "chat":
        addChatMsg(data.name, data.text, data.close ? "close" : "");
        break;

      case "correct":
        addChatMsg(data.playerName, "guessed correctly!", "correct");
        if (data.playerId === myId) {
          hasGuessedCorrectly = true;
          $("#guess-input").disabled = true;
          $("#guess-input").placeholder = "You got it!";
        }
        break;

      case "reveal":
        showReveal(data.word);
        break;

      case "gameover":
        showGameOver(data.scores);
        break;

      case "error":
        if (screens.lobby.classList.contains("active")) {
          $("#lobby-error").textContent = data.message;
        } else if (screens.waiting.classList.contains("active")) {
          const msg = $("#waiting-msg");
          msg.textContent = data.message;
          msg.style.display = "block";
          msg.classList.add("error-text");
          setTimeout(() => msg.classList.remove("error-text"), 3000);
        }
        break;
    }
  }

  function handlePhase(data) {
    showScreen("game");
    isDrawer = data.drawer === myId;
    hasGuessedCorrectly = false;

    // Update header
    $("#round-display").textContent = `Round ${data.round}/${data.maxRounds}`;
    updateTimer(data.timeLeft);

    if (data.phase === "drawing") {
      clearCanvas();

      // Both drawer and guessers see the chat log
      $("#guess-area").classList.remove("hidden");

      if (isDrawer) {
        $("#draw-tools").classList.remove("hidden");
        $("#word-display").textContent = "";
        $("#word-display").classList.add("drawer-prompt");
        // Drawer sees chat but can't type guesses
        $("#guess-input").disabled = true;
        $("#guess-input").placeholder = "";
        $(".guess-input-row").classList.add("hidden");
        enableDrawing();
      } else {
        $("#draw-tools").classList.add("hidden");
        $("#guess-input").disabled = false;
        $("#guess-input").placeholder = "Type your guess...";
        $(".guess-input-row").classList.remove("hidden");
        $("#word-display").classList.remove("drawer-prompt");
        updateHint(data.hint);
        disableDrawing();
      }

      // Clear chat
      $("#chat-log").innerHTML = "";
      addChatMsg(data.drawerName, "is drawing!", "system");

      // Hide overlays
      $("#overlay-reveal").classList.add("hidden");
      $("#overlay-gameover").classList.add("hidden");
    }
  }

  function updateHint(hint) {
    if (!isDrawer) {
      // Group by words: "_____ _ ___" -> "_ _ _ _ _   _   _ _ _"
      const display = hint
        .split("")
        .map((c) => (c === " " ? "  " : c))
        .join(" ");
      $("#word-display").textContent = display;
    }
  }

  function updateTimer(t) {
    const el = $("#timer-display");
    el.textContent = t;
    el.className = "timer";
    if (t <= 10) el.classList.add("danger");
    else if (t <= 30) el.classList.add("warning");
  }

  function updatePlayerList(players) {
    const ul = $("#player-list");
    ul.innerHTML = "";
    players.forEach((p) => {
      const li = document.createElement("li");
      const nameSpan = document.createElement("span");
      nameSpan.textContent = p.name;
      li.appendChild(nameSpan);

      const badges = document.createElement("span");
      if (p.isHost) {
        const b = document.createElement("span");
        b.className = "host-badge";
        b.textContent = "HOST";
        badges.appendChild(b);
      }
      if (p.id === myId) {
        const b = document.createElement("span");
        b.className = "you-badge";
        b.textContent = "YOU";
        badges.appendChild(b);
      }
      li.appendChild(badges);
      ul.appendChild(li);
    });

    // Show start button and rating picker if host, badge if not
    const amHost = myId === hostId;
    $("#btn-start").style.display = amHost ? "block" : "none";
    $("#waiting-msg").style.display = amHost ? "none" : "block";
    $("#waiting-rating-picker").style.display = amHost ? "block" : "none";
    $("#rating-badge").style.display = amHost ? "none" : "inline-block";

    // Sync waiting room rating picker with current selection
    if (amHost) {
      document.querySelectorAll(".waiting-rating-btn").forEach((b) => {
        b.classList.toggle("active", b.dataset.rating === selectedRating);
      });
    }
  }

  function updateScores(players) {
    const ul = $("#game-scores");
    if (!ul) return;
    ul.innerHTML = "";
    const sorted = [...players].sort((a, b) => b.score - a.score);
    sorted.forEach((p) => {
      const li = document.createElement("li");
      if (p.isDrawing) li.className = "drawing";
      const name = document.createElement("span");
      name.textContent = p.name + (p.id === myId ? " (you)" : "");
      const score = document.createElement("span");
      score.className = "score";
      score.textContent = p.score;
      li.appendChild(name);
      li.appendChild(score);
      ul.appendChild(li);
    });
  }

  function addChatMsg(name, text, cls = "") {
    const log = $("#chat-log");
    const div = document.createElement("div");
    div.className = "chat-msg " + cls;
    div.innerHTML = `<span class="name">${escHtml(name)}</span> ${escHtml(text)}`;
    log.appendChild(div);
    log.scrollTop = log.scrollHeight;
  }

  function updateRatingBadge(rating) {
    const badge = $("#rating-badge");
    badge.textContent = RATING_LABELS[rating] || "PG";
    badge.className = "rating-badge";
    if (rating === "pg13") badge.classList.add("pg13");
    else if (rating === "r") badge.classList.add("r");
  }

  function escHtml(s) {
    const d = document.createElement("div");
    d.textContent = s;
    return d.innerHTML;
  }

  function showReveal(word) {
    const el = $("#overlay-reveal");
    $("#reveal-word").textContent = word;
    el.classList.remove("hidden");
    setTimeout(() => el.classList.add("hidden"), 4500);
  }

  function showGameOver(scores) {
    const el = $("#overlay-gameover");
    const ol = $("#final-scores");
    ol.innerHTML = "";
    scores.forEach((s, i) => {
      const li = document.createElement("li");
      const name = document.createElement("span");
      name.textContent = `${i + 1}. ${s.name}`;
      const score = document.createElement("span");
      score.className = "score";
      score.textContent = s.score;
      li.appendChild(name);
      li.appendChild(score);
      ol.appendChild(li);
    });
    el.classList.remove("hidden");
  }

  // Canvas drawing
  const canvas = $("#draw-canvas");
  const ctx = canvas.getContext("2d");
  let canvasDrawingEnabled = false;

  function resizeCanvas() {
    const wrapper = $(".canvas-wrapper");
    const rect = wrapper.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;

    // Save current drawing
    const imageData = canvas.width > 0 ? ctx.getImageData(0, 0, canvas.width, canvas.height) : null;
    const oldW = canvas.width;
    const oldH = canvas.height;

    canvas.width = rect.width * dpr;
    canvas.height = rect.height * dpr;
    canvas.style.width = rect.width + "px";
    canvas.style.height = rect.height + "px";
    ctx.scale(dpr, dpr);

    // Restore if dimensions didn't change much
    if (imageData && oldW === canvas.width && oldH === canvas.height) {
      ctx.putImageData(imageData, 0, 0);
    }

    ctx.lineCap = "round";
    ctx.lineJoin = "round";
  }

  function clearCanvas() {
    const wrapper = $(".canvas-wrapper");
    const rect = wrapper.getBoundingClientRect();
    ctx.clearRect(0, 0, rect.width, rect.height);
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, rect.width, rect.height);
  }

  function getCanvasPos(e) {
    const rect = canvas.getBoundingClientRect();
    const touch = e.touches ? e.touches[0] : e;
    return {
      x: (touch.clientX - rect.left) / rect.width,
      y: (touch.clientY - rect.top) / rect.height,
    };
  }

  function canvasToReal(p) {
    const rect = canvas.getBoundingClientRect();
    return { x: p.x * rect.width, y: p.y * rect.height };
  }

  function drawStroke(stroke) {
    if (!stroke.points || stroke.points.length === 0) return;
    const rect = canvas.getBoundingClientRect();

    ctx.strokeStyle = stroke.color || "#000000";
    ctx.lineWidth = stroke.width || 4;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.beginPath();

    const first = stroke.points[0];
    ctx.moveTo(first.x * rect.width, first.y * rect.height);

    for (let i = 1; i < stroke.points.length; i++) {
      const p = stroke.points[i];
      ctx.lineTo(p.x * rect.width, p.y * rect.height);
    }

    if (stroke.points.length === 1) {
      // Single point - draw a dot
      ctx.lineTo(first.x * rect.width + 0.1, first.y * rect.height + 0.1);
    }

    ctx.stroke();
  }

  function enableDrawing() {
    canvasDrawingEnabled = true;
  }

  function disableDrawing() {
    canvasDrawingEnabled = false;
  }

  function onPointerDown(e) {
    if (!canvasDrawingEnabled) return;
    e.preventDefault();
    drawing = true;
    currentStroke = [];
    const pos = getCanvasPos(e);
    currentStroke.push(pos);

    const real = canvasToReal(pos);
    ctx.strokeStyle = currentColor;
    ctx.lineWidth = currentWidth;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.beginPath();
    ctx.moveTo(real.x, real.y);
  }

  function onPointerMove(e) {
    if (!drawing) return;
    e.preventDefault();
    const pos = getCanvasPos(e);
    currentStroke.push(pos);

    const real = canvasToReal(pos);
    ctx.lineTo(real.x, real.y);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(real.x, real.y);
  }

  function onPointerUp(e) {
    if (!drawing) return;
    e.preventDefault();
    drawing = false;

    if (currentStroke.length > 0) {
      // Send stroke to server
      ws.send(JSON.stringify({
        type: "draw",
        points: currentStroke,
        color: currentColor,
        width: currentWidth,
      }));
    }
    currentStroke = [];
  }

  // Touch events
  canvas.addEventListener("touchstart", onPointerDown, { passive: false });
  canvas.addEventListener("touchmove", onPointerMove, { passive: false });
  canvas.addEventListener("touchend", onPointerUp, { passive: false });
  canvas.addEventListener("touchcancel", onPointerUp, { passive: false });

  // Mouse fallback
  canvas.addEventListener("mousedown", onPointerDown);
  canvas.addEventListener("mousemove", onPointerMove);
  canvas.addEventListener("mouseup", onPointerUp);
  canvas.addEventListener("mouseleave", onPointerUp);

  // Prevent scrolling/zooming while drawing
  document.addEventListener("touchmove", (e) => {
    if (drawing) e.preventDefault();
  }, { passive: false });

  // Window resize
  window.addEventListener("resize", () => {
    if (screens.game.classList.contains("active")) {
      resizeCanvas();
    }
  });

  // Lobby rating picker
  document.querySelectorAll("#screen-lobby .rating-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.querySelectorAll("#screen-lobby .rating-btn").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      selectedRating = btn.dataset.rating;
      $("#rating-desc").textContent = RATING_DESCS[selectedRating];
    });
  });

  // Waiting room rating picker (host only)
  document.querySelectorAll(".waiting-rating-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".waiting-rating-btn").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      selectedRating = btn.dataset.rating;
    });
  });

  // UI Event listeners
  $("#btn-create").addEventListener("click", () => {
    const name = $("#player-name").value.trim();
    if (!name) {
      $("#lobby-error").textContent = "Enter your name";
      return;
    }
    gameKey = generateKey();
    connect(gameKey, name);
  });

  $("#btn-join").addEventListener("click", () => {
    const name = $("#player-name").value.trim();
    const key = $("#game-key").value.trim().toUpperCase();
    if (!name) {
      $("#lobby-error").textContent = "Enter your name";
      return;
    }
    if (!key) {
      $("#lobby-error").textContent = "Enter a game key";
      return;
    }
    connect(key, name);
  });

  $("#btn-copy-key").addEventListener("click", () => {
    navigator.clipboard.writeText(gameKey).then(() => {
      $("#btn-copy-key").textContent = "Copied!";
      setTimeout(() => ($("#btn-copy-key").textContent = "Copy"), 1500);
    });
  });

  $("#btn-start").addEventListener("click", () => {
    ws.send(JSON.stringify({ type: "start", rating: selectedRating }));
  });

  // Color picker
  document.querySelectorAll(".color-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".color-btn").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      currentColor = btn.dataset.color;
    });
  });

  // Brush size
  $("#brush-size").addEventListener("input", (e) => {
    currentWidth = parseInt(e.target.value);
  });

  // Clear canvas
  $("#btn-clear").addEventListener("click", () => {
    clearCanvas();
    ws.send(JSON.stringify({ type: "clear" }));
  });

  // Guess input
  function submitGuess() {
    const input = $("#guess-input");
    const text = input.value.trim();
    if (!text) return;
    ws.send(JSON.stringify({ type: "guess", text }));
    input.value = "";
  }

  $("#btn-guess").addEventListener("click", submitGuess);
  $("#guess-input").addEventListener("keydown", (e) => {
    if (e.key === "Enter") submitGuess();
  });

  // Play again
  $("#btn-play-again").addEventListener("click", () => {
    $("#overlay-gameover").classList.add("hidden");
    showScreen("waiting");
    updatePlayerList([]);
  });

  // Enter key in lobby
  $("#game-key").addEventListener("keydown", (e) => {
    if (e.key === "Enter") $("#btn-join").click();
  });
  $("#player-name").addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      if ($("#game-key").value.trim()) {
        $("#btn-join").click();
      } else {
        $("#game-key").focus();
      }
    }
  });
})();
