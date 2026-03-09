import { PROMPTS } from "./prompts.js";

const ROUND_TIME = 90;
const MAX_ROUNDS = 3;
const HINT_INTERVAL = 20;

export class GameRoom {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.initialized = false;
  }

  // Rebuild in-memory state from storage + live WebSockets
  async ensureLoaded() {
    if (this.initialized) return;
    this.initialized = true;

    const stored = await this.state.storage.get("gameState");
    if (stored) {
      this.gameState = stored;
    } else {
      this.gameState = {
        players: {},       // { [playerId]: { name, score } }
        phase: "lobby",
        hostId: null,
        currentDrawer: null,
        currentWord: null,
        drawOrder: [],
        drawOrderIndex: 0,
        roundNumber: 0,
        guessedCorrectly: [],
        strokes: [],
        timeLeft: 0,
        usedWords: [],
        hints: [],
        rating: "pg",
      };
    }

    // Rebuild sockets map from hibernated WebSockets
    this.sockets = new Map();
    for (const ws of this.state.getWebSockets()) {
      const attachment = ws.deserializeAttachment();
      if (attachment && attachment.playerId) {
        this.sockets.set(attachment.playerId, ws);
      }
    }

    // Clean up players whose sockets are gone
    for (const id of Object.keys(this.gameState.players)) {
      if (!this.sockets.has(id)) {
        delete this.gameState.players[id];
      }
    }

    // Fix host if needed
    if (!this.gameState.hostId || !this.sockets.has(this.gameState.hostId)) {
      this.gameState.hostId = this.sockets.keys().next().value || null;
    }
  }

  async saveState() {
    await this.state.storage.put("gameState", this.gameState);
  }

  async fetch(request) {
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);

    const playerId = crypto.randomUUID().slice(0, 8);
    this.state.acceptWebSocket(server);
    server.serializeAttachment({ playerId });

    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws, message) {
    await this.ensureLoaded();

    let data;
    try {
      data = JSON.parse(message);
    } catch {
      return;
    }

    const { playerId } = ws.deserializeAttachment();

    switch (data.type) {
      case "join":
        await this.handleJoin(ws, playerId, data);
        break;
      case "start":
        await this.handleStart(playerId, data);
        break;
      case "draw":
        this.handleDraw(playerId, data);
        break;
      case "clear":
        this.handleClear(playerId);
        break;
      case "guess":
        await this.handleGuess(playerId, data);
        break;
    }
  }

  async webSocketClose(ws) {
    await this.ensureLoaded();
    const { playerId } = ws.deserializeAttachment();
    await this.handleDisconnect(playerId);
  }

  async webSocketError(ws) {
    await this.ensureLoaded();
    const { playerId } = ws.deserializeAttachment();
    await this.handleDisconnect(playerId);
  }

  async handleJoin(ws, playerId, data) {
    const gs = this.gameState;
    const name = (data.name || "Player").slice(0, 16).trim();

    gs.players[playerId] = { name, score: 0 };
    this.sockets.set(playerId, ws);

    if (!gs.hostId || !this.sockets.has(gs.hostId)) {
      gs.hostId = playerId;
    }

    this.send(ws, { type: "joined", playerId, hostId: gs.hostId, rating: gs.rating });

    // Send current game state to new player
    if (gs.phase !== "lobby") {
      this.send(ws, {
        type: "phase",
        phase: gs.phase,
        drawer: gs.currentDrawer,
        drawerName: gs.players[gs.currentDrawer]?.name,
        wordLength: gs.currentWord?.length,
        timeLeft: gs.timeLeft,
        round: gs.roundNumber,
        maxRounds: MAX_ROUNDS,
        hint: gs.hints.join(""),
      });
      if (gs.strokes.length > 0) {
        this.send(ws, { type: "strokes", strokes: gs.strokes });
      }
      if (playerId === gs.currentDrawer) {
        this.send(ws, { type: "word", word: gs.currentWord });
      }
    }

    this.broadcastPlayers();
    await this.saveState();
  }

  async handleStart(playerId, data) {
    const gs = this.gameState;
    if (playerId !== gs.hostId) return;
    if (gs.phase !== "lobby") return;

    const playerCount = Object.keys(gs.players).length;
    if (playerCount < 2) {
      const ws = this.sockets.get(playerId);
      if (ws) this.send(ws, { type: "error", message: "Need at least 2 players" });
      return;
    }

    const rating = (data.rating || "pg").toLowerCase();
    if (PROMPTS[rating]) {
      gs.rating = rating;
    }

    gs.drawOrder = Object.keys(gs.players);
    this.shuffleArray(gs.drawOrder);
    gs.drawOrderIndex = 0;
    gs.roundNumber = 1;
    gs.usedWords = [];

    this.broadcast({ type: "rating", rating: gs.rating });

    await this.startTurn();
  }

  async startTurn() {
    const gs = this.gameState;

    const activePlayers = gs.drawOrder.filter((id) => this.sockets.has(id));
    if (activePlayers.length < 2) {
      await this.endGame();
      return;
    }

    gs.currentDrawer = activePlayers[gs.drawOrderIndex % activePlayers.length];
    gs.drawOrderIndex++;

    if (gs.drawOrderIndex > 0 && gs.drawOrderIndex % activePlayers.length === 0) {
      gs.roundNumber++;
      if (gs.roundNumber > MAX_ROUNDS) {
        await this.endGame();
        return;
      }
    }

    const pool = PROMPTS[gs.rating] || PROMPTS.pg;
    const usedSet = new Set(gs.usedWords);
    const available = pool.filter((w) => !usedSet.has(w));
    if (available.length === 0) gs.usedWords = [];
    const wordList = available.length > 0 ? available : pool;
    gs.currentWord = wordList[Math.floor(Math.random() * wordList.length)];
    gs.usedWords.push(gs.currentWord);

    gs.guessedCorrectly = [];
    gs.strokes = [];
    gs.phase = "drawing";
    gs.timeLeft = ROUND_TIME;
    gs.hints = gs.currentWord.split("").map((c) => (c === " " ? " " : "_"));

    this.broadcast({
      type: "phase",
      phase: "drawing",
      drawer: gs.currentDrawer,
      drawerName: gs.players[gs.currentDrawer]?.name,
      wordLength: gs.currentWord.length,
      timeLeft: gs.timeLeft,
      round: gs.roundNumber,
      maxRounds: MAX_ROUNDS,
      hint: gs.hints.join(""),
    });

    const drawerWs = this.sockets.get(gs.currentDrawer);
    if (drawerWs) this.send(drawerWs, { type: "word", word: gs.currentWord });

    this.broadcastPlayers();
    await this.saveState();
    await this.scheduleAlarm();
  }

  async scheduleAlarm() {
    await this.state.storage.setAlarm(Date.now() + 1000);
  }

  async alarm() {
    await this.ensureLoaded();
    const gs = this.gameState;

    if (gs.phase === "between") {
      await this.startTurn();
      return;
    }

    if (gs.phase !== "drawing") return;

    gs.timeLeft--;

    if (gs.timeLeft > 0 && gs.timeLeft % HINT_INTERVAL === 0) {
      this.revealHintLetter();
    }

    this.broadcast({ type: "tick", timeLeft: gs.timeLeft, hint: gs.hints.join("") });

    if (gs.timeLeft <= 0) {
      await this.endTurn();
    } else {
      await this.saveState();
      await this.scheduleAlarm();
    }
  }

  revealHintLetter() {
    const gs = this.gameState;
    const hidden = [];
    for (let i = 0; i < gs.hints.length; i++) {
      if (gs.hints[i] === "_") hidden.push(i);
    }
    if (hidden.length <= 1) return;
    const idx = hidden[Math.floor(Math.random() * hidden.length)];
    gs.hints[idx] = gs.currentWord[idx];
  }

  handleDraw(playerId, data) {
    const gs = this.gameState;
    if (gs.phase !== "drawing" || playerId !== gs.currentDrawer) return;

    const stroke = {
      points: data.points,
      color: data.color,
      width: data.width,
    };
    gs.strokes.push(stroke);

    this.broadcast({ type: "draw", stroke }, playerId);
    // Don't await saveState for draw — too frequent, strokes are transient
  }

  handleClear(playerId) {
    const gs = this.gameState;
    if (gs.phase !== "drawing" || playerId !== gs.currentDrawer) return;
    gs.strokes = [];
    this.broadcast({ type: "clear" }, playerId);
  }

  async handleGuess(playerId, data) {
    const gs = this.gameState;
    if (gs.phase !== "drawing") return;
    if (playerId === gs.currentDrawer) return;
    if (gs.guessedCorrectly.includes(playerId)) return;

    const guess = (data.text || "").trim().toLowerCase();
    if (!guess) return;

    const player = gs.players[playerId];
    if (!player) return;

    if (guess === gs.currentWord.toLowerCase()) {
      gs.guessedCorrectly.push(playerId);

      const timeBonus = Math.ceil((gs.timeLeft / ROUND_TIME) * 400);
      player.score += 100 + timeBonus;

      const drawer = gs.players[gs.currentDrawer];
      if (drawer) drawer.score += 50;

      this.broadcast({ type: "correct", playerId, playerName: player.name });
      this.broadcastPlayers();

      const nonDrawers = Object.keys(gs.players).filter(
        (id) => id !== gs.currentDrawer && this.sockets.has(id)
      );
      if (nonDrawers.every((id) => gs.guessedCorrectly.includes(id))) {
        await this.endTurn();
        return;
      }

      await this.saveState();
    } else {
      const isClose = this.isCloseGuess(guess, gs.currentWord.toLowerCase());
      this.broadcast({
        type: "chat",
        playerId,
        name: player.name,
        text: guess,
        close: isClose,
      });
    }
  }

  isCloseGuess(guess, word) {
    if (Math.abs(guess.length - word.length) > 1) return false;
    let diff = 0;
    const maxLen = Math.max(guess.length, word.length);
    for (let i = 0; i < maxLen; i++) {
      if (guess[i] !== word[i]) diff++;
      if (diff > 2) return false;
    }
    return diff <= 2 && diff > 0;
  }

  async endTurn() {
    const gs = this.gameState;
    gs.phase = "between";
    this.broadcast({ type: "reveal", word: gs.currentWord });
    this.broadcastPlayers();

    await this.saveState();
    await this.state.storage.setAlarm(Date.now() + 5000);
  }

  async endGame() {
    const gs = this.gameState;
    gs.phase = "lobby";

    const scores = Object.entries(gs.players)
      .map(([id, p]) => ({ id, name: p.name, score: p.score }))
      .sort((a, b) => b.score - a.score);

    this.broadcast({ type: "gameover", scores });

    for (const id of Object.keys(gs.players)) {
      gs.players[id].score = 0;
    }
    this.broadcastPlayers();
    await this.saveState();
  }

  async handleDisconnect(playerId) {
    const gs = this.gameState;
    this.sockets.delete(playerId);
    delete gs.players[playerId];

    if (playerId === gs.hostId) {
      gs.hostId = this.sockets.keys().next().value || null;
    }

    this.broadcastPlayers();

    if (gs.phase === "drawing" && playerId === gs.currentDrawer) {
      await this.endTurn();
      return;
    }

    if (gs.phase !== "lobby" && this.sockets.size < 2) {
      await this.endGame();
      return;
    }

    await this.saveState();
  }

  send(ws, data) {
    try {
      ws.send(JSON.stringify(data));
    } catch {}
  }

  broadcast(data, excludeId) {
    const msg = JSON.stringify(data);
    for (const [id, ws] of this.sockets) {
      if (id === excludeId) continue;
      try {
        ws.send(msg);
      } catch {}
    }
  }

  broadcastPlayers() {
    const gs = this.gameState;
    const players = Object.entries(gs.players).map(([id, p]) => ({
      id,
      name: p.name,
      score: p.score,
      isHost: id === gs.hostId,
      isDrawing: id === gs.currentDrawer && gs.phase === "drawing",
      connected: this.sockets.has(id),
    }));
    this.broadcast({ type: "players", players, hostId: gs.hostId });
  }

  shuffleArray(arr) {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
  }
}
