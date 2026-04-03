import { beforeEach, describe, expect, it, vi, afterEach } from 'vitest';

const { mockExistsSync, mockExecFileSync, mockSpawn, mockDiscoverAppPath, mockDetectProcess } = vi.hoisted(() => ({
  mockExistsSync: vi.fn(),
  mockExecFileSync: vi.fn(),
  mockSpawn: vi.fn(),
  mockDiscoverAppPath: vi.fn(),
  mockDetectProcess: vi.fn(),
}));

vi.mock('node:fs', () => ({
  existsSync: mockExistsSync,
}));

vi.mock('node:child_process', () => ({
  execFileSync: mockExecFileSync,
  spawn: mockSpawn,
}));

vi.mock('../launcher.js', () => ({
  discoverAppPath: mockDiscoverAppPath,
  detectProcess: mockDetectProcess,
}));

function setPlatform(platform: NodeJS.Platform): () => void {
  const desc = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', { value: platform, configurable: true });
  return () => {
    if (desc) Object.defineProperty(process, 'platform', desc);
  };
}

function setEnv(key: string, value: string): () => void {
  const prev = process.env[key];
  process.env[key] = value;
  return () => {
    if (prev === undefined) delete process.env[key];
    else process.env[key] = prev;
  };
}

describe('browser candidates', () => {
  let restorePlatform = () => {};
  let restoreEnv: Array<() => void> = [];

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    restorePlatform();
    for (const restore of restoreEnv) restore();
    restoreEnv = [];
  });

  it('returns linux candidates in Chrome -> Edge -> Chromium order', async () => {
    restorePlatform = setPlatform('linux');

    mockDetectProcess.mockReturnValue(false);
    mockExecFileSync.mockImplementation((cmd: string, args: string[]) => {
      if (cmd === 'which') {
        const bin = args[0];
        if (bin === 'google-chrome-stable') return '/usr/bin/google-chrome-stable\n';
        if (bin === 'microsoft-edge-stable') return '/usr/bin/microsoft-edge-stable\n';
        if (bin === 'chromium') return '/usr/bin/chromium\n';
        throw new Error('not found');
      }
      throw new Error(`unexpected cmd: ${cmd}`);
    });

    const { getBrowserCandidates } = await import('./candidates.js');
    const candidates = getBrowserCandidates();

    expect(candidates.map((c) => c.id)).toEqual(['chrome', 'edge', 'chromium']);
    expect(candidates.map((c) => c.executable)).toEqual([
      '/usr/bin/google-chrome-stable',
      '/usr/bin/microsoft-edge-stable',
      '/usr/bin/chromium',
    ]);
  });

  it('prioritizes running browsers while preserving brand order', async () => {
    restorePlatform = setPlatform('linux');

    mockDetectProcess.mockImplementation((name: string) => name === 'microsoft-edge-stable');
    mockExecFileSync.mockImplementation((cmd: string, args: string[]) => {
      if (cmd === 'which') {
        const bin = args[0];
        if (bin === 'google-chrome-stable') return '/usr/bin/google-chrome-stable\n';
        if (bin === 'microsoft-edge-stable') return '/usr/bin/microsoft-edge-stable\n';
        if (bin === 'chromium') return '/usr/bin/chromium\n';
        throw new Error('not found');
      }
      throw new Error(`unexpected cmd: ${cmd}`);
    });

    const { getBrowserCandidates } = await import('./candidates.js');
    const candidates = getBrowserCandidates();

    expect(candidates.map((c) => c.id)).toEqual(['edge', 'chrome', 'chromium']);
    expect(candidates.map((c) => c.running)).toEqual([true, false, false]);
  });

  it('skips browsers that are not installed (windows path probe)', async () => {
    restorePlatform = setPlatform('win32');

    restoreEnv.push(setEnv('ProgramFiles', 'C:\\Program Files'));
    restoreEnv.push(setEnv('ProgramFiles(x86)', 'C:\\Program Files (x86)'));
    restoreEnv.push(setEnv('LOCALAPPDATA', 'C:\\Users\\oops\\AppData\\Local'));

    mockExistsSync.mockImplementation((file: string) => file.replace(/\\/g, '/').endsWith('/Microsoft/Edge/Application/msedge.exe'));

    const { getBrowserCandidates } = await import('./candidates.js');
    const candidates = getBrowserCandidates();

    expect(candidates.map((c) => c.id)).toEqual(['edge']);
  });

  it('returns macOS app candidates using discoverAppPath from launcher', async () => {
    restorePlatform = setPlatform('darwin');

    mockDiscoverAppPath.mockImplementation((name: string) => {
      if (name === 'Google Chrome') return '/Applications/Google Chrome.app';
      if (name === 'Microsoft Edge') return '/Applications/Microsoft Edge.app';
      if (name === 'Chromium') return '/Applications/Chromium.app';
      return null;
    });
    mockDetectProcess.mockReturnValue(false);

    const { getBrowserCandidates } = await import('./candidates.js');
    const candidates = getBrowserCandidates();

    expect(candidates.map((c) => c.id)).toEqual(['chrome', 'edge', 'chromium']);
    expect(candidates[0]?.executable).toBe('/Applications/Google Chrome.app');
    expect(mockDiscoverAppPath).toHaveBeenCalledWith('Google Chrome');
  });

  it('launches a detected candidate (linux)', async () => {
    restorePlatform = setPlatform('linux');
    mockSpawn.mockReturnValue({ unref: vi.fn(), on: vi.fn() });

    const { launchBrowserCandidate } = await import('./candidates.js');
    await launchBrowserCandidate({ id: 'edge', name: 'Edge', executable: '/usr/bin/microsoft-edge-stable', running: false });

    expect(mockSpawn).toHaveBeenCalledWith(
      '/usr/bin/microsoft-edge-stable',
      [],
      expect.objectContaining({ detached: true, stdio: 'ignore' }),
    );
  });

  it('launches a detected candidate on macOS via open command', async () => {
    restorePlatform = setPlatform('darwin');
    mockSpawn.mockReturnValue({ unref: vi.fn(), on: vi.fn() });

    const { launchBrowserCandidate } = await import('./candidates.js');
    await launchBrowserCandidate({ id: 'edge', name: 'Edge', executable: '/Applications/Microsoft Edge.app', running: false });

    expect(mockSpawn).toHaveBeenCalledWith(
      'open',
      ['/Applications/Microsoft Edge.app'],
      expect.objectContaining({ detached: true, stdio: 'ignore' }),
    );
  });

  it('swallows spawn ENOENT errors gracefully', async () => {
    restorePlatform = setPlatform('linux');
    let errorHandler: ((err: Error) => void) | undefined;
    mockSpawn.mockReturnValue({
      unref: vi.fn(),
      on: vi.fn((event: string, handler: (err: Error) => void) => {
        if (event === 'error') errorHandler = handler;
      }),
    });

    const { launchBrowserCandidate } = await import('./candidates.js');
    await launchBrowserCandidate({ id: 'chrome', name: 'Chrome', executable: '/nonexistent', running: false });

    // Calling the error handler should not throw
    expect(() => errorHandler?.(new Error('spawn ENOENT'))).not.toThrow();
  });
});
