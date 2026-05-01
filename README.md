# munchfile

**Local files. Live on the web. Zero friction.**

Point munchfile at where your files already live. No folder reorganization, no upload buttons — just URLs.

## Install

```bash
# npm
npm install -g @munchfile/cli

# Homebrew (macOS / Linux)
brew tap ebuntario/munchfile
brew install munchfile
```

Or grab a prebuilt binary from [releases](https://github.com/ebuntario/munchfile-cli/releases/latest) (`darwin-arm64`, `darwin-x64`, `linux-x64`, `linux-arm64`).

## Quick start

```bash
munchfile login your@email.com
munchfile watch ~/Desktop/notes --recursive
```

Every `.md` and `.html` file you save in `~/Desktop/notes` gets a permanent live URL.

## What it does

- Watches local files via chokidar — content-hash identity, not inode tracking, so atomic writes from editors don't break URL stability.
- Streams uploads to the munchfile API in O(64KB) memory regardless of file size.
- Markdown is rendered server-side (remark → rehype, sanitized).
- Phase 1 supports `.md`, `.markdown`, `.html`, `.htm`.

## Links

- Homepage: <https://munchfile.com>
- Source: <https://github.com/ebuntario/munchfile-cli>
- Issues: <https://github.com/ebuntario/munchfile-cli/issues>

## License

MIT
