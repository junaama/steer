## Daemon workdir defaults to root

- Client-created sessions now default to `/` on the daemon host, and the compose daemon no longer creates an empty `agent-workspace` volume as its default filesystem root.
- The web session form starts with `/` in the working-directory field; users can replace it with any path visible to the daemon that will own the session.
