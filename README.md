# Editdock

**MIT-licensed browser video-editor SDK, Node renderer and JSON-first agent CLI.**

Version **0.3.0-alpha.1** is a public testing alpha for implementation and feedback—not a stable 1.0 release, hosted editing service or production upload server.

## Install the pinned release

Requires Node and, for local rendering, a caller-installed FFmpeg build with H.264/AAC and drawtext support plus ffprobe. The locally exercised native combination is macOS arm64, Node 26.7.0, FFmpeg 9.0.1 and ffprobe 8.0.1. Other platforms/builds remain unqualified; `doctor` checks prerequisites, not platform certification.

```sh
npm install --save-exact https://github.com/NSlothuus/editdock/releases/download/v0.3.0-alpha.1/rapid42-editdock-0.3.0-alpha.1.tgz
./node_modules/.bin/editdock help
./node_modules/.bin/editdock schema
./node_modules/.bin/editdock doctor --ffmpeg "$(command -v ffmpeg)"
```

Commit your application's lockfile and use `npm ci` for repeatable installs. Verify the release tarball against its published `SHA256SUMS` before use. **This version is distributed through GitHub Releases; npm registry publication is not yet available.** Do not substitute `npm install @rapid42/editdock` until a registry release is announced.

## Agents and local rendering

The CLI prints one versioned JSON object to stdout, with diagnostics on stderr. It exposes `help`, `schema`, `doctor`, `project init`, `project validate`, `project apply` and `render`. Edits use the same validated command API as the browser editor; there is no separate agent timeline model.

A generated-media walkthrough creates a project, admits a probed source fixture, applies trim/title/manual-caption commands, renders a real MP4 and strictly decodes both streams:

```sh
node node_modules/@rapid42/editdock/scripts/quickstart.mjs \
  --bin "$PWD/node_modules/.bin/editdock" \
  --ffmpeg "$(command -v ffmpeg)" \
  --ffprobe "$(command -v ffprobe)" \
  --output-dir "$PWD/editdock-smoke-001"
```

The output directory must **not already exist**. FFmpeg/ffprobe are host-provided, never bundled. Input manifests map exact asset IDs to trusted absolute local paths; project URLs are not filesystem authority. Output publication is create-only. Cancellation and uncertain publication retain private stages; inspect them rather than blindly deleting or retrying over existing files.

## Browser embedding

Use a browser bundler such as Vite. The public class retains its existing name, `EditWeave`, for API compatibility:

```ts
import { EditWeave, type HostStorage } from '@rapid42/editdock';

const storage: HostStorage = {
  async load() { return null; },
  async save(project) { /* atomically persist with conflict protection */ },
  async ingest(file, kind) {
    // Implement your authenticated media admission and return a probed Asset.
    throw new Error('Host media ingest must be implemented');
  },
  supportsExport: false,
};

const editor = new EditWeave();
editor.storage = storage;
document.body.append(editor);
await editor.ready;
```

This is an adapter contract sketch, not a complete host backend. Your application owns authentication, media custody, accurate asset metadata/URLs, persistence, compare-and-swap conflict handling and export delivery. Local storage helpers do not provide a standalone offline media host. Return `{ project, accept() }` when a load response carries a response-specific save token; commit that token only on acceptance.

The browser root needs a DOM. Node hosts use **`@rapid42/editdock/render`**, never the root import. No demo upload/render server is distributed.

## Handoff, limits and updates

- [Implementation handoff](docs/HANDOFF.md): adapters, CLI manifest, failures, supported scope and upgrade discipline.
- [Copyable agent implementation goal](docs/AGENT-GOAL.md).
- [Changelog](CHANGELOG.md) and [contribution/issue workflow](CONTRIBUTING.md).
- [Report an issue](https://github.com/NSlothuus/editdock/issues): version, sanitized `doctor` output, reproduction and expected/actual result. Never post credentials or private footage.

Export is fixed at **30 fps, 960×540 H.264/AAC**. Manual titles/captions and bounded typed edits are available; transcription, automatic captions, general color management, calibrated preview/export parity, arbitrary plugins and broader platform/device support are not qualified. This SDK is for a trusted host, not a sandbox for untrusted code or an authenticated multi-tenant media service.

Pin each update to a new immutable alpha version and lockfile. Snapshot project/media state, test open → edit → save → reopen → export on copies, then promote deliberately. Do not silently migrate projects or automatically track `latest`.

MIT © Rapid42. SDK licensing is separate from your FFmpeg/codec/font obligations; see [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md).
