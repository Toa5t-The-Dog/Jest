# Jest multiplayer relay — Render deployment package

This is the standalone public room-code service for the Jest FriendMatch development preview.
It does not include or run the host's private Jest game engine.

1. Upload these **extracted files** (including `render.yaml`) to the root of a new GitHub repository.
2. In Render, select New → Blueprint and connect the GitHub repository. Confirm the free Node web service.
3. When deployment succeeds, copy the **actual** Render service address (e.g. the address displayed by Render, not the service name). Verify `/health` and `/join`.
4. In the *separate* Jest Multiplayer Checkpoint 06 game folder on the host computer, edit `Jest/multiplayer/relay-config.json`:

```json
{
  "relayUrl": "wss://YOUR-ACTUAL-RENDER-ADDRESS/socket",
  "joinUrl": "https://YOUR-ACTUAL-RENDER-ADDRESS/join"
}
```

Restart the host's Jest Node server. Host clicks Create Friend Room; friend opens the Render `/join` page and enters the room code. No router configuration is needed.

**Important:** Only a subset of Jest gameplay is supported by the two-human FriendMatch preview. The service has not yet been deployed. The free Render service can sleep after 15 minutes without inbound HTTP/WS traffic; the game host now sends 30-second WSS keepalives while the room is active. Render restarts lose in-memory rooms and require a new code. Free service availability and limits can change.

See `RENDER_MULTIPLAYER_SETUP.md` in the game checkpoint for complete documentation.
