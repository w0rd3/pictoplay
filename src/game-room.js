import { PROMPTS } from "./prompts.js";

const ROUND_TIME = 90;
const MAX_ROUNDS = 3;
const HINT_INTERVAL = 20;

export class GameRoom {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.players = new Map();
    this.sockets = new Map();
    this.phase = "lobby";
    this.hostId = null;
    this.currentDrawer = null;
    this.currentWord = null;
    this.drawOrder = [];
    this.drawOrderIndex = 0;
    this.roundNumber = 0;
    this.guessedCorrectly = new Set();
    this.strokes = [];
    this.timer = null;
    this.timeLeft = 0;
    this.usedWords = new Set();
    this.hints = [];
    this.rating = "pg";
  }

  async fetch(request) {
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);

    this.state.acceptWebSocket(server);

    const playerId = crypto.randomUUID().slice(0, 8);
    server.serializeAttachment({ playerId });

    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws, message) {
    let data;
    try {
      data = JSON.parse(message);
    } catch {
      return;
    }

    const { playerId } = ws.deserializeAttachment();

    switch (data.type) {
      case "join":
        this.handleJoin(ws, playerId, data);
        break;
      case "start":
        this.handleStart(playerId, data);
        break;
      case "draw":
        this.handleDraw(playerId, data);
        break;
      case "clear":
        this.handleClear(playerId);
        break;
      case "guess":
        this.handleGuess(playerId, data);
        break;
    }
  }

  async webSocketClose(ws) {
    const { playerId } = ws.deserializeAttachment();
    this.handleDisconnect(playerId);
  }

  async webSocketError(ws) {
    const { playerId } = ws.deserializeAttachment();
    this.handleDisconnect(playerId);
  }

  handleJoin(ws, playerId, data) {
    const name = (data.name || "Player").slice(0, 16).trim();

    this.players.set(playerId, { name, score: 0 });
    this.sockets.set(playerId, ws);

    if (!this.hostId || !this.sockets.has(this.hostId)) {
      this.hostId = playerId;
    }

    this.send(ws, { type: "joined", playerId, hostId: this.hostId, rating: this.rating });

    // Send current game state to new player
    if (this.phase !== "lobby") {
      this.send(ws, {
        type: "phase",
        phase: this.phase,
        drawer: this.currentDrawer,
        drawerName: this.players.get(this.currentDrawer)?.name,
        wordLength: this.currentWord?.length,
        timeLeft: this.timeLeft,
        round: this.roundNumber,
        maxRounds: MAX_ROUNDS,
        hint: this.hints.join(""),
      });
      // Send existing strokes
      if (this.strokes.length > 0) {
        this.send(ws, { type: "strokes", strokes: this.strokes });
      }
      // If this player is the drawer, send the word
      if (playerId === this.currentDrawer) {
        this.send(ws, { type: "word", word: this.currentWord });
      }
    }

    this.broadcastPlayers();
  }

  handleStart(playerId, data) {
    if (playerId !== this.hostId) return;
    if (this.phase !== "lobby") return;
    if (this.players.size < 2) {
      const ws = this.sockets.get(playerId);
      if (ws) this.send(ws, { type: "error", message: "Need at least 2 players" });
      return;
    }

    // Set rating from host selection
    const rating = (data.rating || "pg").toLowerCase();
    if (PROMPTS[rating]) {
      this.rating = rating;
    }

    this.drawOrder = [...this.players.keys()];
    this.shuffleArray(this.drawOrder);
    this.drawOrderIndex = 0;
    this.roundNumber = 1;
    this.usedWords.clear();

    // Broadcast rating to all players
    this.broadcast({ type: "rating", rating: this.rating });

    this.startTurn();
  }

  startTurn() {
    // Pick drawer
    const activePlayers = this.drawOrder.filter((id) => this.sockets.has(id));
    if (activePlayers.length < 2) {
      this.endGame();
      return;
    }

    this.currentDrawer = activePlayers[this.drawOrderIndex % activePlayers.length];
    this.drawOrderIndex++;

    // Check if we've gone through all players (new round)
    if (this.drawOrderIndex > 0 && this.drawOrderIndex % activePlayers.length === 0) {
      this.roundNumber++;
      if (this.roundNumber > MAX_ROUNDS) {
        this.endGame();
        return;
      }
    }

    // Pick prompt from rated pool
    const pool = PROMPTS[this.rating] || PROMPTS.pg;
    const available = pool.filter((w) => !this.usedWords.has(w));
    if (available.length === 0) this.usedWords.clear();
    const wordList = available.length > 0 ? available : pool;
    this.currentWord = wordList[Math.floor(Math.random() * wordList.length)];
    this.usedWords.add(this.currentWord);

    this.guessedCorrectly.clear();
    this.strokes = [];
    this.phase = "drawing";
    this.timeLeft = ROUND_TIME;

    // Build initial hint (all underscores, preserve spaces)
    this.hints = this.currentWord.split("").map((c) => (c === " " ? " " : "_"));

    // Broadcast phase first, then send word to drawer
    this.broadcast({
      type: "phase",
      phase: "drawing",
      drawer: this.currentDrawer,
      drawerName: this.players.get(this.currentDrawer)?.name,
      wordLength: this.currentWord.length,
      timeLeft: this.timeLeft,
      round: this.roundNumber,
      maxRounds: MAX_ROUNDS,
      hint: this.hints.join(""),
    });

    const drawerWs = this.sockets.get(this.currentDrawer);
    if (drawerWs) this.send(drawerWs, { type: "word", word: this.currentWord });

    this.broadcastPlayers();

    // Start timer using alarm
    this.scheduleAlarm();
  }

  async scheduleAlarm() {
    await this.state.storage.setAlarm(Date.now() + 1000);
  }

  async alarm() {
    if (this.phase === "between") {
      this.startTurn();
      return;
    }

    if (this.phase !== "drawing") return;

    this.timeLeft--;

    // Reveal hint letters periodically
    if (this.timeLeft > 0 && this.timeLeft % HINT_INTERVAL === 0) {
      this.revealHintLetter();
    }

    this.broadcast({ type: "tick", timeLeft: this.timeLeft, hint: this.hints.join("") });

    if (this.timeLeft <= 0) {
      this.endTurn();
    } else {
      await this.scheduleAlarm();
    }
  }

  revealHintLetter() {
    const hidden = [];
    for (let i = 0; i < this.hints.length; i++) {
      if (this.hints[i] === "_") hidden.push(i);
    }
    if (hidden.length <= 1) return;
    const idx = hidden[Math.floor(Math.random() * hidden.length)];
    this.hints[idx] = this.currentWord[idx];
  }

  handleDraw(playerId, data) {
    if (this.phase !== "drawing" || playerId !== this.currentDrawer) return;

    const stroke = {
      points: data.points,
      color: data.color,
      width: data.width,
    };
    this.strokes.push(stroke);

    this.broadcast({ type: "draw", stroke }, playerId);
  }

  handleClear(playerId) {
    if (this.phase !== "drawing" || playerId !== this.currentDrawer) return;
    this.strokes = [];
    this.broadcast({ type: "clear" }, playerId);
  }

  handleGuess(playerId, data) {
    if (this.phase !== "drawing") return;
    if (playerId === this.currentDrawer) return;
    if (this.guessedCorrectly.has(playerId)) return;

    const guess = (data.text || "").trim().toLowerCase();
    if (!guess) return;

    const player = this.players.get(playerId);
    if (!player) return;

    if (guess === this.currentWord.toLowerCase()) {
      this.guessedCorrectly.add(playerId);

      // Score: more points for guessing early
      const timeBonus = Math.ceil((this.timeLeft / ROUND_TIME) * 400);
      player.score += 100 + timeBonus;

      // Drawer also gets points
      const drawer = this.players.get(this.currentDrawer);
      if (drawer) drawer.score += 50;

      this.broadcast({ type: "correct", playerId, playerName: player.name });
      this.broadcastPlayers();

      // Check if all non-drawer players have guessed
      const nonDrawers = [...this.players.keys()].filter(
        (id) => id !== this.currentDrawer && this.sockets.has(id)
      );
      if (nonDrawers.every((id) => this.guessedCorrectly.has(id))) {
        this.endTurn();
      }
    } else {
      // Check for close guess (off by 1-2 chars)
      const isClose = this.isCloseGuess(guess, this.currentWord.toLowerCase());
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

  endTurn() {
    this.phase = "between";
    this.broadcast({
      type: "reveal",
      word: this.currentWord,
    });
    this.broadcastPlayers();

    // Schedule next turn after 5 seconds
    this.state.storage.setAlarm(Date.now() + 5000);
    this.phase = "between";
  }

  // alarm() handles both tick and between-turn transition
  // We differentiate by checking this.phase

  endGame() {
    this.phase = "lobby";
    const scores = [...this.players.entries()]
      .map(([id, p]) => ({ id, name: p.name, score: p.score }))
      .sort((a, b) => b.score - a.score);

    this.broadcast({ type: "gameover", scores });

    // Reset scores
    for (const [, p] of this.players) {
      p.score = 0;
    }
    this.broadcastPlayers();
  }

  handleDisconnect(playerId) {
    this.sockets.delete(playerId);
    this.players.delete(playerId);

    // Reassign host
    if (playerId === this.hostId) {
      this.hostId = this.sockets.keys().next().value || null;
    }

    this.broadcastPlayers();

    // If drawer disconnected during drawing, end turn
    if (this.phase === "drawing" && playerId === this.currentDrawer) {
      this.endTurn();
    }

    // If fewer than 2 players during game, end
    if (this.phase !== "lobby" && this.sockets.size < 2) {
      this.endGame();
    }
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
    const players = [...this.players.entries()].map(([id, p]) => ({
      id,
      name: p.name,
      score: p.score,
      isHost: id === this.hostId,
      isDrawing: id === this.currentDrawer && this.phase === "drawing",
      connected: this.sockets.has(id),
    }));
    this.broadcast({ type: "players", players, hostId: this.hostId });
  }

  shuffleArray(arr) {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
  }
}
