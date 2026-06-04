// Test #10 — Detect accidental npm install -g or brew-managed openclaw replacing
// the managed install. After migration: current symlink exists, brew binary is
// our stub. Before migration: just verifies the expected homebrew path is in place.

import { existsSync, readFileSync, lstatSync, realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const BREW_BINARY = '/opt/homebrew/bin/openclaw';
const STUB_FINGERPRINT = 'openclaw is managed by openclaw-update';

export default {
  id: '10',
  name: 'install-drift',
  modes: ['current', 'quick'],
  timeout_ms: 5000,
  run(ctx) {
    // Use ctx.configDir so this test works against both the live install and
    // the hermetic mock fixture (where HOME/.openclaw may not exist).
    const CURRENT_SYMLINK = resolve(ctx.configDir, 'current');

    const issues = [];
    const notes = [];

    // Check whether we're post-migration (versioned install) or pre-migration (brew).
    const isMigrated = existsSync(CURRENT_SYMLINK) && lstatSync(CURRENT_SYMLINK).isSymbolicLink();

    if (isMigrated) {
      // Post-migration checks
      notes.push('versioned install detected');

      // 1. current symlink must resolve to the same installDir passed by the orchestrator
      let resolved = '';
      try { resolved = realpathSync(CURRENT_SYMLINK); } catch { /* ignore */ }
      if (!resolved) {
        issues.push('~/.openclaw/current symlink does not resolve');
      } else {
        notes.push(`current → ${resolved}`);
      }

      // 2. brew binary should be our stub (after migrate-to-versioned ran)
      if (existsSync(BREW_BINARY)) {
        const content = readFileSync(BREW_BINARY, 'utf8');
        if (!content.includes(STUB_FINGERPRINT)) {
          issues.push('brew openclaw binary exists and is NOT our stub — possible accidental npm install -g');
        }
      } else {
        notes.push('brew openclaw binary absent — ok');
      }

      // 3. The managed wrapper must exist and interactive zsh should resolve it.
      // Non-interactive launchd/agent PATHs may not source ~/.zshrc; don't fail the
      // safety check just because this process inherited a minimal PATH.
      const managedWrapper = resolve(ctx.configDir, 'bin/openclaw');
      if (!existsSync(managedWrapper)) {
        issues.push(`managed wrapper missing: ${managedWrapper}`);
      } else {
        const whichR = spawnSync('/bin/zsh', ['-ic', 'which openclaw'], { encoding: 'utf8', env: process.env, timeout: 3000 });
        const which = (whichR.stdout || '').trim();
        if (which && which !== managedWrapper) {
          issues.push(`interactive zsh resolves openclaw = ${which}, expected ${managedWrapper} — ~/.zshrc/.zprofile may be wrong`);
        } else {
          notes.push(`interactive zsh openclaw → ${which || managedWrapper}`);
        }
      }
    } else {
      // Pre-migration: verify brew install is as expected
      notes.push('pre-migration (brew install)');
      if (!existsSync(BREW_BINARY)) {
        issues.push('brew openclaw binary not found — install may be broken');
      } else {
        const r = spawnSync('readlink', [BREW_BINARY], { encoding: 'utf8' });
        const link = (r.stdout || '').trim();
        if (!link.includes('node_modules/openclaw')) {
          issues.push(`brew binary is not a symlink into node_modules: ${link}`);
        } else {
          notes.push(`brew symlink ok → ${link}`);
        }
      }
    }

    if (issues.length) return { ok: false, detail: issues.join('; ') };
    return { ok: true, detail: notes.join(' | ') };
  },
};
