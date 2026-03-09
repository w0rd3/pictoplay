export { GameRoom } from "./game-room.js";

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/api/ws") {
      const gameKey = url.searchParams.get("key");
      if (!gameKey) {
        return new Response("Missing game key", { status: 400 });
      }

      const roomId = env.GAME_ROOM.idFromName(gameKey.toUpperCase());
      const room = env.GAME_ROOM.get(roomId);
      return room.fetch(request);
    }

    // Let assets binding handle static files
    return env.ASSETS.fetch(request);
  },
};
