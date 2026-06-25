# Contributing to Zen Sync

Thank you for your interest in contributing! Zen Sync is a community project and all contributions are welcome.

## Getting started

```bash
git clone https://github.com/limeflash/zen-sync.git
cd zen-sync/native-host && python install.py
# Load extension in Zen Browser via about:debugging#/runtime/this-firefox
```

## Development workflow

1. Make your changes
2. Reload the extension in Zen Browser (`about:debugging` → Reload)
3. Test your changes
4. Open the Browser Console (`Ctrl+Shift+J`) to see `[zensync]` logs
5. Commit with a clear message
6. Open a PR

## Code style

- **Python**: standard Python style, type hints preferred
- **JavaScript**: no semicolons, 2-space indent, async/await (not callbacks)
- **CSS**: CSS custom properties (HSL color tokens), no preprocessor

## What to work on

Check [Issues](https://github.com/limeflash/zen-sync/issues) for open tasks. High-priority areas:

- **WRITE path**: applying remote state to the local Zen profile
- **macOS testing**: verify profile discovery + native messaging on macOS
- **Conflict resolution**: merge instead of last-writer-wins
- **XPI packaging**: signed XPI for permanent (non-temporary) install
- **Auto-discovery**: zero-config relay setup via QR

## Reporting bugs

Use the bug report template when opening an issue. Include:
- Zen Browser version
- OS (macOS / Windows / Linux)
- Steps to reproduce
- Browser Console output (`Ctrl+Shift+J`)

## Security

Found a security issue? Please don't open a public issue. Email: [security@limeflash.dev] or open a private security advisory on GitHub.

## License

By contributing, you agree that your contributions are licensed under the MIT license.