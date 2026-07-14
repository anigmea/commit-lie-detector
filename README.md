# commit-lie-detector

An LLM-powered git hook that catches misleading commit messages and suggests better ones.

[![npm version](https://badge.fury.io/js/commit-lie-detector.svg)](https://www.npmjs.com/package/commit-lie-detector)
[![CI](https://github.com/anigmea/commit-lie-detector/actions/workflows/publish.yml/badge.svg)](https://github.com/anigmea/commit-lie-detector/actions)

---

Your diff changed 23 files, added 2 new API endpoints, and refactored the auth module. Your message says "minor updates."

**commit-lie-detector** reads your actual diff and tells you exactly what you lied about — then offers to write what actually happened.

---

## Install

```sh
# Install the git hook in your current repo
npx commit-lie-detector install

# Set your API key (one required)
export ANTHROPIC_API_KEY=sk-ant-...   # preferred
# or
export OPENAI_API_KEY=sk-...
```

Add the key to your shell profile (`~/.zshrc`, `~/.bashrc`) to make it permanent.

---

## How it works

After `install`, every `git commit` runs the detector:

**Honest commit — passes silently:**
```
$ git commit -m "fix: null check in getUserById"
[main abc1234] fix: null check in getUserById
```

**Lie detected — shows evidence, offers rewrite:**
```
$ git commit -m "fix typo"

  commit-lie-detector caught a lie:

  Your message: "fix typo"
  What actually changed: Message says 'fix typo' but diff adds UserAuthService,
    two new auth endpoints in routes.ts, and deletes legacy/auth.js

  Suggested: feat: add UserAuthService, new auth endpoints, remove legacy auth.js

  Accept suggestion? [Y]es  [E]dit  [n]o (keep original) >
```

Press **Y** to accept the suggested message. **E** to open `$EDITOR` with it pre-filled. **n** to commit with your original message anyway.

---

## Suggest mode

Generate a commit message from scratch:

```sh
# Prints the message — pipe it directly
git commit -m "$(npx commit-lie-detector suggest)"

# Copy to clipboard
npx commit-lie-detector suggest --copy

# Conventional Commits format
npx commit-lie-detector suggest --conventional
```

Alias it:
```sh
alias gcm='git commit -m "$(npx commit-lie-detector suggest)"'
```

---

## CI / scripts

Non-interactive check — exits 0 (honest) or 1 (lie), JSON to stdout:

```sh
npx commit-lie-detector check "your commit message"
# stdout: {"honest":false,"accusation":"...","suggested_message":"...","confidence":0.05}
# exits 1
```

---

## Configuration

| Option | Effect |
|--------|--------|
| `ANTHROPIC_API_KEY` | Use Claude (preferred when both set) |
| `OPENAI_API_KEY` | Use OpenAI GPT |
| `COMMIT_LIE_SKIP=1` | Bypass check for one commit |
| `[skip-check]` in message | Bypass check for this commit |
| `--conventional` | Conventional Commits format in output |
| `--quality` | Higher-quality model (claude-sonnet-4-6 / gpt-4o) |
| `--strict` | Block commit instead of offering rewrite |
| `--suggest-always` | Show suggested message even on honest commits |

---

## Models

| Key | Default model | `--quality` model |
|-----|--------------|-------------------|
| `ANTHROPIC_API_KEY` | `claude-haiku-4-5-20251001` | `claude-sonnet-4-6` |
| `OPENAI_API_KEY` | `gpt-4o-mini` | `gpt-4o` |

Anthropic is used when both keys are set.

---

## Hook manager integration (Husky / Lefthook)

If `commit-lie-detector install` detects Husky or Lefthook, it prints a snippet instead of writing to `.git/hooks/`:

**Husky** — add to `.husky/commit-msg`:
```sh
npx --no commit-lie-detector _hook "$1"
```

**Lefthook** — add to `lefthook.yml`:
```yaml
commit-msg:
  commands:
    lie-detector:
      run: npx --no commit-lie-detector _hook {1}
```

---

## CI/CD example

```yaml
# .github/workflows/ci.yml
- name: Check commit message
  run: |
    npx commit-lie-detector check "${{ github.event.head_commit.message }}"
  env:
    ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
```

---

## Ignored files

Lock files and generated files are automatically excluded from analysis:

- `package-lock.json`, `yarn.lock`, `pnpm-lock.yaml`, `bun.lockb`
- `Gemfile.lock`, `Pipfile.lock`, `poetry.lock`, `composer.lock`, `Cargo.lock`
- Files matching `*.generated.*`, `*.gen.*`, `*_generated.*`
- Files matching `*.lock`

---

## Why not just use a linter?

Regex-based commit linters check format (length, prefix). They can't read your diff. Only an LLM can look at "modified auth/session.ts, deleted legacy/token.js, added 3 new API endpoints" and compare it to your message "cleanup." This tool catches the lie that format linters miss.

---

## Compared to alternatives

| Tool | Evaluate mode | Suggest mode | Hook-native |
|------|:---:|:---:|:---:|
| **commit-lie-detector** | ✅ | ✅ | ✅ |
| aicommits | ❌ | ✅ | — |
| ai-commit | ❌ | ✅ | — |

Evaluate mode — checking an existing message against the diff — is the differentiator. No other tool does this.

---

## Uninstall

```sh
npx commit-lie-detector uninstall
```

---

## Troubleshoot

```sh
npx commit-lie-detector doctor
```

---

## License

MIT
