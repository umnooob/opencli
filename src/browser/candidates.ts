/**
 * Browser candidate detection — find installed Chromium-based browsers.
 *
 * Reuses launcher.ts helpers (discoverAppPath, detectProcess) on macOS,
 * and adds Linux/Windows detection.
 */

import { execFileSync, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import * as path from 'node:path';
import { discoverAppPath, detectProcess } from '../launcher.js';

export interface BrowserCandidate {
  id: 'chrome' | 'edge' | 'chromium';
  name: string;
  running: boolean;
  /** macOS: app bundle path; Linux/Windows: executable path */
  executable: string;
}

interface BrowserDef {
  id: BrowserCandidate['id'];
  name: string;
  macAppName: string;
  linuxBins: string[];
  winExeParts: string[][];
  processNames: string[];
}

const BROWSER_DEFS: BrowserDef[] = [
  {
    id: 'chrome',
    name: 'Chrome',
    macAppName: 'Google Chrome',
    linuxBins: ['google-chrome-stable', 'google-chrome'],
    winExeParts: [['Google', 'Chrome', 'Application', 'chrome.exe']],
    processNames: ['Google Chrome', 'google-chrome-stable', 'google-chrome', 'chrome', 'chrome.exe'],
  },
  {
    id: 'edge',
    name: 'Edge',
    macAppName: 'Microsoft Edge',
    linuxBins: ['microsoft-edge-stable', 'microsoft-edge'],
    winExeParts: [['Microsoft', 'Edge', 'Application', 'msedge.exe']],
    processNames: ['Microsoft Edge', 'microsoft-edge-stable', 'microsoft-edge', 'msedge', 'msedge.exe'],
  },
  {
    id: 'chromium',
    name: 'Chromium',
    macAppName: 'Chromium',
    linuxBins: ['chromium', 'chromium-browser'],
    winExeParts: [['Chromium', 'Application', 'chrome.exe']],
    processNames: ['Chromium', 'chromium', 'chromium-browser'],
  },
];

function tryWhich(bin: string): string | null {
  try {
    const out = execFileSync('which', [bin], { encoding: 'utf-8', stdio: 'pipe' });
    const resolved = String(out).split('\n')[0]?.trim();
    return resolved || null;
  } catch {
    return null;
  }
}

function winFirstExisting(parts: string[][]): string | null {
  const bases = [
    process.env.ProgramFiles,
    process.env['ProgramFiles(x86)'],
    process.env.LOCALAPPDATA,
  ].filter((x): x is string => typeof x === 'string' && x.length > 0);

  for (const p of parts) {
    for (const base of bases) {
      const full = path.win32.join(base, ...p);
      try { if (existsSync(full)) return full; } catch { /* skip */ }
    }
  }
  return null;
}

function isBrowserRunning(processNames: string[]): boolean {
  if (process.platform === 'darwin' || process.platform === 'linux') {
    return processNames.some(name => detectProcess(name));
  }
  if (process.platform === 'win32') {
    for (const imageName of processNames) {
      try {
        const out = execFileSync('tasklist', ['/FI', `IMAGENAME eq ${imageName}`], { encoding: 'utf-8', stdio: 'pipe' });
        if (String(out).includes(imageName)) return true;
      } catch { /* skip */ }
    }
  }
  return false;
}

function findExecutable(def: BrowserDef): string | null {
  if (process.platform === 'darwin') {
    return discoverAppPath(def.macAppName);
  }
  if (process.platform === 'linux') {
    for (const bin of def.linuxBins) {
      const found = tryWhich(bin);
      if (found) return found;
    }
    return null;
  }
  if (process.platform === 'win32') {
    return winFirstExisting(def.winExeParts);
  }
  return null;
}

export function getBrowserCandidates(): BrowserCandidate[] {
  const installed: BrowserCandidate[] = [];

  for (const def of BROWSER_DEFS) {
    const executable = findExecutable(def);
    if (executable) {
      installed.push({
        id: def.id,
        name: def.name,
        executable,
        running: isBrowserRunning(def.processNames),
      });
    }
  }

  // Running browsers first, preserving brand order within each group
  return [
    ...installed.filter(c => c.running),
    ...installed.filter(c => !c.running),
  ];
}

export async function launchBrowserCandidate(candidate: BrowserCandidate): Promise<void> {
  const opts = { detached: true as const, stdio: 'ignore' as const };

  const cmd = process.platform === 'darwin'
    ? { bin: 'open', args: [candidate.executable] }
    : { bin: candidate.executable, args: [] as string[] };

  const child = spawn(cmd.bin, cmd.args, opts);
  child.on('error', () => {}); // Swallow spawn errors (e.g. ENOENT)
  child.unref();
}
