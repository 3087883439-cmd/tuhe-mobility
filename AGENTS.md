# Development rules

This repository contains the standalone Tuhe WebGIS research prototype. Node.js >=22; no runtime dependency installation is required.

- Run `npm test` after core changes. Tests use synthetic transports and do not call live accounts.
- Start locally with `npm start` or Windows `start.cmd`.
- Never commit credentials, `.env` files, real merchant exports, user location logs, or raw research response archives.
- Do not infer real-world impossibility from missing routes or limited query coverage.
- Preserve time constraints, cycling accumulation, bicycle location continuity, source attribution, unknown business conditions, and distinct access/transit time accounting.
- Keep interest-area display and spatial filtering consistent. Do not fabricate ratings or route geometry.
- Local HTTP endpoints are not an MCP implementation. Public deployment and ChatGPT integration remain separate work.
- Do not publish the private repository or apply an open-source license without the owner's instruction.
